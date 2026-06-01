import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  avg,
  clamp,
  decimal,
  displayTeam,
  logistic,
  num,
  pct,
  pctText,
  readCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from './shared.js';
import { evaluateTemplate, writeEvaluationOutputs } from './odds-core.js';
import { predictTeamKillsHandicap } from './calibration/team-kills-nb-predict.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';

function before(rowDate, cutoffDate) {
  if (!cutoffDate) return true;
  return String(rowDate || '') < String(cutoffDate || '');
}

function matchScore(match, teamId) {
  if (match.team_a_id === teamId) return [num(match.score_a), num(match.score_b)];
  return [num(match.score_b), num(match.score_a)];
}

function sideKills(row, teamId) {
  return row.team_a_id === teamId ? num(row.team_a_kills) : num(row.team_b_kills);
}

function oppKills(row, teamId) {
  return row.team_a_id === teamId ? num(row.team_b_kills) : num(row.team_a_kills);
}

function sideTurrets(row, teamId) {
  return row.team_a_id === teamId ? num(row.team_a_turrets) : num(row.team_b_turrets);
}

function profileValue(primary, fallback, digits = 3) {
  const p = Number(primary);
  if (Number.isFinite(p) && p !== 0) return Number(p.toFixed(digits));
  const f = Number(fallback);
  return Number.isFinite(f) ? Number(f.toFixed(digits)) : 0;
}

// LPL-specific fix (Phase 2 决定): gol.gg 对 LPL 的 first_turret 缺失约 17%、first_blood 缺失 0.5%。
// 用全样本分母会系统性低估真实率约 17 个百分点,所以分母只算字段非空的 map。
function rateOverNonEmpty(maps, teamId, field) {
  const valid = maps.filter((row) => row[field]);
  if (!valid.length) return null;
  return valid.filter((row) => row[field] === teamId).length / valid.length;
}

const RATE_PRIOR_N = 20;
const PATCH_PRIOR_N = 12;
const PATCH_TEAM_PRIOR_CAP = 24;
const RECENT_HALF_LIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCENARIO_THRESHOLD_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'scenario_thresholds.json');

export const SCENARIOS = {
  FAST_STOMP: '强队速推碾压局',
  SLOW_FAVORITE: '强队慢热终结局',
  UNDERDOG_LIVE: '弱队能咬住但难赢',
  CHAOS_HIGH_KILL: '混乱高击杀局',
  LOW_KILL_MACRO: '低击杀运营局',
};

export const SCENARIO_NAMES = [
  SCENARIOS.FAST_STOMP,
  SCENARIOS.SLOW_FAVORITE,
  SCENARIOS.UNDERDOG_LIVE,
  SCENARIOS.CHAOS_HIGH_KILL,
  SCENARIOS.LOW_KILL_MACRO,
];

const DEFAULT_SCENARIO_THRESHOLDS = {
  high_kills_p70: 30,
  low_kills_p30: 28,
  high_time_p70: 31.5,
  low_time_p30: 30.8,
  chaos_p70: 58,
  chaos_p30: 52,
  strength_diff_p70: 15,
  strength_diff_p50: 11,
  strength_diff_p30: 6,
  avg_deaths_p70: 14.5,
  favorite_kills_p50: 15,
  first_turret_p60: 0.55,
  underdog_early_p50: 0.48,
};

let scenarioThresholdCache = null;

export function loadScenarioThresholds() {
  if (scenarioThresholdCache) return scenarioThresholdCache;
  if (!existsSync(SCENARIO_THRESHOLD_PATH)) {
    scenarioThresholdCache = DEFAULT_SCENARIO_THRESHOLDS;
    return scenarioThresholdCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(SCENARIO_THRESHOLD_PATH, 'utf8'));
    scenarioThresholdCache = {
      ...DEFAULT_SCENARIO_THRESHOLDS,
      ...(parsed.thresholds || parsed),
    };
  } catch {
    scenarioThresholdCache = DEFAULT_SCENARIO_THRESHOLDS;
  }
  return scenarioThresholdCache;
}

function safeRate(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
}

function shrinkRate(rawRate, sampleSize, prior = 0.5, priorN = RATE_PRIOR_N) {
  const n = Math.max(0, num(sampleSize));
  const rate = safeRate(rawRate, prior);
  if (!n) return rate;
  return clamp((rate * n + prior * priorN) / (n + priorN), 0, 1);
}

