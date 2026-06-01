import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProfiles, classifyScenario } from '../build-market-analysis.js';
import { ANALYSIS_DIR, clamp, logistic, num, pctText } from '../shared.js';
import { buildSnapshotSummary, readHistoryData, rowDate } from '../backtest/common.js';
import { totalKillsFeatures } from './total-kills-model-predict.js';

const FEATURES = [
  'avg_total_mean',
  'avg_time_mean',
  'strength_abs_diff',
  'recent_map_win_abs_diff',
  'avg_kill_diff_sum',
  'first_turret_mean',
];
const LINES = [27.5, 30.5, 33.5];
const COEF_PATH = path.join(process.cwd(), 'lck', 'calibration', 'total_kills_model_coef.json');
const REPORT_PATH = path.join(ANALYSIS_DIR, '总杀连续模型-vs-旧公式.md');

function scenarioBaselineProbability(team, opponent, line, selection) {
  const scenario = classifyScenario(team, opponent).scenario;
  let mean = (num(team.avg_total_kills) + num(opponent.avg_total_kills)) / 2;
  if (scenario === '混乱高击杀局') mean += 2.2;
  if (scenario === '低击杀运营局') mean -= 2;
  if (scenario === '强队速推碾压局') mean -= 0.8;
  const over = clamp(logistic((mean - Number(line)) / 3.8), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function scalerFor(rows) {
  const scaler = {};
  for (const feature of FEATURES) {
    const values = rows.map((row) => row.features[feature]).filter(Number.isFinite);
    scaler[feature] = { mean: mean(values), sd: stdev(values) || 1 };
  }
  return scaler;
}

function z(value, scaler) {
  return (Number(value || 0) - scaler.mean) / scaler.sd;
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) a[pivot][col] = 1e-10;
    [a[col], a[pivot]] = [a[pivot], a[col]];
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

function fitRidge(rows, scaler, lambda = 0.1) {
  const p = FEATURES.length + 1;
  const xtx = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  const xty = Array.from({ length: p }, () => 0);
  for (const row of rows) {
    const x = [1, ...FEATURES.map((feature) => z(row.features[feature], scaler[feature]))];
    for (let i = 0; i < p; i += 1) {
      xty[i] += x[i] * row.total_kills;
      for (let j = 0; j < p; j += 1) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < p; i += 1) xtx[i][i] += lambda;
  const beta = solveLinear(xtx, xty);
  return {
    intercept: beta[0],
    beta: Object.fromEntries(FEATURES.map((feature, index) => [feature, beta[index + 1]])),
  };
}

function predictMean(row, model, scaler, patchGamma = {}) {
  let value = model.intercept;
  for (const feature of FEATURES) value += model.beta[feature] * z(row.features[feature], scaler[feature]);
  value += Number(patchGamma[row.patch] || 0);
  return value;
}

function fitPatchGamma(rows, model, scaler) {
  const residualsByPatch = new Map();
  for (const row of rows) {
    const patch = row.patch || '';
    if (!residualsByPatch.has(patch)) residualsByPatch.set(patch, []);
    residualsByPatch.get(patch).push(row.total_kills - predictMean(row, model, scaler));
  }
  let baselinePatch = '';
  let maxCount = -1;
  for (const [patch, values] of residualsByPatch) {
    if (values.length > maxCount) {
      baselinePatch = patch;
      maxCount = values.length;
    }
  }
  const baselineMean = mean(residualsByPatch.get(baselinePatch) || []);
  const patchGamma = {};
  for (const [patch, values] of residualsByPatch) patchGamma[patch] = mean(values) - baselineMean;
  patchGamma[baselinePatch] = 0;
  return { baselinePatch, patchGamma };
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs);
  return sign * y;
}

function brier(rows, key) {
  return mean(rows.map((row) => (row[key] - row.outcome) ** 2));
}

function validationRows(examples, model, scaler, patchGamma, sigma) {
  const rows = [];
  for (const row of examples) {
    const continuousMean = predictMean(row, model, scaler, patchGamma);
    for (const line of LINES) {
      const outcome = row.total_kills > line ? 1 : 0;
      rows.push({
        line,
        outcome,
        scenario_p: scenarioBaselineProbability(row.team, row.opponent, line, 'over'),
        continuous_p: clamp(1 - normalCdf((line - continuousMean) / sigma), 0.02, 0.98),
      });
    }
  }
  return rows;
}

function bootstrapDelta(rows, iterations = 500) {
  if (!rows.length) return { low: 0, high: 0 };
  let seed = 20260601;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < rows.length; j += 1) sample.push(rows[Math.floor(rand() * rows.length)]);
    deltas.push(brier(sample, 'continuous_p') - brier(sample, 'scenario_p'));
  }
  deltas.sort((a, b) => a - b);
  return {
    low: deltas[Math.floor(iterations * 0.025)],
    high: deltas[Math.floor(iterations * 0.975)],
  };
}

