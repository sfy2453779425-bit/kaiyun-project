import path from 'node:path';
import { readCsv, teamKey, writeCsv, num } from '../shared.js';
import { argValue, fetchEventOdds, fetchHtml, parseEventHeader } from './op-utils.js';

const OP_MATCH_WIN_PATH = path.join('lpl', 'data', 'history', 'oddsportal_lpl_match_odds.csv');
const OUT_PATH = path.join('lpl', 'data', 'history', 'oddsportal_lpl_prop_odds.csv');

function sideName(selection, opRow) {
  if (selection === 'home') return opRow.home_team;
  if (selection === 'away') return opRow.away_team;
  return selection;
}

function outcomeFor(row, opRow) {
  const totalMaps = num(opRow.home_score) + num(opRow.away_score);
  if (row.market === 'map_total') {
    const line = num(row.line);
    const label = totalMaps > line ? 'over' : 'under';
    return { outcome_value: totalMaps, outcome_label: label };
  }
  if (row.market === 'map_handicap') {
    const line = num(row.line);
    const homeCover = num(opRow.home_score) + line > num(opRow.away_score);
    const isHome = row.selection === 'home';
    return {
      outcome_value: `${opRow.home_score}:${opRow.away_score}`,
      outcome_label: (isHome ? homeCover : !homeCover) ? sideName(row.selection, opRow) : '',
    };
  }
  if (row.market === 'match_win') {
    return {
      outcome_value: opRow.result,
      outcome_label: teamKey(opRow.winner_key) === teamKey(opRow.home_key) ? opRow.home_team : opRow.away_team,
    };
  }
  return { outcome_value: '', outcome_label: '' };
}

async function scrapeOne(opRow) {
  const html = await fetchHtml(opRow.source_url);
  const event = parseEventHeader(html);
  const odds = await fetchEventOdds(event, opRow.source_url, [2, 5, 8, 3]);
  const rows = [];
  for (const row of odds.rows) {
    if (row.market === 'match_win') continue;
    const outcome = outcomeFor(row, opRow);
    rows.push({
      source: 'oddsportal',
      year: opRow.year,
      event_id: opRow.event_id,
      encoded_event_id: opRow.encoded_event_id,
      match_date: opRow.match_date,
      tournament: opRow.tournament,
      home: opRow.home_team,
      away: opRow.away_team,
      home_key: opRow.home_key,
      away_key: opRow.away_key,
      result: opRow.result,
      home_score: opRow.home_score,
      away_score: opRow.away_score,
      market: row.market,
      selection: sideName(row.selection, opRow),
      line: row.line ?? '',
      avg_odds: row.odds,
      max_odds: row.max_odds ?? '',
      no_vig_p: '',
      outcome_value: outcome.outcome_value,
      outcome_label: outcome.outcome_label,
      settled_at: opRow.match_date,
      bookmaker_count: row.bookmaker_count,
      raw_key: row.raw_key,
    });
  }
  return rows;
}

async function main() {
  const limit = Number(argValue('limit', '0'));
  const start = Number(argValue('start', '0'));
  const opRows = await readCsv(OP_MATCH_WIN_PATH);
  const slice = opRows.slice(start, limit ? start + limit : undefined);
  const all = [];
  let failures = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const row = slice[i];
    try {
      const rows = await scrapeOne(row);
      all.push(...rows);
      if ((i + 1) % 25 === 0) console.log(`processed ${i + 1}/${slice.length}, prop rows=${all.length}`);
    } catch (error) {
      failures += 1;
      console.error(`failed ${row.match_date} ${row.home_team} vs ${row.away_team}: ${error.message}`);
    }
  }
  await writeCsv(OUT_PATH, all, [
    'source', 'year', 'event_id', 'encoded_event_id', 'match_date', 'tournament',
    'home', 'away', 'home_key', 'away_key', 'result', 'home_score', 'away_score',
    'market', 'selection', 'line', 'avg_odds', 'max_odds', 'no_vig_p',
    'outcome_value', 'outcome_label', 'settled_at', 'bookmaker_count', 'raw_key',
  ]);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`events=${slice.length}, prop_rows=${all.length}, failures=${failures}`);
}

main().catch((error) => {
  console.error(`scrape-op-historical-props failed: ${error.message}`);
  process.exitCode = 1;
});