function shrinkScore(rawScore, sampleSize, prior = 50, priorN = RATE_PRIOR_N) {
  const n = Math.max(0, num(sampleSize));
  const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : prior;
  if (!n) return score;
  return prior + (score - prior) * (n / (n + priorN));
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

function effectiveCutoffMs(cutoffDate, rows) {
  const explicit = dateMs(cutoffDate);
  if (explicit != null) return explicit;
  const latest = rows.reduce((max, row) => Math.max(max, dateMs(rowDate(row)) || 0), 0);
  return latest ? latest + DAY_MS : Date.now();
}

function decayWeight(row, cutoffMs, halfLifeDays = RECENT_HALF_LIFE_DAYS) {
  const ms = dateMs(rowDate(row));
  if (ms == null || !cutoffMs) return 1;
  const ageDays = Math.max(0, (cutoffMs - ms) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

function decayedRate(rows, predicate, cutoffMs) {
  let weightedHits = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const weight = decayWeight(row, cutoffMs);
    totalWeight += weight;
    if (predicate(row)) weightedHits += weight;
  }
  return {
    rate: totalWeight ? weightedHits / totalWeight : NaN,
    effectiveN: totalWeight,
  };
}

function meanOf(rows, valueFn, fallback = 0) {
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const value = Number(valueFn(row));
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count ? total / count : fallback;
}

function latestPatch(rows) {
  let latest = null;
  for (const row of rows) {
    if (!row.patch) continue;
    const ms = dateMs(rowDate(row)) || 0;
    if (!latest || ms >= latest.ms) latest = { patch: row.patch, ms };
  }
  return latest?.patch || '';
}

function patchAdjustedMean(allRows, patchRows, valueFn, leaguePatchMean, fallback = 0) {
  const allMean = meanOf(allRows, valueFn, fallback);
  const patchMean = meanOf(patchRows, valueFn, allMean);
  const patchN = patchRows.length;
  const teamPriorN = Math.min(allRows.length, PATCH_TEAM_PRIOR_CAP);
  const leagueMean = Number.isFinite(leaguePatchMean) ? leaguePatchMean : allMean;
  const denom = patchN + teamPriorN + PATCH_PRIOR_N;
  if (!denom) return fallback;
  return (patchMean * patchN + allMean * teamPriorN + leagueMean * PATCH_PRIOR_N) / denom;
}

function patchAdjustedRate(allRows, patchRows, predicate, leaguePatchRate, fallback = 0.5) {
  const allRate = allRows.length ? pct(allRows.filter(predicate).length, allRows.length) : fallback;
  const patchHits = patchRows.filter(predicate).length;
  const patchN = patchRows.length;
  const teamPriorN = Math.min(allRows.length, PATCH_TEAM_PRIOR_CAP);
  const leagueRate = Number.isFinite(leaguePatchRate) ? leaguePatchRate : allRate;
  const denom = patchN + teamPriorN + PATCH_PRIOR_N;
  if (!denom) return fallback;
  return clamp((patchHits + allRate * teamPriorN + leagueRate * PATCH_PRIOR_N) / denom, 0, 1);
}

export function buildProfiles(matchRows, mapRows, summaryRows, cutoffDate = '') {
  const teams = new Map();
  for (const row of summaryRows) teams.set(row.team_id, row.team);
  for (const match of matchRows) {
    teams.set(match.team_a_id, displayTeam(match.team_a_id, match.team_a));
    teams.set(match.team_b_id, displayTeam(match.team_b_id, match.team_b));
  }
  const summaryByTeam = new Map(summaryRows.map((row) => [row.team_id, row]));
  const profiles = new Map();
  const leagueMaps = mapRows.filter((row) => before(rowDate(row), cutoffDate));
  const cutoffMs = effectiveCutoffMs(cutoffDate, leagueMaps);
  const currentPatch = latestPatch(leagueMaps);
  const leaguePatchMaps = currentPatch ? leagueMaps.filter((row) => row.patch === currentPatch) : leagueMaps;
  const leagueAvgTotalKillsPatch = meanOf(leaguePatchMaps, (row) => num(row.total_kills), meanOf(leagueMaps, (row) => num(row.total_kills), 28));
  const leagueAvgTimePatch = meanOf(leaguePatchMaps, (row) => num(row.game_time_min), meanOf(leagueMaps, (row) => num(row.game_time_min), 31.5));
  const leagueKillOver = (line) => leaguePatchMaps.length ? pct(leaguePatchMaps.filter((row) => num(row.total_kills) > line).length, leaguePatchMaps.length) : NaN;
  const leagueTimeOver = (line) => leaguePatchMaps.length ? pct(leaguePatchMaps.filter((row) => num(row.game_time_min) > line).length, leaguePatchMaps.length) : NaN;

  for (const [teamId, team] of teams) {
    const summary = summaryByTeam.get(teamId) || {};
    const matches = matchRows
      .filter((row) => row.status === '已结束' && before(row.match_date, cutoffDate) && (row.team_a_id === teamId || row.team_b_id === teamId))
      .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
    const maps = mapRows
      .filter((row) => before(row.match_time || row.match_date, cutoffDate) && (row.team_a_id === teamId || row.team_b_id === teamId))
      .sort((a, b) => String(a.match_time || '').localeCompare(String(b.match_time || '')) || num(a.bo) - num(b.bo));

    const matchWins = matches.filter((row) => row.winner_id === teamId).length;
    const mapWins = maps.filter((row) => row.map_winner_id === teamId).length;
    const kills = maps.reduce((sum, row) => sum + sideKills(row, teamId), 0);
    const deaths = maps.reduce((sum, row) => sum + oppKills(row, teamId), 0);
    const totalKills = maps.reduce((sum, row) => sum + num(row.total_kills), 0);
    const gameTime = maps.reduce((sum, row) => sum + num(row.game_time_min), 0);
    const recentMaps = maps.slice(-10);
    const recentMatches = matches.slice(-5);
    const wonMaps = maps.filter((row) => row.map_winner_id === teamId);
    const lostMaps = maps.filter((row) => row.map_winner_id !== teamId);
    const teamPatchMaps = currentPatch ? maps.filter((row) => row.patch === currentPatch) : maps;
    const wonPatchMaps = teamPatchMaps.filter((row) => row.map_winner_id === teamId);
    const lostPatchMaps = teamPatchMaps.filter((row) => row.map_winner_id !== teamId);

    const useMapStats = maps.length >= 8;
    const rawMatchWinRate = matches.length ? pct(matchWins, matches.length) : num(summary.match_win_rate);
    const rawMapWinRate = useMapStats && maps.length ? pct(mapWins, maps.length) : num(summary.map_win_rate);
    const matchSample = matches.length || num(summary.matches);
    const mapSample = useMapStats ? maps.length : num(summary.maps);
    const matchWinRate = shrinkRate(rawMatchWinRate, matchSample, 0.5, RATE_PRIOR_N);
    const mapWinRate = shrinkRate(rawMapWinRate, mapSample, 0.5, RATE_PRIOR_N);
    const rawRecentMapWinRate = useMapStats && recentMaps.length ? pct(recentMaps.filter((row) => row.map_winner_id === teamId).length, recentMaps.length) : mapWinRate;
    const recentDecayed = useMapStats && maps.length
      ? decayedRate(maps, (row) => row.map_winner_id === teamId, cutoffMs)
      : { rate: rawRecentMapWinRate, effectiveN: 0 };
    const recentMapWinRate = useMapStats && Number.isFinite(recentDecayed.rate)
      ? shrinkRate(recentDecayed.rate, recentDecayed.effectiveN, mapWinRate, 8)
      : mapWinRate;
    const recentMatchText = recentMatches.map((row) => row.winner_id === teamId ? 'W' : 'L').join('');
    const rawAvgKills = useMapStats ? avg(kills, maps.length, 2) : num(summary.avg_kills);
    const rawAvgDeaths = useMapStats ? avg(deaths, maps.length, 2) : num(summary.avg_deaths);
    const rawAvgTotalKills = useMapStats ? avg(totalKills, maps.length, 2) : num(summary.avg_total_kills);
    const rawAvgTime = useMapStats ? avg(gameTime, maps.length, 2) : num(summary.avg_game_time_min);
    const avgKills = rawAvgKills;
    const avgDeaths = rawAvgDeaths;
    const avgTotalKills = useMapStats ? Number(patchAdjustedMean(
      maps,
      teamPatchMaps,
      (row) => num(row.total_kills),
      leagueAvgTotalKillsPatch,
      rawAvgTotalKills || 28,
    ).toFixed(2)) : rawAvgTotalKills;
    const avgTime = useMapStats ? Number(patchAdjustedMean(
      maps,
      teamPatchMaps,
      (row) => num(row.game_time_min),
      leagueAvgTimePatch,
      rawAvgTime || 31.5,
    ).toFixed(2)) : rawAvgTime;
    const killDiff = avgKills - avgDeaths;

    const twoZeroWins = matches.filter((match) => match.winner_id === teamId && matchScore(match, teamId)[0] === 2 && matchScore(match, teamId)[1] === 0).length;
    const zeroTwoLosses = matches.filter((match) => match.winner_id !== teamId && matchScore(match, teamId)[0] === 0 && matchScore(match, teamId)[1] === 2).length;
    const go3 = matches.filter((match) => num(match.score_a) + num(match.score_b) >= 3).length;
    const firstGameRows = maps.filter((row) => num(row.bo) === 1);

    const rawSeries20WinRate = matches.length ? pct(twoZeroWins, matches.length) : num(summary.series_2_0_win_rate);
    const rawSeries02LossRate = matches.length ? pct(zeroTwoLosses, matches.length) : num(summary.series_0_2_loss_rate);
    const rawSeriesGo3Rate = matches.length ? pct(go3, matches.length) : num(summary.series_go_3_maps_rate);
    const rawFirstGameWinRate = useMapStats && firstGameRows.length ? pct(firstGameRows.filter((row) => row.map_winner_id === teamId).length, firstGameRows.length) : mapWinRate;
    const fbRateFromMaps = useMapStats ? rateOverNonEmpty(maps, teamId, 'first_blood_team_id') : null;
    const ftRateFromMaps = useMapStats ? rateOverNonEmpty(maps, teamId, 'first_turret_team_id') : null;
    const rawFirstBloodRate = fbRateFromMaps != null ? fbRateFromMaps : num(summary.first_blood_rate);
    const rawFirstTurretRate = ftRateFromMaps != null ? ftRateFromMaps : num(summary.first_turret_rate);
    const fbSample = useMapStats ? maps.filter((row) => row.first_blood_team_id).length : num(summary.maps);
    const ftSample = useMapStats ? maps.filter((row) => row.first_turret_team_id).length : num(summary.maps);
    const winAvgTime = useMapStats && wonMaps.length ? Number(patchAdjustedMean(
      wonMaps,
      wonPatchMaps,
      (row) => num(row.game_time_min),
      leagueAvgTimePatch,
      avgTime,
    ).toFixed(2)) : avgTime;
    const lossAvgTime = useMapStats && lostMaps.length ? Number(patchAdjustedMean(
      lostMaps,
      lostPatchMaps,
      (row) => num(row.game_time_min),
      leagueAvgTimePatch,
      avgTime,
    ).toFixed(2)) : avgTime;

    const profile = {
      team_id: teamId,
      team,
      matches: matches.length || num(summary.matches),
      maps: useMapStats ? maps.length : num(summary.maps),
      current_patch: currentPatch,
      current_patch_maps: teamPatchMaps.length,
      match_win_rate_raw: rawMatchWinRate,
      map_win_rate_raw: rawMapWinRate,
      recent_10_map_win_rate_raw: rawRecentMapWinRate,
      recent_weighted_effective_maps: Number((recentDecayed.effectiveN || 0).toFixed(2)),
      avg_total_kills_raw: rawAvgTotalKills,
      avg_game_time_min_raw: rawAvgTime,
      match_win_rate: matchWinRate,
      map_win_rate: mapWinRate,
      recent_5: recentMatchText,
      recent_10_map_win_rate: recentMapWinRate,
      series_2_0_win_rate: shrinkRate(rawSeries20WinRate, matchSample, 0.25, 12),
      series_0_2_loss_rate: shrinkRate(rawSeries02LossRate, matchSample, 0.25, 12),
      series_go_3_maps_rate: shrinkRate(rawSeriesGo3Rate, matchSample, 0.45, 12),
      first_game_win_rate: shrinkRate(rawFirstGameWinRate, firstGameRows.length || mapSample, mapWinRate, 8),
      avg_kills: avgKills,
      avg_deaths: avgDeaths,
      avg_kill_diff: killDiff,
      avg_total_kills: avgTotalKills,
      avg_game_time_min: avgTime,
      win_avg_game_time_min: winAvgTime,
      loss_avg_game_time_min: lossAvgTime,
      first_blood_rate_raw: rawFirstBloodRate,
      first_turret_rate_raw: rawFirstTurretRate,
      first_blood_rate: shrinkRate(rawFirstBloodRate, fbSample, 0.5, 10),
      first_turret_rate: shrinkRate(rawFirstTurretRate, ftSample, 0.5, 10),
      dragon_control_rate: num(summary.dragon_control_rate),
      herald_control_rate: num(summary.herald_control_rate),
      baron_control_rate: num(summary.baron_control_rate),
      dragons_per_game: num(summary.dragons_per_game),
      voidgrubs_per_game: num(summary.voidgrubs_per_game),
      gd_at_15: num(summary.gd_at_15),
      td_at_15: num(summary.td_at_15),
      dpm: num(summary.dpm),
      wpm: num(summary.wpm),
      kill_over_27_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.total_kills) > 27.5, leagueKillOver(27.5), logistic((avgTotalKills - 27.5) / 4)) : logistic((avgTotalKills - 27.5) / 4),
      kill_over_30_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.total_kills) > 30.5, leagueKillOver(30.5), logistic((avgTotalKills - 30.5) / 4)) : logistic((avgTotalKills - 30.5) / 4),
      kill_over_33_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.total_kills) > 33.5, leagueKillOver(33.5), logistic((avgTotalKills - 33.5) / 4)) : logistic((avgTotalKills - 33.5) / 4),
      time_over_31_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.game_time_min) > 31.5, leagueTimeOver(31.5), logistic((avgTime - 31.5) / 2.7)) : logistic((avgTime - 31.5) / 2.7),
      time_over_32_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.game_time_min) > 32.5, leagueTimeOver(32.5), logistic((avgTime - 32.5) / 2.7)) : logistic((avgTime - 32.5) / 2.7),
      time_over_33_5_rate: useMapStats ? patchAdjustedRate(maps, teamPatchMaps, (row) => num(row.game_time_min) > 33.5, leagueTimeOver(33.5), logistic((avgTime - 33.5) / 2.7)) : logistic((avgTime - 33.5) / 2.7),
    };

    profile.strength_score_raw = strengthScore(profile);
    profile.tempo_score_raw = tempoScore(profile);
    profile.strength_score_confidence = Number((num(profile.maps) / (num(profile.maps) + RATE_PRIOR_N)).toFixed(3));
    profile.strength_score = shrinkScore(profile.strength_score_raw, profile.maps);
    profile.tempo_score = shrinkScore(profile.tempo_score_raw, profile.maps);
    profiles.set(teamId, profile);
  }

  return profiles;
}

