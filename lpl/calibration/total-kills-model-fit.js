import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
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
import { clamp, num, readCsvIfExists, teamKey, unionColumns, writeCsv } from '../shared.js';
import { totalKillsFeatures } from './total-kills-model-predict.js';

const SEED = 20260601;
const LINES = [27.5, 30.5, 33.5];
const MIN_PRIOR_MAPS = 8;
const MODEL_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_model_coef.json');
const REPORT_PATH = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '连续总杀模型-vs-剧本.md');
const DETAIL_CSV = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'total_kills_continuous_vs_scenario.csv');
const PROP_ODDS_PATH = path.join(process.cwd(), 'lpl', 'data', 'history', 'oddsportal_lpl_prop_odds.csv');
const ODDS_DB_PATH = path.join(process.cwd(), 'lpl', 'data', 'odds_history', 'odds.db');

const FEATURE_KEYS = [
  'avg_total_mean',
  'avg_time_mean',
  'strength_abs_diff',
  'strength_signed_diff',
  'recent_abs_diff',
  'avg_kill_diff_sum',
  'first_turret_mean',
];

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
  const body = rows.map((row) => `| ${columns.map((col) => col.format ? col.format(row[col.key]) : row[col.key]).join(' | ')} |`);
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

function fitScaler(rows) {
  const scaler = {};
  for (const key of FEATURE_KEYS) {
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

function designVector(row, scaler, patchParams) {
  return [
    1,
    ...FEATURE_KEYS.map((key) => scaledFeature(row, key, scaler)),
    ...patchParams.map((patch) => row.features.patch === patch ? 1 : 0),
  ];
}

function fitRidge(rows, { lambda = 0.4, patchLambda = 0.8 } = {}) {
  const scaler = fitScaler(rows);
  const patchCounts = new Map();
  for (const row of rows) patchCounts.set(row.features.patch, (patchCounts.get(row.features.patch) || 0) + 1);
  const patches = [...patchCounts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([patch]) => patch);
  const baselinePatch = patches[0] || '';
  const patchParams = patches.filter((patch) => patch !== baselinePatch);
  const vectors = rows.map((row) => designVector(row, scaler, patchParams));
  const p = vectors[0]?.length || 0;
  const xtx = Array.from({ length: p }, () => Array(p).fill(0));
  const xty = Array(p).fill(0);

  for (let i = 0; i < rows.length; i += 1) {
    const x = vectors[i];
    const y = num(rows[i].total_kills);
    for (let a = 0; a < p; a += 1) {
      xty[a] += x[a] * y;
      for (let b = 0; b < p; b += 1) xtx[a][b] += x[a] * x[b];
    }
  }
  for (let i = 1; i < p; i += 1) {
    xtx[i][i] += i <= FEATURE_KEYS.length ? lambda : patchLambda;
  }
  const betaVector = solveLinearSystem(xtx, xty);
  if (!betaVector) throw new Error('ridge solve failed');

  const partialModel = modelFromVector(betaVector, scaler, baselinePatch, patchParams, NaN, false);
  const rawSigma = Math.sqrt(mean(rows.map((row) => (num(row.total_kills) - predictMean(row, partialModel)) ** 2))) || 7;
  const sigma = fitSigma(rows, partialModel, rawSigma);
  return modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, false);
}

function modelFromVector(betaVector, scaler, baselinePatch, patchParams, sigma, deploy) {
  const beta = {};
  FEATURE_KEYS.forEach((key, index) => { beta[key] = betaVector[index + 1]; });
  const patchGamma = { [baselinePatch]: 0 };
  patchParams.forEach((patch, index) => { patchGamma[patch] = betaVector[1 + FEATURE_KEYS.length + index]; });
  return {
    model: 'total_kills_continuous_normal_v1',
    formula: 'total_kills = intercept + standardized profile features + patch fixed effect; probability via Normal(mean, sigma)',
    fit_year: 2024,
    features: FEATURE_KEYS,
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
  let out = num(model.intercept, 28);
  for (const key of FEATURE_KEYS) {
    const s = model.scaler[key] || { mean: 0, sd: 1 };
    out += ((num(row.features[key], 0) - s.mean) / Math.max(s.sd, 0.000001)) * num(model.beta[key], 0);
  }
  out += num(model.patch_gamma[row.features.patch], 0);
  return clamp(out, 8, 65);
}

function continuousProbability(row, line, selection, model) {
  const z = (num(line) - predictMean(row, model)) / Math.max(num(model.sigma, 7), 0.000001);
  const under = clamp(normalCdf(z), 0.000001, 0.999999);
  return selection === 'under' ? under : 1 - under;
}

function lineBrier(rows, pKey) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => sum + (num(row[pKey]) - num(row.outcome)) ** 2, 0) / rows.length;
}

