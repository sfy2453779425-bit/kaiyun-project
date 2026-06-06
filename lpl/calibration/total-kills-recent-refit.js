import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildProfiles,
} from '../build-market-analysis.js';
import {
  buildSnapshotSummary,
  groupBy,
  isFinishedMatch,
  readHistoryData,
  rowDate,
} from '../backtest/common.js';
import { clamp, num, teamKey, unionColumns, writeCsv } from '../shared.js';
import { totalKillsFeatures } from './total-kills-model-predict.js';

const SEED = 20260603;
const BOOTSTRAP_N = 1000;
const LINES = [27.5, 30.5, 33.5];
const MIN_PRIOR_MAPS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const MODEL_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_model_coef.json');
const CANDIDATE_MODEL_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_recent_candidate_coef.json');
const REPORT_PATH = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '总杀重拟合-vs-当前.md');
const DETAIL_CSV = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'total_kills_refit_vs_current.csv');

const BASE_FEATURE_KEYS = [
  'avg_total_mean',
  'avg_time_mean',
  'strength_abs_diff',
  'strength_signed_diff',
  'recent_abs_diff',
  'avg_kill_diff_sum',
  'first_turret_mean',
];

const META_FEATURE = 'league_recent_total_kills_60';

const VARIANTS = [
  {
    name: 'decay_hl_60_floor_010',
    label: 'Exponential decay half-life 60d, weight floor 0.10',
    halfLifeDays: 60,
    weightFloor: 0.10,
    extraFeatures: [],
  },
  {
    name: 'decay_hl_90_floor_010',
    label: 'Exponential decay half-life 90d, weight floor 0.10',
    halfLifeDays: 90,
    weightFloor: 0.10,
    extraFeatures: [],
  },
  {
    name: 'decay_hl_120_floor_010',
    label: 'Exponential decay half-life 120d, weight floor 0.10',
    halfLifeDays: 120,
    weightFloor: 0.10,
    extraFeatures: [],
  },
  {
    name: 'decay_hl_90_floor_010_meta_60',
    label: 'Half-life 90d plus walk-forward league recent total kills feature',
    halfLifeDays: 90,
    weightFloor: 0.10,
    extraFeatures: [META_FEATURE],
  },
];

