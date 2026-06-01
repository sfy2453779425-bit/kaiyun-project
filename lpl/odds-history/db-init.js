import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

export const ODDS_HISTORY_DIR = path.join(process.cwd(), 'lpl', 'data', 'odds_history');
export const DB_PATH = path.join(ODDS_HISTORY_DIR, 'odds.db');

export function openDb(dbPath = DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initDb(db = openDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      match_id TEXT,
      match_name TEXT NOT NULL,
      match_start_ts TEXT,
      raw_blob TEXT,
      UNIQUE (ts, source, match_name)
    );

    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      line TEXT,
      odds REAL NOT NULL,
      implied_p REAL NOT NULL,
      no_vig_p REAL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_lookup ON odds(snapshot_id, market, selection, line);
    CREATE INDEX IF NOT EXISTS idx_snap_match ON snapshots(match_name, ts);
  `);
  return db;
}

function normalizedPairLine(market, line) {
  if (line == null || line === '') return '';
  const n = Number(line);
  if (Number.isFinite(n) && /handicap/i.test(market)) return String(Math.abs(n));
  return String(line);
}

export function addNoVigProbabilities(markets) {
  const rows = markets.map((row) => ({
    ...row,
    odds: Number(row.odds),
    implied_p: row.implied_p ?? (Number(row.odds) > 0 ? 1 / Number(row.odds) : null),
  }));
  const groups = new Map();
  for (const row of rows) {
    const key = [row.market, normalizedPairLine(row.market, row.line)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const total = group.reduce((sum, row) => sum + row.implied_p, 0);
    if (total <= 0) continue;
    for (const row of group) row.no_vig_p = row.implied_p / total;
  }
  return rows;
}

export function insertSnapshot(payload, db = openDb()) {
  initDb(db);
  const markets = addNoVigProbabilities(payload.markets || []);
  const tx = db.transaction(() => {
    const snapshotInfo = db.prepare(`
      INSERT INTO snapshots (ts, source, match_id, match_name, match_start_ts, raw_blob)
      VALUES (@ts, @source, @match_id, @match_name, @match_start_ts, @raw_blob)
      ON CONFLICT(ts, source, match_name) DO UPDATE SET
        match_id = excluded.match_id,
        match_start_ts = excluded.match_start_ts,
        raw_blob = excluded.raw_blob
      RETURNING id
    `).get({
      ts: payload.ts,
      source: payload.source,
      match_id: payload.match_id || null,
      match_name: payload.match_name,
      match_start_ts: payload.match_start_ts || null,
      raw_blob: payload.raw_blob || null,
    });
    const snapshotId = snapshotInfo.id;
    db.prepare('DELETE FROM odds WHERE snapshot_id = ?').run(snapshotId);
    const insertOdd = db.prepare(`
      INSERT INTO odds (snapshot_id, market, selection, line, odds, implied_p, no_vig_p)
      VALUES (@snapshot_id, @market, @selection, @line, @odds, @implied_p, @no_vig_p)
    `);
    for (const row of markets) {
      insertOdd.run({
        snapshot_id: snapshotId,
        market: row.market,
        selection: row.selection,
        line: row.line == null || row.line === '' ? null : String(row.line),
        odds: Number(row.odds),
        implied_p: Number(row.implied_p),
        no_vig_p: row.no_vig_p == null ? null : Number(row.no_vig_p),
      });
    }
    return { snapshotId, oddsRows: markets.length };
  });
  return tx();
}

export function snapshotCounts(db = openDb()) {
  initDb(db);
  return db.prepare(`
    SELECT source, COUNT(*) AS snapshots
    FROM snapshots
    GROUP BY source
    ORDER BY source
  `).all();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const db = initDb(openDb());
  console.log(`initialized ${DB_PATH}`);
  console.log(snapshotCounts(db));
  db.close();
}
