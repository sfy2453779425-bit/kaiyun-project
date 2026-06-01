import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readLckData } from '../data-loader.js';
import { DATA_DIR, teamKey } from '../shared.js';
import { initDb, snapshotCounts } from '../odds-history/db-init.js';
import { MODEL_MODE } from '../model-mode.js';

const ROOT = process.cwd();
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtest', MODEL_MODE);
const COEF_PATH = path.join(ROOT, 'lck', 'calibration', 'total_kills_model_coef.json');

function status(ok, label, detail) {
  return { ok, label, detail };
}

function maxDate(rows, fieldNames) {
  return rows
    .flatMap((row) => fieldNames.map((field) => String(row[field] || '').slice(0, 10)))
    .filter(Boolean)
    .sort()
    .at(-1) || '';
}

function duplicateKeys(rows, keyFn) {
  const seen = new Set();
  const dup = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (seen.has(key)) dup.add(key);
    seen.add(key);
  }
  return [...dup];
}

function fileExists(relPath) {
  const full = path.join(ROOT, relPath);
  return status(existsSync(full), relPath, existsSync(full) ? `${statSync(full).size} bytes` : 'missing');
}

async function main() {
  const { matches, maps, manualMatches, manualMaps } = await readLckData();
  const checks = [
    fileExists(path.join('lck', 'data', 'lck_matches.csv')),
    fileExists(path.join('lck', 'data', 'lck_map_details.csv')),
    fileExists(path.join('lck', 'data', 'lck_team_detail_summary.csv')),
    fileExists(path.join('lck', 'data', 'manual_recent_matches.csv')),
    fileExists(path.join('lck', 'data', 'manual_recent_maps.csv')),
    fileExists(path.join('lck', 'data', 'history', 'all_matches.csv')),
    fileExists(path.join('lck', 'data', 'history', 'all_map_details.csv')),
    fileExists(path.join('lck', 'data', 'backtest', MODEL_MODE, 'predictions.csv')),
  ];
  checks.push(status(Boolean(process.env.MODEL_MODE) || MODEL_MODE === 'legacy', 'default model mode', process.env.MODEL_MODE ? `MODEL_MODE=${MODEL_MODE}` : 'MODEL_MODE unset -> legacy'));

  const manualMatchDup = duplicateKeys(manualMatches, (row) => {
    const date = String(row.match_date || '').slice(0, 10);
    const teams = [teamKey(row.team_a_id || row.team_a), teamKey(row.team_b_id || row.team_b)].sort().join('|');
    return `${date}|${teams}`;
  });
  const manualMapDup = duplicateKeys(manualMaps, (row) => row.game_id);
  checks.push(status(manualMatchDup.length === 0, 'manual match duplicates', manualMatchDup.join(', ') || 'none'));
  checks.push(status(manualMapDup.length === 0, 'manual map duplicates', manualMapDup.join(', ') || 'none'));

  let coef = null;
  if (existsSync(COEF_PATH)) {
    try {
      coef = JSON.parse(readFileSync(COEF_PATH, 'utf8'));
    } catch {
      coef = null;
    }
  }
  checks.push(status(Boolean(coef), 'total kills coef', coef ? path.relative(ROOT, COEF_PATH) : 'missing or invalid'));
  checks.push(status(coef?.deploy === true, 'total kills deploy', coef ? `deploy=${coef.deploy}` : 'no coef'));

  const db = initDb();
  const counts = snapshotCounts(db);
  checks.push(status(true, 'odds history db', `${counts.reduce((sum, row) => sum + Number(row.odds_rows || 0), 0)} odds rows`));

  const requiredFailed = checks.filter((row) => !row.ok && !['total kills deploy'].includes(row.label));
  console.log('# LCK health check');
  console.log(`model_mode=${MODEL_MODE}`);
  console.log(`current_matches=${matches.length}, current_maps=${maps.length}`);
  console.log(`latest_match_date=${maxDate(matches, ['match_date'])}`);
  console.log(`latest_map_date=${maxDate(maps, ['match_time', 'match_date'])}`);
  console.log(`history_dir=${HISTORY_DIR}`);
  console.log(`backtest_dir=${BACKTEST_DIR}`);
  console.log('');
  console.log('| status | check | detail |');
  console.log('|---|---|---|');
  for (const row of checks) console.log(`| ${row.ok ? 'PASS' : 'WARN'} | ${row.label} | ${row.detail} |`);

  if (requiredFailed.length) {
    process.exitCode = 1;
    console.error(`health-check failed required checks: ${requiredFailed.map((row) => row.label).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(`health-check failed: ${error.message}`);
  process.exitCode = 1;
});
