import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCsvIfExists, teamKey, unionColumns, writeCsv } from '../shared.js';
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

function blankPct(rows, field) {
  if (!rows.length) return '—';
  const blank = rows.filter((row) => !row[field]).length;
  return `${(blank / rows.length * 100).toFixed(1)}%`;
}

function yearOfTournament(matchesInSlug) {
  const years = matchesInSlug.map((row) => String(row.match_date || '').slice(0, 4)).filter(Boolean);
  if (!years.length) return '';
  const counts = new Map();
  for (const y of years) counts.set(y, (counts.get(y) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function main() {
  const folders = await readHistoryFolders();
  const allMatches = [];
  const allMaps = [];
  const allSummary = [];
  const skipped = [];
  const perTournament = [];

  const golTeamIds = new Set();

  for (const { slug, folder } of folders) {
    const [matches, maps, summary] = await Promise.all([
      readCsvIfExists(path.join(folder, 'lpl_matches.csv')),
      readCsvIfExists(path.join(folder, 'lpl_map_details.csv')),
      readCsvIfExists(path.join(folder, 'lpl_team_detail_summary.csv')),
    ]);

    if (!matches.length || !maps.length) {
      skipped.push(`${slug}: missing lpl_matches.csv or lpl_map_details.csv`);
      continue;
    }

    allMatches.push(...matches.map((row) => ({ ...row, history_slug: slug })));
    allMaps.push(...maps.map((row) => ({ ...row, history_slug: slug })));
    allSummary.push(...summary.map((row) => ({ ...row, history_slug: slug })));

    const tournamentName = matches[0]?.tournament || slug;
    for (const row of matches) {
      if (row.team_a) golTeamIds.add(row.team_a);
      if (row.team_b) golTeamIds.add(row.team_b);
    }

    perTournament.push({
      slug,
      tournament_name: tournamentName,
      matches: matches.length,
      maps: maps.length,
      year: yearOfTournament(matches),
      缺失字段统计: {
        first_blood_team_id: blankPct(maps, 'first_blood_team_id'),
        first_turret_team_id: blankPct(maps, 'first_turret_team_id'),
        first_dragon_team_id: blankPct(maps, 'first_dragon_team_id'),
        first_herald_team_id: blankPct(maps, 'first_herald_team_id'),
      },
    });
    console.log(`${slug}: matches=${matches.length}, maps=${maps.length}, summary=${summary.length}, year=${perTournament[perTournament.length - 1].year}`);
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

  const aliasKeys = new Set();
  for (const name of golTeamIds) aliasKeys.add(teamKey(name));

  const manifest = {
    采集日期: new Date().toISOString(),
    采集来源: 'gol.gg',
    采集的赛事: perTournament.sort((a, b) => String(a.year).localeCompare(String(b.year)) || a.slug.localeCompare(b.slug)),
    合并后总样本: { matches: matches.length, maps: maps.length, summary: summary.length },
    'team_id 字典大小(去重前)': golTeamIds.size,
    'alias 合并后唯一队伍数': aliasKeys.size,
    skipped,
  };
  await writeFile(path.join(HISTORY_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`merged: matches=${matches.length}, maps=${maps.length}, summary=${summary.length}`);
  console.log(`team_id (gol display names) distinct: ${golTeamIds.size}`);
  console.log(`alias-merged teamKey distinct: ${aliasKeys.size}`);
  console.log(`manifest -> ${path.join(HISTORY_DIR, 'manifest.json')}`);
  if (skipped.length) {
    console.warn('skipped folders:');
    for (const item of skipped) console.warn(`- ${item}`);
  }
}

main().catch((error) => {
  console.error(`merge-history failed: ${error.message}`);
  process.exitCode = 1;
});
