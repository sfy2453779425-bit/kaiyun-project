import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  cleanText,
  fetchText,
  parseHtmlTables,
  sleep,
  teamKey,
  unionColumns,
  writeCsv,
} from './shared.js';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SEASONS = ['S12', 'S13', 'S14', 'S15', 'S16'];

function seasonToYear(season) {
  return {
    S12: 2022,
    S13: 2023,
    S14: 2024,
    S15: 2025,
    S16: 2026,
  }[season] || '';
}

function isLplTournament(name) {
  if (!name) return false;
  if (/^LPLOL/i.test(name)) return false;
  if (/^LPL\s*Allstars/i.test(name)) return false;
  if (name.trim() === 'LPL') return false;
  return /^LPL\b/i.test(name);
}

function extractLplTournamentNames(html) {
  const names = new Set();
  for (const match of String(html || '').matchAll(/\bLPL[^<'"\n\r]{0,80}/g)) {
    const candidate = match[0].split(/[<'"]/)[0].trim();
    if (isLplTournament(candidate)) names.add(candidate);
  }
  return [...names];
}

function extractTeamsFromListPage(html) {
  const tableMatch = html.match(/<table\b[^>]*class=['"]table_list[^'"]*['"][\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[0];
  const teams = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const inner = rowMatch[1];
    if (/<th\b/i.test(inner)) continue;
    const linkMatch = inner.match(/<a[^>]+href=['"]([^'"]+)['"][^>]*>([^<]+)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1];
    const idMatch = href.match(/team-stats\/(\d+)\//i);
    const name = cleanText(linkMatch[2]);
    if (!name) continue;
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanText(m[1]));
    const games = Number(cells[3] || '') || '';
    teams.push({
      gol_team_id: idMatch ? idMatch[1] : '',
      gol_team_name: name,
      games,
    });
  }
  return teams;
}

async function discoverTournamentsForSeason(season) {
  const url = `https://gol.gg/teams/list/season-${season}/split-ALL/tournament-ALL/`;
  const html = await fetchText(url);
  return extractLplTournamentNames(html);
}

async function fetchTeamsForTournament(name) {
  const enc = encodeURIComponent(name);
  const url = `https://gol.gg/teams/list/season-ALL/split-ALL/tournament-${enc}/`;
  const html = await fetchText(url);
  return { url, teams: extractTeamsFromListPage(html) };
}

async function main() {
  await mkdir(HISTORY_DIR, { recursive: true });

  console.log('Step 1/3: 查询每个赛季的 LPL 相关赛事名...');
  const candidates = [];
  const seenNames = new Set();
  for (const season of SEASONS) {
    const names = await discoverTournamentsForSeason(season);
    for (const name of names) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      candidates.push({
        tournament: name,
        season,
        year: seasonToYear(season),
      });
    }
    console.log(`  ${season}: 发现 ${names.length} 个`);
    await sleep(300);
  }
  candidates.sort((a, b) => String(a.year).localeCompare(String(b.year)) || a.tournament.localeCompare(b.tournament));

  await writeFile(
    path.join(HISTORY_DIR, 'tournament_candidates.json'),
    JSON.stringify({
      collected_at: new Date().toISOString(),
      source: 'gol.gg',
      seasons_queried: SEASONS,
      candidate_count: candidates.length,
      candidates,
    }, null, 2),
    'utf8',
  );
  console.log(`  汇总: ${candidates.length} 个赛事 -> tournament_candidates.json`);

  console.log('Step 2/3: 抓取每个赛事的队伍列表（轻量,不抓 maps）...');
  const auditRows = [];
  let okCount = 0;
  let emptyCount = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    try {
      const { url, teams } = await fetchTeamsForTournament(c.tournament);
      if (!teams.length) {
        emptyCount += 1;
        console.warn(`  [${i + 1}/${candidates.length}] ${c.tournament}: 空（页面无队伍数据,跳过）`);
      } else {
        okCount += 1;
        console.log(`  [${i + 1}/${candidates.length}] ${c.tournament}: ${teams.length} 支队`);
      }
      for (const t of teams) {
        auditRows.push({
          gol_team_id: t.gol_team_id,
          gol_team_name: t.gol_team_name,
          team_key_raw: teamKey(t.gol_team_name),
          tournament: c.tournament,
          season: c.season,
          year: c.year,
          games_in_tournament: t.games,
          source_url: url,
        });
      }
    } catch (error) {
      console.warn(`  [${i + 1}/${candidates.length}] ${c.tournament}: 失败 ${error.message}`);
    }
    await sleep(400);
  }

  console.log('Step 3/3: 汇总 alias audit...');
  const byTeamId = new Map();
  for (const row of auditRows) {
    const key = row.gol_team_id || row.gol_team_name;
    if (!byTeamId.has(key)) {
      byTeamId.set(key, {
        gol_team_id: row.gol_team_id,
        gol_team_name: row.gol_team_name,
        team_key_raw: row.team_key_raw,
        appearances: 0,
        tournaments: [],
        seen_names: new Set(),
      });
    }
    const acc = byTeamId.get(key);
    acc.appearances += 1;
    acc.tournaments.push(row.tournament);
    acc.seen_names.add(row.gol_team_name);
  }
  const distinctRows = [...byTeamId.values()]
    .map((acc) => ({
      gol_team_id: acc.gol_team_id,
      gol_team_name: acc.gol_team_name,
      team_key_raw: acc.team_key_raw,
      appearances: acc.appearances,
      distinct_display_names: [...acc.seen_names].join(' | '),
      tournaments: acc.tournaments.join(' | '),
    }))
    .sort((a, b) => b.appearances - a.appearances || String(a.gol_team_id).localeCompare(String(b.gol_team_id)));

  await writeCsv(
    path.join(DATA_DIR, 'team_alias_audit.csv'),
    auditRows,
    [
      'gol_team_id', 'gol_team_name', 'team_key_raw',
      'tournament', 'season', 'year',
      'games_in_tournament', 'source_url',
    ],
  );
  await writeCsv(
    path.join(DATA_DIR, 'team_alias_audit_distinct.csv'),
    distinctRows,
    ['gol_team_id', 'gol_team_name', 'team_key_raw', 'appearances', 'distinct_display_names', 'tournaments'],
  );

  console.log('');
  console.log('==== 汇总 ====');
  console.log(`赛事候选: ${candidates.length} 个`);
  console.log(`非空赛事: ${okCount} 个`);
  console.log(`空赛事: ${emptyCount} 个`);
  console.log(`alias audit 总行数: ${auditRows.length}`);
  console.log(`distinct gol_team_id: ${byTeamId.size}`);
  console.log('');
  console.log('文件:');
  console.log(`  ${path.join(HISTORY_DIR, 'tournament_candidates.json')}`);
  console.log(`  ${path.join(DATA_DIR, 'team_alias_audit.csv')}`);
  console.log(`  ${path.join(DATA_DIR, 'team_alias_audit_distinct.csv')}`);
}

main().catch((error) => {
  console.error(`LPL discover-teams 失败: ${error.message}`);
  process.exitCode = 1;
});
