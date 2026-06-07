import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  clamp,
  num,
  readCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from '../shared.js';
import { buildProfiles, matchWinProbability } from '../build-market-analysis.js';
import { buildSnapshotSummary } from '../backtest/common.js';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtest');
const MATCHES_CSV = path.join(HISTORY_DIR, 'all_matches.csv');
const MAPS_CSV = path.join(HISTORY_DIR, 'all_map_details.csv');
const SUMMARY_CSV = path.join(HISTORY_DIR, 'all_team_summary.csv');
const CURRENT_PLAYERS_CSV = path.join(DATA_DIR, 'lpl_player_map_details.csv');
const OP_CSV = path.join(HISTORY_DIR, 'oddsportal_lpl_match_odds.csv');

const DETAIL_CSV = path.join(BACKTEST_DIR, 'elo_roster_predictions.csv');
const SUMMARY_OUT_CSV = path.join(BACKTEST_DIR, 'elo_roster_summary.csv');
const BREAKPOINT_CSV = path.join(BACKTEST_DIR, 'elo_roster_breakpoints.csv');
const CONFIG_JSON = path.join(process.cwd(), 'lpl', 'calibration', 'elo_roster_baseline.json');
const REPORT_MD = path.join(ANALYSIS_DIR, 'Elo阵容断点基线对比.md');

const BASE_RATING = 1500;
const ELO_SCALE = 400;
const TEAM_K = 30;
const PLAYER_K = 10;
const DECAY_HALF_LIFE_DAYS = 150;
const ROSTER_BREAK_OVERLAP = 0.7;
const ROSTER_BREAK_RETENTION = 0.45;
const PLAYER_BLEND_WEIGHT = 0.35;
const BOOTSTRAP_SEED = 20260606;
const BOOTSTRAP_ITERS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MODEL_KEYS = [
  'current_model',
  'market',
  'elo_plain',
  'elo_decay',
  'elo_roster_reset',
  'elo_roster_player_blend',
];

function dateText(value) {
  return String(value || '').slice(0, 10);
}

