import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildProfiles,
  classifyScenario,
  scenarioTotalKillsProbability,
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

const SEED = 20260601;
const BOOTSTRAP_N = 1000;
const LINES = [27.5, 30.5, 33.5];
const MIN_PRIOR_MAPS = 8;
const MODEL_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_model_coef.json');
const CANDIDATE_MODEL_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_low_kill_candidate_coef.json');
const REPORT_PATH = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '总杀模型-低杀特征.md');
const DETAIL_CSV = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'total_kills_continuous_vs_scenario.csv');

const BASE_FEATURE_KEYS = [
  'avg_total_mean',
  'avg_time_mean',
  'strength_abs_diff',
  'strength_signed_diff',
  'recent_abs_diff',
  'avg_kill_diff_sum',
  'first_turret_mean',
];

const FEATURE_SETS = [
  {
    name: 'nonlinear_diff',
    description: 'nonlinear strength gap: strength_abs_diff_sq',
    extra: ['strength_abs_diff_sq'],
  },
  {
    name: 'blowout_flag',
    description: 'bloodbath tier indicator: blowout_p80_flag',
    extra: ['blowout_p80_flag'],
  },
  {
    name: 'fast_finish',
    description: 'strength gap x fast-finish tendency',
    extra: ['short_game_rate_mean', 'fast_finish_pressure', 'strength_abs_diff_x_avg_time_mean'],
  },
  {
    name: 'weak_kill_compression',
    description: 'weak-side kill compression proxy and FT interaction',
    extra: ['underdog_expected_kills_proxy', 'underdog_kill_compression', 'first_turret_strength_interaction'],
  },
  {
    name: 'low_kill_combo',
    description: 'compact combo of nonlinear gap + fast finish + weak kill compression',
    extra: ['strength_abs_diff_sq', 'blowout_p80_flag', 'fast_finish_pressure', 'underdog_kill_compression'],
  },
];

function yearOf(value) {
  return String(value || '').slice(0, 4);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function fmt1(value) {
  return fmt(value, 1);
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

function variance(values, avgValue = mean(values)) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return 0;
  return clean.reduce((sum, value) => sum + (value - avgValue) ** 2, 0) / (clean.length - 1);
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
  const body = rows.map((row) => `| ${columns.map((col) => col.format ? col.format(row[col.key]) : (row[col.key] ?? '')).join(' | ')} |`);
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

function addDerivedFeatures(features, params = {}) {
  const out = { ...features };
  const strengthAbsDiff = num(out.strength_abs_diff, 0);
  out.strength_abs_diff_sq = strengthAbsDiff ** 2;
  out.strength_abs_diff_x_avg_time_mean = strengthAbsDiff * num(out.avg_time_mean, 32);
  out.short_game_rate_mean = num(out.short_game_rate_mean, 0.5);
  out.fast_finish_pressure = strengthAbsDiff * out.short_game_rate_mean;
  out.underdog_expected_kills_proxy = num(out.underdog_expected_kills_proxy, 13);
  out.underdog_kill_compression = Math.max(0, 13 - out.underdog_expected_kills_proxy) * strengthAbsDiff;
  out.first_turret_strength_interaction = num(out.first_turret_mean, 0.5) * strengthAbsDiff;
  out.blowout_p80_flag = strengthAbsDiff >= num(params.strength_abs_diff_p80, Infinity) ? 1 : 0;
  return out;
}

function featureKeysFor(set) {
  return [...BASE_FEATURE_KEYS, ...set.extra];
}

function fitFeatureParams(rows) {
  return {
    strength_abs_diff_p80: percentile(rows.map((row) => num(row.features.strength_abs_diff, NaN)), 0.8),
  };
}

function buildObservations(matches, maps) {
  const eligibleMatches = matches
    .filter(isFinishedMatch)
    .filter((match) => ['2024', '2025'].includes(yearOf(match.match_date)))
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const snapshotCache = new Map();
  const rows = [];
  const skipped = { low_sample_matches: 0, missing_profiles: 0, missing_maps: 0 };

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
      .filter((map) => Number.isFinite(num(map.total_kills, NaN)));
    if (!matchMaps.length) {
      skipped.missing_maps += 1;
      continue;
    }
    const scenario = classifyScenario(a, b);
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
        profile_a: a,
        profile_b: b,
        scenario_probs: scenario.scenario_probs,
        features: {
          ...baseFeatures,
          patch: map.patch || baseFeatures.patch || '',
        },
        train_max_date: trainMaxDate,
        feature_latest_date: trainMaxDate,
      });
    }
  }

  return { rows, skipped };
}

