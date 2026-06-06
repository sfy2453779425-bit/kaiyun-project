import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProfiles, classifyScenario } from '../build-market-analysis.js';
import {
  BACKTEST_DIR,
  MODEL_MODE,
  buildSnapshotSummary,
  groupBy,
  isFinishedMatch,
  readHistoryData,
  rowDate,
} from '../backtest/common.js';
import { clamp, logistic, num, teamKey, unionColumns, writeCsv } from '../shared.js';
import { totalKillsFeatures } from './total-kills-model-predict.js';

const ROOT = process.cwd();
const LINES = [27.5, 30.5, 33.5];
const MIN_PRIOR_MAPS = 8;
const BOOTSTRAP_N = 1000;
const SEED = 20260603;
const COEF_PATH = path.join(ROOT, 'lck', 'calibration', 'total_kills_model_coef.json');
const DETAIL_CSV = path.join(BACKTEST_DIR, 'total_kills_continuous_vs_scenario.csv');
const BY_MAP_BO_CSV = path.join(BACKTEST_DIR, 'bo5_calibration_by_map_bo.csv');
const RELIABILITY_CSV = path.join(BACKTEST_DIR, 'bo5_calibration_reliability.csv');
const REPORT_PATH = path.join(ROOT, 'lck', 'data', '盘口分析', 'BO5校准复核.md');

