import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readCsv, num, teamKey, clamp } from '../shared.js';
import { buildProfiles } from '../build-market-analysis.js';
import { buildSnapshotSummary } from '../backtest/common.js';

export const HISTORY_DIR = path.join('lpl', 'data', 'history');
export const ANALYSIS_DIR = path.join('lpl', 'data', '盘口分析');
export const CALIBRATION_DIR = path.join('lpl', 'calibration');
export const OP_PATH = path.join(HISTORY_DIR, 'oddsportal_lpl_match_odds.csv');
export const MATCHES_PATH = path.join(HISTORY_DIR, 'all_matches.csv');
export const MAPS_PATH = path.join(HISTORY_DIR, 'all_map_details.csv');
export const SEED = 20260522;

export function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function logit(p) {
  const safe = clamp(num(p), 0.000001, 0.999999);
  return Math.log(safe / (1 - safe));
}

export function fmt(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function pct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function splitOf(row) {
  return String(row.year) === '2024' ? '2024 fit' : '2025 OOS';
}

function rowDate(row) {
  return row.match_time || row.match_date || '';
}

function dateMs(value) {
  const text = String(value || '').slice(0, 10);
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function patchAgeDays(allMaps, date, patch) {
  if (!patch) return 0;
  const matchMs = dateMs(date);
  if (matchMs == null) return 0;
  let firstMs = null;
  for (const row of allMaps) {
    if (row.patch !== patch) continue;
    const ms = dateMs(rowDate(row));
    if (ms == null || ms >= matchMs) continue;
    if (firstMs == null || ms < firstMs) firstMs = ms;
  }
  return firstMs == null ? 0 : Math.max(0, (matchMs - firstMs) / (24 * 60 * 60 * 1000));
}

function isPlayoffLike(match, op) {
  return /playoff|final|regional|round|play-in/i.test([
    match.tournament,
    match.stage,
    op.tournament,
    op.stage,
  ].filter(Boolean).join(' ')) ? 1 : 0;
}

export function matchWinProbability(team, opponent) {
  const sample = Math.min(num(team.maps) + num(opponent.maps), 60);
  const confidence = clamp(sample / 40, 0.45, 1);
  const raw = sigmoid((team.strength_score - opponent.strength_score) / 13);
  return clamp(0.5 + (raw - 0.5) * confidence, 0.05, 0.95);
}

export async function loadCalibrationRows({ minMaps = 8 } = {}) {
  const [opRows, allMatches, allMaps] = await Promise.all([
    readCsv(OP_PATH),
    readCsv(MATCHES_PATH),
    readCsv(MAPS_PATH),
  ]);

  const matchIndex = new Map();
  for (const match of allMatches) {
    const date = String(match.match_date || '').slice(0, 10);
    const teamA = teamKey(match.team_a_id || match.team_a);
    const teamB = teamKey(match.team_b_id || match.team_b);
    if (!date || !teamA || !teamB) continue;
    matchIndex.set([date, teamA, teamB].join('|'), match);
    matchIndex.set([date, teamB, teamA].join('|'), match);
  }

  const profileCache = new Map();
  const rows = [];
  let matched = 0;
  let unmatched = 0;
  let lowSample = 0;

  for (const op of opRows) {
    const date = String(op.match_date || '').slice(0, 10);
    const homeKey = teamKey(op.home_key || op.home_team);
    const awayKey = teamKey(op.away_key || op.away_team);
    const match = matchIndex.get([date, homeKey, awayKey].join('|'));
    if (!match) {
      unmatched += 1;
      continue;
    }
    matched += 1;

    if (!profileCache.has(date)) {
      const snapshot = buildSnapshotSummary(allMaps, date);
      profileCache.set(date, buildProfiles(allMatches, allMaps, snapshot, date));
    }
    const profiles = profileCache.get(date);
    const home = profiles.get(homeKey);
    const away = profiles.get(awayKey);
    if (!home || !away || Math.min(num(home.maps), num(away.maps)) < minMaps) {
      lowSample += 1;
      continue;
    }

    const modelPHome = matchWinProbability(home, away);
    const marketPHome = num(op.home_market_p);
    const marketPAway = num(op.away_market_p);
    const outcomeHome = teamKey(op.winner_key) === homeKey ? 1 : 0;
    const totalScore = num(op.home_score) + num(op.away_score);
    const maxScore = Math.max(num(op.home_score), num(op.away_score));
    const marketFavoriteP = Math.max(marketPHome, marketPAway);

    rows.push({
      year: String(op.year),
      split: splitOf(op),
      match_id: match.match_id || match.game_id || op.event_id,
      event_id: op.event_id,
      match_date: date,
      tournament: match.tournament || op.tournament,
      stage: match.stage || op.stage || '',
      home_team: op.home_team,
      away_team: op.away_team,
      home_key: homeKey,
      away_key: awayKey,
      winner_key: teamKey(op.winner_key),
      home_score: num(op.home_score),
      away_score: num(op.away_score),
      total_score: totalScore,
      series_type: maxScore >= 3 ? 'BO5' : 'BO3',
      market_shape: marketFavoriteP > 0.65 ? 'strong_favorite' : 'even',
      home_avg_odds: num(op.home_avg_odds),
      away_avg_odds: num(op.away_avg_odds),
      market_p_home: marketPHome,
      market_p_away: marketPAway,
      model_p_home: modelPHome,
      model_p_away: 1 - modelPHome,
      outcome_home: outcomeHome,
      home_strength_score: num(home.strength_score),
      away_strength_score: num(away.strength_score),
      strength_diff: num(home.strength_score) - num(away.strength_score),
      home_recent_10_map_win_rate: num(home.recent_10_map_win_rate),
      away_recent_10_map_win_rate: num(away.recent_10_map_win_rate),
      recent_form_diff: num(home.recent_10_map_win_rate) - num(away.recent_10_map_win_rate),
      home_avg_total_kills: num(home.avg_total_kills),
      away_avg_total_kills: num(away.avg_total_kills),
      avg_total_diff: num(home.avg_total_kills) - num(away.avg_total_kills),
      home_avg_game_time_min: num(home.avg_game_time_min),
      away_avg_game_time_min: num(away.avg_game_time_min),
      avg_time_diff: num(home.avg_game_time_min) - num(away.avg_game_time_min),
      home_maps: num(home.maps),
      away_maps: num(away.maps),
      map_sample_diff: num(home.maps) - num(away.maps),
      current_patch: home.current_patch || away.current_patch || '',
      patch_age_days: patchAgeDays(allMaps, date, home.current_patch || away.current_patch || ''),
      is_playoff: isPlayoffLike(match, op),
    });
  }

  return {
    rows,
    stats: {
      oddsportal_rows: opRows.length,
      history_matches: allMatches.length,
      history_maps: allMaps.length,
      matched,
      unmatched,
      low_sample: lowSample,
      final_rows: rows.length,
    },
  };
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

function nll(features, labels, beta, l2 = 1e-6) {
  let loss = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const z = features[i].reduce((sum, value, j) => sum + value * beta[j], 0);
    const p = clamp(sigmoid(z), 0.000001, 0.999999);
    loss += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p));
  }
  for (let j = 1; j < beta.length; j += 1) loss += 0.5 * l2 * beta[j] ** 2;
  return loss / Math.max(1, labels.length);
}

