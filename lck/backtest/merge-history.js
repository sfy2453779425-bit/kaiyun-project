import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCsvIfExists, unionColumns, writeCsv } from '../shared.js';
import { HISTORY_DIR, ensureHistoryDir } from './common.js';

function dedupe(rows, keyFn) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

async function readHistoryFolders() {
  await ensureHistoryDir();
  const entries = await readdir(HISTORY_DIR, { withFileTypes: true });
  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(HISTORY_DIR, entry.name);
    const info = await stat(folder);
    folders.push({ slug: entry.name, folder, mtimeMs: info.mtimeMs });
  }
  return folders.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function main() {
  const folders = await readHistoryFolders();
  const allMatches = [];
  const allMaps = [];
  const allSummary = [];
  const skipped = [];

  for (const { slug, folder } of folders) {
    const [matches, maps, summary] = await Promise.all([
      readCsvIfExists(path.join(folder, 'lck_matches.csv')),
      readCsvIfExists(path.join(folder, 'lck_map_details.csv')),
      readCsvIfExists(path.join(folder, 'lck_team_detail_summary.csv')),
    ]);

    if (!matches.length || !maps.length) {
      skipped.push(`${slug}: missing lck_matches.csv or lck_map_details.csv`);
      continue;
    }

    allMatches.push(...matches.map((row) => ({ ...row, history_slug: slug })));
    allMaps.push(...maps.map((row) => ({ ...row, history_slug: slug })));
    allSummary.push(...summary.map((row) => ({ ...row, history_slug: slug })));
    console.log(`${slug}: matches=${matches.length}, maps=${maps.length}, summary=${summary.length}`);
  }

  const matches = dedupe(allMatches, (row) => row.match_id)
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));
  const maps = dedupe(allMaps, (row) => row.game_id || [row.match_id, row.bo].join('|'))
    .sort((a, b) => String(a.match_time || a.match_date).localeCompare(String(b.match_time || b.match_date)) || Number(a.bo || 0) - Number(b.bo || 0));
  const summary = dedupe(allSummary, (row) => [row.history_slug, row.team_id].join('|'))
    .sort((a, b) => String(a.history_slug).localeCompare(String(b.history_slug)) || String(a.team_id).localeCompare(String(b.team_id)));

  await writeCsv(path.join(HISTORY_DIR, 'all_matches.csv'), matches, unionColumns(matches));
  await writeCsv(path.join(HISTORY_DIR, 'all_map_details.csv'), maps, unionColumns(maps));
  await writeCsv(path.join(HISTORY_DIR, 'all_team_summary.csv'), summary, unionColumns(summary));

  console.log(`merged: matches=${matches.length}, maps=${maps.length}, summary=${summary.length}`);
  if (skipped.length) {
    console.warn('skipped folders:');
    for (const item of skipped) console.warn(`- ${item}`);
  }
}

main().catch((error) => {
  console.error(`merge-history failed: ${error.message}`);
  process.exitCode = 1;
});