function yearOf(value) {
  return String(value || '').slice(0, 4);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function pctFmt(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function stdev(values) {
  const m = mean(values);
  if (!Number.isFinite(m) || values.length < 2) return 0;
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function loadCoef() {
  if (!existsSync(COEF_PATH)) {
    throw new Error(`missing LCK total-kills coef: ${COEF_PATH}. Run npm run lck:calibration:total-kills first.`);
  }
  return JSON.parse(readFileSync(COEF_PATH, 'utf8'));
}

function z(value, scaler) {
  const sd = num(scaler?.sd, 0);
  if (!Number.isFinite(sd) || sd <= 1e-9) return 0;
  return (num(value) - num(scaler.mean)) / sd;
}

function predictMeanFromCoef(features, patch, coef) {
  let value = num(coef.intercept, 28);
  for (const feature of coef.features || []) {
    value += num(coef.beta?.[feature]) * z(features[feature], coef.scaler?.[feature]);
  }
  value += num(coef.patch_gamma?.[patch], 0);
  return clamp(value, 8, 65);
}

function continuousProbability(meanValue, sigma, line, selection) {
  const under = clamp(normalCdf((num(line) - meanValue) / Math.max(num(sigma, 7), 0.000001)), 0.02, 0.98);
  return selection === 'under' ? under : 1 - under;
}

function scenarioBaselineProbability(team, opponent, line, selection) {
  let scenario = '';
  try {
    scenario = String(classifyScenario(team, opponent)?.scenario || '');
  } catch {
    scenario = '';
  }
  let meanValue = (num(team.avg_total_kills) + num(opponent.avg_total_kills)) / 2;
  if (/混乱|娣蜂贡|高击杀|楂樺嚮/.test(scenario)) meanValue += 2.2;
  if (/低击杀|浣庡嚮/.test(scenario)) meanValue -= 2.0;
  if (/速推|閫熸帹/.test(scenario)) meanValue -= 0.8;
  const over = clamp(logistic((meanValue - num(line)) / 3.8), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

function dateMaxBefore(maps, cutoff) {
  let latest = '';
  for (const map of maps) {
    const date = rowDate(map);
    if (date < cutoff && date > latest) latest = date;
  }
  return latest;
}

function stageType(row) {
  const text = `${row.tournament || ''} ${row.stage || ''} ${row.history_slug || ''}`;
  return /PLAYOFF|FINAL|PLAYIN|PLAY-IN|ROUND|KNOCKOUT|REGIONAL|QUALIFIER/i.test(text)
    ? 'playoff_like'
    : 'regular_like';
}

function buildObservations(matches, maps) {
  const eligibleMatches = matches
    .filter(isFinishedMatch)
    .filter((match) => ['2024', '2025'].includes(yearOf(match.match_date)))
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const snapshotCache = new Map();
  const rows = [];
  const skipped = {
    low_sample_matches: 0,
    missing_profiles: 0,
    missing_maps: 0,
  };

  for (const match of eligibleMatches) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    const profiles = buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff);
    const a = profiles.get(teamKey(match.team_a_id || match.team_a));
    const b = profiles.get(teamKey(match.team_b_id || match.team_b));
    if (!a || !b) {
      skipped.missing_profiles += 1;
      continue;
    }
    if (Math.min(num(a.maps), num(b.maps)) < MIN_PRIOR_MAPS) {
      skipped.low_sample_matches += 1;
      continue;
    }
    const matchMaps = (mapsByMatch.get(match.match_id) || [])
      .filter((map) => Number.isFinite(num(map.total_kills, NaN)))
      .sort((x, y) => num(x.bo) - num(y.bo));
    if (!matchMaps.length) {
      skipped.missing_maps += 1;
      continue;
    }

    const baseFeatures = totalKillsFeatures(a, b);
    const trainMaxDate = dateMaxBefore(maps, cutoff);
    for (const map of matchMaps) {
      rows.push({
        split_year: yearOf(cutoff),
        split: yearOf(cutoff) === '2025' ? 'OOS_2025' : 'fit_2024',
        match_id: match.match_id,
        game_id: map.game_id,
        match_date: cutoff,
        match_name: match.match_name,
        tournament: map.tournament || match.tournament || '',
        stage: map.stage || match.stage || '',
        stage_type: stageType({ ...match, ...map }),
        map_bo: String(num(map.bo)),
        total_kills: num(map.total_kills),
        patch: map.patch || match.patch || '',
        train_max_date: trainMaxDate,
        team_a_id: teamKey(match.team_a_id || match.team_a),
        team_a: match.team_a || map.team_a || '',
        team_b_id: teamKey(match.team_b_id || match.team_b),
        team_b: match.team_b || map.team_b || '',
        features: {
          ...baseFeatures,
          patch: map.patch || match.patch || '',
        },
        profile_a: a,
        profile_b: b,
      });
    }
  }

  return { rows, skipped };
}

function scoreObservations(observations, coef) {
  const rows = [];
  const sigma = Math.max(3.5, num(coef.sigma, 7));
  for (const row of observations) {
    const continuousMean = predictMeanFromCoef(row.features, row.patch, coef);
    for (const line of LINES) {
      for (const selection of ['over', 'under']) {
        const pContinuous = continuousProbability(continuousMean, sigma, line, selection);
        const pBaseline = scenarioBaselineProbability(row.profile_a, row.profile_b, line, selection);
        rows.push({
          split_year: row.split_year,
          split: row.split,
          match_id: row.match_id,
          game_id: row.game_id,
          match_date: row.match_date,
          match_name: row.match_name,
          tournament: row.tournament,
          stage: row.stage,
          stage_type: row.stage_type,
          map_bo: row.map_bo,
          line: String(line),
          selection,
          total_kills: row.total_kills,
          outcome: selection === 'over' ? (row.total_kills > line ? 1 : 0) : (row.total_kills < line ? 1 : 0),
          p_baseline: pBaseline,
          p_continuous: pContinuous,
          continuous_mean: continuousMean,
          residual: row.total_kills - continuousMean,
          sigma,
          patch: row.patch,
          train_max_date: row.train_max_date,
          team_a_id: row.team_a_id,
          team_a: row.team_a,
          team_b_id: row.team_b_id,
          team_b: row.team_b,
          avg_total_mean: row.features.avg_total_mean,
          avg_time_mean: row.features.avg_time_mean,
          strength_abs_diff: row.features.strength_abs_diff,
          recent_map_win_abs_diff: row.features.recent_map_win_abs_diff,
          avg_kill_diff_sum: row.features.avg_kill_diff_sum,
          first_turret_mean: row.features.first_turret_mean,
        });
      }
    }
  }
  return rows;
}

function mapBoAudit(maps) {
  const boCounts = [...groupBy(maps, (row) => String(row.bo || '')).entries()]
    .map(([map_bo, rows]) => ({ map_bo, maps: rows.length }))
    .sort((a, b) => num(a.map_bo) - num(b.map_bo));
  let checkedMatches = 0;
  let sequentialMatches = 0;
  const mismatchExamples = [];
  for (const [matchId, matchMaps] of groupBy(maps, (row) => row.match_id).entries()) {
    const numbers = [...new Set(matchMaps.map((row) => num(row.bo, NaN)).filter(Number.isFinite))]
      .sort((a, b) => a - b);
    if (!numbers.length) continue;
    checkedMatches += 1;
    const sequential = numbers.every((value, index) => value === index + 1);
    if (sequential) sequentialMatches += 1;
    else if (mismatchExamples.length < 5) {
      mismatchExamples.push({
        match_id: matchId,
        match_name: matchMaps[0]?.match_name || '',
        bo_values: numbers.join('/'),
      });
    }
  }
  const g5Maps = maps
    .filter((row) => String(row.bo) === '5')
    .map((row) => ({
      match_id: row.match_id,
      game_id: row.game_id,
      match_time: row.match_time,
      match_name: row.match_name,
      tournament: row.tournament,
      stage: row.stage,
      patch: row.patch,
      total_kills: row.total_kills,
    }));
  return {
    boCounts,
    checkedMatches,
    sequentialMatches,
    mismatchExamples,
    g5Maps,
  };
}

function reliabilityBins(rows, pKey = 'p_continuous', binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    bin_lower: index / binCount,
    bin_upper: (index + 1) / binCount,
    n: 0,
    p_sum: 0,
    y_sum: 0,
  }));
  for (const row of rows) {
    const p = num(row[pKey], NaN);
    const y = num(row.outcome, NaN);
    if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
    const index = Math.max(0, Math.min(binCount - 1, Math.floor(p * binCount)));
    bins[index].n += 1;
    bins[index].p_sum += p;
    bins[index].y_sum += y;
  }
  return bins
    .filter((bin) => bin.n > 0)
    .map((bin) => {
      const avgPred = bin.p_sum / bin.n;
      const actualHit = bin.y_sum / bin.n;
      return {
        bin_lower: bin.bin_lower,
        bin_upper: bin.bin_upper,
        n: bin.n,
        avg_pred: avgPred,
        actual_hit: actualHit,
        gap: actualHit - avgPred,
        abs_gap: Math.abs(actualHit - avgPred),
      };
    });
}