function yearOf(value) {
  return String(value || '').slice(0, 4);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function fmt2(value) {
  return fmt(value, 2);
}

function pctFmt(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function seededRandom(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function weightedMean(values, weights) {
  let sw = 0;
  let sx = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const weight = weights[i];
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    sw += weight;
    sx += value * weight;
  }
  return sw > 0 ? sx / sw : NaN;
}

function weightedVariance(values, weights, avgValue = weightedMean(values, weights)) {
  let sw = 0;
  let sx = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const weight = weights[i];
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    sw += weight;
    sx += weight * (value - avgValue) ** 2;
  }
  return sw > 0 ? sx / sw : 0;
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

function markdownTable(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `|${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join('|')}|`;
  const body = rows.map((row) => `| ${columns.map((col) => {
    const value = row[col.key];
    return col.format ? col.format(value) : (value ?? '');
  }).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= div;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function maxDate(rows) {
  return rows.reduce((best, row) => {
    const date = String(row.match_date || '').slice(0, 10);
    return date > best ? date : best;
  }, '');
}

function daysBetween(later, earlier) {
  const a = Date.parse(`${String(later).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(earlier).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (a - b) / DAY_MS);
}

function fitWeight(row, variant, referenceDate) {
  if (!variant.halfLifeDays) return 1;
  const age = daysBetween(referenceDate, row.match_date);
  const decay = 0.5 ** (age / variant.halfLifeDays);
  return Math.max(num(variant.weightFloor, 0), decay);
}

function featureKeysFor(variant) {
  return [...BASE_FEATURE_KEYS, ...(variant.extraFeatures || [])];
}

function loadCurrentModel() {
  if (!existsSync(MODEL_PATH)) throw new Error(`missing current model: ${MODEL_PATH}`);
  return JSON.parse(readFileSync(MODEL_PATH, 'utf8'));
}

function dateMaxBefore(maps, cutoff) {
  let latest = '';
  for (const map of maps) {
    const date = rowDate(map);
    if (date < cutoff && date > latest) latest = date;
  }
  return latest;
}

function leagueRecentTotalKills(maps, cutoff, halfLifeDays = 60) {
  let sw = 0;
  let sx = 0;
  for (const map of maps) {
    const date = rowDate(map);
    if (!date || date >= cutoff) continue;
    const total = num(map.total_kills, NaN);
    if (!Number.isFinite(total)) continue;
    const weight = 0.5 ** (daysBetween(cutoff, date) / halfLifeDays);
    sw += weight;
    sx += weight * total;
  }
  return sw > 0 ? sx / sw : 28;
}

function buildObservations(matches, maps) {
  const eligibleMatches = matches
    .filter(isFinishedMatch)
    .filter((match) => ['2024', '2025', '2026'].includes(yearOf(match.match_date)))
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const snapshotCache = new Map();
  const leagueMetaCache = new Map();
  const rows = [];
  const skipped = { low_sample_matches: 0, missing_profiles: 0, missing_maps: 0 };

  for (const match of eligibleMatches) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    if (!leagueMetaCache.has(cutoff)) leagueMetaCache.set(cutoff, leagueRecentTotalKills(maps, cutoff, 60));
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
      .filter((map) => Number.isFinite(num(map.total_kills, NaN)));
    if (!matchMaps.length) {
      skipped.missing_maps += 1;
      continue;
    }
    const baseFeatures = totalKillsFeatures(a, b);
    const trainMaxDate = dateMaxBefore(maps, cutoff);
    for (const map of matchMaps) {
      rows.push({
        split_year: yearOf(cutoff),
        match_id: match.match_id,
        game_id: map.game_id,
        match_date: cutoff,
        match_name: match.match_name,
        map_bo: num(map.bo),
        total_kills: num(map.total_kills),
        features: {
          ...baseFeatures,
          [META_FEATURE]: leagueMetaCache.get(cutoff),
          patch: map.patch || baseFeatures.patch || '',
        },
        train_max_date: trainMaxDate,
        feature_latest_date: trainMaxDate,
      });
    }
  }

  return { rows, skipped };
}

function fitScaler(rows, featureKeys, weights) {
  const scaler = {};
  for (const key of featureKeys) {
    const values = rows.map((row) => num(row.features[key], NaN));
    const m = weightedMean(values, weights);
    scaler[key] = {
      mean: Number.isFinite(m) ? m : 0,
      sd: Math.sqrt(weightedVariance(values, weights, m)) || 1,
    };
  }
  return scaler;
}

function scaledFeature(row, key, scaler) {
  const s = scaler[key] || { mean: 0, sd: 1 };
  return (num(row.features[key], 0) - num(s.mean, 0)) / Math.max(num(s.sd, 1), 0.000001);
}

function designVector(row, scaler, patchParams, featureKeys) {
  return [
    1,
    ...featureKeys.map((key) => scaledFeature(row, key, scaler)),
    ...patchParams.map((patch) => row.features.patch === patch ? 1 : 0),
  ];
}

function modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, featureKeys, variant, fitMeta) {
  const beta = {};
  featureKeys.forEach((key, index) => { beta[key] = betaVector[index + 1]; });
  const patchGamma = { [baselinePatch]: 0 };
  patchParams.forEach((patch, index) => { patchGamma[patch] = betaVector[1 + featureKeys.length + index]; });
  return {
    model: 'total_kills_continuous_normal_v1',
    formula: 'total_kills = intercept + standardized profile features + patch fixed effect; probability via Normal(mean, sigma)',
    fit_year: fitMeta.fit_year,
    features: featureKeys,
    refit_method: 'recent_weighted_refit_v1',
    refit_variant: variant.name,
    refit_label: variant.label,
    half_life_days: variant.halfLifeDays,
    weight_floor: variant.weightFloor,
    intercept: betaVector[0],
    beta,
    scaler,
    baseline_patch: baselinePatch,
    patch_gamma: patchGamma,
    sigma,
    deploy: false,
    training: fitMeta,
  };
}

function predictMean(row, model) {
  let out = num(model.intercept, 28);
  for (const key of model.features || []) {
    const s = model.scaler?.[key] || { mean: 0, sd: 1 };
    out += ((num(row.features[key], 0) - num(s.mean, 0)) / Math.max(num(s.sd, 1), 0.000001)) * num(model.beta?.[key], 0);
  }
  out += num(model.patch_gamma?.[row.features.patch], 0);
  return clamp(out, 8, 65);
}

function continuousProbability(row, line, selection, model) {
  const sigma = Math.max(num(model.sigma, 7), 0.000001);
  const z = (num(line) - predictMean(row, model)) / sigma;
  const under = clamp(normalCdf(z), 0.000001, 0.999999);
  return selection === 'under' ? under : 1 - under;
}

function weightedTrainingBrier(rows, model, variant, referenceDate) {
  let sw = 0;
  let loss = 0;
  for (const row of rows) {
    const weight = fitWeight(row, variant, referenceDate);
    for (const line of LINES) {
      for (const selection of ['over', 'under']) {
        const p = continuousProbability(row, line, selection, model);
        const y = selection === 'over' ? (row.total_kills > line ? 1 : 0) : (row.total_kills < line ? 1 : 0);
        sw += weight;
        loss += weight * (p - y) ** 2;
      }
    }
  }
  return sw > 0 ? loss / sw : Infinity;
}

function fitSigma(rows, model, variant, referenceDate, fallback) {
  let best = { sigma: clamp(fallback, 3, 14), brier: Infinity };
  for (let i = 30; i <= 140; i += 5) {
    const sigma = i / 10;
    const candidate = { ...model, sigma };
    const brier = weightedTrainingBrier(rows, candidate, variant, referenceDate);
    if (brier < best.brier) best = { sigma, brier };
  }
  return best.sigma;
}

function fitRidge(rows, variant, referenceDate, fitLabel) {
  if (rows.length < 100) throw new Error(`not enough training rows for ${variant.name}: ${rows.length}`);
  const featureKeys = featureKeysFor(variant);
  const weights = rows.map((row) => fitWeight(row, variant, referenceDate));
  const scaler = fitScaler(rows, featureKeys, weights);
  const patchCounts = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const patch = rows[i].features.patch;
    patchCounts.set(patch, (patchCounts.get(patch) || 0) + weights[i]);
  }
  const patches = [...patchCounts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([patch]) => patch);
  const baselinePatch = patches[0] || '';
  const patchParams = patches.filter((patch) => patch !== baselinePatch);
  const vectors = rows.map((row) => designVector(row, scaler, patchParams, featureKeys));
  const p = vectors[0]?.length || 0;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);

  for (let i = 0; i < rows.length; i += 1) {
    const x = vectors[i];
    const y = num(rows[i].total_kills);
    const weight = weights[i];
    for (let a = 0; a < p; a += 1) {
      xty[a] += weight * x[a] * y;
      for (let b = 0; b < p; b += 1) xtx[a][b] += weight * x[a] * x[b];
    }
  }

  const lambda = 0.4;
  const patchLambda = 0.8;
  for (let i = 1; i < p; i += 1) {
    xtx[i][i] += i <= featureKeys.length ? lambda : patchLambda;
  }
  const betaVector = solveLinearSystem(xtx, xty);
  if (!betaVector) throw new Error(`ridge solve failed for ${variant.name}`);
  const fitMeta = {
    fit_year: fitLabel,
    reference_date: referenceDate,
    train_rows: rows.length,
    effective_weight: weights.reduce((sum, value) => sum + value, 0),
    train_start: rows.reduce((best, row) => !best || row.match_date < best ? row.match_date : best, ''),
    train_end: maxDate(rows),
  };
  const partialModel = modelFromVector(betaVector, scaler, baselinePatch, patchParams, NaN, featureKeys, variant, fitMeta);
  const residuals = rows.map((row, index) => weights[index] * (num(row.total_kills) - predictMean(row, partialModel)) ** 2);
  const rawSigma = Math.sqrt(residuals.reduce((sum, value) => sum + value, 0) / Math.max(weights.reduce((sum, value) => sum + value, 0), 1)) || 7;
  const sigma = fitSigma(rows, partialModel, variant, referenceDate, rawSigma);
  return modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, featureKeys, variant, fitMeta);
}