function fitScaler(rows, featureKeys) {
  const scaler = {};
  for (const key of featureKeys) {
    const values = rows.map((row) => num(row.features[key], NaN)).filter(Number.isFinite);
    const m = mean(values) || 0;
    scaler[key] = {
      mean: m,
      sd: Math.sqrt(variance(values, m)) || 1,
    };
  }
  return scaler;
}

function scaledFeature(row, key, scaler) {
  const s = scaler[key] || { mean: 0, sd: 1 };
  return (num(row.features[key], 0) - s.mean) / Math.max(s.sd, 0.000001);
}

function designVector(row, scaler, patchParams, featureKeys) {
  return [
    1,
    ...featureKeys.map((key) => scaledFeature(row, key, scaler)),
    ...patchParams.map((patch) => row.features.patch === patch ? 1 : 0),
  ];
}

function modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, deploy, featureKeys, featureParams, variant) {
  const beta = {};
  featureKeys.forEach((key, index) => { beta[key] = betaVector[index + 1]; });
  const patchGamma = { [baselinePatch]: 0 };
  patchParams.forEach((patch, index) => { patchGamma[patch] = betaVector[1 + featureKeys.length + index]; });
  return {
    model: 'total_kills_continuous_normal_low_kill_v2',
    formula: 'total_kills = intercept + standardized profile features + low-kill collapse features + patch fixed effect; probability via Normal(mean, sigma)',
    fit_year: 2024,
    features: featureKeys,
    low_kill_feature_variant: variant.name,
    low_kill_feature_description: variant.description,
    feature_params: featureParams,
    intercept: betaVector[0],
    beta,
    scaler,
    baseline_patch: baselinePatch,
    patch_gamma: patchGamma,
    sigma,
    deploy,
  };
}

function predictMean(row, model) {
  const features = addDerivedFeatures(row.features, model.feature_params || {});
  let out = num(model.intercept, 28);
  for (const key of model.features || []) {
    const s = model.scaler?.[key] || { mean: 0, sd: 1 };
    out += ((num(features[key], 0) - num(s.mean, 0)) / Math.max(num(s.sd, 1), 0.000001)) * num(model.beta?.[key], 0);
  }
  out += num(model.patch_gamma?.[features.patch], 0);
  return clamp(out, 8, 65);
}

function fitSigma(rows, model, fallback) {
  let best = { sigma: clamp(fallback, 3, 14), brier: Infinity };
  for (let i = 30; i <= 140; i += 1) {
    const sigma = i / 10;
    const candidate = { ...model, sigma };
    const scored = scoreLineRows(rows, candidate, 'p_new');
    const b = lineBrier(scored, 'p_new');
    if (b < best.brier) best = { sigma, brier: b };
  }
  return best.sigma;
}

function fitRidge(rows, variant, { lambda = 0.4, patchLambda = 0.8 } = {}) {
  const featureParams = fitFeatureParams(rows);
  const prepared = rows.map((row) => ({ ...row, features: addDerivedFeatures(row.features, featureParams) }));
  const featureKeys = featureKeysFor(variant);
  const scaler = fitScaler(prepared, featureKeys);
  const patchCounts = new Map();
  for (const row of prepared) patchCounts.set(row.features.patch, (patchCounts.get(row.features.patch) || 0) + 1);
  const patches = [...patchCounts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([patch]) => patch);
  const baselinePatch = patches[0] || '';
  const patchParams = patches.filter((patch) => patch !== baselinePatch);
  const vectors = prepared.map((row) => designVector(row, scaler, patchParams, featureKeys));
  const p = vectors[0]?.length || 0;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);
  for (let i = 0; i < prepared.length; i += 1) {
    const x = vectors[i];
    const y = num(prepared[i].total_kills);
    for (let a = 0; a < p; a += 1) {
      xty[a] += x[a] * y;
      for (let b = 0; b < p; b += 1) xtx[a][b] += x[a] * x[b];
    }
  }
  for (let i = 1; i < p; i += 1) {
    xtx[i][i] += i <= featureKeys.length ? lambda : patchLambda;
  }
  const betaVector = solveLinearSystem(xtx, xty);
  if (!betaVector) throw new Error(`ridge solve failed for ${variant.name}`);
  const partialModel = modelFromVector(betaVector, scaler, baselinePatch, patchParams, NaN, false, featureKeys, featureParams, variant);
  const rawSigma = Math.sqrt(mean(prepared.map((row) => (num(row.total_kills) - predictMean(row, partialModel)) ** 2))) || 7;
  const sigma = fitSigma(prepared, partialModel, rawSigma);
  return modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, false, featureKeys, featureParams, variant);
}