function strengthScore(p) {
  return 50
    + (p.match_win_rate - 0.5) * 28
    + (p.map_win_rate - 0.5) * 38
    + (p.recent_10_map_win_rate - 0.5) * 14
    + clamp(p.gd_at_15 / 2500, -1, 1) * 12
    + clamp(p.avg_kill_diff / 8, -1, 1) * 8
    + (p.first_turret_rate - 0.5) * 7
    + (p.dragon_control_rate - 0.5) * 5;
}

function tempoScore(p) {
  return 50
    + clamp((p.avg_total_kills - 28) / 10, -1, 1) * 24
    + clamp((p.avg_deaths - 13) / 6, -1, 1) * 14
    + clamp((p.avg_game_time_min - 31) / 5, -1, 1) * 8
    + clamp((p.dpm - 2700) / 600, -1, 1) * 8;
}

function above(value, threshold, scale = 0.3) {
  return logistic((num(value) - num(threshold)) * scale);
}

function below(value, threshold, scale = 0.3) {
  return logistic((num(threshold) - num(value)) * scale);
}

function softmaxScores(scores) {
  const max = Math.max(...Object.values(scores));
  const exp = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Math.exp(value - max)]));
  const total = Object.values(exp).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, exp[name] / total]));
}

function topScenario(probs) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] || SCENARIOS.LOW_KILL_MACRO;
}