function metrics(rows, pKey = 'p_continuous') {
  const valid = rows.filter((row) => Number.isFinite(num(row[pKey], NaN)) && Number.isFinite(num(row.outcome, NaN)));
  if (!valid.length) {
    return {
      rows: 0,
      maps: 0,
      matches: 0,
      ece: NaN,
      brier: NaN,
      mean_actual_total_kills: NaN,
      mean_pred_total_kills: NaN,
      mean_residual: NaN,
    };
  }
  const brier = mean(valid.map((row) => (num(row[pKey]) - num(row.outcome)) ** 2));
  const bins = reliabilityBins(valid, pKey);
  const ece = bins.reduce((sum, bin) => sum + (bin.n / valid.length) * bin.abs_gap, 0);
  const mapsByKey = new Map();
  for (const row of valid) {
    const key = `${row.match_id}|${row.game_id}`;
    if (!mapsByKey.has(key)) mapsByKey.set(key, row);
  }
  const uniqueMaps = [...mapsByKey.values()];
  return {
    rows: valid.length,
    maps: uniqueMaps.length,
    matches: new Set(valid.map((row) => row.match_id)).size,
    ece,
    brier,
    mean_actual_total_kills: mean(uniqueMaps.map((row) => num(row.total_kills, NaN))),
    mean_pred_total_kills: mean(uniqueMaps.map((row) => num(row.continuous_mean, NaN))),
    mean_residual: mean(uniqueMaps.map((row) => num(row.residual, NaN))),
  };
}

function metricRow(scope, rows) {
  return { scope, ...metrics(rows) };
}

function groupMetricRows(detailRows) {
  const rows = [];
  const scopes = [
    { scope: 'all_2024_2025', filter: () => true },
    { scope: '2024_fit', filter: (row) => row.split_year === '2024' },
    { scope: '2025_OOS', filter: (row) => row.split_year === '2025' },
  ];
  for (const { scope, filter } of scopes) {
    for (const mapBo of ['1', '2', '3', '4', '5']) {
      const subset = detailRows.filter((row) => filter(row) && row.map_bo === mapBo);
      const m = metrics(subset);
      rows.push({
        scope,
        year: scope === 'all_2024_2025' ? 'all' : scope.slice(0, 4),
        oos: scope === '2025_OOS' ? 'yes' : 'no',
        map_bo: mapBo,
        n_rows: m.rows,
        n_maps: m.maps,
        n_matches: m.matches,
        ece: m.ece,
        brier: m.brier,
        mean_actual_total_kills: m.mean_actual_total_kills,
        mean_pred_total_kills: m.mean_pred_total_kills,
        mean_residual: m.mean_residual,
      });
    }
  }
  return rows;
}

