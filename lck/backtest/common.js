import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  avg,
  clamp,
  num,
  pct,
  readCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from '../shared.js';
import { MODEL_MODE } from '../model-mode.js';

export { MODEL_MODE };
export const HISTORY_DIR = path.join(DATA_DIR, 'history');
export const BACKTEST_ROOT_DIR = path.join(DATA_DIR, 'backtest');
export const BACKTEST_DIR = path.join(BACKTEST_ROOT_DIR, MODEL_MODE);

// in-sample / out-of-sample 分段: 2024 用于 baseline 同源段, 2025 为纯验证段
export const SPLIT_IN_SAMPLE = 'in_sample_2024';
export const SPLIT_OUT_SAMPLE = 'out_of_sample_2025';

export function splitForDate(matchDate) {
  const year = String(matchDate || '').slice(0, 4);
  if (year <= '2024') return SPLIT_IN_SAMPLE;
  return SPLIT_OUT_SAMPLE;
}

export async function ensureBacktestDir() {
  await mkdir(BACKTEST_DIR, { recursive: true });
}

export async function ensureHistoryDir() {
  await mkdir(HISTORY_DIR, { recursive: true });
}

export function slugify(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

export function isFinishedMatch(row) {
  return Boolean(row?.winner_id) && num(row.score_a, -1) >= 0 && num(row.score_b, -1) >= 0;
}

export function rowDate(row) {
  return String(row.match_time || row.match_date || '').slice(0, 10);
}

export function beforeDate(rowDateValue, cutoffDate) {
  if (!cutoffDate) return true;
  return String(rowDateValue || '') < String(cutoffDate || '');
}

export function matchScore(match, teamId) {
  if (teamKey(match.team_a_id || match.team_a) === teamId) {
    return [num(match.score_a), num(match.score_b)];
  }
  return [num(match.score_b), num(match.score_a)];
}

export function mapTeamKills(map, teamId) {
  const key = teamKey(teamId);
  if (teamKey(map.team_a_id || map.team_a) === key) {
    return { kills: num(map.team_a_kills), opponentKills: num(map.team_b_kills) };
  }
  if (teamKey(map.team_b_id || map.team_b) === key) {
    return { kills: num(map.team_b_kills), opponentKills: num(map.team_a_kills) };
  }
  return null;
}

export function sideTeamId(map, selection) {
  const key = teamKey(selection);
  if (teamKey(map.team_a_id || map.team_a) === key) return teamKey(map.team_a_id || map.team_a);
  if (teamKey(map.team_b_id || map.team_b) === key) return teamKey(map.team_b_id || map.team_b);
  return key;
}

export function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

export function mean(rows, valueFn = (row) => row) {
  const values = rows.map(valueFn).filter((value) => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function brier(rows) {
  return mean(rows, (row) => {
    const p = num(row.model_p);
    const outcome = num(row.outcome);
    return (p - outcome) ** 2;
  });
}

export function hitRate(rows) {
  return mean(rows, (row) => num(row.outcome));
}

export function bucketOf(probability, bucketCount) {
  const p = clamp(num(probability), 0, 0.999999);
  return Math.floor(p * bucketCount);
}

export function scoreForTeam(match, selection) {
  return matchScore(match, teamKey(selection));
}

export function mapNumber(map, fallbackIndex = 0) {
  return num(map.bo || map.map_number, fallbackIndex + 1);
}

export function parseOutcome(value) {
  const n = Number(value);
  return n === 0 || n === 1 ? n : null;
}

function emptyTeamAccumulator(teamId, teamName) {
  return {
    team_id: teamId,
    team: teamName || teamId,
    maps: 0,
    map_wins: 0,
    kills: 0,
    deaths: 0,
    total_kills: 0,
    game_time: 0,
    dragons: 0,
    opp_dragons: 0,
    barons: 0,
    opp_barons: 0,
    first_bloods: 0,
    first_turrets: 0,
    first_heralds: 0,
    match_ids: new Set(),
    match_wins: 0,
    two_zero_wins: 0,
    zero_two_losses: 0,
    go_three_maps: 0,
  };
}

function ensureTeamAccumulator(groups, teamId, teamName) {
  if (!teamId) return null;
  if (!groups.has(teamId)) groups.set(teamId, emptyTeamAccumulator(teamId, teamName));
  const current = groups.get(teamId);
  if (!current.team && teamName) current.team = teamName;
  return current;
}

function addMapSide(groups, map, side) {
  const isA = side === 'a';
  const teamId = isA ? map.team_a_id : map.team_b_id;
  const teamName = isA ? map.team_a : map.team_b;
  const opponentId = isA ? map.team_b_id : map.team_a_id;
  const acc = ensureTeamAccumulator(groups, teamId, teamName);
  if (!acc) return;

  const kills = num(isA ? map.team_a_kills : map.team_b_kills);
  const deaths = num(isA ? map.team_b_kills : map.team_a_kills);
  const dragons = num(isA ? map.team_a_dragons : map.team_b_dragons);
  const oppDragons = num(isA ? map.team_b_dragons : map.team_a_dragons);
  const barons = num(isA ? map.team_a_barons : map.team_b_barons);
  const oppBarons = num(isA ? map.team_b_barons : map.team_a_barons);
  const sideKey = teamKey(teamId || teamName);

  acc.maps += 1;
  acc.map_wins += teamKey(map.map_winner_id || map.map_winner) === sideKey ? 1 : 0;
  acc.kills += kills;
  acc.deaths += deaths;
  acc.total_kills += num(map.total_kills);
  acc.game_time += num(map.game_time_min);
  acc.dragons += dragons;
  acc.opp_dragons += oppDragons;
  acc.barons += barons;
  acc.opp_barons += oppBarons;
  acc.first_bloods += teamKey(map.first_blood_team_id || map.first_blood_team) === sideKey ? 1 : 0;
  acc.first_turrets += teamKey(map.first_turret_team_id || map.first_turret_team) === sideKey ? 1 : 0;
  acc.first_heralds += teamKey(map.first_herald_team_id || map.first_herald_team) === sideKey ? 1 : 0;
  if (map.match_id) acc.match_ids.add(map.match_id);

  ensureTeamAccumulator(groups, opponentId, isA ? map.team_b : map.team_a);
}

function summarizeSeries(rows) {
  const ordered = [...rows].sort((a, b) => mapNumber(a) - mapNumber(b));
  const first = ordered[0] || {};
  const teams = [
    { id: first.team_a_id, name: first.team_a },
    { id: first.team_b_id, name: first.team_b },
  ].filter((team) => team.id);
  return teams.map((team) => {
    const key = teamKey(team.id || team.name);
    let wins = 0;
    let losses = 0;
    for (const map of ordered) {
      const winnerKey = teamKey(map.map_winner_id || map.map_winner);
      if (!winnerKey) continue;
      if (winnerKey === key) wins += 1;
      else losses += 1;
    }
    return {
      team_id: team.id,
      team: team.name || team.id,
      wins,
      losses,
      maps: wins + losses,
    };
  });
}

export function buildSnapshotSummary(maps, cutoffDate) {
  const eligibleMaps = maps.filter((row) => beforeDate(rowDate(row), cutoffDate));
  const teams = new Map();

  for (const map of eligibleMaps) {
    addMapSide(teams, map, 'a');
    addMapSide(teams, map, 'b');
  }

  for (const matchRows of groupBy(eligibleMaps, (row) => row.match_id).values()) {
    for (const side of summarizeSeries(matchRows)) {
      const acc = ensureTeamAccumulator(teams, side.team_id, side.team);
      if (!acc || side.maps === 0) continue;
      if (side.wins > side.losses) acc.match_wins += 1;
      if (side.wins === 2 && side.losses === 0) acc.two_zero_wins += 1;
      if (side.wins === 0 && side.losses === 2) acc.zero_two_losses += 1;
      if (side.maps >= 3) acc.go_three_maps += 1;
    }
  }

  return [...teams.values()].map((team) => {
    const dragonDenom = team.dragons + team.opp_dragons;
    const baronDenom = team.barons + team.opp_barons;
    const matches = team.match_ids.size;
    return {
      team_id: team.team_id,
      team: team.team,
      matches,
      match_wins: team.match_wins,
      match_win_rate: pct(team.match_wins, matches),
      maps: team.maps,
      map_wins: team.map_wins,
      map_win_rate: pct(team.map_wins, team.maps),
      series_2_0_win_rate: pct(team.two_zero_wins, matches),
      series_0_2_loss_rate: pct(team.zero_two_losses, matches),
      series_go_3_maps_rate: pct(team.go_three_maps, matches),
      avg_kills: avg(team.kills, team.maps, 3),
      avg_deaths: avg(team.deaths, team.maps, 3),
      avg_kill_diff: avg(team.kills - team.deaths, team.maps, 3),
      avg_total_kills: avg(team.total_kills, team.maps, 3),
      avg_game_time_min: avg(team.game_time, team.maps, 3),
      first_blood_rate: pct(team.first_bloods, team.maps),
      first_turret_rate: pct(team.first_turrets, team.maps),
      dragon_control_rate: dragonDenom ? team.dragons / dragonDenom : '',
      herald_control_rate: pct(team.first_heralds, team.maps),
      baron_control_rate: baronDenom ? team.barons / baronDenom : '',
      dragons_per_game: avg(team.dragons, team.maps, 3),
      voidgrubs_per_game: '',
      gd_at_15: '',
      td_at_15: '',
      dpm: '',
      wpm: '',
      total_kills_over_30_5_rate: pct(eligibleMaps.filter((row) => (
        (row.team_a_id === team.team_id || row.team_b_id === team.team_id) && num(row.total_kills) > 30.5
      )).length, team.maps),
    };
  });
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-abs * abs);
  return sign * y;
}

export function welchApproxPValue(aValues, bValues) {
  const a = aValues.filter(Number.isFinite);
  const b = bValues.filter(Number.isFinite);
  if (a.length < 2 || b.length < 2) return '';
  const ma = mean(a);
  const mb = mean(b);
  const va = mean(a, (x) => (x - ma) ** 2);
  const vb = mean(b, (x) => (x - mb) ** 2);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!se) return '';
  const z = Math.abs((ma - mb) / se);
  return 2 * (1 - normalCdf(z));
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { low: 0, high: 0 };
  const p = successes / total;
  const denom = 1 + (z ** 2) / total;
  const center = (p + (z ** 2) / (2 * total)) / denom;
  const half = z * Math.sqrt((p * (1 - p) / total) + (z ** 2) / (4 * total ** 2)) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function formatPct(value, digits = 1) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return '';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function decimal(value, digits = 4) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(digits);
}

// 历史 CSV 里的 team-id 列可能是用旧 alias 表写死的陈旧值
// (例如 GEN.G ESPORTS / KWANGDONG FREECS / OK BRION)。
// 这里在读取时统一过一遍 teamKey() 归一化, 既修陈旧值又不怕重跑 merge-history 脏回来。
const TEAM_ID_COLUMNS = [
  'team_a_id', 'team_b_id', 'winner_id',
  'map_winner_id', 'blue_team_id', 'red_team_id',
  'first_blood_team_id', 'first_turret_team_id',
  'first_dragon_team_id', 'first_herald_team_id',
  'team_id', 'opponent_id',
];

export function normalizeTeamIdColumns(rows) {
  for (const row of rows || []) {
    for (const col of TEAM_ID_COLUMNS) {
      if (row[col]) row[col] = teamKey(row[col]);
    }
  }
  return rows;
}

export async function readHistoryData() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(HISTORY_DIR, 'all_matches.csv')),
    readCsv(path.join(HISTORY_DIR, 'all_map_details.csv')),
    readCsvIfExists(path.join(HISTORY_DIR, 'all_team_summary.csv')),
  ]);
  normalizeTeamIdColumns(matches);
  normalizeTeamIdColumns(maps);
  normalizeTeamIdColumns(summary);
  return { matches, maps, summary };
}

export async function writeBacktestCsv(fileName, rows, columns = unionColumns(rows)) {
  await ensureBacktestDir();
  const stampedRows = rows.map((row) => ({ model_mode: row.model_mode || MODEL_MODE, ...row }));
  const stampedColumns = columns.includes('model_mode') ? columns : ['model_mode', ...columns];
  await writeCsv(path.join(BACKTEST_DIR, fileName), stampedRows, stampedColumns);
}