function continuousProbability(row, line, selection, model) {
  const z = (num(line) - predictMean(row, model)) / Math.max(num(model.sigma, 7), 0.000001);
  const under = clamp(normalCdf(z), 0.000001, 0.999999);
  return selection === 'under' ? under : 1 - under;
}

function scoreLineRows(observations, model, pKey = 'p_model') {
  const out = [];
  for (const row of observations) {
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
          [pKey]: continuousProbability(row, line, selection, model),
          mean_model: predictMean(row, model),
          sigma_model: model.sigma,
        });
      }
    }
  }
  return out;
}

function scoreComparison(observations, oldModel, newModel) {
  const out = [];
  for (const row of observations) {
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
          p_scenario: scenarioTotalKillsProbability(row.profile_a, row.profile_b, line, selection, row.scenario_probs),
          old_mean: oldMean,
          new_mean: newMean,
          old_residual: row.total_kills - oldMean,
          new_residual: row.total_kills - newMean,
          patch: row.features.patch,
          train_max_date: row.train_max_date,
          feature_latest_date: row.feature_latest_date,
          ...addDerivedFeatures(row.features, newModel.feature_params || {}),
        });
      }
    }
  }
  return out;
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

function calibrationGap(rows, pKey) {
  if (!rows.length) return NaN;
  return mean(rows.map((row) => num(row[pKey]) - num(row.outcome)));
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

function metricRow(label, rows, pOld = 'p_old', pNew = 'p_new') {
  const mapRows = uniqueMapsFromLineRows(rows);
  return {
    label,
    n_lines: rows.length,
    n_maps: mapRows.length,
    brier_old: lineBrier(rows, pOld),
    brier_new: lineBrier(rows, pNew),
    delta: lineBrier(rows, pNew) - lineBrier(rows, pOld),
    ece_old: ece(rows, pOld),
    ece_new: ece(rows, pNew),
    calibration_gap_old: calibrationGap(rows, pOld),
    calibration_gap_new: calibrationGap(rows, pNew),
    residual_old_mean: mean(mapRows.map((row) => num(row.old_residual))),
    residual_new_mean: mean(mapRows.map((row) => num(row.new_residual))),
    residual_improvement: mean(mapRows.map((row) => Math.abs(num(row.old_residual)) - Math.abs(num(row.new_residual)))),
    mean_actual: mean(mapRows.map((row) => num(row.total_kills))),
    mean_old: mean(mapRows.map((row) => num(row.old_mean))),
    mean_new: mean(mapRows.map((row) => num(row.new_mean))),
  };
}

function bootstrapDelta(rows, pOld = 'p_old', pNew = 'p_new', iterations = BOOTSTRAP_N, seed = SEED) {
  if (!rows.length) return { low: NaN, high: NaN };
  const random = seededRandom(seed);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    deltas.push(lineBrier(sample, pNew) - lineBrier(sample, pOld));
  }
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975),
  };
}

function residualSummary(label, rows) {
  const mapRows = uniqueMapsFromLineRows(rows);
  return {
    label,
    n: mapRows.length,
    actual_mean: mean(mapRows.map((row) => num(row.total_kills))),
    predicted_mean: mean(mapRows.map((row) => num(row.old_mean))),
    residual_mean: mean(mapRows.map((row) => num(row.old_residual))),
    residual_median: percentile(mapRows.map((row) => num(row.old_residual)), 0.5),
  };
}