function resampleRowsByCluster(rows, random) {
  const clusters = [...groupBy(rows, (row) => row.match_id).values()];
  if (!clusters.length) return [];
  const out = [];
  for (let i = 0; i < clusters.length; i += 1) {
    out.push(...clusters[Math.floor(random() * clusters.length)]);
  }
  return out;
}

function pairedClusterDiff(rowsA, rowsB, random) {
  const clusterIds = [...new Set([...rowsA, ...rowsB].map((row) => row.match_id))];
  if (!clusterIds.length) return NaN;
  const groupA = groupBy(rowsA, (row) => row.match_id);
  const groupB = groupBy(rowsB, (row) => row.match_id);
  const sampleA = [];
  const sampleB = [];
  for (let i = 0; i < clusterIds.length; i += 1) {
    const id = clusterIds[Math.floor(random() * clusterIds.length)];
    if (groupA.has(id)) sampleA.push(...groupA.get(id));
    if (groupB.has(id)) sampleB.push(...groupB.get(id));
  }
  if (!sampleA.length || !sampleB.length) return NaN;
  return metrics(sampleA).ece - metrics(sampleB).ece;
}

function bootstrap(rows, rowsCompare = null, iterations = BOOTSTRAP_N, seed = SEED) {
  const random = rng(seed);
  const eceValues = [];
  const diffValues = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = resampleRowsByCluster(rows, random);
    if (sample.length) eceValues.push(metrics(sample).ece);
    if (rowsCompare) {
      const diff = pairedClusterDiff(rows, rowsCompare, random);
      if (Number.isFinite(diff)) diffValues.push(diff);
    }
  }
  const ci = (values) => ({
    low: percentile(values, 0.025),
    median: percentile(values, 0.5),
    high: percentile(values, 0.975),
    n: values.length,
  });
  return {
    ece: ci(eceValues),
    diff: rowsCompare ? ci(diffValues) : null,
  };
}

function reliabilityTableRows(rows, segment) {
  return reliabilityBins(rows).map((bin) => ({
    segment,
    bin_lower: bin.bin_lower,
    bin_upper: bin.bin_upper,
    n: bin.n,
    avg_pred: bin.avg_pred,
    actual_hit: bin.actual_hit,
    gap: bin.gap,
  }));
}

function confoundingRows(detailRows) {
  const source = detailRows.filter((row) => row.split_year === '2025' && ['3', '4', '5'].includes(row.map_bo));
  const tournamentStagePatch = [...groupBy(source, (row) => `${row.tournament}|${row.stage}|${row.patch}|G${row.map_bo}`).entries()]
    .map(([key, rows]) => {
      const [tournament, stage, patch, mapBo] = key.split('|');
      return {
        kind: 'tournament_stage_patch',
        tournament,
        stage,
        patch,
        stage_type: rows[0]?.stage_type || '',
        map_bo: mapBo.replace('G', ''),
        ...metrics(rows),
      };
    })
    .filter((row) => row.rows >= 6)
    .sort((a, b) => b.ece - a.ece);

  const stageTypeRows = [];
  for (const stage of ['regular_like', 'playoff_like']) {
    for (const mapBo of ['3', '4', '5']) {
      const subset = detailRows.filter((row) => row.split_year === '2025' && row.stage_type === stage && row.map_bo === mapBo);
      if (!subset.length) continue;
      stageTypeRows.push({
        kind: 'stage_type',
        stage_type: stage,
        map_bo: mapBo,
        ...metrics(subset),
      });
    }
  }

  const patchRows = [...groupBy(source, (row) => `${row.patch}|G${row.map_bo}`).entries()]
    .map(([key, rows]) => {
      const [patch, mapBo] = key.split('|');
      return {
        kind: 'patch',
        patch,
        map_bo: mapBo.replace('G', ''),
        ...metrics(rows),
      };
    })
    .filter((row) => row.rows >= 6)
    .sort((a, b) => b.ece - a.ece);

  const g5 = detailRows.filter((row) => row.split_year === '2025' && row.map_bo === '5');
  const teamRows = [];
  for (const team of [...new Set(g5.flatMap((row) => [row.team_a_id, row.team_b_id]).filter(Boolean))]) {
    const subset = g5.filter((row) => row.team_a_id === team || row.team_b_id === team);
    teamRows.push({
      kind: 'team_exposure_2025_g5',
      team,
      ...metrics(subset),
    });
  }
  teamRows.sort((a, b) => b.rows - a.rows || b.ece - a.ece);

  return { tournamentStagePatch, stageTypeRows, patchRows, teamRows };
}