function oneHotScenario(scenario) {
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, name === scenario ? 1 : 0]));
}

function scenarioWeights(input) {
  if (typeof input === 'string') return oneHotScenario(input);
  const out = Object.fromEntries(SCENARIO_NAMES.map((name) => [name, clamp(num(input?.[name]), 0, 1)]));
  const total = Object.values(out).reduce((sum, value) => sum + value, 0);
  if (!total) return oneHotScenario(SCENARIOS.LOW_KILL_MACRO);
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, out[name] / total]));
}

function scenarioReason(primary, probs, metrics) {
  const top = Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, probability]) => `${name} ${(probability * 100).toFixed(1)}%`)
    .join(' / ');
  return `软分类最高为 ${primary}; top2=${top}; strength_diff=${metrics.diff.toFixed(1)}, chaos=${metrics.chaos.toFixed(1)}, avg_kills=${metrics.avgTotalKills.toFixed(2)}, avg_time=${metrics.avgTime.toFixed(2)}.`;
}

export function classifyScenarioHard(a, b, thresholds = loadScenarioThresholds()) {
  const favorite = a.strength_score >= b.strength_score ? a : b;
  const underdog = favorite === a ? b : a;
  const diff = favorite.strength_score - underdog.strength_score;
  const avgTotalKills = (a.avg_total_kills + b.avg_total_kills) / 2;
  const avgTime = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const chaos = (a.tempo_score + b.tempo_score) / 2;
  const underdogEarly = Math.max(underdog.first_blood_rate, underdog.first_turret_rate);

  if (chaos >= thresholds.chaos_p70 && avgTotalKills >= thresholds.high_kills_p70 && avgTime >= thresholds.high_time_p70) {
    return {
      scenario: SCENARIOS.CHAOS_HIGH_KILL,
      favorite,
      underdog,
      reason: '双方总击杀、混乱度和比赛时长都处在 LPL 历史高位。',
    };
  }
  if (diff >= thresholds.strength_diff_p70 && favorite.win_avg_game_time_min <= thresholds.low_time_p30 && underdog.avg_deaths >= thresholds.avg_deaths_p70 && favorite.first_turret_rate >= thresholds.first_turret_p60) {
    return {
      scenario: SCENARIOS.FAST_STOMP,
      favorite,
      underdog,
      reason: '强度差达到历史高位，且强队胜局时间短、弱队死亡数高。',
    };
  }
  if (diff >= thresholds.strength_diff_p50 && (favorite.avg_game_time_min >= thresholds.high_time_p70 || underdog.loss_avg_game_time_min >= thresholds.high_time_p70 || favorite.avg_kills <= thresholds.favorite_kills_p50)) {
    return {
      scenario: SCENARIOS.SLOW_FAVORITE,
      favorite,
      underdog,
      reason: '强队占优但终结速度不支持直接速推。',
    };
  }
  if (diff >= thresholds.strength_diff_p30 && underdogEarly >= thresholds.underdog_early_p50) {
    return {
      scenario: SCENARIOS.UNDERDOG_LIVE,
      favorite,
      underdog,
      reason: '强弱有差距，但弱队前期资源有咬住空间。',
    };
  }
  if (avgTotalKills <= thresholds.low_kills_p30 || (avgTime >= thresholds.high_time_p70 && chaos <= thresholds.chaos_p30)) {
    return {
      scenario: SCENARIOS.LOW_KILL_MACRO,
      favorite,
      underdog,
      reason: '击杀环境偏低，比赛更依赖资源交换和控图推进。',
    };
  }
  return {
    scenario: diff >= thresholds.strength_diff_p30 ? SCENARIOS.SLOW_FAVORITE : SCENARIOS.UNDERDOG_LIVE,
    favorite,
    underdog,
    reason: diff >= thresholds.strength_diff_p30 ? '强队略占优，但盘口不宜按碾压处理。' : '强度差不大，单局波动和 BP 影响更高。',
  };
}