function bucketByQuantile(rows, field, quantiles) {
  const values = rows.map((row) => num(row[field], NaN)).filter(Number.isFinite);
  const cuts = quantiles.map((q) => percentile(values, q));
  return rows.map((row) => {
    const value = num(row[field], NaN);
    let idx = 0;
    while (idx < cuts.length && value > cuts[idx]) idx += 1;
    const lo = idx === 0 ? '-inf' : fmt(cuts[idx - 1], 2);
    const hi = idx === cuts.length ? '+inf' : fmt(cuts[idx], 2);
    return { ...row, bucket: `[${lo}, ${hi}]` };
  });
}

function groupSummaries(rows, keyFn, labelPrefix = '') {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, groupRows]) => residualSummary(`${labelPrefix}${key}`, groupRows));
}

function phase0ResidualEvidence(scoredOld) {
  const maps = uniqueMapsFromLineRows(scoredOld);
  const withStrengthBucket = bucketByQuantile(maps, 'strength_abs_diff', [0.2, 0.4, 0.6, 0.8]);
  const strengthRows = [];
  for (const year of ['2024', '2025']) {
    strengthRows.push(...groupSummaries(withStrengthBucket.filter((row) => row.split_year === year), (row) => row.bucket, `${year} strength `));
  }
  const actualRows = [];
  const actualBucket = (row) => {
    const actual = num(row.total_kills);
    if (actual < 18) return '<18';
    if (actual < 22) return '18-21';
    if (actual < 28) return '22-27';
    if (actual < 34) return '28-33';
    return '>=34';
  };
  for (const year of ['2024', '2025']) {
    actualRows.push(...groupSummaries(maps.filter((row) => row.split_year === year), actualBucket, `${year} actual `));
  }

  const strengthP80 = percentile(maps.map((row) => num(row.strength_abs_diff, NaN)), 0.8);
  const highDiffByYear = ['2024', '2025'].map((year) => residualSummary(`${year} high strength diff >= p80`, maps.filter((row) => row.split_year === year && num(row.strength_abs_diff) >= strengthP80)));
  const low18ByYear = ['2024', '2025'].map((year) => residualSummary(`${year} actual <18`, maps.filter((row) => row.split_year === year && num(row.total_kills) < 18)));
  const low22ByYear = ['2024', '2025'].map((year) => residualSummary(`${year} actual <22`, maps.filter((row) => row.split_year === year && num(row.total_kills) < 22)));
  const highDiffNegative = highDiffByYear.every((row) => row.n >= 20 && row.residual_mean < 0);
  const lowTailNegative = low18ByYear.every((row) => row.n >= 10 && row.residual_mean < -4)
    && low22ByYear.every((row) => row.n >= 20 && row.residual_mean < -2);

  return {
    strengthP80,
    strengthRows,
    actualRows,
    highDiffByYear,
    low18ByYear,
    low22ByYear,
    systemWeakness: highDiffNegative && lowTailNegative,
  };
}

function evaluateVariant(observations, oldModel, variant) {
  const fitRows = observations.filter((row) => row.split_year === '2024');
  const model = fitRidge(fitRows, variant);
  const scored = scoreComparison(observations, oldModel, model);
  const fitScored = scored.filter((row) => row.split_year === '2024');
  const oosScored = scored.filter((row) => row.split_year === '2025');
  const fitMetric = metricRow(`${variant.name} 2024 fit`, fitScored);
  const oosMetric = metricRow(`${variant.name} 2025 OOS`, oosScored);
  const oosCi = bootstrapDelta(oosScored);
  const low18Metric = metricRow(`${variant.name} 2025 actual <18`, oosScored.filter((row) => num(row.total_kills) < 18));
  const low22Metric = metricRow(`${variant.name} 2025 actual <22`, oosScored.filter((row) => num(row.total_kills) < 22));
  const highKillMetric = metricRow(`${variant.name} 2025 actual >=34`, oosScored.filter((row) => num(row.total_kills) >= 34));
  const strengthP30 = percentile(uniqueMapsFromLineRows(oosScored).map((row) => num(row.strength_abs_diff, NaN)), 0.3);
  const evenMetric = metricRow(`${variant.name} 2025 even strength <=p30`, oosScored.filter((row) => num(row.strength_abs_diff) <= strengthP30));
  const highKillCi = bootstrapDelta(oosScored.filter((row) => num(row.total_kills) >= 34));
  const evenCi = bootstrapDelta(oosScored.filter((row) => num(row.strength_abs_diff) <= strengthP30));
  const fitImprovement = -fitMetric.delta;
  const oosImprovement = -oosMetric.delta;
  const overfitFlag = oosImprovement > 0 && fitImprovement > oosImprovement * 1.3;
  return {
    variant,
    model,
    scored,
    fitMetric,
    oosMetric,
    oosCi,
    low18Metric,
    low22Metric,
    highKillMetric,
    evenMetric,
    highKillCi,
    evenCi,
    overfitFlag,
  };
}

