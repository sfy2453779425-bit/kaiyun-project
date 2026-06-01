import path from 'node:path';
import { argValue, readCsv, teamKey, num, unionColumns, writeCsv } from '../shared.js';
import {
  BACKTEST_DIR,
  groupBy,
  mapNumber,
  mapTeamKills,
  readHistoryData,
  scoreForTeam,
  writeBacktestCsv,
} from './common.js';

const PER_MAP_MARKETS = new Set([
  'team_kills_handicap',
  'total_kills',
  'game_time',
  'first_blood',
  'first_turret',
]);

function outcomeForSeries(row, match, maps) {
  if (!match) return null;
  const selection = teamKey(row.selection);
  const [forScore, againstScore] = scoreForTeam(match, row.selection);

  if (row.market === 'match_win') return teamKey(match.winner_id || match.winner) === selection ? 1 : 0;
  if (row.market === 'map_handicap') return forScore + num(row.line) > againstScore ? 1 : 0;
  if (row.market === 'map_total') {
    const mapCount = num(match.score_a) + num(match.score_b);
    return row.selection === 'over' ? (mapCount > num(row.line) ? 1 : 0) : (mapCount < num(row.line) ? 1 : 0);
  }
  if (row.market === 'game1_win') {
    const game1 = maps.find((map) => mapNumber(map) === 1);
    if (!game1) return null;
    const winnerKey = teamKey(game1.map_winner_id || game1.map_winner);
    if (!winnerKey) return null;
    return winnerKey === selection ? 1 : 0;
  }
  return null;
}

function outcomeForMap(row, map) {
  const line = num(row.line);
  if (row.market === 'team_kills_handicap') {
    const kills = mapTeamKills(map, row.selection);
    if (!kills) return null;
    return kills.kills + line > kills.opponentKills ? 1 : 0;
  }
  if (row.market === 'total_kills') {
    return row.selection === 'over' ? (num(map.total_kills) > line ? 1 : 0) : (num(map.total_kills) < line ? 1 : 0);
  }
  if (row.market === 'game_time') {
    return row.selection === 'over' ? (num(map.game_time_min) > line ? 1 : 0) : (num(map.game_time_min) < line ? 1 : 0);
  }
  if (row.market === 'first_blood') {
    const winnerKey = teamKey(map.first_blood_team_id || map.first_blood_team);
    if (!winnerKey) return null;
    return winnerKey === teamKey(row.selection) ? 1 : 0;
  }
  if (row.market === 'first_turret') {
    const winnerKey = teamKey(map.first_turret_team_id || map.first_turret_team);
    if (!winnerKey) return null;
    return winnerKey === teamKey(row.selection) ? 1 : 0;
  }
  return null;
}

async function main() {
  const predictionsPath = argValue('predictions', path.join(BACKTEST_DIR, 'predictions.csv'));
  const matchesPath = argValue('matches');
  const mapsPath = argValue('maps');
  const outputPath = argValue('output');
  const predictions = await readCsv(predictionsPath);
  const history = matchesPath && mapsPath ? null : await readHistoryData();
  const matches = matchesPath ? await readCsv(matchesPath) : history.matches;
  const maps = mapsPath ? await readCsv(mapsPath) : history.maps;
  const matchesById = new Map(matches.map((row) => [row.match_id, row]));
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const out = [];
  let skipped = 0;

  for (const row of predictions) {
    const match = matchesById.get(row.match_id);
    const matchMaps = (mapsByMatch.get(row.match_id) || [])
      .sort((a, b) => mapNumber(a) - mapNumber(b));

    if (PER_MAP_MARKETS.has(row.market)) {
      for (let i = 0; i < matchMaps.length; i += 1) {
        const map = matchMaps[i];
        const outcome = outcomeForMap(row, map);
        if (outcome == null) {
          skipped += 1;
          continue;
        }
        out.push({
          ...row,
          outcome,
          map_number: mapNumber(map, i),
          map_game_id: map.game_id,
          map_winner_id: map.map_winner_id,
          map_total_kills: map.total_kills,
          map_game_time_min: map.game_time_min,
        });
      }
      continue;
    }

    const outcome = outcomeForSeries(row, match, matchMaps);
    if (outcome == null) {
      skipped += 1;
      continue;
    }
    out.push({
      ...row,
      outcome,
      map_number: '',
      map_game_id: '',
      map_winner_id: '',
      map_total_kills: '',
      map_game_time_min: '',
    });
  }

  if (outputPath) {
    await writeCsv(path.resolve(outputPath), out, unionColumns(out));
  } else {
    await writeBacktestCsv('predictions_with_outcomes.csv', out, unionColumns(out));
  }
  console.log(`outcome_rows=${out.length}`);
  console.log(`skipped_without_outcome=${skipped}`);
}

main().catch((error) => {
  console.error(`backtest-outcomes failed: ${error.message}`);
  process.exitCode = 1;
});