function dateMs(value) {
  const text = dateText(value);
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function daysBetween(later, earlier) {
  const a = dateMs(later);
  const b = dateMs(earlier);
  if (a == null || b == null) return NaN;
  return Math.max(0, (a - b) / DAY_MS);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function fmtPct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function variance(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return NaN;
  const avg = mean(clean);
  return mean(clean.map((value) => (value - avg) ** 2));
}

function isFinished(match) {
  return Boolean(teamKey(match.winner_id || match.winner))
    && num(match.score_a, -1) >= 0
    && num(match.score_b, -1) >= 0
    && dateText(match.match_date);
}

function yearOf(row) {
  return dateText(row.match_date).slice(0, 4);
}

function mapNumber(row, fallback = 0) {
  return num(row.bo || row.map_number, fallback + 1);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function eloProbability(ratingA, ratingB) {
  return clamp(1 / (1 + (10 ** (-(ratingA - ratingB) / ELO_SCALE))), 0.03, 0.97);
}

function marginMultiplier(match) {
  const diff = Math.abs(num(match.score_a) - num(match.score_b));
  const mapsPlayed = num(match.score_a) + num(match.score_b);
  const seriesBoost = mapsPlayed >= 4 ? 1.08 : 1;
  return clamp((1 + Math.max(0, diff - 1) * 0.16) * seriesBoost, 0.9, 1.35);
}

function ratingAfterDecay(rating, currentDate, lastDate) {
  const days = daysBetween(currentDate, lastDate);
  if (!Number.isFinite(days) || days <= 0) return rating;
  const retention = 0.5 ** (days / DECAY_HALF_LIFE_DAYS);
  return BASE_RATING + (rating - BASE_RATING) * retention;
}

function getTeamState(states, teamId) {
  if (!states.has(teamId)) {
    states.set(teamId, {
      rating: BASE_RATING,
      lastDate: '',
      matches: 0,
      lastRoster: null,
    });
  }
  return states.get(teamId);
}

function updateElo(states, match, modelKey, breakpoints, rostersByTeam = null) {
  const teamA = teamKey(match.team_a_id || match.team_a);
  const teamB = teamKey(match.team_b_id || match.team_b);
  const stateA = getTeamState(states, teamA);
  const stateB = getTeamState(states, teamB);
  const matchDate = dateText(match.match_date);

  if (modelKey.includes('decay')) {
    stateA.rating = ratingAfterDecay(stateA.rating, matchDate, stateA.lastDate);
    stateB.rating = ratingAfterDecay(stateB.rating, matchDate, stateB.lastDate);
  }

  if (modelKey.includes('roster') && rostersByTeam) {
    maybeApplyRosterBreak(stateA, teamA, match, rostersByTeam.get(teamA), modelKey, breakpoints);
    maybeApplyRosterBreak(stateB, teamB, match, rostersByTeam.get(teamB), modelKey, breakpoints);
  }

  const pA = eloProbability(stateA.rating, stateB.rating);
  const outcomeA = teamKey(match.winner_id || match.winner) === teamA ? 1 : 0;
  const k = TEAM_K * marginMultiplier(match);
  const deltaA = k * (outcomeA - pA);
  stateA.rating += deltaA;
  stateB.rating -= deltaA;
  stateA.matches += 1;
  stateB.matches += 1;
  stateA.lastDate = matchDate;
  stateB.lastDate = matchDate;

  if (rostersByTeam) {
    if (rostersByTeam.get(teamA)?.size) stateA.lastRoster = new Set(rostersByTeam.get(teamA));
    if (rostersByTeam.get(teamB)?.size) stateB.lastRoster = new Set(rostersByTeam.get(teamB));
  }
}

function maybeApplyRosterBreak(state, teamId, match, roster, modelKey, breakpoints) {
  if (!roster?.size) return;
  if (!state.lastRoster?.size) return;
  const overlap = rosterOverlap(state.lastRoster, roster);
  if (!Number.isFinite(overlap) || overlap >= ROSTER_BREAK_OVERLAP) return;
  const oldRating = state.rating;
  const retention = modelKey === 'elo_roster_player_blend'
    ? clamp(overlap, ROSTER_BREAK_RETENTION, 0.9)
    : ROSTER_BREAK_RETENTION;
  state.rating = BASE_RATING + (state.rating - BASE_RATING) * retention;
  breakpoints.push({
    date: dateText(match.match_date),
    match_id: match.match_id,
    match_name: match.match_name,
    team_id: teamId,
    model: modelKey,
    overlap: fmt(overlap),
    retention: fmt(retention),
    rating_before: fmt(oldRating, 2),
    rating_after: fmt(state.rating, 2),
    previous_roster: [...state.lastRoster].sort().join('/'),
    current_roster: [...roster].sort().join('/'),
  });
}

function rosterOverlap(a, b) {
  if (!a?.size || !b?.size) return NaN;
  let same = 0;
  for (const item of a) if (b.has(item)) same += 1;
  return same / Math.max(a.size, b.size);
}

function playerKey(teamId, playerName) {
  return `${teamKey(teamId)}:${String(playerName || '').trim().toLowerCase()}`;
}

function playerRating(playerStates, key) {
  if (!playerStates.has(key)) playerStates.set(key, BASE_RATING);
  return playerStates.get(key);
}

function rosterPlayerRating(playerStates, teamId, roster) {
  if (!roster?.size) return BASE_RATING;
  const values = [...roster].map((player) => playerRating(playerStates, playerKey(teamId, player)));
  return mean(values);
}

function blendedRating(teamRating, playerRosterRating) {
  return teamRating * (1 - PLAYER_BLEND_WEIGHT) + playerRosterRating * PLAYER_BLEND_WEIGHT;
}

function updatePlayerElo(playerStates, match, rostersByTeam) {
  const teamA = teamKey(match.team_a_id || match.team_a);
  const teamB = teamKey(match.team_b_id || match.team_b);
  const rosterA = rostersByTeam.get(teamA);
  const rosterB = rostersByTeam.get(teamB);
  if (!rosterA?.size || !rosterB?.size) return;
  const ratingA = rosterPlayerRating(playerStates, teamA, rosterA);
  const ratingB = rosterPlayerRating(playerStates, teamB, rosterB);
  const pA = eloProbability(ratingA, ratingB);
  const outcomeA = teamKey(match.winner_id || match.winner) === teamA ? 1 : 0;
  const deltaA = PLAYER_K * marginMultiplier(match) * (outcomeA - pA);
  for (const player of rosterA) {
    const key = playerKey(teamA, player);
    playerStates.set(key, playerRating(playerStates, key) + deltaA);
  }
  for (const player of rosterB) {
    const key = playerKey(teamB, player);
    playerStates.set(key, playerRating(playerStates, key) - deltaA);
  }
}

async function loadPlayerRows() {
  const rows = [];
  rows.push(...await readCsvIfExists(CURRENT_PLAYERS_CSV));
  if (existsSync(HISTORY_DIR)) {
    for (const entry of await readdir(HISTORY_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      rows.push(...await readCsvIfExists(path.join(HISTORY_DIR, entry.name, 'lpl_player_map_details.csv')));
    }
  }
  return dedupePlayers(rows);
}

function dedupePlayers(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      row.match_id,
      row.game_id,
      teamKey(row.team_id || row.team),
      String(row.role || '').toUpperCase(),
      String(row.player_name || '').trim().toLowerCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildRosterIndex(playerRows) {
  const byMapTeam = new Map();
  for (const row of playerRows) {
    const teamId = teamKey(row.team_id || row.team);
    const player = String(row.player_name || '').trim();
    if (!teamId || !player) continue;
    const key = [row.match_id, row.game_id, teamId].join('|');
    if (!byMapTeam.has(key)) byMapTeam.set(key, new Map());
    const role = String(row.role || '').toUpperCase() || String(byMapTeam.get(key).size);
    byMapTeam.get(key).set(role, player);
  }

  const out = new Map();
  for (const [key, roleMap] of byMapTeam.entries()) {
    const roster = [...roleMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, player]) => player.toLowerCase())
      .filter(Boolean);
    out.set(key, new Set(roster));
  }
  return out;
}

function rosterForMap(map, teamId, rosterIndex) {
  return rosterIndex.get([map.match_id, map.game_id, teamKey(teamId)].join('|')) || null;
}

function rosterForMatchTeam(match, matchMaps, rosterIndex, teamId) {
  const maps = [...matchMaps].sort((a, b) => mapNumber(a) - mapNumber(b));
  for (const map of maps) {
    const roster = rosterForMap(map, teamId, rosterIndex);
    if (roster?.size) return roster;
  }
  return null;
}

function rostersForMatch(match, matchMaps, rosterIndex) {
  const teamA = teamKey(match.team_a_id || match.team_a);
  const teamB = teamKey(match.team_b_id || match.team_b);
  return new Map([
    [teamA, rosterForMatchTeam(match, matchMaps, rosterIndex, teamA)],
    [teamB, rosterForMatchTeam(match, matchMaps, rosterIndex, teamB)],
  ]);
}

function buildMarketIndex(opRows) {
  const index = new Map();
  for (const row of opRows) {
    const date = dateText(row.match_date);
    const home = teamKey(row.home_key || row.home_team);
    const away = teamKey(row.away_key || row.away_team);
    if (!date || !home || !away) continue;
    const direct = {
      pTeam1: num(row.home_market_p, NaN),
      pTeam2: num(row.away_market_p, NaN),
      avgOddsTeam1: num(row.home_avg_odds, NaN),
      avgOddsTeam2: num(row.away_avg_odds, NaN),
    };
    index.set([date, home, away].join('|'), direct);
    index.set([date, away, home].join('|'), {
      pTeam1: direct.pTeam2,
      pTeam2: direct.pTeam1,
      avgOddsTeam1: direct.avgOddsTeam2,
      avgOddsTeam2: direct.avgOddsTeam1,
    });
  }
  return index;
}

function marketForMatch(match, marketIndex) {
  const teamA = teamKey(match.team_a_id || match.team_a);
  const teamB = teamKey(match.team_b_id || match.team_b);
  return marketIndex.get([dateText(match.match_date), teamA, teamB].join('|')) || null;
}

function trainingMaxDate(maps, match) {
  const cutoff = dateText(match.match_date);
  const teams = new Set([
    teamKey(match.team_a_id || match.team_a),
    teamKey(match.team_b_id || match.team_b),
  ]);
  const dates = maps
    .filter((row) => dateText(row.match_time || row.match_date) < cutoff)
    .filter((row) => teams.has(teamKey(row.team_a_id || row.team_a)) || teams.has(teamKey(row.team_b_id || row.team_b)))
    .map((row) => dateText(row.match_time || row.match_date))
    .filter(Boolean)
    .sort();
  return dates.at(-1) || '';
}

function currentModelPrediction(match, matches, maps, summary, profileCache) {
  const cutoff = dateText(match.match_date);
  if (!profileCache.has(cutoff)) {
    const snapshot = buildSnapshotSummary(maps, cutoff);
    profileCache.set(cutoff, buildProfiles(matches, maps, snapshot, cutoff));
  }
  const profiles = profileCache.get(cutoff);
  const a = profiles.get(teamKey(match.team_a_id || match.team_a));
  const b = profiles.get(teamKey(match.team_b_id || match.team_b));
  if (!a || !b || Math.min(num(a.maps), num(b.maps)) < 8) {
    return { p: NaN, teamAMaps: a ? num(a.maps) : 0, teamBMaps: b ? num(b.maps) : 0 };
  }
  return {
    p: matchWinProbability(a, b),
    teamAMaps: num(a.maps),
    teamBMaps: num(b.maps),
    teamAStrength: num(a.strength_score),
    teamBStrength: num(b.strength_score),
  };
}

function modelPredictions(match, states, playerStates) {
  const teamA = teamKey(match.team_a_id || match.team_a);
  const teamB = teamKey(match.team_b_id || match.team_b);
  const p = {};
  const statePlainA = getTeamState(states.elo_plain, teamA);
  const statePlainB = getTeamState(states.elo_plain, teamB);
  p.elo_plain = eloProbability(statePlainA.rating, statePlainB.rating);

  const stateDecayA = getTeamState(states.elo_decay, teamA);
  const stateDecayB = getTeamState(states.elo_decay, teamB);
  p.elo_decay = eloProbability(
    ratingAfterDecay(stateDecayA.rating, match.match_date, stateDecayA.lastDate),
    ratingAfterDecay(stateDecayB.rating, match.match_date, stateDecayB.lastDate),
  );

  const stateRosterA = getTeamState(states.elo_roster_reset, teamA);
  const stateRosterB = getTeamState(states.elo_roster_reset, teamB);
  p.elo_roster_reset = eloProbability(stateRosterA.rating, stateRosterB.rating);

  const stateBlendA = getTeamState(states.elo_roster_player_blend, teamA);
  const stateBlendB = getTeamState(states.elo_roster_player_blend, teamB);
  const rosterA = stateBlendA.lastRoster;
  const rosterB = stateBlendB.lastRoster;
  const blendA = blendedRating(stateBlendA.rating, rosterPlayerRating(playerStates, teamA, rosterA));
  const blendB = blendedRating(stateBlendB.rating, rosterPlayerRating(playerStates, teamB, rosterB));
  p.elo_roster_player_blend = eloProbability(blendA, blendB);
  return p;
}

function updateAllStates(states, playerStates, match, matchMaps, rosterIndex, breakpoints) {
  const rostersByTeam = rostersForMatch(match, matchMaps, rosterIndex);
  updateElo(states.elo_plain, match, 'elo_plain', breakpoints);
  updateElo(states.elo_decay, match, 'elo_decay', breakpoints);
  updateElo(states.elo_roster_reset, match, 'elo_roster_reset', breakpoints, rostersByTeam);
  updateElo(states.elo_roster_player_blend, match, 'elo_roster_player_blend', breakpoints, rostersByTeam);
  updatePlayerElo(playerStates, match, rostersByTeam);
}

function brier(rows, modelKey) {
  return mean(rows.map((row) => {
    const p = num(row[modelKey], NaN);
    const y = num(row.outcome, NaN);
    return Number.isFinite(p) && Number.isFinite(y) ? (p - y) ** 2 : NaN;
  }));
}

function logLoss(rows, modelKey) {
  return mean(rows.map((row) => {
    const p = clamp(num(row[modelKey], NaN), 0.000001, 0.999999);
    const y = num(row.outcome, NaN);
    if (!Number.isFinite(p) || !Number.isFinite(y)) return NaN;
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }));
}

function hitRate(rows) {
  return mean(rows.map((row) => num(row.outcome, NaN)));
}

function accuracy(rows, modelKey) {
  return mean(rows.map((row) => {
    const p = num(row[modelKey], NaN);
    const y = num(row.outcome, NaN);
    if (!Number.isFinite(p) || !Number.isFinite(y)) return NaN;
    return (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
  }));
}

function ece(rows, modelKey, bucketCount = 10) {
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (const row of rows) {
    const p = num(row[modelKey], NaN);
    const y = num(row.outcome, NaN);
    if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
    const bucket = Math.min(bucketCount - 1, Math.floor(clamp(p, 0, 0.999999) * bucketCount));
    buckets[bucket].push({ p, y });
  }
  const total = buckets.reduce((sum, items) => sum + items.length, 0);
  if (!total) return NaN;
  return buckets.reduce((sum, items) => {
    if (!items.length) return sum;
    const meanP = mean(items.map((item) => item.p));
    const meanY = mean(items.map((item) => item.y));
    return sum + (items.length / total) * Math.abs(meanP - meanY);
  }, 0);
}

function bias(rows, modelKey) {
  return mean(rows.map((row) => {
    const p = num(row[modelKey], NaN);
    const y = num(row.outcome, NaN);
    return Number.isFinite(p) && Number.isFinite(y) ? p - y : NaN;
  }));
}

function validRows(rows, modelKey) {
  return rows.filter((row) => Number.isFinite(num(row[modelKey], NaN)) && Number.isFinite(num(row.outcome, NaN)));
}

function foldRows(rows, fold) {
  if (fold === 'all') return rows;
  if (fold === 'recent_2025_2026') return rows.filter((row) => row.year === '2025' || row.year === '2026');
  return rows.filter((row) => row.year === fold);
}

function summaryRows(rows) {
  const folds = ['2024', '2025', '2026', 'recent_2025_2026', 'all'];
  const out = [];
  for (const fold of folds) {
    const baseRows = foldRows(rows, fold);
    for (const model of MODEL_KEYS) {
      const items = validRows(baseRows, model);
      if (!items.length) continue;
      out.push({
        fold,
        model,
        n: items.length,
        brier: fmt(brier(items, model)),
        logloss: fmt(logLoss(items, model)),
        ece: fmt(ece(items, model)),
        bias_p_minus_actual: fmt(bias(items, model)),
        hit_rate: fmt(hitRate(items)),
        accuracy: fmt(accuracy(items, model)),
        mean_p: fmt(mean(items.map((row) => num(row[model], NaN)))),
        p_sd: fmt(Math.sqrt(variance(items.map((row) => num(row[model], NaN))))),
      });
    }
  }
  return out;
}

function bootstrapDelta(rows, candidateKey, baselineKey) {
  const usable = rows.filter((row) => Number.isFinite(num(row[candidateKey], NaN))
    && Number.isFinite(num(row[baselineKey], NaN))
    && Number.isFinite(num(row.outcome, NaN)));
  const clusters = [...groupBy(usable, (row) => row.match_id).values()];
  if (clusters.length < 20) return { nClusters: clusters.length, low: NaN, high: NaN, mean: NaN };
  const random = seededRandom(BOOTSTRAP_SEED);
  const deltas = [];
  for (let i = 0; i < BOOTSTRAP_ITERS; i += 1) {
    const sample = [];
    for (let j = 0; j < clusters.length; j += 1) {
      sample.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    deltas.push(brier(sample, candidateKey) - brier(sample, baselineKey));
  }
  deltas.sort((a, b) => a - b);
  return {
    nClusters: clusters.length,
    mean: mean(deltas),
    low: deltas[Math.floor(deltas.length * 0.025)],
    high: deltas[Math.floor(deltas.length * 0.975)],
  };
}

function bestVariant(summary) {
  const recent = summary.filter((row) => row.fold === 'recent_2025_2026' && row.model.startsWith('elo_'));
  return [...recent].sort((a, b) => num(a.brier, Infinity) - num(b.brier, Infinity))[0] || null;
}

function markdownTable(rows, columns) {
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => String(row[col] ?? '')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function reportMarkdown({ detailRows, summary, breakpoints, config, leakageChecks }) {
  const recentRows = summary.filter((row) => row.fold === 'recent_2025_2026');
  const yearRows = summary.filter((row) => ['2024', '2025', '2026'].includes(row.fold)
    && ['current_model', config.best_variant, 'market'].includes(row.model));
  const bpByYear = Object.entries(Object.groupBy ? Object.groupBy(breakpoints, (row) => row.date.slice(0, 4)) : {})
    .map(([year, rows]) => ({ year, breakpoints: rows.length }));
  const fallbackBpByYear = !Object.groupBy
    ? [...groupBy(breakpoints, (row) => row.date.slice(0, 4)).entries()].map(([year, rows]) => ({ year, breakpoints: rows.length }))
    : bpByYear;

  return [
    '# LPL Elo + roster baseline review',
    '',
    '## 大白话结论',
    '',
    config.deploy
      ? `- 这轮 Elo/阵容断点 baseline 通过了纸面闸门，最佳版本是 ${config.best_variant}。但它仍然只是 baseline，需要再接真实赔率 ROI 后才能真钱用。`
      : `- 这轮只落成“对照实验”，不接管线上模型。最佳版本是 ${config.best_variant || 'none'}，deploy=false。`,
    '- 它解决的是一个问题：队伍换人后，老队名下面的旧战绩不能全信；Elo 会在阵容断点后把评分往联盟均值拉回。',
    '- 预测时严格只用比赛日前的数据；同一天的比赛先全部预测，再统一更新，避免同日结果泄漏。',
    '',
    '## Recent 2025+2026 summary / 近两年滚动对比',
    '',
    markdownTable(recentRows, ['model', 'n', 'brier', 'ece', 'bias_p_minus_actual', 'accuracy', 'mean_p']),
    '',
    '## Yearly key comparison / 分年关键对比',
    '',
    markdownTable(yearRows, ['fold', 'model', 'n', 'brier', 'ece', 'bias_p_minus_actual', 'accuracy']),
    '',
    '## Bootstrap check / Bootstrap 稳健性',
    '',
    markdownTable(config.bootstrap_checks, ['candidate', 'baseline', 'fold', 'n_clusters', 'brier_delta_mean', 'ci_low', 'ci_high', 'pass']),
    '',
    '## Roster break count / 阵容断点数量',
    '',
    markdownTable(fallbackBpByYear, ['year', 'breakpoints']),
    '',
    '## Leakage spot check / 泄漏抽查',
    '',
    markdownTable(leakageChecks, ['match_id', 'match_date', 'train_max_date', 'ok']),
    '',
    '## Files / 输出文件',
    '',
    `- detail csv: ${DETAIL_CSV}`,
    `- summary csv: ${SUMMARY_OUT_CSV}`,
    `- roster break csv: ${BREAKPOINT_CSV}`,
    `- config json: ${CONFIG_JSON}`,
    '',
    `detail_rows=${detailRows.length}`,
    `roster_break_rows=${breakpoints.length}`,
    '',
  ].join('\n');
}

async function main() {
  await mkdir(BACKTEST_DIR, { recursive: true });
  await mkdir(path.dirname(REPORT_MD), { recursive: true });

  const [matches, maps, teamSummary, playerRows, opRows] = await Promise.all([
    readCsv(MATCHES_CSV),
    readCsv(MAPS_CSV),
    readCsvIfExists(SUMMARY_CSV),
    loadPlayerRows(),
    readCsvIfExists(OP_CSV),
  ]);

  const finished = matches
    .filter(isFinished)
    .filter((row) => ['2024', '2025', '2026'].includes(yearOf(row)))
    .sort((a, b) => dateText(a.match_date).localeCompare(dateText(b.match_date))
      || String(a.match_id).localeCompare(String(b.match_id)));

  const rosterIndex = buildRosterIndex(playerRows);
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const marketIndex = buildMarketIndex(opRows);
  const byDate = groupBy(finished, (row) => dateText(row.match_date));
  const states = {
    elo_plain: new Map(),
    elo_decay: new Map(),
    elo_roster_reset: new Map(),
    elo_roster_player_blend: new Map(),
  };
  const playerStates = new Map();
  const profileCache = new Map();
  const breakpoints = [];
  const rows = [];
  const leakageChecks = [];

  for (const [date, dayMatches] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const match of dayMatches) {
      const teamA = teamKey(match.team_a_id || match.team_a);
      const teamB = teamKey(match.team_b_id || match.team_b);
      const outcome = teamKey(match.winner_id || match.winner) === teamA ? 1 : 0;
      const current = currentModelPrediction(match, matches, maps, teamSummary, profileCache);
      const elo = modelPredictions(match, states, playerStates);
      const market = marketForMatch(match, marketIndex);
      const trainMax = trainingMaxDate(maps, match);
      if (leakageChecks.length < 10) {
        leakageChecks.push({
          match_id: match.match_id,
          match_date: date,
          train_max_date: trainMax,
          ok: trainMax ? String(trainMax) < String(date) : 'no_prior',
        });
      }
      rows.push({
        match_id: match.match_id,
        match_date: date,
        year: yearOf(match),
        tournament: match.tournament || '',
        stage: match.stage || '',
        patch: match.patch || '',
        match_name: match.match_name,
        team_a_id: teamA,
        team_a: match.team_a,
        team_b_id: teamB,
        team_b: match.team_b,
        score_a: match.score_a,
        score_b: match.score_b,
        winner_id: teamKey(match.winner_id || match.winner),
        outcome,
        current_model: fmt(current.p),
        market: Number.isFinite(market?.pTeam1) ? fmt(market.pTeam1) : '',
        elo_plain: fmt(elo.elo_plain),
        elo_decay: fmt(elo.elo_decay),
        elo_roster_reset: fmt(elo.elo_roster_reset),
        elo_roster_player_blend: fmt(elo.elo_roster_player_blend),
        current_team_a_maps: current.teamAMaps ?? '',
        current_team_b_maps: current.teamBMaps ?? '',
        current_team_a_strength: Number.isFinite(current.teamAStrength) ? fmt(current.teamAStrength, 2) : '',
        current_team_b_strength: Number.isFinite(current.teamBStrength) ? fmt(current.teamBStrength, 2) : '',
        train_max_date: trainMax,
      });
    }

    for (const match of dayMatches) {
      updateAllStates(states, playerStates, match, mapsByMatch.get(match.match_id) || [], rosterIndex, breakpoints);
    }
  }

  const summary = summaryRows(rows);
  const best = bestVariant(summary);
  const bestKey = best?.model || '';
  const recent = rows.filter((row) => row.year === '2025' || row.year === '2026');
  const bootCurrent = bestKey ? bootstrapDelta(recent, bestKey, 'current_model') : null;
  const bootMarket = bestKey ? bootstrapDelta(recent, bestKey, 'market') : null;
  const currentRecent = summary.find((row) => row.fold === 'recent_2025_2026' && row.model === 'current_model');
  const bestRecent = summary.find((row) => row.fold === 'recent_2025_2026' && row.model === bestKey);
  const passVsCurrent = Boolean(bestRecent && currentRecent
    && num(bestRecent.brier, Infinity) < num(currentRecent.brier, -Infinity)
    && bootCurrent
    && Number.isFinite(bootCurrent.high)
    && bootCurrent.high <= 0);

  const config = {
    model_type: 'lpl_dynamic_elo_roster_baseline_v1',
    generated_at: new Date().toISOString(),
    deploy: false,
    deploy_reason: 'comparison_baseline_only_not_wired_to_runtime',
    lpl_only: true,
    parameters: {
      base_rating: BASE_RATING,
      elo_scale: ELO_SCALE,
      team_k: TEAM_K,
      player_k: PLAYER_K,
      decay_half_life_days: DECAY_HALF_LIFE_DAYS,
      roster_break_overlap: ROSTER_BREAK_OVERLAP,
      roster_break_retention: ROSTER_BREAK_RETENTION,
      player_blend_weight: PLAYER_BLEND_WEIGHT,
      bootstrap_seed: BOOTSTRAP_SEED,
      bootstrap_iters: BOOTSTRAP_ITERS,
    },
    best_variant: bestKey,
    paper_gate: {
      pass_vs_current: passVsCurrent,
      reason: passVsCurrent
        ? 'Brier improved vs current_model with bootstrap CI high <= 0 on 2025+2026.'
        : 'Did not clear strict baseline gate. Keep as paper-only comparison.',
    },
    bootstrap_checks: [
      bootCurrent ? {
        candidate: bestKey,
        baseline: 'current_model',
        fold: 'recent_2025_2026',
        n_clusters: bootCurrent.nClusters,
        brier_delta_mean: fmt(bootCurrent.mean),
        ci_low: fmt(bootCurrent.low),
        ci_high: fmt(bootCurrent.high),
        pass: bootCurrent.high <= 0 ? 'yes' : 'no',
      } : null,
      bootMarket ? {
        candidate: bestKey,
        baseline: 'market',
        fold: 'recent_2025_2026',
        n_clusters: bootMarket.nClusters,
        brier_delta_mean: fmt(bootMarket.mean),
        ci_low: fmt(bootMarket.low),
        ci_high: fmt(bootMarket.high),
        pass: bootMarket.high <= 0 ? 'yes' : 'no',
      } : null,
    ].filter(Boolean),
    outputs: {
      detail_csv: DETAIL_CSV,
      summary_csv: SUMMARY_OUT_CSV,
      breakpoint_csv: BREAKPOINT_CSV,
      report_md: REPORT_MD,
    },
  };

  await writeCsv(DETAIL_CSV, rows, unionColumns(rows));
  await writeCsv(SUMMARY_OUT_CSV, summary, unionColumns(summary));
  await writeCsv(BREAKPOINT_CSV, breakpoints, unionColumns(breakpoints));
  await writeFile(CONFIG_JSON, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(REPORT_MD, reportMarkdown({
    detailRows: rows,
    summary,
    breakpoints,
    config,
    leakageChecks,
  }), 'utf8');

  console.log(`detail_rows=${rows.length}`);
  console.log(`summary_rows=${summary.length}`);
  console.log(`roster_breaks=${breakpoints.length}`);
  console.log(`best_variant=${bestKey || 'none'}`);
  console.log(`deploy=${config.deploy}`);
  console.log(`report=${REPORT_MD}`);
}

main().catch((error) => {
  console.error(`elo-roster-baseline failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