function pickBest(evaluations) {
  return [...evaluations].sort((a, b) => {
    const aLow = a.low18Metric.residual_improvement + a.low22Metric.residual_improvement;
    const bLow = b.low18Metric.residual_improvement + b.low22Metric.residual_improvement;
    const aOos = -a.oosMetric.delta;
    const bOos = -b.oosMetric.delta;
    return (bOos - aOos) || (bLow - aLow);
  })[0];
}

function deployDecision(best) {
  const overallPass = best.oosMetric.delta <= 0 && best.oosCi.high <= 0;
  const lowTailPass = best.low18Metric.n_maps >= 10
    && best.low22Metric.n_maps >= 20
    && best.low18Metric.residual_new_mean > best.low18Metric.residual_old_mean
    && best.low22Metric.residual_new_mean > best.low22Metric.residual_old_mean
    && best.low18Metric.delta <= 0
    && best.low22Metric.delta <= 0;
  const highKillNotHurt = !(best.highKillMetric.delta > 0 && best.highKillCi.low > 0);
  const evenNotHurt = !(best.evenMetric.delta > 0 && best.evenCi.low > 0);
  const overfitPass = !best.overfitFlag;
  return {
    overallPass,
    lowTailPass,
    highKillNotHurt,
    evenNotHurt,
    overfitPass,
    deploy: overallPass && lowTailPass && highKillNotHurt && evenNotHurt && overfitPass,
  };
}

function coefficientRows(model) {
  return [
    { key: 'intercept', value: model.intercept },
    ...(model.features || []).map((key) => ({ key, value: model.beta[key] })),
    { key: 'sigma', value: model.sigma },
  ];
}

function reportMetricRows(evaluations) {
  return evaluations.map((ev) => ({
    variant: ev.variant.name,
    fit_delta: ev.fitMetric.delta,
    oos_delta: ev.oosMetric.delta,
    oos_ci_low: ev.oosCi.low,
    oos_ci_high: ev.oosCi.high,
    low18_res_old: ev.low18Metric.residual_old_mean,
    low18_res_new: ev.low18Metric.residual_new_mean,
    low18_brier_delta: ev.low18Metric.delta,
    low22_res_old: ev.low22Metric.residual_old_mean,
    low22_res_new: ev.low22Metric.residual_new_mean,
    low22_brier_delta: ev.low22Metric.delta,
    high_kill_delta: ev.highKillMetric.delta,
    even_delta: ev.evenMetric.delta,
    overfit: ev.overfitFlag ? 'YES' : 'NO',
  }));
}

function addValidation(model, best, decision) {
  return {
    ...model,
    deploy: decision.deploy,
    validation: {
      fit: best.fitMetric,
      oos: best.oosMetric,
      oos_delta_ci95: best.oosCi,
      low18: best.low18Metric,
      low22: best.low22Metric,
      high_kill: {
        ...best.highKillMetric,
        delta_ci95: best.highKillCi,
      },
      even_strength: {
        ...best.evenMetric,
        delta_ci95: best.evenCi,
      },
      overfit_flag: best.overfitFlag,
      decision,
    },
    generated_at: new Date().toISOString(),
    seed: SEED,
  };
}