function scoreComparison(rows, oldModel, newModel, source) {
  const out = [];
  for (const row of rows) {
    const oldMean = predictMean(row, oldModel);
    const newMean = predictMean(row, newModel);
    for (const line of LINES) {
      for (const selection of ['over', 'under']) {
        out.push({
          split_year: row.split_year,
          match_id: row.match_id,
          game_id: row.game_id,
          match_date: row.match_date,
          match_name: row.match_name,
          map_bo: row.map_bo,
          line,
          selection,
          total_kills: row.total_kills,
          outcome: selection === 'over' ? (row.total_kills > line ? 1 : 0) : (row.total_kills < line ? 1 : 0),
          p_old: continuousProbability(row, line, selection, oldModel),
          p_new: continuousProbability(row, line, selection, newModel),
          old_mean: oldMean,
          new_mean: newMean,
          old_residual: row.total_kills - oldMean,
          new_residual: row.total_kills - newMean,
          sigma_old: oldModel.sigma,
          sigma_new: newModel.sigma,
          patch: row.features.patch,
          league_recent_total_kills_60: row.features[META_FEATURE],
          train_max_date: row.train_max_date,
          feature_latest_date: row.feature_latest_date,
          model_source: source,
        });
      }
    }
  }
  return out;
}

function scoreRollingYear(observations, oldModel, variant, targetYear) {
  const targetRows = observations.filter((row) => row.split_year === targetYear);
  const byDate = groupBy(targetRows, (row) => row.match_date);
  const scored = [];
  const fitSummaries = [];
  for (const [date, rows] of [...byDate.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const trainRows = observations.filter((row) => row.match_date < date && ['2024', '2025', '2026'].includes(row.split_year));
    const model = fitRidge(trainRows, variant, date, `rolling_before_${date}`);
    scored.push(...scoreComparison(rows, oldModel, model, `rolling_before_${date}`));
    fitSummaries.push({
      date,
      train_rows: model.training.train_rows,
      effective_weight: model.training.effective_weight,
      train_start: model.training.train_start,
      train_end: model.training.train_end,
      sigma: model.sigma,
    });
  }
  return { scored, fitSummaries };
}

function uniqueMapsFromLineRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.match_id}|${row.game_id}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function lineBrier(rows, pKey) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => sum + (num(row[pKey]) - num(row.outcome)) ** 2, 0) / rows.length;
}

