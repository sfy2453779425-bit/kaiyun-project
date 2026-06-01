import path from 'node:path';
import { readCsv, teamKey, num, clamp } from '../shared.js';
import {
  buildProfiles,
  classifyScenario,
  totalKillsProbability,
  gameTimeProbability,
  mapHandicapProbability,
  mapTotalOverProbability,
  firstObjectiveProbability,
} from '../build-market-analysis.js';
import { buildSnapshotSummary } from '../backtest/common.js';

export const PROP_PATH = path.join('lpl', 'data', 'history', 'oddsportal_lpl_prop_odds.csv');
export const HISTORY_DIR = path.join('lpl', 'data', 'history');

function matchKey(date, home, away) {
  return [date, teamKey(home), teamKey(away)].join('|');
}

function addNoVig(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.event_id, row.market, row.line || ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const inv = group.map((row) => 1 / num(row.avg_odds));
    const total = inv[0] + inv[1];
    if (total <= 0) continue;
    group.forEach((row, i) => { row.market_p = inv[i] / total; });
  }
}

function outcome(row) {
  if (row.market === 'map_total' || row.market === 'total_kills' || row.market === 'game_time') {
    return row.outcome_label === row.selection ? 1 : 0;
  }
  if (row.market === 'map_handicap' || row.market === 'first_blood' || row.market === 'first_turret') {
    return teamKey(row.outcome_label) === teamKey(row.selection) ? 1 : 0;
  }
  return null;
}

function modelProbability(row, home, away) {
  const scenario = classifyScenario(home, away);
  const favorite = home.strength_score >= away.strength_score ? home : away;
  const underdog = favorite === home ? away : home;
  const selectionKey = teamKey(row.selection);
  if (row.market === 'total_kills') return totalKillsProbability(home, away, row.line, row.selection, scenario.scenario_probs);
  if (row.market === 'game_time') return gameTimeProbability(home, away, row.line, row.selection, scenario.scenario_probs);
  if (row.market === 'map_total') {
    const over = mapTotalOverProbability(favorite, underdog, scenario.scenario_probs);
    return row.selection === 'over' ? over : 1 - over;
  }
  if (row.market === 'map_handicap') {
    const isFavorite = selectionKey === teamKey(favorite.team_id);
    const line = num(row.line);
    if (line < 0 && isFavorite) return mapHandicapProbability(favorite, underdog, scenario.scenario_probs);
    if (line > 0 && !isFavorite) return 1 - mapHandicapProbability(favorite, underdog, scenario.scenario_probs);
    return 0.5;
  }
  if (row.market === 'first_blood') {
    const team = selectionKey === teamKey(home.team_id) ? home : away;
    const opp = team === home ? away : home;
    return firstObjectiveProbability(team, opp, 'first_blood_rate');
  }
  if (row.market === 'first_turret') {
    const team = selectionKey === teamKey(home.team_id) ? home : away;
    const opp = team === home ? away : home;
    return firstObjectiveProbability(team, opp, 'first_turret_rate');
  }
  return null;
}

export async function loadPropRows({ minMaps = 8 } = {}) {
  const [props, matches, maps] = await Promise.all([
    readCsv(PROP_PATH).catch(() => []),
    readCsv(path.join(HISTORY_DIR, 'all_matches.csv')),
    readCsv(path.join(HISTORY_DIR, 'all_map_details.csv')),
  ]);
  addNoVig(props);

  const matchIndex = new Map();
  for (const match of matches) {
    const date = String(match.match_date || '').slice(0, 10);
    matchIndex.set(matchKey(date, match.team_a_id, match.team_b_id), match);
    matchIndex.set(matchKey(date, match.team_b_id, match.team_a_id), match);
  }

  const profileCache = new Map();
  const rows = [];
  const stats = { prop_rows: props.length, matched: 0, low_sample: 0, no_market_pair: 0, no_model: 0, final_rows: 0 };
  for (const prop of props) {
    if (!prop.market_p) {
      stats.no_market_pair += 1;
      continue;
    }
    const date = String(prop.match_date || '').slice(0, 10);
    const match = matchIndex.get(matchKey(date, prop.home_key || prop.home, prop.away_key || prop.away));
    if (!match) continue;
    stats.matched += 1;
    if (!profileCache.has(date)) {
      const snapshot = buildSnapshotSummary(maps, date);
      profileCache.set(date, buildProfiles(matches, maps, snapshot, date));
    }
    const profiles = profileCache.get(date);
    const home = profiles.get(teamKey(prop.home_key || prop.home));
    const away = profiles.get(teamKey(prop.away_key || prop.away));
    if (!home || !away || Math.min(num(home.maps), num(away.maps)) < minMaps) {
      stats.low_sample += 1;
      continue;
    }
    const modelP = modelProbability(prop, home, away);
    const y = outcome(prop);
    if (modelP == null || y == null) {
      stats.no_model += 1;
      continue;
    }
    rows.push({
      ...prop,
      year: String(prop.year),
      model_p: clamp(modelP, 0.001, 0.999),
      market_p: clamp(prop.market_p, 0.001, 0.999),
      outcome: y,
      odds: num(prop.avg_odds),
    });
  }
  stats.final_rows = rows.length;
  return { rows, stats };
}