async function buildExamples(matches, maps, summary) {
  const examples = [];
  const profileCache = new Map();
  const snapshotCache = new Map();
  for (const map of [...maps].sort((a, b) => String(rowDate(a)).localeCompare(String(rowDate(b))) || num(a.bo) - num(b.bo))) {
    const cutoff = rowDate(map);
    if (!cutoff || !num(map.total_kills)) continue;
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    if (!profileCache.has(cutoff)) profileCache.set(cutoff, buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff));
    const profiles = profileCache.get(cutoff);
    const team = profiles.get(map.team_a_id);
    const opponent = profiles.get(map.team_b_id);
    if (!team || !opponent || Math.min(num(team.maps), num(opponent.maps)) < 8) continue;
    examples.push({
      date: cutoff,
      year: cutoff.slice(0, 4),
      patch: map.patch || '',
      total_kills: num(map.total_kills),
      team,
      opponent,
      features: totalKillsFeatures(team, opponent),
    });
  }
  return examples;
}

async function main() {
  const { matches, maps, summary } = await readHistoryData();
  const examples = await buildExamples(matches, maps, summary);
  const train = examples.filter((row) => row.year === '2024');
  const oos = examples.filter((row) => row.year === '2025');

  if (train.length < 100 || oos.length < 100) {
    throw new Error(`not enough examples: train=${train.length}, oos=${oos.length}`);
  }

  const scaler = scalerFor(train);
  const model = fitRidge(train, scaler);
  const { baselinePatch, patchGamma } = fitPatchGamma(train, model, scaler);
  const trainResiduals = train.map((row) => row.total_kills - predictMean(row, model, scaler, patchGamma));
  const sigma = Math.max(4.5, stdev(trainResiduals));
  const fitRows = validationRows(train, model, scaler, patchGamma, sigma);
  const oosRows = validationRows(oos, model, scaler, patchGamma, sigma);
  const fitDelta = brier(fitRows, 'continuous_p') - brier(fitRows, 'scenario_p');
  const oosDelta = brier(oosRows, 'continuous_p') - brier(oosRows, 'scenario_p');
  const ci = bootstrapDelta(oosRows);
  const deploy = oosRows.length >= 300 && oosDelta < 0 && ci.high < 0;

  const coef = {
    model: 'lck_total_kills_continuous_normal_v1',
    formula: 'total_kills = intercept + standardized LCK profile features + patch fixed effect; probability via Normal(mean, sigma)',
    fit_year: 2024,
    features: FEATURES,
    intercept: model.intercept,
    beta: model.beta,
    scaler,
    baseline_patch: baselinePatch,
    patch_gamma: patchGamma,
    sigma,
    deploy,
    validation: {
      fit: {
        n: fitRows.length,
        brier_baseline: brier(fitRows, 'scenario_p'),
        brier_continuous: brier(fitRows, 'continuous_p'),
        delta: fitDelta,
      },
      oos: {
        n: oosRows.length,
        brier_baseline: brier(oosRows, 'scenario_p'),
        brier_continuous: brier(oosRows, 'continuous_p'),
        delta: oosDelta,
      },
      oos_delta_ci95: ci,
    },
    generated_at: new Date().toISOString(),
  };

  await mkdir(path.dirname(COEF_PATH), { recursive: true });
  await mkdir(ANALYSIS_DIR, { recursive: true });
  await writeFile(COEF_PATH, `${JSON.stringify(coef, null, 2)}\n`, 'utf8');
  await writeFile(REPORT_PATH, [
    '# LCK 连续总杀模型 vs 旧剧本公式',
    '',
    `- 训练: 2024 maps, examples=${train.length}, line rows=${fitRows.length}`,
    `- 样本外: 2025 maps, examples=${oos.length}, line rows=${oosRows.length}`,
    `- Deploy: ${deploy ? 'yes' : 'no'}`,
    '',
    '| segment | n | old_brier | continuous_brier | delta |',
    '|---|---:|---:|---:|---:|',
    `| 2024 fit | ${fitRows.length} | ${brier(fitRows, 'scenario_p').toFixed(4)} | ${brier(fitRows, 'continuous_p').toFixed(4)} | ${fitDelta.toFixed(4)} |`,
    `| 2025 OOS | ${oosRows.length} | ${brier(oosRows, 'scenario_p').toFixed(4)} | ${brier(oosRows, 'continuous_p').toFixed(4)} | ${oosDelta.toFixed(4)} |`,
    '',
    `2025 OOS delta bootstrap CI95: [${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}]`,
    '',
    deploy
      ? '结论: 连续模型样本外优于旧公式且置信区间通过，线上启用。'
      : '结论: 连续模型未通过样本外闸门，线上继续使用旧公式 fallback。',
    '',
    '注意: 该模型只证明概率校准/排序改进，不等于已证明真实盘口盈利；真实 ROI 仍依赖 odds-history 的成交赔率。',
  ].join('\n'), 'utf8');

  console.log(`LCK total kills model: deploy=${deploy}, oos_delta=${oosDelta.toFixed(4)}, ci=[${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}]`);
}

main().catch((error) => {
  console.error(`total-kills-model-fit failed: ${error.message}`);
  process.exitCode = 1;
});