export function fitLogistic(features, labels, { maxIter = 100, l2 = 1e-6 } = {}) {
  const k = features[0]?.length || 0;
  let beta = Array(k).fill(0);
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    const gradient = Array(k).fill(0);
    const hessian = Array.from({ length: k }, () => Array(k).fill(0));

    for (let i = 0; i < labels.length; i += 1) {
      const x = features[i];
      const z = x.reduce((sum, value, j) => sum + value * beta[j], 0);
      const p = sigmoid(z);
      const error = p - labels[i];
      const weight = Math.max(p * (1 - p), 1e-6);
      for (let a = 0; a < k; a += 1) {
        gradient[a] += error * x[a];
        for (let b = 0; b < k; b += 1) hessian[a][b] += weight * x[a] * x[b];
      }
    }
    for (let j = 1; j < k; j += 1) {
      gradient[j] += l2 * beta[j];
      hessian[j][j] += l2;
    }

    const step = solveLinearSystem(hessian, gradient);
    if (!step) break;
    const stepNorm = Math.sqrt(step.reduce((sum, value) => sum + value ** 2, 0));
    const currentLoss = nll(features, labels, beta, l2);
    let next = beta.map((value, j) => value - step[j]);
    let nextLoss = nll(features, labels, next, l2);
    let scale = 1;
    while (nextLoss > currentLoss && scale > 1 / 128) {
      scale /= 2;
      next = beta.map((value, j) => value - scale * step[j]);
      nextLoss = nll(features, labels, next, l2);
    }
    beta = next;
    if (stepNorm < 1e-7) {
      converged = true;
      break;
    }
  }

  return { beta, converged, iterations, loss: nll(features, labels, beta, l2) };
}

