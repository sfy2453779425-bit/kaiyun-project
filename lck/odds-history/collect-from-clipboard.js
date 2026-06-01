import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argValue, num, parseCsv } from '../shared.js';
import { initDb, insertSnapshot } from './db-init.js';

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readClipboard() {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function normalizeMarket(value) {
  const text = String(value || '').trim().toLowerCase();
  const map = {
    match_win: 'match_win',
    map_handicap: 'map_handicap',
    map_total: 'map_total',
    game1_win: 'game1_win',
    team_kills_handicap: 'team_kills_handicap',
    total_kills: 'total_kills',
    game_time: 'game_time',
    first_blood: 'first_blood',
    first_turret: 'first_turret',
  };
  return map[text] || text;
}

function rowsFromDelimited(text) {
  const normalized = String(text || '').replace(/\t/g, ',');
  const rows = parseCsv(normalized);
  return rows
    .map((row) => ({
      market: normalizeMarket(row.market || row.盘口 || row.type || ''),
      selection: String(row.selection || row.选项 || row.side || '').trim(),
      line: String(row.line || row.盘口线 || row.handicap || '').trim(),
      odds: num(row.odds || row.赔率, NaN),
    }))
    .filter((row) => row.market && row.selection && Number.isFinite(row.odds) && row.odds > 1);
}

function rowsFromLooseText(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    const match = cleaned.match(/^([a-zA-Z_]+)\s+(.+?)\s+(-?\d+(?:\.\d+)?)?\s+([1-9]\d*\.\d+)$/);
    if (!match) continue;
    rows.push({
      market: normalizeMarket(match[1]),
      selection: match[2].trim(),
      line: match[3] || '',
      odds: Number(match[4]),
    });
  }
  return rows;
}

function parseMarkets(text) {
  const delimited = rowsFromDelimited(text);
  if (delimited.length) return delimited;
  return rowsFromLooseText(text);
}

async function main() {
  const matchName = argValue('match');
  if (!matchName) throw new Error('missing --match="Team A vs Team B"');
  const eventDate = argValue('event-date', '');
  const source = argValue('source', 'manual');
  const notes = argValue('notes', '');
  const text = readStdin() || readClipboard();
  const markets = parseMarkets(text);
  if (!markets.length) {
    throw new Error('no odds rows parsed. Use CSV/TSV headers: market,selection,line,odds');
  }
  const result = insertSnapshot({ source, matchName, eventDate, notes, markets }, initDb());
  console.log(`inserted snapshot=${result.snapshotId}, odds_rows=${result.oddsRows}`);
}

main().catch((error) => {
  console.error(`collect-from-clipboard failed: ${error.message}`);
  process.exitCode = 1;
});