export function classifyScenario(a, b) {
  const thresholds = loadScenarioThresholds();
  const hard = classifyScenarioHard(a, b, thresholds);
  const { favorite, underdog } = hard;
  const diff = favorite.strength_score - underdog.strength_score;
  const avgTotalKills = (a.avg_total_kills + b.avg_total_kills) / 2;
  const avgTime = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const chaos = (a.tempo_score + b.tempo_score) / 2;
  const underdogEarly = Math.max(underdog.first_blood_rate, underdog.first_turret_rate);
  const diffNotHuge = below(diff, thresholds.strength_diff_p70, 0.25);

  const scores = {
    [SCENARIOS.CHAOS_HIGH_KILL]: 0.15
      + above(chaos, thresholds.chaos_p70, 0.25) * 1.15
      + above(avgTotalKills, thresholds.high_kills_p70, 0.25) * 1.05
      + above(avgTime, thresholds.high_time_p70, 0.25) * 0.75,
    [SCENARIOS.FAST_STOMP]: 0.15
      + above(diff, thresholds.strength_diff_p70, 0.28) * 1.25
      + below(favorite.win_avg_game_time_min, thresholds.low_time_p30, 0.35) * 0.95
      + above(underdog.avg_deaths, thresholds.avg_deaths_p70, 0.25) * 0.85
      + above(favorite.first_turret_rate, thresholds.first_turret_p60, 8) * 0.55,
    [SCENARIOS.SLOW_FAVORITE]: 0.15
      + above(diff, thresholds.strength_diff_p50, 0.28) * 1.05
      + Math.max(
        above(favorite.avg_game_time_min, thresholds.high_time_p70, 0.25),
        above(underdog.loss_avg_game_time_min, thresholds.high_time_p70, 0.25),
        below(favorite.avg_kills, thresholds.favorite_kills_p50, 0.35),
      ) * 1.05
      + below(chaos, thresholds.chaos_p70, 0.18) * 0.45,
    [SCENARIOS.UNDERDOG_LIVE]: 0.15
      + above(diff, thresholds.strength_diff_p30, 0.28) * 0.8
      + diffNotHuge * 0.8
      + above(underdogEarly, thresholds.underdog_early_p50, 8) * 1.0
      + below(avgTotalKills, thresholds.high_kills_p70, 0.18) * 0.35,
    [SCENARIOS.LOW_KILL_MACRO]: 0.15
      + below(avgTotalKills, thresholds.low_kills_p30, 0.25) * 1.25
      + above(avgTime, thresholds.high_time_p70, 0.22) * 0.75
      + below(chaos, thresholds.chaos_p30, 0.25) * 1.0,
  };

  const scenario_probs = softmaxScores(scores);
  const primary_scenario = topScenario(scenario_probs);
  return {
    primary_scenario,
    scenario: primary_scenario,
    scenario_probs,
    hard_scenario: hard.scenario,
    favorite,
    underdog,
    reason: scenarioReason(primary_scenario, scenario_probs, { diff, chaos, avgTotalKills, avgTime }),
  };
}

function sampleConfidence(profileA, profileB) {
  const sample = Math.min(num(profileA.maps) + num(profileB.maps), 60);
  return clamp(sample / 40, 0.45, 1);
}

export function matchWinProbability(team, opponent) {
  const confidence = sampleConfidence(team, opponent);
  const raw = logistic((team.strength_score - opponent.strength_score) / 13);
  return clamp(0.5 + (raw - 0.5) * confidence, 0.05, 0.95);
}

export function coverProbability(team, opponent, line) {
  const expectedKillDiff = ((team.avg_kill_diff - opponent.avg_kill_diff) / 2)
    + ((team.strength_score - opponent.strength_score) / 9);
  const threshold = -Number(line);
  return clamp(logistic((expectedKillDiff - threshold) / 4.8), 0.05, 0.95);
}

export function teamKillsHandicapProbability(team, opponent, line) {
  try {
    const nb = predictTeamKillsHandicap(
      team.team_id,
      opponent.team_id,
      team.current_patch || opponent.current_patch || '',
      '',
      line,
      {
        opponentStrengthScore: opponent.strength_score,
        teamStrengthScore: team.strength_score,
      },
    );
    if (nb && Number.isFinite(nb.probability)) return clamp(nb.probability, 0.02, 0.98);
  } catch {
    // Keep the old lightweight projection as the runtime fallback.
  }
  return coverProbability(team, opponent, line);
}