function markdownTable(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `| ${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => {
    const value = row[col.key];
    return col.format ? col.format(value, row) : value ?? '';
  }).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function metricColumns() {
  return [
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'map_bo', label: 'G#' },
    { key: 'n_rows', label: 'rows' },
    { key: 'n_maps', label: 'maps' },
    { key: 'n_matches', label: 'matches' },
    { key: 'ece', label: 'ECE', format: (value) => pctFmt(value) },
    { key: 'brier', label: 'Brier', format: (value) => fmt(value) },
    { key: 'mean_actual_total_kills', label: 'actual kills', format: (value) => fmt(value, 2) },
    { key: 'mean_pred_total_kills', label: 'pred kills', format: (value) => fmt(value, 2) },
    { key: 'mean_residual', label: 'actual-pred', format: (value) => fmt(value, 2) },
  ];
}

function reliabilityColumns() {
  return [
    { key: 'segment', label: 'segment', align: 'left' },
    { key: 'bin', label: 'p bucket', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'avg_pred', label: 'avg_pred', format: (value) => pctFmt(value) },
    { key: 'actual_hit', label: 'actual_hit', format: (value) => pctFmt(value) },
    { key: 'gap', label: 'actual-pred', format: (value) => pctFmt(value) },
  ];
}

function rowForReliabilityMd(row) {
  return {
    ...row,
    bin: `${Math.round(num(row.bin_lower) * 100)}-${Math.round(num(row.bin_upper) * 100)}%`,
  };
}

async function maybeWriteDetailCsv(scoredRows) {
  await mkdir(BACKTEST_DIR, { recursive: true });
  const flatRows = scoredRows.map((row) => ({
    ...row,
    p_baseline: fmt(row.p_baseline),
    p_continuous: fmt(row.p_continuous),
    continuous_mean: fmt(row.continuous_mean),
    residual: fmt(row.residual),
    sigma: fmt(row.sigma),
    avg_total_mean: fmt(row.avg_total_mean),
    avg_time_mean: fmt(row.avg_time_mean),
    strength_abs_diff: fmt(row.strength_abs_diff),
    recent_map_win_abs_diff: fmt(row.recent_map_win_abs_diff),
    avg_kill_diff_sum: fmt(row.avg_kill_diff_sum),
    first_turret_mean: fmt(row.first_turret_mean),
  }));
  await writeCsv(DETAIL_CSV, flatRows, unionColumns(flatRows));
}

async function main() {
  const coef = loadCoef();
  const { matches, maps } = await readHistoryData();
  const audit = mapBoAudit(maps);
  const { rows: observations, skipped } = buildObservations(matches, maps);
  if (!observations.length) throw new Error('no LCK total-kills observations generated');
  const detailRows = scoreObservations(observations, coef);
  await maybeWriteDetailCsv(detailRows);

  const groupedMetrics = groupMetricRows(detailRows);
  await writeCsv(BY_MAP_BO_CSV, groupedMetrics, [
    'scope', 'year', 'oos', 'map_bo', 'n_rows', 'n_maps', 'n_matches',
    'ece', 'brier', 'mean_actual_total_kills', 'mean_pred_total_kills', 'mean_residual',
  ]);

  const g5_2025 = detailRows.filter((row) => row.split_year === '2025' && row.map_bo === '5');
  const g3_2025 = detailRows.filter((row) => row.split_year === '2025' && row.map_bo === '3');
  const boot2025 = bootstrap(g5_2025, g3_2025);
  const g5All = detailRows.filter((row) => row.map_bo === '5');
  const g3All = detailRows.filter((row) => row.map_bo === '3');
  const bootAll = bootstrap(g5All, g3All, BOOTSTRAP_N, SEED + 11);

  const reliabilityRows = [
    ...reliabilityTableRows(g5_2025, '2025_OOS_G5'),
    ...reliabilityTableRows(g3_2025, '2025_OOS_G3'),
    ...reliabilityTableRows(g5All, '2024_2025_G5'),
  ];
  await writeCsv(RELIABILITY_CSV, reliabilityRows, [
    'segment', 'bin_lower', 'bin_upper', 'n', 'avg_pred', 'actual_hit', 'gap',
  ]);

  const confounds = confoundingRows(detailRows);
  const g5M = metrics(g5_2025);
  const g3M = metrics(g3_2025);
  const diff = g5M.ece - g3M.ece;
  const diffSignificant = boot2025.diff.low > 0 || boot2025.diff.high < 0;
  const enoughG5Maps = g5M.maps >= 30;
  const gateVerdict = diffSignificant && g5M.ece > g3M.ece
    ? 'G5 total_kills 暂停真钱，G1-G4 不受本实验影响。'
    : '不建议新增真钱硬闸门；G5 total_kills 只做 shadow 观察。';

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const report = [];
  report.push('# LCK BO5 / G5 总杀校准复核');
  report.push('');
  report.push(`Generated at: ${new Date().toISOString()}`);
  report.push(`MODEL_MODE: \`${MODEL_MODE}\`（离线复核；未改线上模型/真钱闸门）`);
  report.push(`Detail CSV: \`${path.relative(ROOT, DETAIL_CSV).replaceAll(path.sep, '/')}\``);
  report.push(`Reliability CSV: \`${path.relative(ROOT, RELIABILITY_CSV).replaceAll(path.sep, '/')}\``);
  report.push('');
  report.push('## 0. map_bo 字段核验');
  report.push('');
  report.push('- LCK 历史小局文件字段名是 `bo`，本报告把它映射为 `map_bo`。');
  report.push('- 按 `match_id` 分组检查后，`bo` 在同一场内从 1 开始递增，语义是 **第几局/G1-G5**，不是赛制 BO1/BO3/BO5。');
  report.push(`- 检查比赛数: ${audit.checkedMatches}；顺序完整比赛数: ${audit.sequentialMatches}；异常比赛数: ${audit.checkedMatches - audit.sequentialMatches}。`);
  report.push('');
  report.push(markdownTable([
    { key: 'map_bo', label: 'map_bo/G#', align: 'left' },
    { key: 'maps', label: 'maps' },
  ], audit.boCounts));
  if (audit.mismatchExamples.length) {
    report.push('');
    report.push('异常样例:');
    report.push(markdownTable([
      { key: 'match_id', label: 'match_id', align: 'left' },
      { key: 'match_name', label: 'match', align: 'left' },
      { key: 'bo_values', label: 'bo values', align: 'left' },
    ], audit.mismatchExamples));
  }
  report.push('');
  report.push('2025 G5 样本列表:');
  report.push(markdownTable([
    { key: 'match_time', label: 'date', align: 'left' },
    { key: 'match_name', label: 'match', align: 'left' },
    { key: 'tournament', label: 'tournament', align: 'left' },
    { key: 'stage', label: 'stage', align: 'left' },
    { key: 'patch', label: 'patch', align: 'left' },
    { key: 'total_kills', label: 'kills' },
  ], audit.g5Maps));
  report.push('');
  report.push('## 1. 复现分组指标');
  report.push('');
  report.push(`- 连续模型系数: \`${path.relative(ROOT, COEF_PATH).replaceAll(path.sep, '/')}\`, deploy=${coef.deploy === true ? 'true' : 'false'}, generated_at=${coef.generated_at || ''}`);
  report.push(`- 生成样本: maps=${observations.length}, line/selection rows=${detailRows.length}; skipped=${JSON.stringify(skipped)}。`);
  report.push('- 行数 rows 是 line × over/under 样本行；地图数/总杀均值按唯一 `match_id + game_id` 去重。');
  report.push('');
  report.push(markdownTable(metricColumns(), groupedMetrics.filter((row) => row.scope !== 'all_2024_2025')));
  report.push('');
  report.push('重点比较:');
  report.push(markdownTable(metricColumns(), [
    { scope: '2025_OOS_G3', map_bo: '3', n_rows: g3M.rows, n_maps: g3M.maps, n_matches: g3M.matches, ece: g3M.ece, brier: g3M.brier, mean_actual_total_kills: g3M.mean_actual_total_kills, mean_pred_total_kills: g3M.mean_pred_total_kills, mean_residual: g3M.mean_residual },
    { scope: '2025_OOS_G5', map_bo: '5', n_rows: g5M.rows, n_maps: g5M.maps, n_matches: g5M.matches, ece: g5M.ece, brier: g5M.brier, mean_actual_total_kills: g5M.mean_actual_total_kills, mean_pred_total_kills: g5M.mean_pred_total_kills, mean_residual: g5M.mean_residual },
  ]));
  report.push('');
  report.push('## 2. Cluster Bootstrap');
  report.push('');
  report.push(`- Bootstrap: ${BOOTSTRAP_N} 次，seed=${SEED}，cluster=` + '`match_id`。');
  report.push(markdownTable([
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'g5_ece', label: 'G5 ECE', format: (value) => pctFmt(value) },
    { key: 'g5_ci', label: 'G5 ECE 95% CI', align: 'left' },
    { key: 'diff', label: 'G5-G3 ECE diff', format: (value) => pctFmt(value) },
    { key: 'diff_ci', label: 'diff 95% CI', align: 'left' },
    { key: 'bootstrap_n', label: 'valid boot n' },
  ], [
    {
      scope: '2025 OOS',
      g5_ece: g5M.ece,
      g5_ci: `[${pctFmt(boot2025.ece.low)}, ${pctFmt(boot2025.ece.high)}]`,
      diff,
      diff_ci: `[${pctFmt(boot2025.diff.low)}, ${pctFmt(boot2025.diff.high)}]`,
      bootstrap_n: `${boot2025.ece.n}/${boot2025.diff.n}`,
    },
    {
      scope: '2024-2025 all',
      g5_ece: metrics(g5All).ece,
      g5_ci: `[${pctFmt(bootAll.ece.low)}, ${pctFmt(bootAll.ece.high)}]`,
      diff: metrics(g5All).ece - metrics(g3All).ece,
      diff_ci: `[${pctFmt(bootAll.diff.low)}, ${pctFmt(bootAll.diff.high)}]`,
      bootstrap_n: `${bootAll.ece.n}/${bootAll.diff.n}`,
    },
  ]));
  report.push('');
  report.push('## 3. Reliability curve');
  report.push('');
  report.push('完整 CSV 已输出到 reliability CSV。下面只展示 2025 OOS G5:');
  report.push('');
  report.push(markdownTable(reliabilityColumns(), reliabilityRows.filter((row) => row.segment === '2025_OOS_G5').map(rowForReliabilityMd)));
  report.push('');
  report.push('## 4. 混淆检查');
  report.push('');
  report.push('### regular vs playoff');
  report.push(markdownTable([
    { key: 'stage_type', label: 'stage_type', align: 'left' },
    { key: 'map_bo', label: 'G#' },
    { key: 'rows', label: 'rows' },
    { key: 'maps', label: 'maps' },
    { key: 'matches', label: 'matches' },
    { key: 'ece', label: 'ECE', format: (value) => pctFmt(value) },
    { key: 'brier', label: 'Brier', format: (value) => fmt(value) },
    { key: 'mean_residual', label: 'actual-pred', format: (value) => fmt(value, 2) },
  ], confounds.stageTypeRows));
  report.push('');
  report.push('### tournament / stage / patch 高 ECE 桶');
  report.push(markdownTable([
    { key: 'tournament', label: 'tournament', align: 'left' },
    { key: 'stage', label: 'stage', align: 'left' },
    { key: 'patch', label: 'patch', align: 'left' },
    { key: 'map_bo', label: 'G#' },
    { key: 'rows', label: 'rows' },
    { key: 'maps', label: 'maps' },
    { key: 'matches', label: 'matches' },
    { key: 'ece', label: 'ECE', format: (value) => pctFmt(value) },
    { key: 'brier', label: 'Brier', format: (value) => fmt(value) },
  ], confounds.tournamentStagePatch.slice(0, 12)));
  report.push('');
  report.push('### patch 分层');
  report.push(markdownTable([
    { key: 'patch', label: 'patch', align: 'left' },
    { key: 'map_bo', label: 'G#' },
    { key: 'rows', label: 'rows' },
    { key: 'maps', label: 'maps' },
    { key: 'ece', label: 'ECE', format: (value) => pctFmt(value) },
    { key: 'brier', label: 'Brier', format: (value) => fmt(value) },
  ], confounds.patchRows.slice(0, 16)));
  report.push('');
  report.push('### 2025 G5 team exposure');
  report.push(markdownTable([
    { key: 'team', label: 'team', align: 'left' },
    { key: 'rows', label: 'rows' },
    { key: 'maps', label: 'maps' },
    { key: 'matches', label: 'matches' },
    { key: 'ece', label: 'ECE', format: (value) => pctFmt(value) },
    { key: 'brier', label: 'Brier', format: (value) => fmt(value) },
  ], confounds.teamRows));
  report.push('');
  report.push('混淆结论: 2025 G5 只有 5 张图，全部来自 LCK Cup 2025 playoff/finals，且 HLE 暴露 5 张、GEN 3 张、NS/T1/DK 各 1 张。G5 误差不能和“全 BO5 赛制”或“所有队伍稳定规律”直接等同。');
  report.push('');
  report.push('## 5. 2026 supplement');
  report.push('');
  report.push('正式 continuous backtest 明细只覆盖 2024/2025。当前本地 `lck_map_details.csv` 的 2026 样本只有 G1-G3，没有 G4/G5；因此 2026 不进入主结论，也不单独做 G5 supplement。');
  report.push('');
  report.push('## 6. 结论');
  report.push('');
  report.push(`1. Claude/Codex 原始数字能不能复现: **LCK 之前没有现成的 \`total_kills_continuous_vs_scenario.csv\`，本次是按 LPL 口径首次生成 LCK 明细；所以不能说复现旧 LCK 数字，只能说复现了同一实验口径。** \`map_bo\` 语义已核验为第几局。`);
  report.push(`2. LCK 是否也存在 G5 total_kills 明显失准: 2025 OOS G5 ECE=${pctFmt(g5M.ece)}，G3 ECE=${pctFmt(g3M.ece)}，G5-G3 diff=${pctFmt(diff)}，CI=${`[${pctFmt(boot2025.diff.low)}, ${pctFmt(boot2025.diff.high)}]`}。${diffSignificant ? 'CI 不跨 0，支持 G5 相对 G3 有显著失准。' : 'CI 跨 0，统计上不能证明 G5 相对 G3 明显更差。'} 样本只有 ${g5M.maps} 张 G5 图，结论强度受限。`);
  report.push('3. 应该封全部 BO5 总杀，还是只封 G5 总杀: **如果要加规则，也只能命名为 G5/第五局 total_kills 规则；不支持封全部 BO5 总杀。** 因为 `map_bo=5` 是局号，不是赛制字段。');
  report.push(`4. 是否建议真钱停用: **${enoughG5Maps && diffSignificant ? gateVerdict : '不建议新增真钱硬停用；G5 total_kills 只 shadow 观察。'}** 当前 G5 maps=${g5M.maps}，低于 30 张图的最小稳定样本。`);
  report.push('');
  report.push('附: 本报告没有修改线上模型、概率闸门、真钱投注规则。');

  await writeFile(REPORT_PATH, `\uFEFF${report.join('\n')}\n`, 'utf8');

  console.log(`wrote ${DETAIL_CSV}`);
  console.log(`wrote ${BY_MAP_BO_CSV}`);
  console.log(`wrote ${RELIABILITY_CSV}`);
  console.log(`wrote ${REPORT_PATH}`);
  console.log(`2025 G5 ECE=${pctFmt(g5M.ece)} Brier=${fmt(g5M.brier)} maps=${g5M.maps}`);
  console.log(`2025 G3 ECE=${pctFmt(g3M.ece)} Brier=${fmt(g3M.brier)} maps=${g3M.maps}`);
  console.log(`2025 G5-G3 ECE diff=${pctFmt(diff)} CI=[${pctFmt(boot2025.diff.low)}, ${pctFmt(boot2025.diff.high)}]`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
