import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  avg,
  clamp,
  decimal,
  displayTeam,
  logistic,
  num,
  pct,
  pctText,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from './shared.js';
import { evaluateTemplate, writeEvaluationOutputs } from './odds-core.js';
import { readLckData } from './data-loader.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';
import { MODEL_MODE, USE_NEW_MODEL } from './model-mode.js';

function before(rowDate, cutoffDate) {
  if (!cutoffDate) return true;
  return String(rowDate || '') < String(cutoffDate || '');
}

// ===== 模型模式开关 =====
// 默认 legacy = 改动前那条被实战验证(+40% / 17注)的旧管线。
// MODEL_MODE=new 启用本会话的实验改动(近期衰减 / 软剧本 / 数据阈值 / 扣水硬护栏),
// 仅供影子对比, 未经实战验证前不要当默认。
export { MODEL_MODE, USE_NEW_MODEL };

// ===== T1-3 近期权重衰减(仅 new 启用; legacy 用 Infinity ⇒ 全部等权 ⇒ 退回旧的普通平均) =====
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_HALF_LIFE_DAYS = USE_NEW_MODEL ? 90 : Infinity;

function dateMs(value) {
  const s = String(value || '').slice(0, 10);
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function rowDateOf(row) {
  return String(row.match_time || row.match_date || '').slice(0, 10);
}

function effectiveCutoffMs(cutoffDate, rows) {
  const explicit = dateMs(cutoffDate);
  if (explicit != null) return explicit;
  const latest = rows.reduce((max, row) => Math.max(max, dateMs(rowDateOf(row)) || 0), 0);
  return latest ? latest + DAY_MS : Date.now();
}

function decayWeight(row, cutoffMs, halfLifeDays = RECENT_HALF_LIFE_DAYS) {
  const ms = dateMs(rowDateOf(row));
  if (ms == null || !cutoffMs) return 1;
  const ageDays = Math.max(0, (cutoffMs - ms) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

// 加权命中率 (rate) 和加权均值 (mean)
function wRate(rows, predicate, cutoffMs) {
  let hits = 0;
  let total = 0;
  for (const row of rows) {
    const w = decayWeight(row, cutoffMs);
    total += w;
    if (predicate(row)) hits += w;
  }
  return total ? hits / total : NaN;
}

function wMean(rows, valueFn, cutoffMs) {
  let acc = 0;
  let total = 0;
  for (const row of rows) {
    const v = Number(valueFn(row));
    if (!Number.isFinite(v)) continue;
    const w = decayWeight(row, cutoffMs);
    total += w;
    acc += w * v;
  }
  return total ? acc / total : NaN;
}

// ===== T1-1/T1-2 剧本: 数据自适应阈值 + 软分类 =====
const SCENARIOS = {
  FAST_STOMP: '强队速推碾压局',
  SLOW_FAVORITE: '强队慢热终结局',
  UNDERDOG_LIVE: '弱队能咬住但难赢',
  CHAOS_HIGH_KILL: '混乱高击杀局',
  LOW_KILL_MACRO: '低击杀运营局',
};
const SCENARIO_NAMES = Object.values(SCENARIOS);

const SCENARIO_THRESHOLDS_PATH = path.join(process.cwd(), 'lck', 'calibration', 'scenario_thresholds.json');
// 写死的兜底值(仅在 scenario_thresholds.json 缺失时用; 正常应跑 npm run scenario-thresholds 生成)
const FALLBACK_THRESHOLDS = {
  high_kills_p70: 28, low_kills_p30: 25,
  high_time_p70: 33, low_time_p30: 31,
  chaos_p70: 54, chaos_p30: 46,
  strength_diff_p70: 18, strength_diff_p50: 10, strength_diff_p30: 5,
  avg_deaths_p70: 14.5, favorite_kills_p50: 14.5,
  first_turret_p60: 0.55, underdog_early_p50: 0.45,
};
let _thresholdsCache = null;
export function loadScenarioThresholds() {
  if (_thresholdsCache) return _thresholdsCache;
  try {
    const json = JSON.parse(readFileSync(SCENARIO_THRESHOLDS_PATH, 'utf8'));
    _thresholdsCache = { ...FALLBACK_THRESHOLDS, ...(json.thresholds || {}), _source: 'json' };
  } catch {
    _thresholdsCache = { ...FALLBACK_THRESHOLDS, _source: 'fallback' };
  }
  return _thresholdsCache;
}

function above(value, threshold, scale = 0.3) {
  return logistic((num(value) - num(threshold)) * scale);
}
function below(value, threshold, scale = 0.3) {
  return logistic((num(threshold) - num(value)) * scale);
}
function softmaxScores(scores) {
  const max = Math.max(...Object.values(scores));
  const exp = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.exp(v - max)]));
  const total = Object.values(exp).reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, exp[name] / total]));
}
function topScenario(probs) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] || SCENARIOS.LOW_KILL_MACRO;
}
function oneHotScenario(scenario) {
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, name === scenario ? 1 : 0]));
}
// 接受字符串(硬)或概率字典(软), 统一归一成概率字典
function scenarioWeights(input) {
  if (typeof input === 'string') return oneHotScenario(input);
  const out = Object.fromEntries(SCENARIO_NAMES.map((name) => [name, clamp(num(input?.[name]), 0, 1)]));
  const total = Object.values(out).reduce((s, v) => s + v, 0);
  if (!total) return oneHotScenario(SCENARIOS.LOW_KILL_MACRO);
  return Object.fromEntries(SCENARIO_NAMES.map((name) => [name, out[name] / total]));
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

export function buildProfiles(matchRows, mapRows, summaryRows, cutoffDate = '') {
  const teams = new Map();
  for (const row of summaryRows) teams.set(row.team_id, row.team);
  for (const match of matchRows) {
    teams.set(match.team_a_id, displayTeam(match.team_a_id, match.team_a));
    teams.set(match.team_b_id, displayTeam(match.team_b_id, match.team_b));
  }
  const summaryByTeam = new Map(summaryRows.map((row) => [row.team_id, row]));
  const profiles = new Map();
  const cutoffMs = effectiveCutoffMs(cutoffDate, mapRows);

  for (const [teamId, team] of teams) {
    const summary = summaryByTeam.get(teamId) || {};
    const matches = matchRows
      .filter((row) => row.status === '已结束' && before(row.match_date, cutoffDate) && (row.team_a_id === teamId || row.team_b_id === teamId))
      .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
    const maps = mapRows
      .filter((row) => before(row.match_time || row.match_date, cutoffDate) && (row.team_a_id === teamId || row.team_b_id === teamId))
      .sort((a, b) => String(a.match_time || '').localeCompare(String(b.match_time || '')) || num(a.bo) - num(b.bo));

    const recentMaps = maps.slice(-10);
    const recentMatches = matches.slice(-5);
    const wonMaps = maps.filter((row) => row.map_winner_id === teamId);
    const lostMaps = maps.filter((row) => row.map_winner_id !== teamId);

    const useMapStats = maps.length >= 8;
    // T1-3: 所有率/均值改成近期权重(30 天半衰), 让最近战绩主导, 缓解高估弱队
    const round2 = (v, fb) => (Number.isFinite(v) ? Number(v.toFixed(2)) : num(fb));
    const matchWinRate = profileValue(matches.length ? wRate(matches, (row) => row.winner_id === teamId, cutoffMs) : NaN, summary.match_win_rate);
    const mapWinRate = useMapStats ? profileValue(wRate(maps, (row) => row.map_winner_id === teamId, cutoffMs), summary.map_win_rate) : num(summary.map_win_rate);
    const recentMapWinRate = useMapStats && recentMaps.length ? wRate(recentMaps, (row) => row.map_winner_id === teamId, cutoffMs) : mapWinRate;
    const recentMatchText = recentMatches.map((row) => row.winner_id === teamId ? 'W' : 'L').join('');
    const avgKills = useMapStats ? round2(wMean(maps, (row) => sideKills(row, teamId), cutoffMs), summary.avg_kills) : num(summary.avg_kills);
    const avgDeaths = useMapStats ? round2(wMean(maps, (row) => oppKills(row, teamId), cutoffMs), summary.avg_deaths) : num(summary.avg_deaths);
    const avgTotalKills = useMapStats ? round2(wMean(maps, (row) => num(row.total_kills), cutoffMs), summary.avg_total_kills) : num(summary.avg_total_kills);
    const avgTime = useMapStats ? round2(wMean(maps, (row) => num(row.game_time_min), cutoffMs), summary.avg_game_time_min) : num(summary.avg_game_time_min);
    const killDiff = avgKills - avgDeaths;

    const firstGameRows = maps.filter((row) => num(row.bo) === 1);

    const firstBloodKnown = maps.filter((row) => teamKey(row.first_blood_team_id || row.first_blood_team));
    const firstTurretKnown = maps.filter((row) => teamKey(row.first_turret_team_id || row.first_turret_team));

    const profile = {
      team_id: teamId,
      team,
      matches: matches.length || num(summary.matches),
      maps: useMapStats ? maps.length : num(summary.maps),
      match_win_rate: matchWinRate,
      map_win_rate: mapWinRate,
      recent_5: recentMatchText,
      recent_10_map_win_rate: recentMapWinRate,
      series_2_0_win_rate: matches.length ? wRate(matches, (m) => m.winner_id === teamId && matchScore(m, teamId)[0] === 2 && matchScore(m, teamId)[1] === 0, cutoffMs) : num(summary.series_2_0_win_rate),
      series_0_2_loss_rate: matches.length ? wRate(matches, (m) => m.winner_id !== teamId && matchScore(m, teamId)[0] === 0 && matchScore(m, teamId)[1] === 2, cutoffMs) : num(summary.series_0_2_loss_rate),
      series_go_3_maps_rate: matches.length ? wRate(matches, (m) => num(m.score_a) + num(m.score_b) >= 3, cutoffMs) : num(summary.series_go_3_maps_rate),
      first_game_win_rate: useMapStats && firstGameRows.length ? wRate(firstGameRows, (row) => row.map_winner_id === teamId, cutoffMs) : mapWinRate,
      avg_kills: avgKills,
      avg_deaths: avgDeaths,
      avg_kill_diff: killDiff,
      avg_total_kills: avgTotalKills,
      avg_game_time_min: avgTime,
      win_avg_game_time_min: useMapStats && wonMaps.length ? round2(wMean(wonMaps, (row) => num(row.game_time_min), cutoffMs), avgTime) : avgTime,
      loss_avg_game_time_min: useMapStats && lostMaps.length ? round2(wMean(lostMaps, (row) => num(row.game_time_min), cutoffMs), avgTime) : avgTime,
      first_blood_rate: useMapStats && firstBloodKnown.length
        ? wRate(firstBloodKnown, (row) => teamKey(row.first_blood_team_id || row.first_blood_team) === teamId, cutoffMs)
        : num(summary.first_blood_rate),
      first_turret_rate: useMapStats && firstTurretKnown.length
        ? wRate(firstTurretKnown, (row) => teamKey(row.first_turret_team_id || row.first_turret_team) === teamId, cutoffMs)
        : num(summary.first_turret_rate),
      dragon_control_rate: num(summary.dragon_control_rate),
      herald_control_rate: num(summary.herald_control_rate),
      baron_control_rate: num(summary.baron_control_rate),
      dragons_per_game: num(summary.dragons_per_game),
      voidgrubs_per_game: num(summary.voidgrubs_per_game),
      gd_at_15: num(summary.gd_at_15),
      td_at_15: num(summary.td_at_15),
      dpm: num(summary.dpm),
      wpm: num(summary.wpm),
      kill_over_27_5_rate: useMapStats ? pct(maps.filter((row) => num(row.total_kills) > 27.5).length, maps.length) : logistic((avgTotalKills - 27.5) / 4),
      kill_over_30_5_rate: useMapStats ? pct(maps.filter((row) => num(row.total_kills) > 30.5).length, maps.length) : logistic((avgTotalKills - 30.5) / 4),
      kill_over_33_5_rate: useMapStats ? pct(maps.filter((row) => num(row.total_kills) > 33.5).length, maps.length) : logistic((avgTotalKills - 33.5) / 4),
      time_over_31_5_rate: useMapStats ? pct(maps.filter((row) => num(row.game_time_min) > 31.5).length, maps.length) : logistic((avgTime - 31.5) / 2.7),
      time_over_32_5_rate: useMapStats ? pct(maps.filter((row) => num(row.game_time_min) > 32.5).length, maps.length) : logistic((avgTime - 32.5) / 2.7),
      time_over_33_5_rate: useMapStats ? pct(maps.filter((row) => num(row.game_time_min) > 33.5).length, maps.length) : logistic((avgTime - 33.5) / 2.7),
    };

    profile.strength_score = strengthScore(profile);
    profile.tempo_score = tempoScore(profile);
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

// 硬分类(仅用于确定 favorite/underdog 及兜底), 阈值来自 LCK 数据百分位
function classifyScenarioHard(a, b, t) {
  const favorite = a.strength_score >= b.strength_score ? a : b;
  const underdog = favorite === a ? b : a;
  const diff = favorite.strength_score - underdog.strength_score;
  const avgTotalKills = (a.avg_total_kills + b.avg_total_kills) / 2;
  const avgTime = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const chaos = (a.tempo_score + b.tempo_score) / 2;
  const underdogEarly = Math.max(underdog.first_blood_rate, underdog.first_turret_rate);

  if (chaos >= t.chaos_p70 && avgTotalKills >= t.high_kills_p70 && avgTime >= t.high_time_p70) {
    return { scenario: SCENARIOS.CHAOS_HIGH_KILL, favorite, underdog };
  }
  if (diff >= t.strength_diff_p70 && favorite.win_avg_game_time_min <= t.low_time_p30 && underdog.avg_deaths >= t.avg_deaths_p70 && favorite.first_turret_rate >= t.first_turret_p60) {
    return { scenario: SCENARIOS.FAST_STOMP, favorite, underdog };
  }
  if (diff >= t.strength_diff_p50 && (favorite.avg_game_time_min >= t.high_time_p70 || underdog.loss_avg_game_time_min >= t.high_time_p70 || favorite.avg_kills <= t.favorite_kills_p50)) {
    return { scenario: SCENARIOS.SLOW_FAVORITE, favorite, underdog };
  }
  if (diff >= t.strength_diff_p30 && underdogEarly >= t.underdog_early_p50) {
    return { scenario: SCENARIOS.UNDERDOG_LIVE, favorite, underdog };
  }
  if (avgTotalKills <= t.low_kills_p30 || (avgTime >= t.high_time_p70 && chaos <= t.chaos_p30)) {
    return { scenario: SCENARIOS.LOW_KILL_MACRO, favorite, underdog };
  }
  return { scenario: diff >= t.strength_diff_p30 ? SCENARIOS.SLOW_FAVORITE : SCENARIOS.UNDERDOG_LIVE, favorite, underdog };
}

// 旧管线: 写死阈值的硬分类(改动前那条被实战验证的逻辑)。返回 one-hot scenario_probs,
// 让下游概率函数得到和旧 if-else 完全等价的结果(scenarioWeights 对 one-hot 还原 mean += k*1)。
function classifyScenarioLegacy(a, b) {
  const favorite = a.strength_score >= b.strength_score ? a : b;
  const underdog = favorite === a ? b : a;
  const diff = favorite.strength_score - underdog.strength_score;
  const avgTotalKills = (a.avg_total_kills + b.avg_total_kills) / 2;
  const avgTime = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const chaos = (a.tempo_score + b.tempo_score) / 2;
  const underdogEarly = Math.max(underdog.first_blood_rate, underdog.first_turret_rate);
  let scenario;
  let reason;
  if (chaos >= 58 && avgTotalKills >= 30 && avgTime >= 30.5) {
    scenario = SCENARIOS.CHAOS_HIGH_KILL; reason = '双方总击杀和死亡环境偏高，且比赛时长不短，劣势方仍可能持续接团。';
  } else if (diff >= 15 && favorite.win_avg_game_time_min <= 30.8 && underdog.avg_deaths >= 14.5 && favorite.first_turret_rate >= 0.55) {
    scenario = SCENARIOS.FAST_STOMP; reason = '强队强度差明显，首塔/推进效率好，弱队死亡数偏高。';
  } else if (diff >= 11 && (favorite.avg_game_time_min >= 31.2 || underdog.loss_avg_game_time_min >= 31.2 || favorite.avg_kills <= 15)) {
    scenario = SCENARIOS.SLOW_FAVORITE; reason = '强队胜率占优，但节奏和终结速度不支持直接速推。';
  } else if (diff >= 6 && underdogEarly >= 0.48) {
    scenario = SCENARIOS.UNDERDOG_LIVE; reason = '强弱有差距，但弱队前期一血/首塔或近期单局表现有咬住空间。';
  } else if (avgTotalKills <= 28 || (avgTime >= 31.5 && chaos <= 52)) {
    scenario = SCENARIOS.LOW_KILL_MACRO; reason = '双方击杀环境偏低，比赛更依赖资源交换和控图推进。';
  } else {
    scenario = diff >= 6 ? SCENARIOS.SLOW_FAVORITE : SCENARIOS.UNDERDOG_LIVE;
    reason = diff >= 6 ? '强队略占优，但盘口不宜按碾压处理。' : '强度差不大，单局波动和BP影响更高。';
  }
  return { scenario, scenario_probs: oneHotScenario(scenario), hard_scenario: scenario, favorite, underdog, reason };
}

// 分发: 默认 legacy, MODEL_MODE=new 走软分类
export function classifyScenario(a, b) {
  return USE_NEW_MODEL ? classifyScenarioSoft(a, b) : classifyScenarioLegacy(a, b);
}

// 软分类: 每种剧本给一个连续分数, softmax 成概率, 避免硬阈值在边界跳变
function classifyScenarioSoft(a, b) {
  const t = loadScenarioThresholds();
  const hard = classifyScenarioHard(a, b, t);
  const { favorite, underdog } = hard;
  const diff = favorite.strength_score - underdog.strength_score;
  const avgTotalKills = (a.avg_total_kills + b.avg_total_kills) / 2;
  const avgTime = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const chaos = (a.tempo_score + b.tempo_score) / 2;
  const underdogEarly = Math.max(underdog.first_blood_rate, underdog.first_turret_rate);

  const scores = {
    [SCENARIOS.CHAOS_HIGH_KILL]: 0.15
      + above(chaos, t.chaos_p70, 0.25) * 1.15
      + above(avgTotalKills, t.high_kills_p70, 0.25) * 1.05
      + above(avgTime, t.high_time_p70, 0.25) * 0.75,
    [SCENARIOS.FAST_STOMP]: 0.15
      + above(diff, t.strength_diff_p70, 0.28) * 1.25
      + below(favorite.win_avg_game_time_min, t.low_time_p30, 0.35) * 0.95
      + above(underdog.avg_deaths, t.avg_deaths_p70, 0.25) * 0.85
      + above(favorite.first_turret_rate, t.first_turret_p60, 8) * 0.55,
    [SCENARIOS.SLOW_FAVORITE]: 0.15
      + above(diff, t.strength_diff_p50, 0.28) * 1.05
      + Math.max(
        above(favorite.avg_game_time_min, t.high_time_p70, 0.25),
        above(underdog.loss_avg_game_time_min, t.high_time_p70, 0.25),
        below(favorite.avg_kills, t.favorite_kills_p50, 0.35),
      ) * 1.05
      + below(chaos, t.chaos_p70, 0.18) * 0.45,
    [SCENARIOS.UNDERDOG_LIVE]: 0.15
      + above(diff, t.strength_diff_p30, 0.28) * 0.8
      + below(diff, t.strength_diff_p70, 0.25) * 0.8
      + above(underdogEarly, t.underdog_early_p50, 8) * 1.0
      + below(avgTotalKills, t.high_kills_p70, 0.18) * 0.35,
    [SCENARIOS.LOW_KILL_MACRO]: 0.15
      + below(avgTotalKills, t.low_kills_p30, 0.25) * 1.25
      + above(avgTime, t.high_time_p70, 0.22) * 0.75
      + below(chaos, t.chaos_p30, 0.25) * 1.0,
  };

  const scenario_probs = softmaxScores(scores);
  const primary = topScenario(scenario_probs);
  const top2 = Object.entries(scenario_probs).sort((x, y) => y[1] - x[1]).slice(0, 2)
    .map(([n, p]) => `${n} ${(p * 100).toFixed(0)}%`).join(' / ');
  return {
    scenario: primary,
    scenario_probs,
    hard_scenario: hard.scenario,
    favorite,
    underdog,
    reason: `软分类 top2=${top2}; 强度差=${diff.toFixed(1)}, chaos=${chaos.toFixed(1)}, 均杀=${avgTotalKills.toFixed(1)}, 均时长=${avgTime.toFixed(1)}。`,
  };
}

function sampleConfidence(profileA, profileB) {
  const sample = Math.min(num(profileA.maps) + num(profileB.maps), 60);
  return clamp(sample / 40, 0.45, 1);
}

const MATCH_WIN_SHRINK_K = 0.91;

function matchWinProbability(team, opponent, options = {}) {
  const confidence = sampleConfidence(team, opponent);
  const raw = logistic((team.strength_score - opponent.strength_score) / 13);
  const probability = clamp(0.5 + (raw - 0.5) * confidence, 0.05, 0.95);
  if (!options.shrink) return probability;
  return clamp(0.5 + (probability - 0.5) * MATCH_WIN_SHRINK_K, 0.05, 0.95);
}

function coverProbability(team, opponent, line) {
  const expectedKillDiff = ((team.avg_kill_diff - opponent.avg_kill_diff) / 2)
    + ((team.strength_score - opponent.strength_score) / 9);
  const threshold = -Number(line);
  return clamp(logistic((expectedKillDiff - threshold) / 4.8), 0.05, 0.95);
}

function totalKillsProbability(team, opponent, line, selection, scenario, patch = '') {
  try {
    const prediction = predictTotalKills(team, opponent, patch || team.current_patch || opponent.current_patch || '');
    if (prediction) return selection === 'over' ? prediction.p_over(line) : prediction.p_under(line);
  } catch {
    // Fall back to the original scenario formula if the calibrated model is unavailable.
  }
  const probs = scenarioWeights(scenario);
  let mean = (team.avg_total_kills + opponent.avg_total_kills) / 2;
  mean += 2.2 * probs[SCENARIOS.CHAOS_HIGH_KILL];
  mean -= 2.0 * probs[SCENARIOS.LOW_KILL_MACRO];
  mean -= 0.8 * probs[SCENARIOS.FAST_STOMP];
  const over = clamp(logistic((mean - Number(line)) / 3.8), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

function gameTimeProbability(team, opponent, line, selection, scenario) {
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

function mapHandicapProbability(favorite, underdog, scenario) {
  const probs = scenarioWeights(scenario);
  let p = (favorite.series_2_0_win_rate + underdog.series_0_2_loss_rate + matchWinProbability(favorite, underdog) ** 2) / 3;
  p += 0.09 * probs[SCENARIOS.FAST_STOMP];
  p -= 0.08 * probs[SCENARIOS.SLOW_FAVORITE];
  p -= 0.11 * probs[SCENARIOS.UNDERDOG_LIVE];
  p -= 0.04 * probs[SCENARIOS.CHAOS_HIGH_KILL];
  return clamp(p, 0.05, 0.9);
}

function mapTotalOverProbability(favorite, underdog, scenario) {
  const probs = scenarioWeights(scenario);
  const diff = Math.abs(favorite.strength_score - underdog.strength_score);
  let p = ((favorite.series_go_3_maps_rate + underdog.series_go_3_maps_rate) / 2) * 0.45
    + clamp(0.66 - diff / 38, 0.22, 0.66) * 0.55;
  p += 0.08 * probs[SCENARIOS.UNDERDOG_LIVE];
  p -= 0.12 * probs[SCENARIOS.FAST_STOMP];
  p += 0.02 * probs[SCENARIOS.SLOW_FAVORITE];
  return clamp(p, 0.08, 0.82);
}

function firstObjectiveProbability(team, opponent, field) {
  const p = team[field] * 0.62 + (1 - opponent[field]) * 0.28 + 0.5 * 0.10;
  return clamp(p, 0.12, 0.88);
}

function scenarioAlignment(row, scenario, favorite, underdog) {
  const isFav = teamKey(row.selection) === favorite.team_id;
  const isDog = teamKey(row.selection) === underdog.team_id;
  if (scenario === '强队速推碾压局') {
    if ((row.market === 'map_handicap' && isFav && Number(row.line) < 0)
      || (row.market === 'team_kills_handicap' && isFav && Number(row.line) < 0)
      || (row.market === 'game_time' && row.selection === 'under')
      || (row.market === 'map_total' && row.selection === 'under')) return '一致';
    if ((row.market === 'map_total' && row.selection === 'over') || (row.market === 'game_time' && row.selection === 'over')) return '冲突';
  }
  if (scenario === '强队慢热终结局') {
    if ((row.market === 'match_win' && isFav)
      || (row.market === 'team_kills_handicap' && isDog && Number(row.line) > 0)
      || (row.market === 'game_time' && row.selection === 'over')) return '一致';
    if (row.market === 'team_kills_handicap' && isFav && Number(row.line) < -5) return '冲突';
  }
  if (scenario === '弱队能咬住但难赢') {
    if ((row.market === 'map_handicap' && isDog && Number(row.line) > 0)
      || (row.market === 'match_win' && isFav)
      || (row.market === 'map_total' && row.selection === 'over')) return '一致';
  }
  if (scenario === '混乱高击杀局') {
    if ((row.market === 'total_kills' && row.selection === 'over') || (row.market === 'game_time' && row.selection === 'over')) return '一致';
    if (row.market === 'total_kills' && row.selection === 'under') return '冲突';
  }
  if (scenario === '低击杀运营局') {
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
    ...extra,
    market,
    selection,
    line: line ?? '',
    side: '',
    probability: decimal(clamp(probability, 0.02, 0.98)),
    probability_text: pctText(clamp(probability, 0.02, 0.98)),
    sample,
    basis,
    note: note || extra.note || '',
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
    model_mode: MODEL_MODE,
    match_id: match.match_id,
    match_date: match.match_date,
    match_name: match.match_name,
    scenario: scenario.scenario,
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
  const rawPA = matchWinProbability(a, b);
  const rawPB = 1 - rawPA;
  const pA = matchWinProbability(a, b, { shrink: true });
  const pB = 1 - pA;
  addRate(rows, base, 'match_win', a.team, '', pA, sample, '综合强度/近期/前期资源', 'match_win shrink k=0.91', {
    raw_probability: decimal(rawPA),
    raw_probability_text: pctText(rawPA),
  });
  addRate(rows, base, 'match_win', b.team, '', pB, sample, '综合强度/近期/前期资源', 'match_win shrink k=0.91', {
    raw_probability: decimal(rawPB),
    raw_probability_text: pctText(rawPB),
  });

  const fav2_0 = mapHandicapProbability(favorite, underdog, scenario.scenario_probs);
  addRate(rows, base, 'map_handicap', favorite.team, '-1.5', fav2_0, sample, '2-0率/被2-0率/剧本修正');
  addRate(rows, base, 'map_handicap', underdog.team, '+1.5', 1 - fav2_0, sample, '2-0率/被2-0率/剧本修正');
  const overMaps = mapTotalOverProbability(favorite, underdog, scenario.scenario_probs);
  addRate(rows, base, 'map_total', 'over', '2.5', overMaps, sample, '打满率/强度接近度/剧本修正');
  addRate(rows, base, 'map_total', 'under', '2.5', 1 - overMaps, sample, '打满率/强度接近度/剧本修正');

  addRate(rows, base, 'game1_win', a.team, '', clamp(pA * 0.6 + a.first_game_win_rate * 0.4, 0.05, 0.95), sample, '第一局胜率/整体胜率');
  addRate(rows, base, 'game1_win', b.team, '', clamp(pB * 0.6 + b.first_game_win_rate * 0.4, 0.05, 0.95), sample, '第一局胜率/整体胜率');

  addRate(rows, base, 'team_kills_handicap', favorite.team, '-5.5', coverProbability(favorite, underdog, -5.5), sample, '击杀差/强度差');
  addRate(rows, base, 'team_kills_handicap', underdog.team, '+5.5', coverProbability(underdog, favorite, 5.5), sample, '击杀差/强度差');

  const totalKillsModel = (() => {
    try {
      return predictTotalKills(a, b, match.patch || '');
    } catch {
      return null;
    }
  })();
  const totalKillsExtra = (line, selection) => {
    if (!totalKillsModel) return {};
    const lineEdge = selection === 'over' ? totalKillsModel.mean - Number(line) : Number(line) - totalKillsModel.mean;
    return {
      total_kills_model_mean: totalKillsModel.mean.toFixed(2),
      total_kills_model_sigma: totalKillsModel.sigma.toFixed(2),
      line_edge_kills: lineEdge.toFixed(2),
      note: 'continuous_total_kills_model',
    };
  };

  for (const line of Array.from({ length: 15 }, (_, index) => 24.5 + index)) {
    addRate(rows, base, 'total_kills', 'over', String(line), totalKillsProbability(a, b, line, 'over', scenario.scenario_probs, match.patch || ''), sample, '双方总击杀均值/死亡数/剧本', '', totalKillsExtra(line, 'over'));
    addRate(rows, base, 'total_kills', 'under', String(line), totalKillsProbability(a, b, line, 'under', scenario.scenario_probs, match.patch || ''), sample, '双方总击杀均值/死亡数/剧本', '', totalKillsExtra(line, 'under'));
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
      model_mode: MODEL_MODE,
      match_id: match.match_id,
      match_date: match.match_date,
      match_name: match.match_name,
      scenario: scenario.scenario,
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
    model_mode: row.model_mode || MODEL_MODE,
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
  const { matches: matchRows, maps: mapRows, summary: summaryRows } = await readLckData();

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
      model_mode: MODEL_MODE,
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
    'model_mode', 'match_id', 'match_date', 'match_name', 'scenario', 'scenario_reason',
    'favorite', 'underdog', 'market', 'selection', 'line', 'side',
    'probability', 'probability_text', 'raw_probability', 'raw_probability_text',
    'sample', 'basis', 'scenario_alignment',
    'team_state_summary', 'key_data', 'risk_tip',
    'total_kills_model_mean', 'total_kills_model_sigma', 'line_edge_kills',
    'note',
  ]);
  await writeCsv(path.join(ANALYSIS_DIR, '赔率填写模板.csv'), template, [
    'model_mode', 'match_id', 'match_date', 'match_name', 'scenario', 'market', 'selection',
    'line', 'side', 'odds', 'note',
  ]);
  await writeEvaluationOutputs(evaluation, reports);

  await writeFile(path.join(ANALYSIS_DIR, '字段说明.txt'), [
    'LCK盘口模型字段说明',
    '',
    `model_mode = ${MODEL_MODE}（默认 legacy；MODEL_MODE=new 才启用实验管线）`,
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
  ].join('\r\n'), 'utf8');

  console.log(`完成。待赛 ${upcoming.length} 场，盘口概率 ${allRates.length} 条。`);
  console.log(path.join(ANALYSIS_DIR, '赔率填写模板.csv'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
  console.error(`LCK盘口分析生成失败: ${error.message}`);
  process.exitCode = 1;
  });
}
