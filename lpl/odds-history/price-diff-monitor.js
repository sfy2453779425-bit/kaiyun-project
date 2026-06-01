import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { initDb, ODDS_HISTORY_DIR, openDb } from './db-init.js';
import { argValue } from './op-utils.js';

const ALERT_PATH = path.join(ODDS_HISTORY_DIR, 'alerts.log');

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function keyOf(row) {
  return [row.match_name, row.market, row.selection, row.line || ''].join('|');
}

async function main() {
  const minutes = Number(argValue('minutes', '60'));
  const threshold = Number(argValue('threshold', '1.08'));
  const stabilityPp = Number(argValue('op-stability-pp', '3')) / 100;
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const db = initDb(openDb());
  const rows = db.prepare(`
    SELECT s.ts, s.source, s.match_name, o.market, o.selection, o.line, o.odds, o.implied_p, o.no_vig_p
    FROM snapshots s
    JOIN odds o ON o.snapshot_id = s.id
    WHERE s.ts >= ?
    ORDER BY s.ts ASC
  `).all(since);

  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const alerts = [];
  for (const group of groups.values()) {
    const opRows = group.filter((row) => row.source === 'oddsportal' && row.no_vig_p);
    const smallRows = group.filter((row) => row.source !== 'oddsportal');
    if (!opRows.length || !smallRows.length) continue;
    const opNoVigs = opRows.map((row) => Number(row.no_vig_p)).filter(Number.isFinite);
    if (!opNoVigs.length || stddev(opNoVigs) > stabilityPp) continue;
    const opP = opNoVigs[opNoVigs.length - 1];
    const opFairOdds = 1 / opP;
    const latestSmallBySource = new Map();
    for (const row of smallRows) latestSmallBySource.set(row.source, row);
    for (const row of latestSmallBySource.values()) {
      const ratio = Number(row.odds) / opFairOdds;
      if (ratio < threshold) continue;
      const line = `[${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 16)}] ${row.match_name} | ${row.market} ${row.selection}${row.line ? ` ${row.line}` : ''} | ${row.source} ${Number(row.odds).toFixed(3)} vs OP fair ${opFairOdds.toFixed(3)} | +${pct(ratio - 1)} 价水 | OP no_vig_p ${pct(opP)}`;
      alerts.push(line);
    }
  }

  if (alerts.length) {
    await mkdir(ODDS_HISTORY_DIR, { recursive: true });
    await appendFile(ALERT_PATH, `${alerts.join('\n')}\n`, 'utf8');
  }
  for (const alert of alerts) console.log(alert);
  console.log(`alerts=${alerts.length}, window_minutes=${minutes}, threshold=${threshold}`);
  db.close();
}

main().catch((error) => {
  console.error(`price-diff-monitor failed: ${error.message}`);
  process.exitCode = 1;
});