function ece(rows, pKey, buckets = 10) {
  if (!rows.length) return NaN;
  let total = 0;
  for (let i = 0; i < buckets; i += 1) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const bucket = rows.filter((row) => {
      const p = num(row[pKey]);
      return i === buckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
    });
    if (!bucket.length) continue;
    total += (bucket.length / rows.length) * Math.abs(mean(bucket.map((row) => num(row[pKey]))) - mean(bucket.map((row) => num(row.outcome))));
  }
  return total;
}

function metricRow(label, rows) {
  const mapRows = uniqueMapsFromLineRows(rows);
  return {
    label,
    n_lines: rows.length,
    n_maps: mapRows.length,
    brier_old: lineBrier(rows, 'p_old'),
    brier_new: lineBrier(rows, 'p_new'),
    brier_delta: lineBrier(rows, 'p_new') - lineBrier(rows, 'p_old'),
    ece_old: ece(rows, 'p_old'),
    ece_new: ece(rows, 'p_new'),
    ece_delta: ece(rows, 'p_new') - ece(rows, 'p_old'),
    bias_old: mean(mapRows.map((row) => num(row.old_residual))),
    bias_new: mean(mapRows.map((row) => num(row.new_residual))),
    mean_actual: mean(mapRows.map((row) => num(row.total_kills))),
    mean_old: mean(mapRows.map((row) => num(row.old_mean))),
    mean_new: mean(mapRows.map((row) => num(row.new_mean))),
  };
}

function clusterBootstrapBrierDelta(rows, iterations = BOOTSTRAP_N, seed = SEED) {
  const groups = [...groupBy(rows, (row) => row.match_id).values()];
  const random = seededRandom(seed);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < groups.length; j += 1) {
      sample.push(...groups[Math.floor(random() * groups.length)]);
    }
    deltas.push(lineBrier(sample, 'p_new') - lineBrier(sample, 'p_old'));
  }
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975),
  };
}