export function plattFeatures(rows) {
  return rows.map((row) => [1, logit(row.model_p_home)]);
}

export function residualFeatures(rows) {
  return rows.map((row) => [
    1,
    logit(row.market_p_home),
    logit(row.model_p_home) - logit(row.market_p_home),
  ]);
}

export function labels(rows) {
  return rows.map((row) => num(row.outcome_home));
}

export function predictLogistic(beta, feature) {
  return sigmoid(feature.reduce((sum, value, j) => sum + value * beta[j], 0));
}

export function addPredictions(rows, { plattCoef = null, residualCoef = null } = {}) {
  return rows.map((row) => ({
    ...row,
    p_model_cal: plattCoef ? predictLogistic(plattCoef, [1, logit(row.model_p_home)]) : undefined,
    p_final: residualCoef ? predictLogistic(residualCoef, [
      1,
      logit(row.market_p_home),
      logit(row.model_p_home) - logit(row.market_p_home),
    ]) : undefined,
  }));
}

export function brier(rows, pFn) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => sum + (pFn(row) - row.outcome_home) ** 2, 0) / rows.length;
}

export function logLoss(rows, pFn) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => {
    const p = clamp(pFn(row), 0.000001, 0.999999);
    return sum - (row.outcome_home * Math.log(p) + (1 - row.outcome_home) * Math.log(1 - p));
  }, 0) / rows.length;
}

export function metricRow(label, rows, predictors) {
  const out = { label, n: rows.length };
  for (const [name, pFn] of Object.entries(predictors)) {
    out[`brier_${name}`] = brier(rows, pFn);
    out[`logloss_${name}`] = logLoss(rows, pFn);
  }
  return out;
}

export function calibrationBuckets(rows, pFn, bucketCount = 10) {
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    bucket: `${fmt(i / bucketCount, 1)}-${fmt((i + 1) / bucketCount, 1)}`,
    n: 0,
    p_sum: 0,
    wins: 0,
  }));
  for (const row of rows) {
    const p = clamp(pFn(row), 0, 0.999999);
    const idx = Math.floor(p * bucketCount);
    buckets[idx].n += 1;
    buckets[idx].p_sum += p;
    buckets[idx].wins += row.outcome_home;
  }
  return buckets.map((bucket) => ({
    ...bucket,
    mean_p: bucket.n ? bucket.p_sum / bucket.n : NaN,
    hit_rate: bucket.n ? bucket.wins / bucket.n : NaN,
    bias: bucket.n ? bucket.p_sum / bucket.n - bucket.wins / bucket.n : NaN,
  }));
}

export function seededRandom(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function bootstrapCoef(rows, featureFn, labelFn, { iterations = 1000, seed = SEED } = {}) {
  const random = seededRandom(seed);
  const coefs = [];
  let failures = 0;
  for (let i = 0; i < iterations; i += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    const fit = fitLogistic(featureFn(sample), labelFn(sample), { maxIter: 80 });
    if (!fit.beta.every(Number.isFinite)) {
      failures += 1;
      continue;
    }
    coefs.push(fit.beta);
  }
  return { coefs, failures };
}

export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function ciFor(coefs, index) {
  const values = coefs.map((coef) => coef[index]).filter(Number.isFinite);
  return {
    low: percentile(values, 0.025),
    high: percentile(values, 0.975),
  };
}

export function wilson(successes, n, z = 1.96) {
  if (!n) return { low: NaN, high: NaN };
  const phat = successes / n;
  const denom = 1 + z ** 2 / n;
  const center = (phat + z ** 2 / (2 * n)) / denom;
  const half = z * Math.sqrt((phat * (1 - phat) + z ** 2 / (4 * n)) / n) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function markdownTable(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `|${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join('|')}|`;
  const body = rows.map((row) => `| ${columns.map((col) => col.format ? col.format(row[col.key]) : row[col.key]).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeMarkdown(filePath, lines) {
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}
