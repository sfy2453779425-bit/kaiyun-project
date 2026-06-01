import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clamp, num, teamKey } from '../shared.js';

const DEFAULT_COEF_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'team_kills_nb_coef.json');
const DEFAULT_MAX_KILLS = 80;

let cachedPath = null;
let cachedModel = null;

function safeExp(value) {
  return Math.exp(clamp(num(value), -4, 4.6));
}

function normalizeSide(side) {
  const text = String(side || '').toLowerCase();
  if (text.startsWith('blue')) return 'blue';
  if (text.startsWith('red')) return 'red';
  return '';
}

function oppositeSide(side) {
  const normalized = normalizeSide(side);
  if (normalized === 'blue') return 'red';
  if (normalized === 'red') return 'blue';
  return '';
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

function nbVariance(mean, dispersionK) {
  const mu = Math.max(num(mean), 0.000001);
  const k = Math.max(num(dispersionK, 20), 0.05);
  return mu + (mu ** 2) / k;
}

function getTeam(model, teamId) {
  const key = teamKey(teamId);
  return model.teams?.[key] || null;
}

function standardizedStrength(model, opponentId, explicitStrength) {
  const scaler = model.scaler || {};
  const mean = num(scaler.opponent_strength_mean, 50);
  const sd = Math.max(num(scaler.opponent_strength_sd, 1), 0.000001);
  const opponent = getTeam(model, opponentId);
  const strength = Number.isFinite(Number(explicitStrength))
    ? Number(explicitStrength)
    : num(opponent?.mean_strength_score, mean);
  return (strength - mean) / sd;
}

function nbP0(mean, dispersionK) {
  const k = Math.max(num(dispersionK, 20), 0.05);
  const mu = Math.max(num(mean, 0), 0.000001);
  const p = k / (k + mu);
  return p ** k;
}

export function nbPmfArray(mean, dispersionK, maxKills = DEFAULT_MAX_KILLS) {
  const max = Math.max(1, Math.floor(num(maxKills, DEFAULT_MAX_KILLS)));
  const k = Math.max(num(dispersionK, 20), 0.05);
  const mu = Math.max(num(mean, 0), 0.000001);
  const q = mu / (k + mu);
  const pmf = Array(max + 1).fill(0);
  pmf[0] = nbP0(mu, k);
  let total = pmf[0];
  for (let x = 0; x < max; x += 1) {
    pmf[x + 1] = pmf[x] * ((x + k) / (x + 1)) * q;
    total += pmf[x + 1];
  }
  if (total > 0 && total < 1) pmf[max] += 1 - total;
  return pmf;
}

export function nbCdf(mean, dispersionK, threshold) {
  const x = Math.floor(num(threshold, -1));
  if (x < 0) return 0;
  const pmf = nbPmfArray(mean, dispersionK, Math.max(DEFAULT_MAX_KILLS, x + 20));
  let sum = 0;
  for (let i = 0; i <= Math.min(x, pmf.length - 1); i += 1) sum += pmf[i];
  return clamp(sum, 0, 1);
}

export function loadTeamKillsNbModel(filePath = DEFAULT_COEF_PATH) {
  const resolved = path.resolve(filePath);
  if (cachedModel && cachedPath === resolved) return cachedModel;
  if (!existsSync(resolved)) return null;
  const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  cachedPath = resolved;
  cachedModel = parsed;
  return cachedModel;
}

export function isTeamKillsNbReady(filePath = DEFAULT_COEF_PATH) {
  return Boolean(loadTeamKillsNbModel(filePath));
}

export function predictTeamKills(teamId, opponentId, patch = '', side = '', options = {}) {
  const model = options.model || loadTeamKillsNbModel(options.coefPath || DEFAULT_COEF_PATH);
  if (!model) return null;

  const team = getTeam(model, teamId);
  const global = model.global || {};
  const alpha = num(team?.alpha_team, num(global.global_alpha, Math.log(14)));
  const k = Math.max(num(team?.dispersion_k, num(global.global_dispersion_k, 20)), 0.05);
  const gamma = num(global.gamma_patch?.[String(patch || '')], 0);
  const isBlue = normalizeSide(side) === 'blue' ? 1 : 0;
  const zOpp = standardizedStrength(model, opponentId, options.opponentStrengthScore);
  const eta = alpha
    + num(global.beta_opp, 0) * zOpp
    + gamma
    + num(global.delta_blue, 0) * isBlue;
  const mean = clamp(safeExp(eta), 0.05, 80);

  return {
    team_id: teamKey(teamId),
    opponent_id: teamKey(opponentId),
    patch: String(patch || ''),
    side: normalizeSide(side),
    mean,
    dispersion_k: k,
    p_over(line) {
      return clamp(1 - nbCdf(mean, k, Math.floor(num(line))), 0.000001, 0.999999);
    },
    p_under(line) {
      return clamp(nbCdf(mean, k, Math.ceil(num(line)) - 1), 0.000001, 0.999999);
    },
    cdf(kills) {
      return nbCdf(mean, k, kills);
    },
  };
}

export function predictTeamKillsHandicap(teamId, opponentId, patch = '', side = '', line = 0, options = {}) {
  const model = options.model || loadTeamKillsNbModel(options.coefPath || DEFAULT_COEF_PATH);
  if (!model) return null;
  const normalizedSide = normalizeSide(side);
  if (!normalizedSide) {
    const blue = predictTeamKillsHandicap(teamId, opponentId, patch, 'blue', line, options);
    const red = predictTeamKillsHandicap(teamId, opponentId, patch, 'red', line, options);
    if (!blue || !red) return null;
    return {
      probability: (blue.probability + red.probability) / 2,
      team_mean: (blue.team_mean + red.team_mean) / 2,
      opponent_mean: (blue.opponent_mean + red.opponent_mean) / 2,
      team_k: (blue.team_k + red.team_k) / 2,
      opponent_k: (blue.opponent_k + red.opponent_k) / 2,
      diff_variance_scale: (num(blue.diff_variance_scale, 1) + num(red.diff_variance_scale, 1)) / 2,
      side: 'neutral_avg',
      model: blue.model === red.model ? blue.model : 'negative_binomial_neutral_avg',
    };
  }

  const team = predictTeamKills(teamId, opponentId, patch, normalizedSide, options);
  const opponent = predictTeamKills(opponentId, teamId, patch, oppositeSide(normalizedSide), {
    ...options,
    opponentStrengthScore: options.teamStrengthScore,
  });
  if (!team || !opponent) return null;

  const varianceScale = Math.max(num(options.diffVarianceScale, num(model.global?.handicap_diff_variance_scale, 1)), 1);
  if (varianceScale > 1.05) {
    const meanDiff = team.mean - opponent.mean;
    const sdDiff = Math.sqrt(Math.max((nbVariance(team.mean, team.dispersion_k) + nbVariance(opponent.mean, opponent.dispersion_k)) * varianceScale, 0.000001));
    const threshold = -num(line);
    const probability = 1 - normalCdf((threshold - meanDiff) / sdDiff);
    return {
      probability: clamp(probability, 0.000001, 0.999999),
      team_mean: team.mean,
      opponent_mean: opponent.mean,
      team_k: team.dispersion_k,
      opponent_k: opponent.dispersion_k,
      diff_variance_scale: varianceScale,
      side: normalizedSide,
      model: 'negative_binomial_diff_scaled',
    };
  }

  const maxKills = num(options.maxKills, DEFAULT_MAX_KILLS);
  const teamPmf = nbPmfArray(team.mean, team.dispersion_k, maxKills);
  const oppPmf = nbPmfArray(opponent.mean, opponent.dispersion_k, maxKills);
  let probability = 0;
  const handicap = num(line);
  for (let x = 0; x < teamPmf.length; x += 1) {
    for (let y = 0; y < oppPmf.length; y += 1) {
      if (x + handicap > y) probability += teamPmf[x] * oppPmf[y];
    }
  }

  return {
    probability: clamp(probability, 0.000001, 0.999999),
    team_mean: team.mean,
    opponent_mean: opponent.mean,
    team_k: team.dispersion_k,
    opponent_k: opponent.dispersion_k,
    side: normalizedSide,
    model: 'negative_binomial',
  };
}
