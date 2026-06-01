import { initDb, insertSnapshot, openDb } from './db-init.js';
import { argValue, fetchEventOdds, fetchHtml, parseEventHeader } from './op-utils.js';

function canonicalSelection(row, event) {
  if (row.selection === 'home') return event.home;
  if (row.selection === 'away') return event.away;
  return row.selection;
}

async function buildPayload(eventUrl) {
  const html = await fetchHtml(eventUrl);
  const event = parseEventHeader(html);
  const odds = await fetchEventOdds(event, eventUrl);
  return {
    source: 'oddsportal',
    ts: new Date().toISOString(),
    match_id: event.event_id,
    match_name: event.match_name,
    match_start_ts: event.match_start_ts,
    raw_blob: JSON.stringify({ event: event.raw, odds: odds.raw }),
    markets: odds.rows.map((row) => ({
      market: row.market,
      selection: canonicalSelection(row, event),
      line: row.line,
      odds: row.odds,
    })),
  };
}

async function main() {
  const eventUrl = argValue('event-url');
  if (!eventUrl) throw new Error('--event-url is required. --event-id alone is not enough because OP requires xhashf.');
  const payload = await buildPayload(eventUrl);
  if (!payload.markets.length) throw new Error('no OP odds rows parsed from event page');
  const db = initDb(openDb());
  const result = insertSnapshot(payload, db);
  console.log(`inserted OP snapshot id=${result.snapshotId}, ${result.oddsRows} odds rows`);
  db.close();
}

main().catch((error) => {
  console.error(`scrape-op-snapshot failed: ${error.message}`);
  process.exitCode = 1;
});