function gateDecision(metric2025, metric2026, combinedMetric, combinedCi) {
  const gate2025 = metric2025.ece_new <= 0.02;
  const gate2026Bias = Math.abs(metric2026.bias_new) < 0.4 && Math.abs(metric2026.bias_new) < Math.abs(metric2026.bias_old);
  const gate2026Ece = metric2026.ece_new <= metric2026.ece_old - 0.005;
  const gateBrier = combinedCi.high <= 0;
  return {
    gate2025,
    gate2026Bias,
    gate2026Ece,
    gateBrier,
    deploy: gate2025 && gate2026Bias && gate2026Ece && gateBrier && combinedMetric.brier_delta <= 0,
  };
}

function evaluateVariant(observations, oldModel, variant) {
  const fit2024Rows = observations.filter((row) => row.split_year === '2024');
  const eval2025Rows = observations.filter((row) => row.split_year === '2025');
  const modelFor2025 = fitRidge(fit2024Rows, variant, maxDate(fit2024Rows), '2024_static_for_2025_oos');
  const scored2025 = scoreComparison(eval2025Rows, oldModel, modelFor2025, '2024_static_for_2025_oos');
  const rolling2026 = scoreRollingYear(observations, oldModel, variant, '2026');
  const combined = [...scored2025, ...rolling2026.scored];
  const metric2025 = metricRow('2025 OOS', scored2025);
  const metric2026 = metricRow('2026 rolling OOS', rolling2026.scored);
  const combinedMetric = metricRow('2025+2026 OOS', combined);
  const combinedCi = clusterBootstrapBrierDelta(combined);
  const decision = gateDecision(metric2025, metric2026, combinedMetric, combinedCi);
  return {
    variant,
    modelFor2025,
    scored: combined,
    scored2025,
    scored2026: rolling2026.scored,
    rollingFitSummaries: rolling2026.fitSummaries,
    metric2025,
    metric2026,
    combinedMetric,
    combinedCi,
    decision,
  };
}

function pickBest(evaluations) {
  return [...evaluations].sort((a, b) => {
    if (a.decision.deploy !== b.decision.deploy) return a.decision.deploy ? -1 : 1;
    const aPasses = Object.entries(a.decision).filter(([key, value]) => key.startsWith('gate') && value).length;
    const bPasses = Object.entries(b.decision).filter(([key, value]) => key.startsWith('gate') && value).length;
    if (aPasses !== bPasses) return bPasses - aPasses;
    return a.combinedMetric.brier_delta - b.combinedMetric.brier_delta
      || Math.abs(a.metric2026.bias_new) - Math.abs(b.metric2026.bias_new)
      || a.metric2026.ece_new - b.metric2026.ece_new;
  })[0];
}

function validationObject(best, finalModel, landed) {
  return {
    refit_report: path.relative(process.cwd(), REPORT_PATH).replaceAll(path.sep, '/'),
    detail_csv: path.relative(process.cwd(), DETAIL_CSV).replaceAll(path.sep, '/'),
    selected_variant: best.variant.name,
    landed,
    gates: best.decision,
    metrics: {
      oos_2025: best.metric2025,
      oos_2026: best.metric2026,
      oos_2025_2026: best.combinedMetric,
      brier_delta_ci95_2025_2026_cluster_match: best.combinedCi,
    },
    final_training: finalModel.training,
    bootstrap: {
      iterations: BOOTSTRAP_N,
      seed: SEED,
      cluster: 'match_id',
    },
  };
}

function coefficientRows(model) {
  return [
    { key: 'intercept', value: model.intercept },
    ...(model.features || []).map((key) => ({ key, value: model.beta?.[key] })),
    { key: 'sigma', value: model.sigma },
  ];
}

