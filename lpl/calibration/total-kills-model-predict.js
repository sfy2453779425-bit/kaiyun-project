import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clamp, num } from '../shared.js';

const DEFAULT_COEF_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_model_coef.json');

let cachedPath = null;
let cachedModel = null;

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

export function loadTotalKillsModel(filePath = DEFAULT_COEF_PATH) {
  const resolved = path.resolve(filePath);
  if (cachedModel && cachedPath === resolved) return cachedModel;
  if (!existsSync(resolved)) return null;
  const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  cachedPath = resolved;
  cachedModel = parsed;
  return cachedModel;
}

export function totalKillsFeatures(team, opponent) {
  const strengthDiff = num(team.strength_score) - num(opponent.strength_score);
  const strengthAbsDiff = Math.abs(strengthDiff);
  const favorite = strengthDiff >= 0 ? team : opponent;
  const underdog = strengthDiff >= 0 ? opponent : team;
  const avgTimeMean = (num(team.avg_game_time_min, 32) + num(opponent.avg_game_time_min, 32)) / 2;
  const firstTurretMean = (num(team.first_turret_rate, 0.5) + num(opponent.first_turret_rate, 0.5)) / 2;
  const shortGameRateMean = 1 - ((num(team.time_over_31_5_rate, 0.5) + num(opponent.time_over_31_5_rate, 0.5)) / 2);
  const underdogExpectedKillsProxy = num(underdog.avg_kills, 13) * Math.exp(-0.035 * strengthAbsDiff);
  return {
    avg_total_mean: (num(team.avg_total_kills, 28) + num(opponent.avg_total_kills, 28)) / 2,
    avg_time_mean: avgTimeMean,
    strength_abs_diff: strengthAbsDiff,
    strength_signed_diff: strengthDiff,
    recent_abs_diff: Math.abs(num(team.recent_10_map_win_rate, 0.5) - num(opponent.recent_10_map_win_rate, 0.5)),
    avg_kill_diff_sum: num(team.avg_kill_diff) + num(opponent.avg_kill_diff),
    first_turret_mean: firstTurretMean,
    strength_abs_diff_sq: strengthAbsDiff ** 2,
    strength_abs_diff_x_avg_time_mean: strengthAbsDiff * avgTimeMean,
    short_game_rate_mean: shortGameRateMean,
    fast_finish_pressure: strengthAbsDiff * shortGameRateMean,
    underdog_expected_kills_proxy: underdogExpectedKillsProxy,
    underdog_kill_compression: Math.max(0, 13 - underdogExpectedKillsProxy) * strengthAbsDiff,
    first_turret_strength_interaction: firstTurretMean * strengthAbsDiff,
    favorite_avg_kills: num(favorite.avg_kills, 14),
    underdog_avg_kills: num(underdog.avg_kills, 13),
    patch: team.current_patch || opponent.current_patch || '',
  };
}

function featureVector(features, model) {
  return model.features.map((key) => {
    const value = num(features[key], 0);
    const scaler = model.scaler?.[key];
    if (!scaler) return value;
    return (value - num(scaler.mean)) / Math.max(num(scaler.sd, 1), 0.000001);
  });
}

export function predictTotalKills(team, opponent, options = {}) {
  const model = options.model || loadTotalKillsModel(options.coefPath || DEFAULT_COEF_PATH);
  if (!model || model.deploy !== true) return null;
  const features = totalKillsFeatures(team, opponent);
  const vector = featureVector(features, model);
  let mean = num(model.intercept, 28);
  for (let i = 0; i < vector.length; i += 1) mean += vector[i] * num(model.beta?.[model.features[i]], 0);
  mean += num(model.patch_gamma?.[features.patch], 0);
  mean = clamp(mean, 8, 65);
  const sigma = clamp(num(model.sigma, 7), 2.5, 18);

  return {
    mean,
    sigma,
    features,
    p_over(line) {
      return clamp(1 - normalCdf((num(line) - mean) / sigma), 0.000001, 0.999999);
    },
    p_under(line) {
      return clamp(normalCdf((num(line) - mean) / sigma), 0.000001, 0.999999);
    },
  };
}