function scoreRows(observations, model) {
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
          p_baseline: scenarioTotalKillsProbability(row.profile_a, row.profile_b, line, selection, row.scenario_probs),
          p_continuous: continuousProbability(row, line, selection, model),
          continuous_mean: predictMean(row, model),
          sigma: model.sigma,
          patch: row.features.patch,
        });
      }
    }
  }
  return out;
}

function fitSigma(rows, model, fallback) {
  let best = { sigma: clamp(fallback, 3, 14), brier: Infinity };
  for (let i = 30; i <= 140; i += 1) {
    const sigma = i / 10;
    const candidate = { ...model, sigma };
    const scored = scoreRows(rows, candidate);
    const b = lineBrier(scored, 'p_continuous');
    if (b < best.brier) best = { sigma, brier: b };
  }
  return best.sigma;
}

function metricRow(label, rows) {
  const brierBaseline = lineBrier(rows, 'p_baseline');
  const brierContinuous = lineBrier(rows, 'p_continuous');
  return {
    label,
    n: rows.length,
    brier_baseline: brierBaseline,
    brier_continuous: brierContinuous,
    delta: brierContinuous - brierBaseline,
  };
}

function bootstrapDelta(rows, iterations = 1000) {
  const random = seededRandom(SEED);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    deltas.push(lineBrier(sample, 'p_continuous') - lineBrier(sample, 'p_baseline'));
  }
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975),
  };
}

function dateMaxBefore(maps, cutoff) {
  let latest = '';
  for (const map of maps) {
    const date = rowDate(map);
    if (date < cutoff && date > latest) latest = date;
  }
  return latest;
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
      });
    }
  }

  return { rows, skipped };
}

async function oddsDataStatus() {
  const propRows = await readCsvIfExists(PROP_ODDS_PATH);
  const propTotalKills = propRows.filter((row) => row.market === 'total_kills').length;
  let dbTotalKills = 0;
  let dbSnapshots = 0;
  if (existsSync(ODDS_DB_PATH)) {
    const db = new Database(ODDS_DB_PATH, { readonly: true });
    dbTotalKills = db.prepare("select count(*) as n from odds where market='total_kills'").get().n;
    dbSnapshots = db.prepare('select count(*) as n from snapshots').get().n;
    db.close();
  }
  return {
    prop_csv_rows: propRows.length,
    prop_csv_total_kills_rows: propTotalKills,
    odds_db_exists: existsSync(ODDS_DB_PATH),
    odds_db_snapshots: dbSnapshots,
    odds_db_total_kills_rows: dbTotalKills,
    roi_available: propTotalKills >= 50,
  };
}

function coefficientRows(model) {
  return [
    { key: 'intercept', value: model.intercept },
    ...FEATURE_KEYS.map((key) => ({ key, value: model.beta[key] })),
    { key: 'sigma', value: model.sigma },
  ];
}

