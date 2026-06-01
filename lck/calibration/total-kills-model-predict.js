import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clamp, num } from '../shared.js';

const COEF_PATH = path.join(process.cwd(), 'lck', 'calibration', 'total_kills_model_coef.json');

let cached = null;

function loadCoef() {
  if (cached !== null) return cached;
  if (!existsSync(COEF_PATH)) {
    cached = null;
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(COEF_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
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

function z(value, scaler) {
  const sd = Number(scaler?.sd || 0);
  if (!Number.isFinite(sd) || sd <= 1e-9) return 0;
  return (Number(value || 0) - Number(scaler.mean || 0)) / sd;
}

export function totalKillsFeatures(team, opponent) {
  return {
    avg_total_mean: (num(team.avg_total_kills) + num(opponent.avg_total_kills)) / 2,
    avg_time_mean: (num(team.avg_game_time_min) + num(opponent.avg_game_time_min)) / 2,
    strength_abs_diff: Math.abs(num(team.strength_score) - num(opponent.strength_score)),
    recent_map_win_abs_diff: Math.abs(num(team.recent_10_map_win_rate) - num(opponent.recent_10_map_win_rate)),
    avg_kill_diff_sum: num(team.avg_kill_diff) + num(opponent.avg_kill_diff),
    first_turret_mean: (num(team.first_turret_rate) + num(opponent.first_turret_rate)) / 2,
  };
}

export function predictTotalKills(team, opponent, patch = '') {
  const coef = loadCoef();
  if (!coef || coef.deploy !== true) return null;

  const features = totalKillsFeatures(team, opponent);
  let mean = Number(coef.intercept || 0);
  for (const name of coef.features || []) {
    mean += Number(coef.beta?.[name] || 0) * z(features[name], coef.scaler?.[name]);
  }
  const patchKey = patch || team.current_patch || opponent.current_patch || '';
  mean += Number(coef.patch_gamma?.[patchKey] || 0);

  const sigma = Math.max(3.5, Number(coef.sigma || 7.5));
  return {
    model: coef.model || 'lck_total_kills_continuous_normal_v1',
    mean,
    sigma,
    p_over(line) {
      return clamp(1 - normalCdf((Number(line) - mean) / sigma), 0.02, 0.98);
    },
    p_under(line) {
      return clamp(normalCdf((Number(line) - mean) / sigma), 0.02, 0.98);
    },
  };
}
