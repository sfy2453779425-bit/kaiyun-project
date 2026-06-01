import { readFile } from 'node:fs/promises';
import { initDb, insertSnapshot, openDb } from './db-init.js';

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function validateIso(value, field) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} must be ISO datetime`);
  return d.toISOString();
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('payload must be JSON object');
  if (!payload.source || typeof payload.source !== 'string') throw new Error('source is required');
  if (!payload.match_name || typeof payload.match_name !== 'string') throw new Error('match_name is required');
  if (!Array.isArray(payload.markets) || payload.markets.length === 0) throw new Error('markets must be non-empty array');
  const ts = validateIso(payload.ts || new Date().toISOString(), 'ts');
  const matchStartTs = payload.match_start_ts ? validateIso(payload.match_start_ts, 'match_start_ts') : null;

  const markets = payload.markets.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`markets[${index}] must be object`);
    if (!row.market || typeof row.market !== 'string') throw new Error(`markets[${index}].market is required`);
    if (!row.selection || typeof row.selection !== 'string') throw new Error(`markets[${index}].selection is required`);
    const odds = Number(row.odds);
    if (!Number.isFinite(odds) || odds <= 1) throw new Error(`markets[${index}].odds must be > 1`);
    return {
      market: row.market,
      selection: row.selection,
      line: row.line == null || row.line === '' ? null : String(row.line),
      odds,
    };
  });

  return {
    source: payload.source,
    ts,
    match_id: payload.match_id || null,
    match_name: payload.match_name,
    match_start_ts: matchStartTs,
    raw_blob: payload.raw_blob || JSON.stringify(payload),
    markets,
  };
}

async function main() {
  const jsonFile = argValue('json-file');
  const text = jsonFile ? await readFile(jsonFile, 'utf8') : await readStdin();
  if (!text.trim()) throw new Error('empty JSON input');
  const payload = validatePayload(JSON.parse(text));
  const db = initDb(openDb());
  const result = insertSnapshot(payload, db);
  console.log(`inserted snapshot id=${result.snapshotId}, ${result.oddsRows} odds rows`);
  db.close();
}

main().catch((error) => {
  console.error(`collect-from-clipboard failed: ${error.message}`);
  process.exitCode = 1;
});
