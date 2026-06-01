import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildProfiles, coverProbability } from '../build-market-analysis.js';
import { buildSnapshotSummary, isFinishedMatch, readHistoryData, rowDate } from '../backtest/common.js';
import { clamp, logistic, num, readCsvIfExists, teamKey } from '../shared.js';
import {
  nbPmfArray,
  predictTeamKills,
  predictTeamKillsHandicap,
} from './team-kills-nb-predict.js';

const SEED = 20260601;
const PRIOR_N = 20;
const MAX_BOOTSTRAP = 1000;
const LINES = [12.5, 15.5, 18.5, 21.5];
const COEF_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'team_kills_nb_coef.json');
const REPORT_PATH = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '校准层-team-kills-NB.md');
const CURRENT_DATA_DIR = path.join(process.cwd(), 'lpl', 'data');

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

function markdownTable(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `|${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join('|')}|`;
  const body = rows.map((row) => `| ${columns.map((col) => col.format ? col.format(row[col.key]) : row[col.key]).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
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

function std(values) {
  return Math.sqrt(Math.max(variance(values), 0));
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function maxAbs(values) {
  return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

function addScaled(a, b, scale) {
  const out = Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] + b[i] * scale;
  return out;
}

function logGamma(z) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const zz = z - 1;
  for (let i = 0; i < coefficients.length; i += 1) x += coefficients[i] / (zz + i + 1);
  const t = zz + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

function nbLogPmf(kills, meanKills, dispersionK) {
  const y = Math.max(0, Math.round(num(kills)));
  const mu = Math.max(num(meanKills), 0.000001);
  const k = Math.max(num(dispersionK, 20), 0.05);
  return logGamma(y + k) - logGamma(k) - logGamma(y + 1)
    + k * Math.log(k / (k + mu))
    + y * Math.log(mu / (k + mu));
}

function safeExp(value) {
  return Math.exp(clamp(num(value), -4, 4.6));
}

function countBy(rows, keyFn) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

function sortedKeysByCount(rows, keyFn) {
  return [...countBy(rows, keyFn).entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key]) => key);
}

function sideFor(map, teamId) {
  const key = teamKey(teamId);
  if (teamKey(map.blue_team_id || map.blue_team) === key) return 'blue';
  if (teamKey(map.red_team_id || map.red_team) === key) return 'red';
  return '';
}

function mapSideRows(map) {
  const aId = teamKey(map.team_a_id || map.team_a);
  const bId = teamKey(map.team_b_id || map.team_b);
  if (!aId || !bId) return [];
  return [
    {
      team_id: aId,
      team_name: map.team_a,
      opponent_id: bId,
      opponent_name: map.team_b,
      kills: num(map.team_a_kills),
      opponent_kills: num(map.team_b_kills),
      side: sideFor(map, aId),
    },
    {
      team_id: bId,
      team_name: map.team_b,
      opponent_id: aId,
      opponent_name: map.team_a,
      kills: num(map.team_b_kills),
      opponent_kills: num(map.team_a_kills),
      side: sideFor(map, bId),
    },
  ];
}

function modelPatch(row) {
  return String(row.patch || 'unknown');
}

function isEligibleMap(map) {
  const date = rowDate(map);
  return ['2024', '2025'].includes(yearOf(date))
    && teamKey(map.team_a_id || map.team_a)
    && teamKey(map.team_b_id || map.team_b)
    && Number.isFinite(num(map.team_a_kills, NaN))
    && Number.isFinite(num(map.team_b_kills, NaN));
}

function buildObservations(matches, maps) {
  const eligibleMaps = maps
    .filter(isEligibleMap)
    .sort((a, b) => String(rowDate(a)).localeCompare(String(rowDate(b))) || num(a.bo) - num(b.bo));
  const snapshotCache = new Map();
  const observations = [];

  for (const map of eligibleMaps) {
    const cutoff = rowDate(map);
    if (!snapshotCache.has(cutoff)) {
      snapshotCache.set(cutoff, buildProfiles(matches, maps, buildSnapshotSummary(maps, cutoff), cutoff));
    }
    const profiles = snapshotCache.get(cutoff);
    for (const side of mapSideRows(map)) {
      const team = profiles.get(side.team_id);
      const opponent = profiles.get(side.opponent_id);
      observations.push({
        split_year: yearOf(cutoff),
        match_id: map.match_id,
        game_id: map.game_id,
        match_name: map.match_name,
        match_date: cutoff,
        map_bo: num(map.bo),
        patch: modelPatch(map),
        team_id: side.team_id,
        team_name: side.team_name || side.team_id,
        opponent_id: side.opponent_id,
        opponent_name: side.opponent_name || side.opponent_id,
        side: side.side,
        is_blue_side: side.side === 'blue' ? 1 : 0,
        kills: side.kills,
        opponent_kills: side.opponent_kills,
        opponent_strength_score_shrunk: num(opponent?.strength_score, 50),
        team_strength_score_shrunk: num(team?.strength_score, 50),
        team_prior_maps: num(team?.maps, 0),
        opponent_prior_maps: num(opponent?.maps, 0),
        team_avg_kills_prior: num(team?.avg_kills, 14),
        opponent_avg_kills_prior: num(opponent?.avg_kills, 14),
      });
    }
  }

  return observations;
}

function initialDispersionByTeam(rows) {
  const kills = rows.map((row) => num(row.kills)).filter(Number.isFinite);
  const globalMean = mean(kills) || 14;
  const globalVariance = variance(kills, globalMean);
  const rawGlobalK = globalVariance > globalMean
    ? globalMean ** 2 / Math.max(globalVariance - globalMean, 0.000001)
    : 80;
  const globalK = clamp(rawGlobalK, 1.2, 150);
  const byTeam = new Map();
  for (const row of rows) {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push(num(row.kills));
  }
  const out = {};
  for (const [teamId, values] of byTeam) {
    const m = mean(values) || globalMean;
    const v = variance(values, m);
    const raw = values.length >= 3 && v > m ? m ** 2 / Math.max(v - m, 0.000001) : globalK;
    const shrunk = Math.exp((values.length * Math.log(clamp(raw, 1.2, 150)) + PRIOR_N * Math.log(globalK)) / (values.length + PRIOR_N));
    out[teamId] = clamp(shrunk, 1.2, 150);
  }
  return { globalMean, globalK, dispersionByTeam: out };
}

function buildSpec(rows) {
  const teams = sortedKeysByCount(rows, (row) => row.team_id);
  const patches = sortedKeysByCount(rows, (row) => row.patch);
  const baselinePatch = patches[0] || 'unknown';
  const patchParams = patches.filter((patch) => patch !== baselinePatch);
  const strengths = rows.map((row) => num(row.opponent_strength_score_shrunk, 50));
  const strengthMean = mean(strengths) || 50;
  const strengthSd = std(strengths) || 1;
  const { globalMean, globalK, dispersionByTeam } = initialDispersionByTeam(rows);

  const rowsByTeam = new Map();
  for (const row of rows) {
    if (!rowsByTeam.has(row.team_id)) rowsByTeam.set(row.team_id, []);
    rowsByTeam.get(row.team_id).push(row);
  }
  const teamPriors = {};
  const teamNames = {};
  const meanStrengthByTeam = {};
  for (const teamId of teams) {
    const teamRows = rowsByTeam.get(teamId) || [];
    const rawMean = mean(teamRows.map((row) => num(row.kills))) || globalMean;
    const shrunkMean = (rawMean * teamRows.length + globalMean * PRIOR_N) / (teamRows.length + PRIOR_N);
    teamPriors[teamId] = Math.log(Math.max(shrunkMean, 0.01));
    teamNames[teamId] = teamRows.find((row) => row.team_name)?.team_name || teamId;
    meanStrengthByTeam[teamId] = mean(teamRows.map((row) => num(row.team_strength_score_shrunk, 50))) || 50;
  }

  const betaIndex = 0;
  const deltaIndex = 1;
  const gammaStart = 2;
  const alphaStart = gammaStart + patchParams.length;
  return {
    teams,
    patches,
    baselinePatch,
    patchParams,
    teamPriors,
    teamNames,
    meanStrengthByTeam,
    strengthMean,
    strengthSd,
    globalMean,
    globalK,
    dispersionByTeam,
    betaIndex,
    deltaIndex,
    gammaStart,
    alphaStart,
    paramCount: alphaStart + teams.length,
    teamIndex: new Map(teams.map((team, index) => [team, index])),
    patchIndex: new Map(patchParams.map((patch, index) => [patch, index])),
  };
}

function initialTheta(spec, model = null) {
  const theta = Array(spec.paramCount).fill(0);
  theta[spec.betaIndex] = num(model?.global?.beta_opp, -0.03);
  theta[spec.deltaIndex] = num(model?.global?.delta_blue, 0.02);
  for (const patch of spec.patchParams) {
    theta[spec.gammaStart + spec.patchIndex.get(patch)] = num(model?.global?.gamma_patch?.[patch], 0);
  }
  for (const teamId of spec.teams) {
    theta[spec.alphaStart + spec.teamIndex.get(teamId)] = num(model?.teams?.[teamId]?.alpha_team, spec.teamPriors[teamId]);
  }
  return theta;
}

function rowEta(row, theta, spec) {
  const zOpp = (num(row.opponent_strength_score_shrunk, spec.strengthMean) - spec.strengthMean) / spec.strengthSd;
  const patchOffset = spec.patchIndex.has(row.patch)
    ? theta[spec.gammaStart + spec.patchIndex.get(row.patch)]
    : 0;
  const teamOffset = spec.teamIndex.has(row.team_id)
    ? theta[spec.alphaStart + spec.teamIndex.get(row.team_id)]
    : Math.log(spec.globalMean);
  return teamOffset
    + theta[spec.betaIndex] * zOpp
    + theta[spec.deltaIndex] * num(row.is_blue_side)
    + patchOffset;
}

function rowMean(row, theta, spec) {
  return safeExp(rowEta(row, theta, spec));
}

function valueGradient(theta, rows, spec, dispersionByTeam) {
  const gradient = Array(theta.length).fill(0);
  let loss = 0;
  for (const row of rows) {
    const y = num(row.kills);
    const k = Math.max(num(dispersionByTeam[row.team_id], spec.globalK), 0.05);
    const mu = rowMean(row, theta, spec);
    loss -= nbLogPmf(y, mu, k);
    const dEta = mu * (k + y) / (k + mu) - y;
    const zOpp = (num(row.opponent_strength_score_shrunk, spec.strengthMean) - spec.strengthMean) / spec.strengthSd;
    gradient[spec.betaIndex] += dEta * zOpp;
    gradient[spec.deltaIndex] += dEta * num(row.is_blue_side);
    if (spec.patchIndex.has(row.patch)) gradient[spec.gammaStart + spec.patchIndex.get(row.patch)] += dEta;
    if (spec.teamIndex.has(row.team_id)) gradient[spec.alphaStart + spec.teamIndex.get(row.team_id)] += dEta;
  }

  for (const teamId of spec.teams) {
    const idx = spec.alphaStart + spec.teamIndex.get(teamId);
    const diff = theta[idx] - spec.teamPriors[teamId];
    loss += 0.5 * PRIOR_N * diff ** 2;
    gradient[idx] += PRIOR_N * diff;
  }
  const globalL2 = 0.05;
  const gammaL2 = 0.25;
  for (const idx of [spec.betaIndex, spec.deltaIndex]) {
    loss += 0.5 * globalL2 * theta[idx] ** 2;
    gradient[idx] += globalL2 * theta[idx];
  }
  for (const patch of spec.patchParams) {
    const idx = spec.gammaStart + spec.patchIndex.get(patch);
    loss += 0.5 * gammaL2 * theta[idx] ** 2;
    gradient[idx] += gammaL2 * theta[idx];
  }

  const scale = 1 / Math.max(1, rows.length);
  return {
    value: loss * scale,
    gradient: gradient.map((value) => value * scale),
  };
}

function lbfgs(initial, objective, { maxIter = 120, tolerance = 1e-5, memory = 8 } = {}) {
  let theta = [...initial];
  let evaluation = objective(theta);
  const history = [];
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter += 1) {
    iterations = iter + 1;
    const gradNorm = maxAbs(evaluation.gradient);
    if (gradNorm < tolerance) {
      converged = true;
      break;
    }

    let direction = lbfgsDirection(evaluation.gradient, history);
    let directionalDerivative = dot(evaluation.gradient, direction);
    if (!Number.isFinite(directionalDerivative) || directionalDerivative >= 0) {
      direction = evaluation.gradient.map((value) => -value);
      directionalDerivative = dot(evaluation.gradient, direction);
    }

    let step = 1;
    let nextTheta = null;
    let nextEvaluation = null;
    for (let lineIter = 0; lineIter < 30; lineIter += 1) {
      const candidate = addScaled(theta, direction, step);
      const candidateEval = objective(candidate);
      if (Number.isFinite(candidateEval.value)
        && candidateEval.value <= evaluation.value + 1e-4 * step * directionalDerivative) {
        nextTheta = candidate;
        nextEvaluation = candidateEval;
        break;
      }
      step *= 0.5;
    }

    if (!nextTheta || !nextEvaluation) break;
    const s = nextTheta.map((value, index) => value - theta[index]);
    const y = nextEvaluation.gradient.map((value, index) => value - evaluation.gradient[index]);
    const ys = dot(y, s);
    if (ys > 1e-12) {
      history.push({ s, y, rho: 1 / ys });
      if (history.length > memory) history.shift();
    }
    theta = nextTheta;
    evaluation = nextEvaluation;
  }

  return {
    theta,
    loss: evaluation.value,
    gradient_norm: maxAbs(evaluation.gradient),
    converged,
    iterations,
  };
}

function lbfgsDirection(gradient, history) {
  const q = [...gradient];
  const alphas = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    const alpha = item.rho * dot(item.s, q);
    alphas[i] = alpha;
    for (let j = 0; j < q.length; j += 1) q[j] -= alpha * item.y[j];
  }
  let gamma = 1;
  if (history.length) {
    const last = history[history.length - 1];
    const yy = dot(last.y, last.y);
    if (yy > 0) gamma = dot(last.s, last.y) / yy;
  }
  const r = q.map((value) => value * gamma);
  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    const beta = item.rho * dot(item.y, r);
    const alpha = alphas[i] || 0;
    for (let j = 0; j < r.length; j += 1) r[j] += item.s[j] * (alpha - beta);
  }
  return r.map((value) => -value);
}

function updateDispersions(rows, theta, spec) {
  const residualRatios = [];
  const byTeam = new Map();
  for (const row of rows) {
    const mu = rowMean(row, theta, spec);
    const y = num(row.kills);
    const ratio = ((y - mu) ** 2 - y) / Math.max(mu ** 2, 0.000001);
    residualRatios.push(ratio);
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push(ratio);
  }
  const globalRatio = Math.max(mean(residualRatios), 1 / 150);
  const globalK = clamp(1 / globalRatio, 1.2, 150);
  const out = {};
  for (const teamId of spec.teams) {
    const ratios = byTeam.get(teamId) || [];
    const rawRatio = Math.max(mean(ratios), 1 / 150);
    const rawK = clamp(1 / rawRatio, 1.2, 150);
    out[teamId] = clamp(Math.exp((ratios.length * Math.log(rawK) + PRIOR_N * Math.log(globalK)) / (ratios.length + PRIOR_N)), 1.2, 150);
  }
  return { dispersionByTeam: out, globalK };
}

function fitNbModel(rows, options = {}) {
  const spec = buildSpec(rows);
  let dispersionByTeam = { ...spec.dispersionByTeam };
  let theta = initialTheta(spec, options.initialModel);
  let fit = lbfgs(theta, (candidate) => valueGradient(candidate, rows, spec, dispersionByTeam), {
    maxIter: options.maxIter || 120,
    tolerance: options.tolerance || 1e-5,
    memory: options.memory || 8,
  });
  theta = fit.theta;

  if (options.updateDispersion !== false) {
    const updated = updateDispersions(rows, theta, spec);
    dispersionByTeam = updated.dispersionByTeam;
    spec.globalK = updated.globalK;
    fit = lbfgs(theta, (candidate) => valueGradient(candidate, rows, spec, dispersionByTeam), {
      maxIter: options.secondMaxIter || 100,
      tolerance: options.tolerance || 1e-5,
      memory: options.memory || 8,
    });
    theta = fit.theta;
    const finalDispersion = updateDispersions(rows, theta, spec);
    dispersionByTeam = finalDispersion.dispersionByTeam;
    spec.globalK = finalDispersion.globalK;
  }

  return modelFromFit(rows, theta, spec, dispersionByTeam, fit);
}

function modelFromFit(rows, theta, spec, dispersionByTeam, fit) {
  const gammaPatch = { [spec.baselinePatch]: 0 };
  for (const patch of spec.patchParams) gammaPatch[patch] = theta[spec.gammaStart + spec.patchIndex.get(patch)];
  const rowsByTeam = new Map();
  for (const row of rows) {
    if (!rowsByTeam.has(row.team_id)) rowsByTeam.set(row.team_id, []);
    rowsByTeam.get(row.team_id).push(row);
  }
  const teams = {};
  for (const teamId of spec.teams) {
    const teamRows = rowsByTeam.get(teamId) || [];
    const idx = spec.alphaStart + spec.teamIndex.get(teamId);
    const means = teamRows.map((row) => rowMean(row, theta, spec));
    teams[teamId] = {
      team: spec.teamNames[teamId] || teamId,
      alpha_team: theta[idx],
      alpha_prior: spec.teamPriors[teamId],
      n_fit: teamRows.length,
      mean_fit: mean(means),
      mean_observed_fit: mean(teamRows.map((row) => num(row.kills))),
      dispersion_k: dispersionByTeam[teamId] || spec.globalK,
      mean_strength_score: spec.meanStrengthByTeam[teamId] || 50,
    };
  }
  return {
    model: 'team_kills_negative_binomial_v1',
    formula: 'kills ~ NegBin(mu, k), log(mu)=alpha_team + beta_opp*z(opponent_strength_score_shrunk) + gamma_patch + delta_blue',
    fit_year: 2024,
    prior_n: PRIOR_N,
    global: {
      beta_opp: theta[spec.betaIndex],
      delta_blue: theta[spec.deltaIndex],
      gamma_patch: gammaPatch,
      baseline_patch: spec.baselinePatch,
      global_alpha: Math.log(spec.globalMean),
      global_mean_kills: spec.globalMean,
      global_dispersion_k: spec.globalK,
    },
    scaler: {
      opponent_strength_mean: spec.strengthMean,
      opponent_strength_sd: spec.strengthSd,
    },
    teams,
    fit: {
      converged: fit.converged,
      iterations: fit.iterations,
      loss: fit.loss,
      gradient_norm: fit.gradient_norm,
      n_observations: rows.length,
      n_teams: spec.teams.length,
      n_patches: spec.patches.length,
    },
    nonconverged_teams: [],
    generated_at: new Date().toISOString(),
  };
}

function bootstrapBeta(fitRows) {
  const random = seededRandom(SEED);
  const betaValues = [];
  let failures = 0;
  for (let i = 0; i < MAX_BOOTSTRAP; i += 1) {
    const sample = Array.from({ length: fitRows.length }, () => fitRows[Math.floor(random() * fitRows.length)]);
    try {
      const fit = fitNbModel(sample, {
        maxIter: 35,
        secondMaxIter: 0,
        updateDispersion: false,
        tolerance: 2e-5,
        memory: 5,
      });
      if (Number.isFinite(fit.global.beta_opp)) betaValues.push(fit.global.beta_opp);
      else failures += 1;
    } catch {
      failures += 1;
    }
    if ((i + 1) % 100 === 0) console.log(`bootstrap ${i + 1}/${MAX_BOOTSTRAP}`);
  }
  return {
    values: betaValues,
    failures,
    ci: {
      low: percentile(betaValues, 0.025),
      high: percentile(betaValues, 0.975),
    },
  };
}

function oldSingleTeamKillsOver(obs, line) {
  const meanKills = num(obs.team_avg_kills_prior, 14)
    - (num(obs.opponent_strength_score_shrunk, 50) - 50) * 0.04;
  return clamp(logistic((meanKills - num(line)) / 2.5), 0.05, 0.95);
}

function scoreRows(observations, model) {
  const rows = [];
  for (const obs of observations) {
    for (const line of LINES) {
      const nb = predictTeamKills(obs.team_id, obs.opponent_id, obs.patch, obs.side, {
        model,
        opponentStrengthScore: obs.opponent_strength_score_shrunk,
      });
      if (!nb) continue;
      rows.push({
        split_year: obs.split_year,
        match_id: obs.match_id,
        game_id: obs.game_id,
        match_date: obs.match_date,
        match_name: obs.match_name,
        team_id: obs.team_id,
        opponent_id: obs.opponent_id,
        patch: obs.patch,
        side: obs.side,
        line,
        prior_maps: obs.team_prior_maps,
        kills: obs.kills,
        outcome: obs.kills > line ? 1 : 0,
        p_old: oldSingleTeamKillsOver(obs, line),
        p_nb: nb.p_over(line),
        nb_mean: nb.mean,
        nb_k: nb.dispersion_k,
      });
    }
  }
  return rows;
}

function brier(rows, key) {
  return rows.length
    ? rows.reduce((sum, row) => sum + (num(row[key]) - num(row.outcome)) ** 2, 0) / rows.length
    : NaN;
}

function metricRow(label, rows) {
  return {
    label,
    n: rows.length,
    brier_old: brier(rows, 'p_old'),
    brier_nb: brier(rows, 'p_nb'),
    delta: brier(rows, 'p_nb') - brier(rows, 'p_old'),
  };
}

function metrics(scoreData) {
  const out = [
    metricRow('2024 fit / 2024 拟合内', scoreData.filter((row) => row.split_year === '2024')),
    metricRow('2025 OOS / 2025 样本外', scoreData.filter((row) => row.split_year === '2025')),
    metricRow('2025 low sample <20 maps / 2025 小样本队', scoreData.filter((row) => row.split_year === '2025' && num(row.prior_maps) < 20)),
  ];
  for (const line of LINES) {
    out.push(metricRow(`2025 line ${line}`, scoreData.filter((row) => row.split_year === '2025' && num(row.line) === line)));
  }
  return out;
}

function estimateHandicapDiffVarianceScale(rows, model) {
  const byGame = new Map();
  for (const row of rows) {
    const key = `${row.match_id}|${row.game_id}`;
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(row);
  }
  let residualSq = 0;
  let independentVariance = 0;
  let n = 0;
  for (const group of byGame.values()) {
    if (group.length < 2) continue;
    const a = group[0];
    const b = group[1];
    const predA = predictTeamKills(a.team_id, a.opponent_id, a.patch, a.side, {
      model,
      opponentStrengthScore: a.opponent_strength_score_shrunk,
    });
    const predB = predictTeamKills(b.team_id, b.opponent_id, b.patch, b.side, {
      model,
      opponentStrengthScore: b.opponent_strength_score_shrunk,
    });
    if (!predA || !predB) continue;
    const actualDiff = num(a.kills) - num(b.kills);
    const meanDiff = predA.mean - predB.mean;
    const varA = predA.mean + (predA.mean ** 2) / Math.max(predA.dispersion_k, 0.05);
    const varB = predB.mean + (predB.mean ** 2) / Math.max(predB.dispersion_k, 0.05);
    residualSq += (actualDiff - meanDiff) ** 2;
    independentVariance += varA + varB;
    n += 1;
  }
  const raw = independentVariance > 0 ? residualSq / independentVariance : 1;
  return {
    n_maps: n,
    raw_ratio: raw,
    scale: clamp(raw, 1, 3.5),
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function currentLgdTesCheck(model) {
  const matchesPath = path.join(CURRENT_DATA_DIR, 'lpl_matches.csv');
  const mapsPath = path.join(CURRENT_DATA_DIR, 'lpl_map_details.csv');
  if (!existsSync(matchesPath) || !existsSync(mapsPath)) return null;
  const [matches, maps, summary] = await Promise.all([
    readCsvIfExists(matchesPath),
    readCsvIfExists(mapsPath),
    readCsvIfExists(path.join(CURRENT_DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const cutoff = '2026-05-29';
  const profiles = buildProfiles(matches, maps, buildSnapshotSummary(maps, cutoff), cutoff);
  const lgd = profiles.get('LGD');
  const tes = profiles.get('TES');
  if (!lgd || !tes) return null;
  const match = matches.find((row) => String(row.match_date || '').startsWith(cutoff)
    && new Set([teamKey(row.team_a_id || row.team_a), teamKey(row.team_b_id || row.team_b)]).has('LGD')
    && new Set([teamKey(row.team_a_id || row.team_a), teamKey(row.team_b_id || row.team_b)]).has('TES'));
  const latestPatch = [...maps]
    .filter((row) => rowDate(row) < cutoff && row.patch)
    .sort((a, b) => String(rowDate(b)).localeCompare(String(rowDate(a))))[0]?.patch || lgd.current_patch || tes.current_patch || '';
  const nb = predictTeamKillsHandicap('LGD', 'TES', match?.patch || latestPatch, '', 8.5, {
    model,
    opponentStrengthScore: tes.strength_score,
    teamStrengthScore: lgd.strength_score,
  });
  return {
    match_name: match?.match_name || 'Top Esports vs LGD Gaming',
    cutoff,
    patch: match?.patch || latestPatch,
    old_cover_probability: coverProbability(lgd, tes, 8.5),
    nb_cover_probability: nb?.probability ?? NaN,
    lgd_nb_mean: nb?.team_mean ?? NaN,
    tes_nb_mean: nb?.opponent_mean ?? NaN,
    lgd_strength: lgd.strength_score,
    tes_strength: tes.strength_score,
    lgd_maps: lgd.maps,
    tes_maps: tes.maps,
  };
}

function pmfSanity(model) {
  const teams = Object.keys(model.teams || {}).slice(0, 3);
  return teams.map((teamId) => {
    const pred = predictTeamKills(teamId, 'TES', '', '', { model });
    const pmf = pred ? nbPmfArray(pred.mean, pred.dispersion_k, 80) : [];
    return {
      team_id: teamId,
      pmf_sum: pmf.reduce((sum, value) => sum + value, 0),
    };
  });
}

async function main() {
  const { matches, maps } = await readHistoryData();
  const observations = buildObservations(matches.filter(isFinishedMatch), maps);
  const fitRows = observations.filter((row) => row.split_year === '2024');
  const validateRows = observations.filter((row) => row.split_year === '2025');
  if (!fitRows.length || !validateRows.length) throw new Error('missing 2024 fit rows or 2025 validation rows');

  console.log(`observations: total=${observations.length}, 2024=${fitRows.length}, 2025=${validateRows.length}`);
  const model = fitNbModel(fitRows, { maxIter: 160, secondMaxIter: 120, tolerance: 1e-6 });
  const handicapVariance = estimateHandicapDiffVarianceScale(fitRows, model);
  model.global.handicap_diff_variance_scale = handicapVariance.scale;
  model.global.handicap_diff_variance_raw_ratio = handicapVariance.raw_ratio;
  model.global.handicap_diff_variance_n_maps = handicapVariance.n_maps;
  const boot = bootstrapBeta(fitRows);
  model.global.beta_opp_ci95 = boot.ci;
  model.global.beta_opp_mean_multiplier_per_1sd = Math.exp(model.global.beta_opp);
  model.global.beta_opp_ci95_multiplier = {
    low: Math.exp(boot.ci.low),
    high: Math.exp(boot.ci.high),
  };
  model.bootstrap = {
    iterations: MAX_BOOTSTRAP,
    seed: SEED,
    successful: boot.values.length,
    failures: boot.failures,
  };

  const scoreData = scoreRows(observations, model);
  const metricRows = metrics(scoreData);
  model.validation_metrics = metricRows;
  model.pmf_sanity = pmfSanity(model);
  const lgdTes = await currentLgdTesCheck(model);
  model.lgd_tes_2026_05_29 = lgdTes;

  await writeJson(COEF_PATH, model);

  const lowSampleTeams = Object.entries(model.teams)
    .filter(([, team]) => num(team.n_fit) < 20)
    .map(([teamId, team]) => ({ team_id: teamId, n_fit: team.n_fit, dispersion_k: team.dispersion_k }))
    .sort((a, b) => a.n_fit - b.n_fit || a.team_id.localeCompare(b.team_id));
  const coefRows = [
    {
      key: 'beta_opp',
      value: model.global.beta_opp,
      ci_low: boot.ci.low,
      ci_high: boot.ci.high,
      effect: Math.exp(model.global.beta_opp) - 1,
    },
    {
      key: 'delta_blue',
      value: model.global.delta_blue,
      ci_low: '',
      ci_high: '',
      effect: Math.exp(model.global.delta_blue) - 1,
    },
  ];

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  const lines = [
    '# 单队击杀 Negative Binomial 校准 / Team Kills Negative Binomial Calibration',
    '',
    `- Fit / 拟合: 2024 maps only, observations=${fitRows.length}.`,
    `- Validate / 验证: 2025 OOS observations=${validateRows.length}.`,
    `- Bootstrap / 自助法: ${MAX_BOOTSTRAP} resamples, seed=${SEED}, successful=${boot.values.length}, failures=${boot.failures}.`,
    `- Coef JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    '## Global Coefficients / 全局系数',
    '',
    markdownTable([
      { key: 'key', label: 'coef / 系数', align: 'left' },
      { key: 'value', label: 'value', format: fmt },
      { key: 'ci_low', label: 'CI low', format: (value) => value === '' ? '' : fmt(value) },
      { key: 'ci_high', label: 'CI high', format: (value) => value === '' ? '' : fmt(value) },
      { key: 'effect', label: 'mean change', format: pctFmt },
    ], coefRows),
    '',
    `- beta_opp meaning / beta_opp 含义: opponent strength +1 SD changes expected kills by **${pctFmt(Math.exp(model.global.beta_opp) - 1)}**.`,
    `- beta_opp 95% CI as multiplier / 均值倍率区间: **${fmt(Math.exp(boot.ci.low))} to ${fmt(Math.exp(boot.ci.high))}**.`,
    `- Handicap diff variance scale / 击杀让分差值方差膨胀: **${fmt(model.global.handicap_diff_variance_scale)}** (fit maps=${model.global.handicap_diff_variance_n_maps}).`,
    '',
    '## Brier Backtest / Brier 回测',
    '',
    markdownTable([
      { key: 'label', label: 'segment / 分段', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'brier_old', label: 'old extrapolation', format: fmt },
      { key: 'brier_nb', label: 'NB model', format: fmt },
      { key: 'delta', label: 'NB-old', format: fmt },
    ], metricRows),
    '',
    '## LGD vs TES G1 Check / LGD vs TES 第一局复算',
    '',
    lgdTes
      ? markdownTable([
        { key: 'match_name', label: 'match / 比赛', align: 'left' },
        { key: 'patch', label: 'patch' },
        { key: 'lgd_maps', label: 'LGD maps' },
        { key: 'tes_maps', label: 'TES maps' },
        { key: 'old_cover_probability', label: 'old LGD +8.5', format: pctFmt },
        { key: 'nb_cover_probability', label: 'NB LGD +8.5', format: pctFmt },
        { key: 'lgd_nb_mean', label: 'LGD mean', format: fmt },
        { key: 'tes_nb_mean', label: 'TES mean', format: fmt },
      ], [lgdTes])
      : '- Current 2026 LGD vs TES input not found / 未找到当前 2026 LGD vs TES 输入。',
    '',
    '## Low Sample Teams / 小样本队伍',
    '',
    lowSampleTeams.length
      ? markdownTable([
        { key: 'team_id', label: 'team', align: 'left' },
        { key: 'n_fit', label: 'n_fit' },
        { key: 'dispersion_k', label: 'k', format: fmt },
      ], lowSampleTeams)
      : '- None / 无。',
    '',
    '## Notes / 备注',
    '',
    `- Non-converged teams / 未收敛队伍: ${model.nonconverged_teams.length ? model.nonconverged_teams.join(', ') : 'none / 无'}.`,
    '- The old baseline is the previous single-team kills extrapolation: team avg kills adjusted by opponent strength, then logistic over line.',
    '- 旧基线是原单队击杀外推: 队伍均杀按对手强度修正后，用 logistic 转成 over 概率。',
  ];
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');

  console.log(`wrote ${COEF_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
  const oos = metricRows.find((row) => row.label.startsWith('2025 OOS'));
  console.log(`beta_opp=${fmt(model.global.beta_opp)} ci=[${fmt(boot.ci.low)}, ${fmt(boot.ci.high)}]`);
  console.log(`2025 Brier old=${fmt(oos?.brier_old)} nb=${fmt(oos?.brier_nb)}`);
  if (lgdTes) console.log(`LGD +8.5 old=${pctFmt(lgdTes.old_cover_probability)} nb=${pctFmt(lgdTes.nb_cover_probability)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