export function scenarioTotalKillsProbability(team, opponent, line, selection, scenario) {
  const probs = scenarioWeights(scenario);
  let mean = (team.avg_total_kills + opponent.avg_total_kills) / 2;
  mean += 2.2 * probs[SCENARIOS.CHAOS_HIGH_KILL];
  mean -= 2.0 * probs[SCENARIOS.LOW_KILL_MACRO];
  mean -= 0.8 * probs[SCENARIOS.FAST_STOMP];
  // scale 6 (not 3.8): 校准回测显示 3.8 过尖致 under 过度自信(ECE 5.8%→3.6%, 见 总杀校准-可靠性曲线.md)。
  // 仅当连续模型不可用时走这里; 线上主路径用已部署的 predictTotalKills。
  const over = clamp(logistic((mean - Number(line)) / 6), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

export function totalKillsProbability(team, opponent, line, selection, scenario) {
  try {
    const prediction = predictTotalKills(team, opponent);
    if (prediction) {
      return selection === 'over' ? prediction.p_over(line) : prediction.p_under(line);
    }
  } catch {
    // Fall back to the scenario adjustment if the calibrated continuous model is unavailable.
  }
  return scenarioTotalKillsProbability(team, opponent, line, selection, scenario);
}

export function gameTimeProbability(team, opponent, line, selection, scenario) {
  const probs = scenarioWeights(scenario);
  let mean = (team.avg_game_time_min + opponent.avg_game_time_min) / 2;
  mean -= 1.8 * probs[SCENARIOS.FAST_STOMP];
  mean += 0.8 * probs[SCENARIOS.SLOW_FAVORITE];
  mean += 1.1 * probs[SCENARIOS.UNDERDOG_LIVE];
  mean += 1.0 * probs[SCENARIOS.CHAOS_HIGH_KILL];
  mean += 0.9 * probs[SCENARIOS.LOW_KILL_MACRO];
  const over = clamp(logistic((mean - Number(line)) / 2.5), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

export function mapHandicapProbability(favorite, underdog, scenario) {
  const probs = scenarioWeights(scenario);
  let p = (favorite.series_2_0_win_rate + underdog.series_0_2_loss_rate + matchWinProbability(favorite, underdog) ** 2) / 3;
  p += 0.09 * probs[SCENARIOS.FAST_STOMP];
  p -= 0.08 * probs[SCENARIOS.SLOW_FAVORITE];
  p -= 0.11 * probs[SCENARIOS.UNDERDOG_LIVE];
  p -= 0.04 * probs[SCENARIOS.CHAOS_HIGH_KILL];
  return clamp(p, 0.05, 0.9);
}

export function mapTotalOverProbability(favorite, underdog, scenario) {
  const probs = scenarioWeights(scenario);
  const diff = Math.abs(favorite.strength_score - underdog.strength_score);
  let p = ((favorite.series_go_3_maps_rate + underdog.series_go_3_maps_rate) / 2) * 0.45
    + clamp(0.66 - diff / 38, 0.22, 0.66) * 0.55;
  p += 0.08 * probs[SCENARIOS.UNDERDOG_LIVE];
  p -= 0.12 * probs[SCENARIOS.FAST_STOMP];
  p += 0.02 * probs[SCENARIOS.SLOW_FAVORITE];
  return clamp(p, 0.08, 0.82);
}

export function firstObjectiveProbability(team, opponent, field) {
  const p = team[field] * 0.62 + (1 - opponent[field]) * 0.28 + 0.5 * 0.10;
  return clamp(p, 0.12, 0.88);
}

function scenarioAlignment(row, scenario, favorite, underdog) {
  const isFav = teamKey(row.selection) === favorite.team_id;
  const isDog = teamKey(row.selection) === underdog.team_id;
  if (scenario === SCENARIOS.FAST_STOMP) {
    if ((row.market === 'map_handicap' && isFav && Number(row.line) < 0)
      || (row.market === 'team_kills_handicap' && isFav && Number(row.line) < 0)
      || (row.market === 'game_time' && row.selection === 'under')
      || (row.market === 'map_total' && row.selection === 'under')) return '一致';
    if ((row.market === 'map_total' && row.selection === 'over') || (row.market === 'game_time' && row.selection === 'over')) return '冲突';
  }
  if (scenario === SCENARIOS.SLOW_FAVORITE) {
    if ((row.market === 'match_win' && isFav)
      || (row.market === 'team_kills_handicap' && isDog && Number(row.line) > 0)
      || (row.market === 'game_time' && row.selection === 'over')) return '一致';
    if (row.market === 'team_kills_handicap' && isFav && Number(row.line) < -5) return '冲突';
  }
  if (scenario === SCENARIOS.UNDERDOG_LIVE) {
    if ((row.market === 'map_handicap' && isDog && Number(row.line) > 0)
      || (row.market === 'match_win' && isFav)
      || (row.market === 'map_total' && row.selection === 'over')) return '一致';
  }
  if (scenario === SCENARIOS.CHAOS_HIGH_KILL) {
    if ((row.market === 'total_kills' && row.selection === 'over') || (row.market === 'game_time' && row.selection === 'over')) return '一致';
    if (row.market === 'total_kills' && row.selection === 'under') return '冲突';
  }
  if (scenario === SCENARIOS.LOW_KILL_MACRO) {
    if ((row.market === 'total_kills' && row.selection === 'under')
      || (row.market === 'game_time' && row.selection === 'over')
      || (row.market === 'match_win' && isFav)) return '一致';
    if (row.market === 'total_kills' && row.selection === 'over') return '冲突';
  }
  return '中性';
}

function addRate(rows, base, market, selection, line, probability, sample, basis, note = '', extra = {}) {
  const row = {
    ...base,
    market,
    selection,
    line: line ?? '',
    side: '',
    probability: decimal(clamp(probability, 0.02, 0.98)),
    probability_text: pctText(clamp(probability, 0.02, 0.98)),
    sample,
    basis,
    note,
    ...extra,
  };
  row.scenario_alignment = scenarioAlignment(row, base.scenario, base.favorite_id_obj, base.underdog_id_obj);
  delete row.favorite_id_obj;
  delete row.underdog_id_obj;
  rows.push(row);
}

export function buildMarketsForMatch(match, profiles) {
  const a = profiles.get(match.team_a_id);
  const b = profiles.get(match.team_b_id);
  if (!a || !b) return { rates: [], report: null };
  const scenario = classifyScenario(a, b);
  const favorite = scenario.favorite;
  const underdog = scenario.underdog;
  const sample = Math.round(num(a.maps) + num(b.maps));
  const base = {
    match_id: match.match_id,
    match_date: match.match_date,
    match_name: match.match_name,
    scenario: scenario.primary_scenario,
    primary_scenario: scenario.primary_scenario,
    scenario_probs: JSON.stringify(scenario.scenario_probs),
    scenario_reason: scenario.reason,
    favorite: favorite.team,
    underdog: underdog.team,
    favorite_id: favorite.team_id,
    underdog_id: underdog.team_id,
    favorite_id_obj: favorite,
    underdog_id_obj: underdog,
    team_state_summary: `${a.team}: 大场${pctText(a.match_win_rate)} 小局${pctText(a.map_win_rate)} 近5${a.recent_5 || '-'}，均杀/均死${a.avg_kills.toFixed(1)}/${a.avg_deaths.toFixed(1)}；${b.team}: 大场${pctText(b.match_win_rate)} 小局${pctText(b.map_win_rate)} 近5${b.recent_5 || '-'}，均杀/均死${b.avg_kills.toFixed(1)}/${b.avg_deaths.toFixed(1)}。`,
    key_data: `强度分 ${a.team} ${a.strength_score.toFixed(1)} vs ${b.team} ${b.strength_score.toFixed(1)}；GD@15 ${a.team} ${a.gd_at_15} vs ${b.team} ${b.gd_at_15}；平均总击杀 ${((a.avg_total_kills + b.avg_total_kills) / 2).toFixed(2)}；平均时长 ${((a.avg_game_time_min + b.avg_game_time_min) / 2).toFixed(2)} 分钟；首塔率 ${a.team} ${pctText(a.first_turret_rate)} vs ${b.team} ${pctText(b.first_turret_rate)}。`,
    risk_tip: '先按剧本筛盘口，再看EV；同场多个盘口如果都依赖同一剧本，建议合计不超过当日总投入50%。',
  };
  const rows = [];
  const pA = matchWinProbability(a, b);
  const pB = 1 - pA;
  addRate(rows, base, 'match_win', a.team, '', pA, sample, '综合强度/近期/前期资源');
  addRate(rows, base, 'match_win', b.team, '', pB, sample, '综合强度/近期/前期资源');

  const fav2_0 = mapHandicapProbability(favorite, underdog, scenario.scenario_probs);
  addRate(rows, base, 'map_handicap', favorite.team, '-1.5', fav2_0, sample, '2-0率/被2-0率/剧本修正');
  addRate(rows, base, 'map_handicap', underdog.team, '+1.5', 1 - fav2_0, sample, '2-0率/被2-0率/剧本修正');
  const overMaps = mapTotalOverProbability(favorite, underdog, scenario.scenario_probs);
  addRate(rows, base, 'map_total', 'over', '2.5', overMaps, sample, '打满率/强度接近度/剧本修正');
  addRate(rows, base, 'map_total', 'under', '2.5', 1 - overMaps, sample, '打满率/强度接近度/剧本修正');

  addRate(rows, base, 'game1_win', a.team, '', clamp(pA * 0.6 + a.first_game_win_rate * 0.4, 0.05, 0.95), sample, '第一局胜率/整体胜率');
  addRate(rows, base, 'game1_win', b.team, '', clamp(pB * 0.6 + b.first_game_win_rate * 0.4, 0.05, 0.95), sample, '第一局胜率/整体胜率');

  addRate(rows, base, 'team_kills_handicap', favorite.team, '-5.5', teamKillsHandicapProbability(favorite, underdog, -5.5), sample, 'NB team-kills distribution / fallback kill-diff');
  addRate(rows, base, 'team_kills_handicap', underdog.team, '+5.5', teamKillsHandicapProbability(underdog, favorite, 5.5), sample, 'NB team-kills distribution / fallback kill-diff');

  const totalKillsModel = (() => {
    try {
      return predictTotalKills(a, b);
    } catch {
      return null;
    }
  })();
  const totalKillsExtra = (line, selection) => {
    if (!totalKillsModel) return {};
    const lineEdge = selection === 'over'
      ? totalKillsModel.mean - Number(line)
      : Number(line) - totalKillsModel.mean;
    return {
      total_kills_model_mean: totalKillsModel.mean.toFixed(2),
      total_kills_model_sigma: totalKillsModel.sigma.toFixed(2),
      line_edge_kills: lineEdge.toFixed(2),
    };
  };
  const totalKillsNote = (line, selection) => {
    if (!totalKillsModel) return '';
    const edge = totalKillsExtra(line, selection).line_edge_kills;
    return `continuous_mean=${totalKillsModel.mean.toFixed(2)}, sigma=${totalKillsModel.sigma.toFixed(2)}, line_edge=${edge}`;
  };
  const totalKillsBasis = totalKillsModel
    ? 'continuous total-kills model / line gap'
    : '双方总击杀均值/死亡数/剧本';
  for (const line of [27.5, 30.5, 33.5]) {
    addRate(rows, base, 'total_kills', 'over', String(line), totalKillsProbability(a, b, line, 'over', scenario.scenario_probs), sample, totalKillsBasis, totalKillsNote(line, 'over'), totalKillsExtra(line, 'over'));
    addRate(rows, base, 'total_kills', 'under', String(line), totalKillsProbability(a, b, line, 'under', scenario.scenario_probs), sample, totalKillsBasis, totalKillsNote(line, 'under'), totalKillsExtra(line, 'under'));
  }
  for (const line of [31.5, 32.5, 33.5]) {
    addRate(rows, base, 'game_time', 'over', String(line), gameTimeProbability(a, b, line, 'over', scenario.scenario_probs), sample, '双方时长/终结速度/拖延能力');
    addRate(rows, base, 'game_time', 'under', String(line), gameTimeProbability(a, b, line, 'under', scenario.scenario_probs), sample, '双方时长/终结速度/拖延能力');
  }

  addRate(rows, base, 'first_blood', a.team, '', firstObjectiveProbability(a, b, 'first_blood_rate'), sample, '一血率，高波动低权重');
  addRate(rows, base, 'first_blood', b.team, '', firstObjectiveProbability(b, a, 'first_blood_rate'), sample, '一血率，高波动低权重');
  addRate(rows, base, 'first_turret', a.team, '', firstObjectiveProbability(a, b, 'first_turret_rate'), sample, '首塔率，高波动低权重');
  addRate(rows, base, 'first_turret', b.team, '', firstObjectiveProbability(b, a, 'first_turret_rate'), sample, '首塔率，高波动低权重');

  return {
    rates: rows,
    report: {
      match_id: match.match_id,
      match_date: match.match_date,
      match_name: match.match_name,
      scenario: scenario.primary_scenario,
      primary_scenario: scenario.primary_scenario,
      scenario_probs: JSON.stringify(scenario.scenario_probs),
      hard_scenario: scenario.hard_scenario,
      scenario_reason: scenario.reason,
      favorite: favorite.team,
      underdog: underdog.team,
      team_state_summary: base.team_state_summary,
      key_data: base.key_data,
      risk_tip: base.risk_tip,
    },
  };
}

async function buildOddsTemplate(rateRows) {
  const existing = await readCsvIfExists(path.join(ANALYSIS_DIR, '赔率填写模板.csv'));
  const oddsByKey = new Map(existing.map((row) => [[row.match_name, row.market, row.selection, row.line].join('|'), row.odds || '']));
  return rateRows.map((row) => ({
    match_id: row.match_id,
    match_date: row.match_date,
    match_name: row.match_name,
    scenario: row.scenario,
    market: row.market,
    selection: row.selection,
    line: row.line,
    side: row.side || '',
    odds: oddsByKey.get([row.match_name, row.market, row.selection, row.line].join('|')) || '',
    note: row.note || '',
  }));
}

async function main() {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const [matchRows, mapRows, summaryRows] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);

  const upcoming = matchRows
    .filter((row) => row.status !== '已结束')
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
  const allRates = [];
  const reports = [];
  for (const match of upcoming) {
    const profiles = buildProfiles(matchRows, mapRows, summaryRows, match.match_date);
    const { rates, report } = buildMarketsForMatch(match, profiles);
    allRates.push(...rates);
    if (report) reports.push(report);
  }

  const profilesNow = [...buildProfiles(matchRows, mapRows, summaryRows).values()]
    .sort((a, b) => b.strength_score - a.strength_score)
    .map((profile) => ({
      ...profile,
      match_win_rate_text: pctText(profile.match_win_rate),
      map_win_rate_text: pctText(profile.map_win_rate),
      first_blood_rate_text: pctText(profile.first_blood_rate),
      first_turret_rate_text: pctText(profile.first_turret_rate),
      strength_score: profile.strength_score.toFixed(1),
      tempo_score: profile.tempo_score.toFixed(1),
    }));

  const template = await buildOddsTemplate(allRates);
  const evaluation = evaluateTemplate(template, allRates);

  await writeCsv(path.join(ANALYSIS_DIR, '队伍盘口命中率.csv'), profilesNow, unionColumns(profilesNow));
  await writeCsv(path.join(ANALYSIS_DIR, '比赛剧本摘要.csv'), reports, unionColumns(reports));
  await writeCsv(path.join(ANALYSIS_DIR, '待赛对阵盘口概率.csv'), allRates, [
    'match_id', 'match_date', 'match_name', 'scenario', 'primary_scenario', 'scenario_probs', 'scenario_reason',
    'favorite', 'underdog', 'market', 'selection', 'line', 'side',
    'probability', 'probability_text', 'sample', 'basis', 'scenario_alignment',
    'team_state_summary', 'key_data', 'risk_tip',
    'total_kills_model_mean', 'total_kills_model_sigma', 'line_edge_kills',
    'note',
  ]);
  await writeCsv(path.join(ANALYSIS_DIR, '赔率填写模板.csv'), template, [
    'match_id', 'match_date', 'match_name', 'scenario', 'market', 'selection',
    'line', 'side', 'odds', 'note',
  ]);
  await writeEvaluationOutputs(evaluation, reports);

  await writeFile(path.join(ANALYSIS_DIR, '字段说明.txt'), [
    'LPL盘口模型字段说明',
    '',
    'market:',
    'match_win = 胜负盘',
    'map_handicap = 地图让分，line=-1.5/+1.5',
    'map_total = 地图总数，line=2.5，selection=over/under',
    'game1_win = 第一局胜负',
    'team_kills_handicap = 击杀让分，line为该队盘口',
    'total_kills = 单局总击杀大小',
    'game_time = 单局时长大小',
    'first_blood = 第一滴血，高波动低权重',
    'first_turret = 首塔，高波动低权重',
    '',
    'EV公式:',
    '隐含胜率 = 1 / 十进制赔率',
    'EV = 模型命中率 × 十进制赔率 - 1',
    '',
    '风险等级:',
    'A = EV明显为正，样本和剧本一致，无冲突',
    'B = EV为正但优势不厚或样本一般，小注',
    'C = 观察，不下注',
    'D = EV为负或逻辑冲突，放弃',
    '',
    'LPL 改造说明 (Phase 2 决定):',
    'first_blood / first_turret 在 LPL 公开数据有显著缺失率(FT ~17%),',
    '所以 buildProfiles 中 FB / FT 的分母只算字段非空的 map,避免系统性低估真实率。',
  ].join('\r\n'), 'utf8');

  console.log(`完成。待赛 ${upcoming.length} 场，盘口概率 ${allRates.length} 条。`);
  console.log(path.join(ANALYSIS_DIR, '赔率填写模板.csv'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
  console.error(`LPL盘口分析生成失败: ${error.message}`);
  process.exitCode = 1;
  });
}