async function writeDetailCsv(scored, bestModel) {
  const detailRows = scored.map((row) => {
    const out = {
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
      p_baseline: fmt(row.p_scenario),
      p_continuous: fmt(row.p_new),
      p_old_continuous: fmt(row.p_old),
      continuous_mean: fmt(row.new_mean),
      old_continuous_mean: fmt(row.old_mean),
      residual_new: fmt(row.new_residual),
      residual_old: fmt(row.old_residual),
      sigma: fmt(bestModel.sigma),
      patch: row.patch,
      train_max_date: row.train_max_date,
      feature_latest_date: row.feature_latest_date,
    };
    for (const key of Object.keys(row)) {
      if (BASE_FEATURE_KEYS.includes(key) || key.endsWith('_proxy') || key.includes('strength') || key.includes('finish') || key.includes('compression') || key.includes('turret')) {
        if (out[key] == null && Number.isFinite(Number(row[key]))) out[key] = fmt(row[key]);
      }
    }
    return out;
  });
  await mkdir(path.dirname(DETAIL_CSV), { recursive: true });
  await writeCsv(DETAIL_CSV, detailRows, unionColumns(detailRows));
}

async function writeReport({
  observations,
  skipped,
  oldModel,
  phase0,
  evaluations,
  best,
  decision,
  landed,
}) {
  const fitRows = observations.filter((row) => row.split_year === '2024');
  const oosRows = observations.filter((row) => row.split_year === '2025');
  const spotChecks = observations.slice(0, 5).map((row) => ({
    match_date: row.match_date,
    match_name: row.match_name,
    game_id: row.game_id,
    train_max_date: row.train_max_date,
    feature_latest_date: row.feature_latest_date,
    ok: row.feature_latest_date < row.match_date ? 'PASS' : 'FAIL',
  }));

  const lines = [
    '# 总杀模型-低杀特征 / Total Kills Low-Kill Collapse Feature',
    '',
    `- Generated / 生成时间: ${new Date().toISOString()}`,
    `- Fit / 拟合: 2024 maps, n=${fitRows.length}.`,
    `- OOS / 样本外: 2025 maps, n=${oosRows.length}.`,
    `- Current model / 当前线上模型: \`${oldModel.model || 'unknown'}\`, deploy=${oldModel.deploy}.`,
    `- Skipped / 跳过: low_sample_matches=${skipped.low_sample_matches}, missing_profiles=${skipped.missing_profiles}, missing_maps=${skipped.missing_maps}.`,
    '',
    '## Phase 0: Residual Evidence / 残差证据',
    '',
    `- Strength diff p80 / 实力差 p80: ${fmt(phase0.strengthP80, 2)}.`,
    `- System weakness verdict / 系统弱点判定: **${phase0.systemWeakness ? 'YES / 是' : 'NO / 否'}**.`,
    '',
    '### By Strength Diff Quantile / 按实力差分位',
    '',
    markdownTable([
      { key: 'label', label: 'bucket', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'actual_mean', label: 'actual', format: fmt1 },
      { key: 'predicted_mean', label: 'pred', format: fmt1 },
      { key: 'residual_mean', label: 'residual mean', format: fmt },
      { key: 'residual_median', label: 'residual median', format: fmt },
    ], phase0.strengthRows),
    '',
    '### By Actual Total Kills / 按实际总杀',
    '',
    markdownTable([
      { key: 'label', label: 'bucket', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'actual_mean', label: 'actual', format: fmt1 },
      { key: 'predicted_mean', label: 'pred', format: fmt1 },
      { key: 'residual_mean', label: 'residual mean', format: fmt },
      { key: 'residual_median', label: 'residual median', format: fmt },
    ], phase0.actualRows),
    '',
  ];

  if (!phase0.systemWeakness) {
    lines.push('## Stop Decision / 停止判定');
    lines.push('');
    lines.push('- Phase 0 did not prove a consistent negative residual in both high-strength-diff and low-kill-tail buckets across 2024 and 2025.');
    lines.push('- The two preview games remain useful warnings, but current evidence says they are not enough to justify a new deployed feature.');
    lines.push('- 按规格停止: 目前证据更像方差或局部样本, 不加特征, 不更新线上模型。');
    lines.push('- Scenario retirement cleanup is not executed in this run because no new low-kill feature was deployed. The current continuous model remains the primary total-kills path; scenario logic remains fallback/narrative only.');
    lines.push('- 本次不执行剧本退役清理, 因为低杀新特征没有落地。当前连续模型仍是总杀主路径; 剧本逻辑仍只保留为兜底/叙事。');
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  lines.push('## Candidate Feature Tests / 候选特征测试');
  lines.push('');
  lines.push(markdownTable([
    { key: 'variant', label: 'variant', align: 'left' },
    { key: 'fit_delta', label: '2024 fit delta', format: fmt },
    { key: 'oos_delta', label: '2025 OOS delta', format: fmt },
    { key: 'oos_ci_low', label: 'OOS CI low', format: fmt },
    { key: 'oos_ci_high', label: 'OOS CI high', format: fmt },
    { key: 'low18_res_old', label: '<18 old residual', format: fmt },
    { key: 'low18_res_new', label: '<18 new residual', format: fmt },
    { key: 'low18_brier_delta', label: '<18 Brier delta', format: fmt },
    { key: 'low22_res_old', label: '<22 old residual', format: fmt },
    { key: 'low22_res_new', label: '<22 new residual', format: fmt },
    { key: 'low22_brier_delta', label: '<22 Brier delta', format: fmt },
    { key: 'high_kill_delta', label: 'high kill delta', format: fmt },
    { key: 'even_delta', label: 'even delta', format: fmt },
    { key: 'overfit', label: 'overfit' },
  ], reportMetricRows(evaluations)));
  lines.push('');
  lines.push('## Selected Variant / 选中特征');
  lines.push('');
  lines.push(`- Selected / 选中: **${best.variant.name}**.`);
  lines.push(`- Description / 说明: ${best.variant.description}.`);
  lines.push(`- Extra features / 新增特征: ${best.variant.extra.map((key) => `\`${key}\``).join(', ')}.`);
  lines.push('');
  lines.push('## New vs Current Model / 新旧模型对比');
  lines.push('');
  lines.push(markdownTable([
    { key: 'label', label: 'segment', align: 'left' },
    { key: 'n_maps', label: 'maps' },
    { key: 'n_lines', label: 'lines' },
    { key: 'brier_old', label: 'old Brier', format: fmt },
    { key: 'brier_new', label: 'new Brier', format: fmt },
    { key: 'delta', label: 'new-old', format: fmt },
    { key: 'ece_old', label: 'old ECE', format: fmt },
    { key: 'ece_new', label: 'new ECE', format: fmt },
    { key: 'residual_old_mean', label: 'old residual', format: fmt },
    { key: 'residual_new_mean', label: 'new residual', format: fmt },
    { key: 'mean_old', label: 'old mean', format: fmt1 },
    { key: 'mean_new', label: 'new mean', format: fmt1 },
    { key: 'mean_actual', label: 'actual', format: fmt1 },
  ], [best.fitMetric, best.oosMetric, best.low18Metric, best.low22Metric, best.highKillMetric, best.evenMetric]));
  lines.push('');
  lines.push(`- 2025 OOS bootstrap CI for Brier delta / 2025 样本外 Brier delta CI: **[${fmt(best.oosCi.low)}, ${fmt(best.oosCi.high)}]**.`);
  lines.push(`- High-kill subset CI / 高杀子集 CI: [${fmt(best.highKillCi.low)}, ${fmt(best.highKillCi.high)}].`);
  lines.push(`- Even-strength subset CI / 均势子集 CI: [${fmt(best.evenCi.low)}, ${fmt(best.evenCi.high)}].`);
  lines.push('');
  lines.push('## Walk-forward Audit / 前视审计');
  lines.push('');
  lines.push(markdownTable([
    { key: 'match_date', label: 'match date' },
    { key: 'match_name', label: 'match', align: 'left' },
    { key: 'game_id', label: 'game_id' },
    { key: 'train_max_date', label: 'train max date' },
    { key: 'feature_latest_date', label: 'feature latest date' },
    { key: 'ok', label: 'ok' },
  ], spotChecks));
  lines.push('');
  lines.push('## Coefficients / 系数');
  lines.push('');
  lines.push(markdownTable([
    { key: 'key', label: 'feature', align: 'left' },
    { key: 'value', label: 'value', format: fmt },
  ], coefficientRows(best.model)));
  lines.push('');
  lines.push('## Deploy Gate / 落地闸门');
  lines.push('');
  lines.push(markdownTable([
    { key: 'gate', label: 'gate', align: 'left' },
    { key: 'pass', label: 'pass' },
  ], [
    { gate: 'overall OOS CI high <= 0 / 整体样本外不变差', pass: decision.overallPass ? 'PASS' : 'FAIL' },
    { gate: 'low-kill tail improves / 低杀尾部改善', pass: decision.lowTailPass ? 'PASS' : 'FAIL' },
    { gate: 'high-kill not significantly hurt / 高杀不显著变差', pass: decision.highKillNotHurt ? 'PASS' : 'FAIL' },
    { gate: 'even-strength not significantly hurt / 均势不显著变差', pass: decision.evenNotHurt ? 'PASS' : 'FAIL' },
    { gate: 'overfit check / 过拟合检查', pass: decision.overfitPass ? 'PASS' : 'FAIL' },
  ]));
  lines.push('');
  lines.push(`- Deploy decision / 落地判定: **${landed ? 'DEPLOYED / 已落地' : 'NOT DEPLOYED / 未落地'}**.`);
  lines.push(landed
    ? `- Updated / 已更新: \`${MODEL_PATH}\`.`
    : `- Current model preserved / 保留当前模型: \`${MODEL_PATH}\`; candidate written to \`${CANDIDATE_MODEL_PATH}\`.`);
  lines.push('');
  lines.push('## Scenario Retirement / 剧本退役记录');
  lines.push('');
  lines.push('- Online total kills path uses `predictTotalKills` when `total_kills_model_coef.json` has `deploy=true`; `scenarioTotalKillsProbability` remains fallback only if model loading fails.');
  lines.push('- 线上总杀在模型可加载且 deploy=true 时不依赖 5 剧本；`scenarioTotalKillsProbability` 仅是模型加载失败时的兜底。');
  lines.push('- `classifyScenario` may remain as a human-readable narrative label for reports/dashboard; its numeric total-kills adjustments should not be used in the normal betting path.');
  lines.push('- 建议后续清理清单: `build-market-analysis.js` 的 `scenarioTotalKillsProbability` fallback、`scenario-soft-compare.js`、`scenario-thresholds.js`、`scenario-split.js`、旧 `剧本软分类校准对比.md`。先列清单, 等 Claude/用户确认再删。');
  lines.push('');

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const oldModel = loadCurrentModel();
  const { matches, maps } = await readHistoryData();
  const { rows: observations, skipped } = buildObservations(matches, maps);
  const fitRows = observations.filter((row) => row.split_year === '2024');
  const oosRows = observations.filter((row) => row.split_year === '2025');
  if (!fitRows.length || !oosRows.length) throw new Error('missing fit or OOS observations');

  const oldScored = scoreComparison(observations, oldModel, oldModel);
  const phase0 = phase0ResidualEvidence(oldScored);
  await writeDetailCsv(oldScored, oldModel);

  if (!phase0.systemWeakness) {
    await writeReport({ observations, skipped, oldModel, phase0, evaluations: [], best: null, decision: null, landed: false });
    console.log(`Phase 0 found no systematic weakness; wrote ${REPORT_PATH}`);
    return;
  }

  const evaluations = FEATURE_SETS.map((variant) => evaluateVariant(observations, oldModel, variant));
  const best = pickBest(evaluations);
  const decision = deployDecision(best);
  const candidateModel = addValidation(best.model, best, decision);
  await mkdir(path.dirname(CANDIDATE_MODEL_PATH), { recursive: true });
  await writeFile(CANDIDATE_MODEL_PATH, `${JSON.stringify(candidateModel, null, 2)}\n`, 'utf8');

  let landed = false;
  if (decision.deploy) {
    await writeFile(MODEL_PATH, `${JSON.stringify(candidateModel, null, 2)}\n`, 'utf8');
    landed = true;
  }
  await writeDetailCsv(best.scored, candidateModel);
  await writeReport({ observations, skipped, oldModel, phase0, evaluations, best, decision, landed });

  console.log(`wrote ${REPORT_PATH}`);
  console.log(`best=${best.variant.name} oos_delta=${fmt(best.oosMetric.delta)} ci=[${fmt(best.oosCi.low)}, ${fmt(best.oosCi.high)}] deploy=${landed}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
