import path from 'node:path';
import { ANALYSIS_DIR, readCsv, teamKey, writeCsv } from './shared.js';

const POLYMARKET_SERIES_ID = '10311'; // League of Legends
const TEMPLATE_FILE = path.join(ANALYSIS_DIR, '赔率填写模板.csv');
const AUDIT_FILE = path.join(ANALYSIS_DIR, 'polymarket_odds.csv');

const TEAM_ALIASES = {
  ig1: 'IG',
  ig: 'IG',
  invictusgaming: 'IG',
  wb: 'WBG',
  wbg: 'WBG',
  weibogaming: 'WBG',
  edwardgaming: 'EDG',
  edwardgaming: 'EDG',
  edg: 'EDG',
  thundertalkgaming: 'TT',
  ttgaming: 'TT',
  tt: 'TT',
};

function normalizeTeam(value) {
  const raw = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return TEAM_ALIASES[raw] || teamKey(value);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

function priceToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return '';
  return (1 / p).toFixed(3);
}

function dateFromSlug(slug) {
  const m = String(slug || '').match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : '';
}

function teamsFromTitle(title) {
  const m = String(title || '').match(/^LoL:\s+(.+?)\s+vs\s+(.+?)\s+\(/i);
  if (!m) return null;
  return {
    teamA: m[1],
    teamB: m[2],
    teamAKey: normalizeTeam(m[1]),
    teamBKey: normalizeTeam(m[2]),
  };
}

function buildMarketRows(event) {
  const rows = [];
  const eventDate = dateFromSlug(event.slug);

  for (const market of event.markets || []) {
    const outcomes = parseJsonArray(market.outcomes);
    const prices = parseJsonArray(market.outcomePrices);
    if (outcomes.length !== prices.length) continue;

    let projectMarket = '';
    let lineByOutcome = new Map();

    if (market.slug === event.slug) {
      projectMarket = 'match_win';
    } else if (/Game 1 Winner/i.test(market.question || '')) {
      projectMarket = 'game1_win';
    } else if (/Game Handicap/i.test(market.question || '') && /1\.5/.test(market.question || '')) {
      projectMarket = 'map_handicap';
      const q = String(market.question || '');
      const parts = [...q.matchAll(/([A-Za-z0-9 .']+?)\s+\(([+-]1\.5)\)/g)];
      for (const part of parts) lineByOutcome.set(normalizeTeam(part[1]), part[2]);
    } else {
      continue;
    }

    for (let i = 0; i < outcomes.length; i += 1) {
      const selection = outcomes[i];
      const selectionKey = normalizeTeam(selection);
      const probability = Number(prices[i]);
      const line = projectMarket === 'map_handicap' ? (lineByOutcome.get(selectionKey) || '') : '';
      if (projectMarket === 'map_handicap' && !line) continue;
      rows.push({
        source: 'polymarket',
        event_slug: event.slug,
        event_title: event.title,
        market_id: market.id,
        market_slug: market.slug,
        question: market.question,
        match_date: eventDate,
        project_market: projectMarket,
        selection,
        selection_key: selectionKey,
        line,
        polymarket_price: probability.toFixed(3),
        decimal_odds: priceToDecimal(probability),
        liquidity: market.liquidity || '',
        volume: market.volume || '',
      });
    }
  }

  return rows;
}

function templateMatchKey(row) {
  const teams = String(row.match_name || '')
    .split(/\s+vs\s+/i)
    .map(normalizeTeam)
    .sort()
    .join('|');
  return [String(row.match_date || '').slice(0, 10), teams].join('|');
}

function oddsMatchKey(row) {
  const teams = teamsFromTitle(row.event_title);
  if (!teams) return '';
  return [row.match_date, [teams.teamAKey, teams.teamBKey].sort().join('|')].join('|');
}

async function fetchPolymarketEvents() {
  const url = `https://gamma-api.polymarket.com/events?series_id=${POLYMARKET_SERIES_ID}&closed=false&limit=100`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 LPL odds collector' } });
  if (!res.ok) throw new Error(`Polymarket events request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const templateRows = await readCsv(TEMPLATE_FILE);
  const neededKeys = new Set(templateRows.map(templateMatchKey));
  const events = await fetchPolymarketEvents();
  const relevantEvents = events.filter((event) => neededKeys.has(oddsMatchKey({
    event_title: event.title,
    match_date: dateFromSlug(event.slug),
  })));

  const oddsRows = relevantEvents.flatMap(buildMarketRows);
  const oddsByKey = new Map();
  for (const row of oddsRows) {
    oddsByKey.set([
      oddsMatchKey(row),
      row.project_market,
      row.selection_key,
      row.line,
    ].join('|'), row);
  }

  let filled = 0;
  const updated = templateRows.map((row) => {
    const key = [
      templateMatchKey(row),
      row.market || '',
      normalizeTeam(row.selection || ''),
      row.line || '',
    ].join('|');
    const source = oddsByKey.get(key);
    if (!source) return row;
    filled += 1;
    return {
      ...row,
      odds: source.decimal_odds,
      odds_source: 'polymarket',
      odds_source_market_id: source.market_id,
      odds_source_price: source.polymarket_price,
    };
  });

  await writeCsv(TEMPLATE_FILE, updated, [
    'match_id', 'match_date', 'match_name', 'scenario', 'market', 'selection',
    'line', 'side', 'odds', 'note', 'odds_source', 'odds_source_market_id',
    'odds_source_price',
  ]);
  await writeCsv(AUDIT_FILE, oddsRows, [
    'source', 'event_slug', 'event_title', 'market_id', 'market_slug', 'question',
    'match_date', 'project_market', 'selection', 'selection_key', 'line',
    'polymarket_price', 'decimal_odds', 'liquidity', 'volume',
  ]);

  console.log(`Polymarket events matched: ${relevantEvents.length}`);
  console.log(`Polymarket odds rows parsed: ${oddsRows.length}`);
  console.log(`Template odds filled: ${filled}`);
  console.log(TEMPLATE_FILE);
  console.log(AUDIT_FILE);
}

main().catch((error) => {
  console.error(`Polymarket odds collection failed: ${error.message}`);
  process.exitCode = 1;
});