function evaluationRows(evaluations) {
  return evaluations.map((ev) => ({
    variant: ev.variant.name,
    ece25_old: ev.metric2025.ece_old,
    ece25_new: ev.metric2025.ece_new,
    brier25_delta: ev.metric2025.brier_delta,
    bias26_old: ev.metric2026.bias_old,
    bias26_new: ev.metric2026.bias_new,
    ece26_old: ev.metric2026.ece_old,
    ece26_new: ev.metric2026.ece_new,
    brier26_delta: ev.metric2026.brier_delta,
    combined_delta: ev.combinedMetric.brier_delta,
    ci_low: ev.combinedCi.low,
    ci_high: ev.combinedCi.high,
    gates: [
      ev.decision.gate2025 ? '25ECE' : '',
      ev.decision.gate2026Bias ? '26BIAS' : '',
      ev.decision.gate2026Ece ? '26ECE' : '',
      ev.decision.gateBrier ? 'BRIER' : '',
    ].filter(Boolean).join('+') || 'FAIL',
    deploy: ev.decision.deploy ? 'YES' : 'NO',
  }));
}

function spotCheckRows(observations) {
  return observations
    .filter((row) => ['2025', '2026'].includes(row.split_year))
    .slice(0, 5)
    .map((row) => {
      const featureDates = Object.fromEntries([...BASE_FEATURE_KEYS, META_FEATURE].map((key) => [key, row.feature_latest_date]));
      return {
        match_date: row.match_date,
        match_name: row.match_name,
        game_id: row.game_id,
        latest_avg_total: featureDates.avg_total_mean,
        latest_avg_time: featureDates.avg_time_mean,
        latest_strength: featureDates.strength_abs_diff,
        latest_recent_form: featureDates.recent_abs_diff,
        latest_meta: featureDates[META_FEATURE],
        ok: Object.values(featureDates).every((date) => date < row.match_date) ? 'PASS' : 'FAIL',
      };
    });
}

async function writeDetailCsv(scored) {
  const rows = scored.map((row) => ({
    split_year: row.split_year,
    match_id: row.match_id,
    game_id: row.game_id,
    match_date: row.match_date,
    match_name: row.match_name,
    map_bo: row.map_bo,
    line: row.line,
    selection: row.selection,
    total_kills: row.total_kills,
    outcome: row.outcome,
    p_old: fmt(row.p_old),
    p_new: fmt(row.p_new),
    old_mean: fmt(row.old_mean),
    new_mean: fmt(row.new_mean),
    old_residual: fmt(row.old_residual),
    new_residual: fmt(row.new_residual),
    sigma_old: fmt(row.sigma_old),
    sigma_new: fmt(row.sigma_new),
    patch: row.patch,
    league_recent_total_kills_60: fmt(row.league_recent_total_kills_60),
    train_max_date: row.train_max_date,
    feature_latest_date: row.feature_latest_date,
    model_source: row.model_source,
  }));
  await mkdir(path.dirname(DETAIL_CSV), { recursive: true });
  await writeCsv(DETAIL_CSV, rows, unionColumns(rows));
}