async function main() {
  const { matches, maps } = await readHistoryData();
  const { rows: observations, skipped } = buildObservations(matches, maps);
  const fitRows = observations.filter((row) => row.split_year === '2024');
  const oosRows = observations.filter((row) => row.split_year === '2025');
  if (!fitRows.length || !oosRows.length) throw new Error('missing fit or OOS observations');

  const model = fitRidge(fitRows);
  const scored = scoreRows(observations, model);
  const fitScored = scored.filter((row) => row.split_year === '2024');
  const oosScored = scored.filter((row) => row.split_year === '2025');
  const fitMetric = metricRow('2024 fit / 2024 拟合内', fitScored);
  const oosMetric = metricRow('2025 OOS / 2025 样本外', oosScored);
  const oosCi = bootstrapDelta(oosScored);
  const fitImprovement = -fitMetric.delta;
  const oosImprovement = -oosMetric.delta;
  const overfitFlag = oosImprovement > 0 && fitImprovement > oosImprovement * 1.3;
  const deploy = oosMetric.delta <= 0 && oosCi.high <= 0 && !overfitFlag;
  model.deploy = deploy;
  model.validation = {
    fit: fitMetric,
    oos: oosMetric,
    oos_delta_ci95: oosCi,
    overfit_flag: overfitFlag,
    deploy,
  };
  model.generated_at = new Date().toISOString();
  model.seed = SEED;

  await mkdir(path.dirname(MODEL_PATH), { recursive: true });
  await writeFile(MODEL_PATH, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  await mkdir(path.dirname(DETAIL_CSV), { recursive: true });
  const detailRows = scored.map((row) => {
    const { profile_a, profile_b, scenario_probs, features, ...flat } = row;
    return {
      ...flat,
      p_baseline: fmt(row.p_baseline),
      p_continuous: fmt(row.p_continuous),
      continuous_mean: fmt(row.continuous_mean),
      sigma: fmt(row.sigma),
    };
  });
  await writeCsv(DETAIL_CSV, detailRows, unionColumns(detailRows));

  const byLine = [];
  for (const line of LINES) {
    const lineRows = oosScored.filter((row) => num(row.line) === line);
    const metric = metricRow(`2025 line ${line}`, lineRows);
    const ci = bootstrapDelta(lineRows);
    byLine.push({ ...metric, ci_low: ci.low, ci_high: ci.high });
  }
  const spotChecks = observations.slice(0, 5).map((row) => ({
    match_date: row.match_date,
    match_name: row.match_name,
    game_id: row.game_id,
    train_max_date: row.train_max_date,
    ok: row.train_max_date < row.match_date ? 'PASS' : 'FAIL',
  }));
  const oddsStatus = await oddsDataStatus();

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const lines = [
    '# 连续总杀模型 vs 剧本模型 / Continuous Total Kills Model vs Scenario Baseline',
    '',
    `- Fit / 拟合: 2024 maps, n=${fitRows.length}.`,
    `- OOS / 样本外: 2025 maps, n=${oosRows.length}.`,
    `- Detail CSV / 明细: \`${DETAIL_CSV}\`.`,
    `- Coef JSON / 系数: \`${MODEL_PATH}\`.`,
    `- Skipped / 跳过: low_sample_matches=${skipped.low_sample_matches}, missing_profiles=${skipped.missing_profiles}, missing_maps=${skipped.missing_maps}.`,
    '',
    '## Acceptance / 验收',
    '',
    markdownTable([
      { key: 'label', label: 'segment / 分段', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'brier_baseline', label: 'scenario Brier', format: fmt },
      { key: 'brier_continuous', label: 'continuous Brier', format: fmt },
      { key: 'delta', label: 'continuous-scenario', format: fmt },
    ], [fitMetric, oosMetric]),
    '',
    `- 2025 OOS delta bootstrap CI / 2025 样本外 delta 置信区间: **${fmt(oosCi.low)} to ${fmt(oosCi.high)}**.`,
    `- Overfit check / 过拟合检查: **${overfitFlag ? 'FLAG' : 'OK'}**.`,
    `- Deploy decision / 落地判定: **${deploy ? 'DEPLOY / 落地启用' : 'NO DEPLOY / 不落地'}**.`,
    '',
    '## By Line / 按盘口线',
    '',
    markdownTable([
      { key: 'label', label: 'line / 盘口线', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'brier_baseline', label: 'scenario Brier', format: fmt },
      { key: 'brier_continuous', label: 'continuous Brier', format: fmt },
      { key: 'delta', label: 'delta', format: fmt },
      { key: 'ci_low', label: 'CI low', format: fmt },
      { key: 'ci_high', label: 'CI high', format: fmt },
    ], byLine),
    '',
    '## Coefficients / 系数',
    '',
    markdownTable([
      { key: 'key', label: 'feature / 特征', align: 'left' },
      { key: 'value', label: 'value', format: fmt },
    ], coefficientRows(model)),
    '',
    '## Walk-forward Spot Check / 严格前视检查',
    '',
    markdownTable([
      { key: 'match_date', label: 'match date' },
      { key: 'match_name', label: 'match', align: 'left' },
      { key: 'game_id', label: 'game_id' },
      { key: 'train_max_date', label: 'train max date' },
      { key: 'ok', label: 'ok' },
    ], spotChecks),
    '',
    '## Real Odds ROI / 真实报价 ROI',
    '',
    `- OddsPortal prop CSV rows / OP prop CSV 行数: ${oddsStatus.prop_csv_rows}, total_kills rows=${oddsStatus.prop_csv_total_kills_rows}.`,
    `- odds.db snapshots / odds.db 快照: ${oddsStatus.odds_db_snapshots}, total_kills odds rows=${oddsStatus.odds_db_total_kills_rows}.`,
    `- ROI verdict / ROI 判定: **${oddsStatus.roi_available ? 'quote data available / 可跑 ROI' : 'no settled historical quote data / 无足够已结算历史报价, 不能下盈利结论'}**.`,
    '',
    '## Verdict / 结论',
    '',
    deploy
      ? '- Continuous model passed 2025 OOS Brier gate and is enabled in `build-market-analysis.js` via `total_kills_model_coef.json`.'
      : '- Continuous model did not pass the 2025 OOS gate; `build-market-analysis.js` will keep using the scenario baseline fallback.',
    deploy
      ? '- 连续模型通过 2025 样本外 Brier 闸门, 主流程将自动启用。'
      : '- 连续模型未通过 2025 样本外闸门, 主流程继续使用原剧本模型作为 fallback。',
  ];
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');

  console.log(`wrote ${MODEL_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
  console.log(`2025 OOS delta=${fmt(oosMetric.delta)} ci=[${fmt(oosCi.low)}, ${fmt(oosCi.high)}] deploy=${deploy}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
