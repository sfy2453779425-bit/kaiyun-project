import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_MODE } from '../model-mode.js';

export const ODDS_HISTORY_DIR = path.join(process.cwd(), 'lck', 'data', 'odds_history');
export const ODDS_DB_PATH = path.join(ODDS_HISTORY_DIR, 'odds.db');

export function openDb() {
  mkdirSync(ODDS_HISTORY_DIR, { recursive: true });
  const db = new Database(ODDS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initDb(db = openDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL,
      source TEXT NOT NULL,
      match_name TEXT NOT NULL,
      event_date TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      line TEXT,
      odds REAL NOT NULL,
      implied_p REAL,
      no_vig_p REAL,
      outcome INTEGER,
      actual_value TEXT,
      settled_at TEXT,
      model_mode TEXT DEFAULT 'legacy'
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_match ON snapshots(match_name, event_date);
    CREATE INDEX IF NOT EXISTS idx_odds_market ON odds(market, selection, line);
  `);

  // 迁移: 给 odds 表补下注追踪字段 (stake>0 的行 = 实际下注, 用于真实 ROI)
  const cols = new Set(db.prepare(`PRAGMA table_info(odds)`).all().map((c) => c.name));
  const migrations = [
    ['stake', 'REAL DEFAULT 0'],
    ['model_p', 'REAL'],
    ['recommended', 'INTEGER DEFAULT 0'],
    ['compliance', 'TEXT'],
    ['model_mode', "TEXT DEFAULT 'legacy'"],
  ];
  for (const [name, type] of migrations) {
    if (!cols.has(name)) db.exec(`ALTER TABLE odds ADD COLUMN ${name} ${type}`);
  }
  // 迁移: snapshots 加 league (赛事联赛), 用于按 LCK/LPL/EWC 分开统计真实 ROI
  const snapCols = new Set(db.prepare(`PRAGMA table_info(snapshots)`).all().map((c) => c.name));
  if (!snapCols.has('league')) db.exec(`ALTER TABLE snapshots ADD COLUMN league TEXT`);
  return db;
}

export function insertSnapshot({ source = 'manual', matchName, eventDate = '', notes = '', markets = [] }, db = initDb()) {
  const capturedAt = new Date().toISOString();
  const snapshot = db.prepare(`
    INSERT INTO snapshots (captured_at, source, match_name, event_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(capturedAt, source, matchName, eventDate, notes);
  const insertOdds = db.prepare(`
    INSERT INTO odds (snapshot_id, market, selection, line, odds, implied_p, no_vig_p, stake, model_p, recommended, compliance, model_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byMarketLine = new Map();
  for (const row of markets) {
    const key = [row.market, row.line || ''].join('|');
    if (!byMarketLine.has(key)) byMarketLine.set(key, []);
    byMarketLine.get(key).push(row);
  }
  const noVigByRow = new Map();
  for (const group of byMarketLine.values()) {
    const total = group.reduce((sum, row) => sum + (row.odds > 0 ? 1 / row.odds : 0), 0);
    for (const row of group) noVigByRow.set(row, total ? (1 / row.odds) / total : null);
  }
  const tx = db.transaction(() => {
    for (const row of markets) {
      const implied = row.odds > 0 ? 1 / row.odds : null;
      insertOdds.run(
        snapshot.lastInsertRowid, row.market, row.selection, row.line ?? '', row.odds, implied, noVigByRow.get(row),
        row.stake ?? 0, row.model_p ?? null, row.recommended ? 1 : 0, row.compliance ?? '', row.model_mode || MODEL_MODE,
      );
    }
  });
  tx();
  return { snapshotId: snapshot.lastInsertRowid, oddsRows: markets.length };
}

export function snapshotCounts(db = initDb()) {
  return db.prepare(`
    SELECT s.source, COUNT(DISTINCT s.id) AS snapshots, COUNT(o.id) AS odds_rows
    FROM snapshots s
    LEFT JOIN odds o ON o.snapshot_id = s.id
    GROUP BY s.source
    ORDER BY s.source
  `).all();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = initDb();
  console.log(snapshotCounts(db));
}