async function writeReport({
  observations,
  skipped,
  oldModel,
  evaluations,
  best,
  finalModel,
  landed,
}) {
  const rowsByYear = ['2024', '2025', '2026'].map((year) => ({
    year,
    maps: observations.filter((row) => row.split_year === year).length,
  }));
  const finalValidation = validationObject(best, finalModel, landed);
  const selectedRows = [
    { ...best.metric2025, label: '2025 OOS / 2025 样本外' },
    { ...best.metric2026, label: '2026 rolling OOS / 2026 滚动样本外' },
    { ...best.combinedMetric, label: '2025+2026 OOS / 2025+2026 合并样本外' },
  ];

  const lines = [
    '# 总杀重拟合 vs 当前 / Total Kills Refit vs Current',
    '',
    `- Generated / 生成时间: ${new Date().toISOString()}`,
    `- Current model / 当前模型: \`${oldModel.model || 'unknown'}\`, deploy=${oldModel.deploy}, generated_at=${oldModel.generated_at || ''}.`,
    `- Candidate detail CSV / 候选明细: \`${path.relative(process.cwd(), DETAIL_CSV).replaceAll(path.sep, '/')}\`.`,
    `- Candidate coef / 候选系数: \`${path.relative(process.cwd(), CANDIDATE_MODEL_PATH).replaceAll(path.sep, '/')}\`.`,
    `- Online coef / 线上系数: \`${path.relative(process.cwd(), MODEL_PATH).replaceAll(path.sep, '/')}\`.`,
    `- Skipped / 跳过: low_sample_matches=${skipped.low_sample_matches}, missing_profiles=${skipped.missing_profiles}, missing_maps=${skipped.missing_maps}.`,
    '',
    '## Verdict / 最终判定',
    '',
    landed
      ? '- **DEPLOYED / 已落地**: selected candidate passed every hard gate and replaced `total_kills_model_coef.json`.'
      : '- **NOT DEPLOYED / 不落地**: at least one hard gate failed, so the current deployed coefficient file was preserved.',
    `- Selected variant / 选中方案: **${best.variant.name}** (${best.variant.label}).`,
    `- 2025 ECE gate / 2025 ECE 闸门: ${pctFmt(best.metric2025.ece_new)} <= 2.0% -> **${best.decision.gate2025 ? 'PASS' : 'FAIL'}**.`,
    `- 2026 bias gate / 2026 bias 闸门: old=${fmt2(best.metric2026.bias_old)}, new=${fmt2(best.metric2026.bias_new)}, |new|<0.40 -> **${best.decision.gate2026Bias ? 'PASS' : 'FAIL'}**.`,
    `- 2026 ECE gate / 2026 ECE 改善: old=${pctFmt(best.metric2026.ece_old)}, new=${pctFmt(best.metric2026.ece_new)} -> **${best.decision.gate2026Ece ? 'PASS' : 'FAIL'}**.`,
    `- 2025+2026 Brier delta CI / Brier 差值 CI: [${fmt(best.combinedCi.low)}, ${fmt(best.combinedCi.high)}] -> **${best.decision.gateBrier ? 'PASS' : 'FAIL'}**.`,
    '',
    '## Data / 数据范围',
    '',
    markdownTable([
      { key: 'year', label: 'year / 年份', align: 'left' },
      { key: 'maps', label: 'eligible maps / 合格地图' },
    ], rowsByYear),
    '',
    '## Candidate Search / 候选方案搜索',
    '',
    markdownTable([
      { key: 'variant', label: 'variant / 方案', align: 'left' },
      { key: 'ece25_old', label: '25 old ECE', format: pctFmt },
      { key: 'ece25_new', label: '25 new ECE', format: pctFmt },
      { key: 'brier25_delta', label: '25 Brier delta', format: fmt },
      { key: 'bias26_old', label: '26 old bias', format: fmt2 },
      { key: 'bias26_new', label: '26 new bias', format: fmt2 },
      { key: 'ece26_old', label: '26 old ECE', format: pctFmt },
      { key: 'ece26_new', label: '26 new ECE', format: pctFmt },
      { key: 'brier26_delta', label: '26 Brier delta', format: fmt },
      { key: 'combined_delta', label: '25+26 delta', format: fmt },
      { key: 'ci_low', label: 'CI low', format: fmt },
      { key: 'ci_high', label: 'CI high', format: fmt },
      { key: 'gates', label: 'passed gates / 通过项', align: 'left' },
      { key: 'deploy', label: 'deploy' },
    ], evaluationRows(evaluations)),
    '',
    '## Selected New vs Current / 选中方案新旧对比',
    '',
    markdownTable([
      { key: 'label', label: 'segment / 分段', align: 'left' },
      { key: 'n_maps', label: 'maps' },
      { key: 'n_lines', label: 'lines' },
      { key: 'brier_old', label: 'old Brier', format: fmt },
      { key: 'brier_new', label: 'new Brier', format: fmt },
      { key: 'brier_delta', label: 'new-old', format: fmt },
      { key: 'ece_old', label: 'old ECE', format: pctFmt },
      { key: 'ece_new', label: 'new ECE', format: pctFmt },
      { key: 'bias_old', label: 'old bias', format: fmt2 },
      { key: 'bias_new', label: 'new bias', format: fmt2 },
      { key: 'mean_actual', label: 'actual', format: fmt2 },
      { key: 'mean_old', label: 'old mean', format: fmt2 },
      { key: 'mean_new', label: 'new mean', format: fmt2 },
    ], selectedRows),
    '',
    '## Bootstrap / Bootstrap 闸门',
    '',
    `- Iterations / 次数: ${BOOTSTRAP_N}, seed=${SEED}, cluster=\`match_id\`.`,
    `- Brier delta = new - old. CI upper must be <= 0 / Brier 差值 = 新 - 旧, 95% CI 上界必须 <= 0.`,
    `- Selected CI / 选中方案 CI: **[${fmt(best.combinedCi.low)}, ${fmt(best.combinedCi.high)}]**.`,
    '',
    '## Walk-forward Leakage Audit / 前视泄漏自检',
    '',
    'Every profile/meta feature below was built from maps strictly before the target map date. Patch is a known schedule/meta field, not an outcome statistic. / 下列 profile/meta 特征均只依赖目标比赛日前的地图。patch 是赛程/版本字段, 不是赛果统计。',
    '',
    markdownTable([
      { key: 'match_date', label: 'match date' },
      { key: 'match_name', label: 'match', align: 'left' },
      { key: 'game_id', label: 'game_id' },
      { key: 'latest_avg_total', label: 'avg_total latest' },
      { key: 'latest_avg_time', label: 'avg_time latest' },
      { key: 'latest_strength', label: 'strength latest' },
      { key: 'latest_recent_form', label: 'recent latest' },
      { key: 'latest_meta', label: 'meta latest' },
      { key: 'ok', label: 'ok' },
    ], spotCheckRows(observations)),
    '',
    '## Final Coefficients / 最终候选系数',
    '',
    markdownTable([
      { key: 'key', label: 'feature / 特征', align: 'left' },
      { key: 'value', label: 'value', format: fmt },
    ], coefficientRows(finalModel)),
    '',
    '## G5 Note / 第五局备注',
    '',
    '- This refit does not unlock G5 total-kills real-money betting. The existing G5 paper-only gate remains unchanged. / 本次重拟合不自动解除 G5 总杀真钱封禁, 现有 G5 纸面闸门保持不变。',
    '',
    '## Validation JSON / 验证元数据',
    '',
    '```json',
    JSON.stringify(finalValidation, null, 2),
    '```',
    '',
  ];

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const oldModel = loadCurrentModel();
  const { matches, maps } = await readHistoryData();
  const { rows: observations, skipped } = buildObservations(matches, maps);
  const years = new Set(observations.map((row) => row.split_year));
  for (const year of ['2024', '2025', '2026']) {
    if (!years.has(year)) throw new Error(`missing observations for ${year}`);
  }

  const evaluations = [];
  for (const variant of VARIANTS) {
    evaluations.push(evaluateVariant(observations, oldModel, variant));
  }
  const best = pickBest(evaluations);
  const finalTrainRows = observations.filter((row) => ['2024', '2025', '2026'].includes(row.split_year));
  const finalModel = fitRidge(finalTrainRows, best.variant, maxDate(finalTrainRows), '2024_2025_2026_final');
  finalModel.deploy = best.decision.deploy;
  finalModel.generated_at = new Date().toISOString();
  finalModel.seed = SEED;
  finalModel.validation = validationObject(best, finalModel, best.decision.deploy);

  await mkdir(path.dirname(CANDIDATE_MODEL_PATH), { recursive: true });
  await writeFile(CANDIDATE_MODEL_PATH, `${JSON.stringify(finalModel, null, 2)}\n`, 'utf8');

  let landed = false;
  if (best.decision.deploy) {
    finalModel.deploy = true;
    finalModel.validation.landed = true;
    await writeFile(MODEL_PATH, `${JSON.stringify(finalModel, null, 2)}\n`, 'utf8');
    landed = true;
  }

  await writeDetailCsv(best.scored);
  await writeReport({ observations, skipped, oldModel, evaluations, best, finalModel, landed });

  console.log(`wrote ${REPORT_PATH}`);
  console.log(`wrote ${DETAIL_CSV}`);
  console.log(`wrote ${CANDIDATE_MODEL_PATH}`);
  console.log(`selected=${best.variant.name} deploy=${landed}`);
  console.log(`2025_ECE_new=${pctFmt(best.metric2025.ece_new)} 2026_bias_old=${fmt2(best.metric2026.bias_old)} 2026_bias_new=${fmt2(best.metric2026.bias_new)} 2026_ECE_old=${pctFmt(best.metric2026.ece_old)} 2026_ECE_new=${pctFmt(best.metric2026.ece_new)} brier_CI=[${fmt(best.combinedCi.low)}, ${fmt(best.combinedCi.high)}]`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
