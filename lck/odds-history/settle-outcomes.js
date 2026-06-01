import { readLckData } from '../data-loader.js';
import { num, teamKey } from '../shared.js';
import { initDb } from './db-init.js';

function matchKey(row) {
  return String(row.match_name || '').toLowerCase();
}

function mapNumber(row) {
  return num(row.bo || row.map_number, 1);
}

function scoreFor(match, selection) {
  const key = teamKey(selection);
  if (teamKey(match.team_a_id || match.team_a) === key) return [num(match.score_a), num(match.score_b)];
  if (teamKey(match.team_b_id || match.team_b) === key) return [num(match.score_b), num(match.score_a)];
  return null;
}

function sideKills(map, selection) {
  const key = teamKey(selection);
  if (teamKey(map.team_a_id || map.team_a) === key) return [num(map.team_a_kills), num(map.team_b_kills)];
  if (teamKey(map.team_b_id || map.team_b) === key) return [num(map.team_b_kills), num(map.team_a_kills)];
  return null;
}

function outcomeFor(row, match, maps) {
  const line = num(row.line);
  const firstMap = [...maps].sort((a, b) => mapNumber(a) - mapNumber(b))[0];
  if (row.market === 'match_win') {
    return { outcome: teamKey(match.winner_id || match.winner) === teamKey(row.selection) ? 1 : 0, actual: match.winner || match.winner_id };
  }
  if (row.market === 'map_handicap') {
    const score = scoreFor(match, row.selection);
    if (!score) return null;
    return { outcome: score[0] + line > score[1] ? 1 : 0, actual: `${score[0]}-${score[1]}` };
  }
  if (row.market === 'map_total') {
    const totalMaps = num(match.score_a) + num(match.score_b);
    const hit = row.selection === 'over' ? totalMaps > line : totalMaps < line;
    return { outcome: hit ? 1 : 0, actual: String(totalMaps) };
  }
  if (!firstMap) return null;
  if (row.market === 'game1_win') {
    return { outcome: teamKey(firstMap.map_winner_id || firstMap.map_winner) === teamKey(row.selection) ? 1 : 0, actual: firstMap.map_winner || firstMap.map_winner_id };
  }
  if (row.market === 'total_kills') {
    const actual = num(firstMap.total_kills, NaN);
    if (!Number.isFinite(actual)) return null;
    const hit = row.selection === 'over' ? actual > line : actual < line;
    return { outcome: hit ? 1 : 0, actual: String(actual) };
  }
  if (row.market === 'game_time') {
    const actual = num(firstMap.game_time_min, NaN);
    if (!Number.isFinite(actual)) return null;
    const hit = row.selection === 'over' ? actual > line : actual < line;
    return { outcome: hit ? 1 : 0, actual: String(actual) };
  }
  if (row.market === 'team_kills_handicap') {
    const kills = sideKills(firstMap, row.selection);
    if (!kills) return null;
    return { outcome: kills[0] + line > kills[1] ? 1 : 0, actual: `${kills[0]}-${kills[1]}` };
  }
  if (row.market === 'first_blood') {
    const winner = teamKey(firstMap.first_blood_team_id || firstMap.first_blood_team);
    if (!winner) return null;
    return { outcome: winner === teamKey(row.selection) ? 1 : 0, actual: firstMap.first_blood_team || firstMap.first_blood_team_id };
  }
  if (row.market === 'first_turret') {
    const winner = teamKey(firstMap.first_turret_team_id || firstMap.first_turret_team);
    if (!winner) return null;
    return { outcome: winner === teamKey(row.selection) ? 1 : 0, actual: firstMap.first_turret_team || firstMap.first_turret_team_id };
  }
  return null;
}

async function main() {
  const db = initDb();
  const { matches, maps } = await readLckData();
  const matchesByName = new Map(matches.map((row) => [matchKey(row), row]));
  const mapsByMatchId = new Map();
  for (const map of maps) {
    if (!mapsByMatchId.has(map.match_id)) mapsByMatchId.set(map.match_id, []);
    mapsByMatchId.get(map.match_id).push(map);
  }
  const rows = db.prepare(`
    SELECT o.id, s.match_name, s.event_date, o.market, o.selection, o.line
    FROM odds o
    JOIN snapshots s ON s.id = o.snapshot_id
    WHERE o.outcome IS NULL
  `).all();
  const update = db.prepare('UPDATE odds SET outcome=?, actual_value=?, settled_at=? WHERE id=?');
  let settled = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const match = matchesByName.get(matchKey(row));
    if (!match || !match.winner_id) {
      skipped += 1;
      continue;
    }
    const matchMaps = mapsByMatchId.get(match.match_id) || maps.filter((map) => matchKey(map) === matchKey(row));
    const result = outcomeFor(row, match, matchMaps);
    if (!result) {
      skipped += 1;
      continue;
    }
    update.run(result.outcome, result.actual, now, row.id);
    settled += 1;
  }
  console.log(`settled=${settled}, skipped=${skipped}`);
}

main().catch((error) => {
  console.error(`settle-outcomes failed: ${error.message}`);
  process.exitCode = 1;
});
