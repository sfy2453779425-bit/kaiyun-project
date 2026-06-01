import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  argValue,
  readCsvIfExists,
  unionColumns,
  writeCsv,
} from './shared.js';

const SOURCE_DIR = argValue('source-dir', '');

if (!SOURCE_DIR) {
  console.error('错误: 必须传入 --source-dir=已采集赛事目录');
  process.exit(2);
}

function keyFor(fileName, row) {
  if (fileName === 'lpl_matches.csv') return row.match_id || row.game_id || '';
  if (fileName === 'lpl_map_details.csv') return row.game_id || [row.match_id, row.bo].join('|');
  if (fileName === 'lpl_player_map_details.csv') {
    return [
      row.game_id || row.match_id || '',
      row.team_id || row.team || '',
      row.player_name || '',
      row.role || '',
      row.hero || '',
    ].join('|');
  }
  return '';
}

function mergeRows(existing, incoming, fileName) {
  const byKey = new Map();
  const order = [];

  for (const row of existing) {
    const key = keyFor(fileName, row);
    if (!key) continue;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, row);
  }

  let addedOrReplaced = 0;
  for (const row of incoming) {
    const key = keyFor(fileName, row);
    if (!key) continue;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, row);
    addedOrReplaced += 1;
  }

  return {
    rows: order.map((key) => byKey.get(key)),
    addedOrReplaced,
  };
}

async function updateLatestSummary(sourceDir, results) {
  const summaryPath = path.join(DATA_DIR, 'latest-summary.json');
  let summary = {};
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  } catch {
    summary = {};
  }
  let sourceSummary = {};
  try {
    sourceSummary = JSON.parse(await readFile(path.join(sourceDir, 'latest-summary.json'), 'utf8'));
  } catch {
    sourceSummary = {};
  }

  summary.merged_collected_tournament_at = new Date().toISOString();
  summary.merged_collected_tournament = sourceSummary.tournament || path.basename(sourceDir);
  summary.merged_collected_source_dir = sourceDir;
  summary.merge_collected_results = results;
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function main() {
  const sourceDir = path.resolve(SOURCE_DIR);
  const files = [
    'lpl_matches.csv',
    'lpl_map_details.csv',
    'lpl_player_map_details.csv',
  ];
  const results = [];

  for (const fileName of files) {
    const targetPath = path.join(DATA_DIR, fileName);
    const sourcePath = path.join(sourceDir, fileName);
    const [existing, incoming] = await Promise.all([
      readCsvIfExists(targetPath),
      readCsvIfExists(sourcePath),
    ]);
    if (!incoming.length) {
      results.push({ file: fileName, before: existing.length, incoming: 0, addedOrReplaced: 0, after: existing.length });
      continue;
    }
    const merged = mergeRows(existing, incoming, fileName);
    await writeCsv(targetPath, merged.rows, unionColumns([...existing, ...incoming]));
    results.push({
      file: fileName,
      before: existing.length,
      incoming: incoming.length,
      addedOrReplaced: merged.addedOrReplaced,
      after: merged.rows.length,
    });
  }

  await updateLatestSummary(sourceDir, results);
  for (const result of results) {
    console.log(`${result.file}: before=${result.before}, incoming=${result.incoming}, addedOrReplaced=${result.addedOrReplaced}, after=${result.after}`);
  }
}

main().catch((error) => {
  console.error(`merge-collected failed: ${error.message}`);
  process.exitCode = 1;
});
