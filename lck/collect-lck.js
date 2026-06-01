import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  RAW_DIR,
  DEFAULT_TOURNAMENT,
  absoluteGolUrl,
  argNumber,
  argValue,
  avg,
  cleanText,
  displayTeam,
  extractAltNames,
  fetchText,
  golUrl,
  hasFlag,
  htmlCells,
  num,
  parseDurationToMinutes,
  parseHtmlTables,
  parsePercent,
  readCsvIfExists,
  pct,
  safeFileName,
  sleep,
  teamKey,
  unionColumns,
  writeCsv,
} from './shared.js';

const TOURNAMENT = argValue('tournament', process.env.LCK_TOURNAMENT || DEFAULT_TOURNAMENT);
const MAX_MATCHES = argNumber('max-matches', 0);
const SKIP_GAMES = hasFlag('no-games');

function tableByCaption(html, captionPart) {
  return parseHtmlTables(html).find((table) => table.caption.includes(captionPart));
}

function parseMatchList(html) {
  const table = tableByCaption(html, 'results');
  if (!table) throw new Error('无法解析 GOL 赛程表');
  const rows = [];

  for (const rowMatch of table.html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/<th\b/i.test(rowMatch[1])) continue;
    const cells = htmlCells(rowMatch[1]);
    if (cells.length < 7) continue;
    const href = (cells[0].html.match(/href=['"]([^'"]+)['"]/i) || [])[1] || '';
    const gameId = (href.match(/stats\/(\d+)\//) || [])[1] || '';
    const scoreText = cells[2].text.replace(/\s+/g, ' ').trim();
    const score = scoreText.match(/(\d+)\s*-\s*(\d+)/);
    const teamA = cells[1].text;
    const teamB = cells[3].text;
    const scoreA = score ? Number(score[1]) : '';
    const scoreB = score ? Number(score[2]) : '';
    const winner = score ? (scoreA > scoreB ? teamA : teamB) : '';
    const matchName = cells[0].text || `${teamA} vs ${teamB}`;
    rows.push({
      match_id: gameId,
      game_id: gameId,
      tournament: TOURNAMENT,
      match_name: matchName,
      match_date: cells[6].text,
      status: score ? '已结束' : '未开始',
      stage: cells[4].text,
      patch: cells[5].text,
      team_a_id: teamKey(teamA),
      team_a: teamA,
      score_a: scoreA,
      team_b_id: teamKey(teamB),
      team_b: teamB,
      score_b: scoreB,
      winner_id: winner ? teamKey(winner) : '',
      winner,
      source_url: href ? absoluteGolUrl(href) : '',
    });
  }

  return rows;
}

function parseStatsTable(html, requiredHeaders) {
  const tables = parseHtmlTables(html);
  return tables.find((table) => requiredHeaders.every((header) => table.headers.includes(header)))
    || { headers: [], rows: [] };
}

function extractGameIds(summaryHtml, fallbackId) {
  const ids = [...summaryHtml.matchAll(/stats\/(\d+)\/page-game/gi)].map((match) => match[1]);
  const unique = [...new Set(ids)];
  return unique.length ? unique : [fallbackId].filter(Boolean);
}

function metric(block, alt) {
  const re = new RegExp(`alt=['"]${alt}['"][^>]*>\\s*([0-9.]+k?)`, 'i');
  const match = String(block || '').match(re);
  return match ? num(match[1]) : 0;
}

function sectionBetween(block, firstNeedle, secondNeedle) {
  const start = block.indexOf(firstNeedle);
  if (start === -1) return '';
  const end = secondNeedle ? block.indexOf(secondNeedle, start + firstNeedle.length) : -1;
  return end === -1 ? block.slice(start) : block.slice(start, end);
}

function parseSideBlock(block, side) {
  const header = String(block || '').match(/title=['"]([^'"]+) stats['"][^>]*>([^<]+)<\/a>\s*-\s*(WIN|LOSS)/i);
  const team = cleanText(header?.[2] || '');
  const bansHtml = sectionBetween(block, 'Bans', 'Picks');
  const picksHtml = sectionBetween(block, 'Picks', '</div>');
  return {
    side,
    team,
    team_id: teamKey(team),
    result: header?.[3] || '',
    kills: metric(block, 'Kills'),
    towers: metric(block, 'Towers'),
    dragons: metric(block, 'Dragons'),
    barons: metric(block, 'Nashor'),
    gold: metric(block, 'Team Gold'),
    first_blood: /alt=['"]First Blood['"]/i.test(block),
    first_tower: /alt=['"]First Tower['"]/i.test(block),
    bans: extractAltNames(bansHtml).join('/'),
    picks: extractAltNames(picksHtml).join('/'),
  };
}

function parseGamePage(html) {
  const blueStart = html.indexOf('blue-line-header');
  const redStart = html.indexOf('red-line-header');
  if (blueStart === -1 || redStart === -1) throw new Error('无法解析蓝红方数据');
  const tableStart = html.indexOf('<table', redStart);
  const blueBlock = html.slice(blueStart, redStart);
  const redBlock = html.slice(redStart, tableStart === -1 ? redStart + 9000 : tableStart);
  const duration = (html.match(/Game Time<br\/>\s*<h1>([^<]+)<\/h1>/i) || [])[1] || '';
  const patch = (html.match(/>\s*v([0-9.]+)\s*<\/div>/i) || [])[1] || '';
  return {
    game_time: duration,
    game_time_min: parseDurationToMinutes(duration),
    patch,
    blue: parseSideBlock(blueBlock, 'blue'),
    red: parseSideBlock(redBlock, 'red'),
  };
}

function parseCompleteStats(html) {
  const table = (String(html || '').match(/<table\b[^>]*class=['"][^'"]*completestats[^'"]*['"][\s\S]*?<\/table>/i) || [])[0] || '';
  if (!table) return [];
  const thead = (table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i) || [])[1] || '';
  const heroes = extractAltNames(thead).slice(0, 10);
  const statRows = {};

  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/<th\b/i.test(rowMatch[1])) continue;
    const cells = htmlCells(rowMatch[1]);
    if (cells.length < 2) continue;
    const key = cells[0].text;
    statRows[key] = cells.slice(1).map((cell) => cell.text);
  }

  return heroes.map((hero, index) => ({
    side: index < 5 ? 'blue' : 'red',
    player_name: statRows.Player?.[index] || '',
    role: statRows.Role?.[index] || '',
    hero,
    kills: statRows.Kills?.[index] || '',
    deaths: statRows.Deaths?.[index] || '',
    assists: statRows.Assists?.[index] || '',
    golds: statRows.Golds?.[index] || '',
    creeps: statRows.CS?.[index] || '',
    vision_score: statRows['Vision Score']?.[index] || '',
    damage_per_minute: statRows.DPM?.[index] || '',
    hero_damage: statRows['Total damage to Champion']?.[index] || '',
  }));
}

function sideForTeam(game, teamId) {
  if (game.blue.team_id === teamId) return game.blue;
  if (game.red.team_id === teamId) return game.red;
  return null;
}

async function collectGameDetails(matchRows) {
  const completed = matchRows
    .filter((match) => match.status === '已结束' && match.source_url)
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
  const selected = MAX_MATCHES > 0 ? completed.slice(-MAX_MATCHES) : completed;
  const mapRows = [];
  const playerRows = [];

  console.log(`准备采集 ${selected.length} 场已结束比赛的小局数据...`);
  for (let i = 0; i < selected.length; i += 1) {
    const match = selected[i];
    const summaryHtml = await fetchText(match.source_url);
    await writeFile(path.join(RAW_DIR, `summary_${match.match_id}.html`), summaryHtml, 'utf8');
    const gameIds = extractGameIds(summaryHtml, match.match_id);

    for (let mapIndex = 0; mapIndex < gameIds.length; mapIndex += 1) {
      const gameId = gameIds[mapIndex];
      const gameUrl = `https://gol.gg/game/stats/${gameId}/page-game/`;
      const fullStatsUrl = `https://gol.gg/game/stats/${gameId}/page-fullstats/`;
      const [gameHtml, fullStatsHtml] = await Promise.all([
        fetchText(gameUrl),
        fetchText(fullStatsUrl),
      ]);
      await writeFile(path.join(RAW_DIR, `game_${gameId}.html`), gameHtml, 'utf8');
      await writeFile(path.join(RAW_DIR, `fullstats_${gameId}.html`), fullStatsHtml, 'utf8');

      const game = parseGamePage(gameHtml);
      const fullStats = parseCompleteStats(fullStatsHtml);
      const sideA = sideForTeam(game, match.team_a_id) || game.blue;
      const sideB = sideForTeam(game, match.team_b_id) || game.red;
      const winner = game.blue.result === 'WIN' ? game.blue : game.red;
      const firstBlood = game.blue.first_blood ? game.blue : game.red.first_blood ? game.red : null;
      const firstTower = game.blue.first_tower ? game.blue : game.red.first_tower ? game.red : null;

      mapRows.push({
        match_id: match.match_id,
        game_id: gameId,
        match_name: match.match_name,
        match_time: match.match_date,
        tournament: TOURNAMENT,
        stage: match.stage,
        bo: mapIndex + 1,
        patch: game.patch || match.patch,
        map_winner_id: winner.team_id,
        map_winner: winner.team,
        blue_team_id: game.blue.team_id,
        blue_team: game.blue.team,
        red_team_id: game.red.team_id,
        red_team: game.red.team,
        game_time_min: game.game_time_min,
        game_time: game.game_time,
        team_a_id: match.team_a_id,
        team_a: match.team_a,
        team_a_kills: sideA.kills,
        team_a_turrets: sideA.towers,
        team_a_dragons: sideA.dragons,
        team_a_barons: sideA.barons,
        team_b_id: match.team_b_id,
        team_b: match.team_b,
        team_b_kills: sideB.kills,
        team_b_turrets: sideB.towers,
        team_b_dragons: sideB.dragons,
        team_b_barons: sideB.barons,
        total_kills: sideA.kills + sideB.kills,
        total_turrets: sideA.towers + sideB.towers,
        total_dragons: sideA.dragons + sideB.dragons,
        total_barons: sideA.barons + sideB.barons,
        first_blood_team_id: firstBlood?.team_id || '',
        first_blood_team: firstBlood?.team || '',
        first_turret_team_id: firstTower?.team_id || '',
        first_turret_team: firstTower?.team || '',
        first_dragon_team_id: '',
        first_dragon_team: '',
        first_herald_team_id: '',
        first_herald_team: '',
        blue_bans: game.blue.bans,
        red_bans: game.red.bans,
        blue_picks: fullStats.filter((row) => row.side === 'blue').map((row) => row.hero).join('/'),
        red_picks: fullStats.filter((row) => row.side === 'red').map((row) => row.hero).join('/'),
        source_url: gameUrl,
      });

      for (const player of fullStats) {
        const side = player.side === 'blue' ? game.blue : game.red;
        playerRows.push({
          match_id: match.match_id,
          game_id: gameId,
          match_name: match.match_name,
          bo: mapIndex + 1,
          team_id: side.team_id,
          team: side.team,
          side: player.side,
          player_name: player.player_name,
          role: player.role,
          hero: player.hero,
          kills: player.kills,
          deaths: player.deaths,
          assists: player.assists,
          golds: player.golds,
          creeps: player.creeps,
          hero_damage: player.hero_damage,
          damage_per_minute: player.damage_per_minute,
          vision_score: player.vision_score,
        });
      }

      await sleep(250);
    }
    console.log(`${i + 1}/${selected.length} ${match.match_name} 小局:${gameIds.length}`);
    await sleep(500);
  }

  return { mapRows, playerRows };
}

function matchScore(match, teamId) {
  if (match.team_a_id === teamId) return [num(match.score_a), num(match.score_b)];
  return [num(match.score_b), num(match.score_a)];
}

function buildRecentForm(matchRows) {
  const teams = new Map();
  for (const match of matchRows) {
    teams.set(match.team_a_id, match.team_a);
    teams.set(match.team_b_id, match.team_b);
  }
  const forms = new Map();
  const stats = new Map([...teams].map(([id, name]) => [id, {
    team_id: id,
    team_name: displayTeam(id, name),
    played: 0,
    wins: 0,
    losses: 0,
    maps_won: 0,
    maps_lost: 0,
    win_rate: '0.000',
    recent_5: '',
  }]));

  const finished = matchRows
    .filter((match) => match.status === '已结束')
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
  for (const match of finished) {
    for (const teamId of [match.team_a_id, match.team_b_id]) {
      const row = stats.get(teamId);
      const [forMaps, againstMaps] = matchScore(match, teamId);
      const won = match.winner_id === teamId;
      row.played += 1;
      row.wins += won ? 1 : 0;
      row.losses += won ? 0 : 1;
      row.maps_won += forMaps;
      row.maps_lost += againstMaps;
      if (!forms.has(teamId)) forms.set(teamId, []);
      forms.get(teamId).push(won ? 'W' : 'L');
    }
  }

  return [...stats.values()].map((row) => ({
    ...row,
    win_rate: row.played ? (row.wins / row.played).toFixed(3) : '0.000',
    recent_5: (forms.get(row.team_id) || []).slice(-5).join(''),
  })).sort((a, b) => b.wins - a.wins || a.team_name.localeCompare(b.team_name));
}

function buildTeamSummary(mapRows, matchRows, golTeamRows) {
  const teams = new Map();
  for (const match of matchRows) {
    teams.set(match.team_a_id, displayTeam(match.team_a_id, match.team_a));
    teams.set(match.team_b_id, displayTeam(match.team_b_id, match.team_b));
  }
  for (const row of golTeamRows) teams.set(teamKey(row.name), displayTeam(teamKey(row.name), row.name));

  const golByTeam = new Map(golTeamRows.map((row) => [teamKey(row.name), row]));

  return [...teams].map(([teamId, team]) => {
    const maps = mapRows.filter((row) => row.team_a_id === teamId || row.team_b_id === teamId);
    const matches = matchRows.filter((row) => row.status === '已结束' && (row.team_a_id === teamId || row.team_b_id === teamId));
    const gol = golByTeam.get(teamId) || {};
    const useMapStats = maps.length >= 8;
    let killsFor = 0;
    let deaths = 0;
    let gameTime = 0;
    let mapWins = 0;
    let fb = 0;
    let ft = 0;
    let killOver30 = 0;
    for (const map of maps) {
      const side = map.team_a_id === teamId ? 'a' : 'b';
      const other = side === 'a' ? 'b' : 'a';
      const kills = num(map[`team_${side}_kills`]);
      const against = num(map[`team_${other}_kills`]);
      killsFor += kills;
      deaths += against;
      gameTime += num(map.game_time_min);
      mapWins += map.map_winner_id === teamId ? 1 : 0;
      fb += map.first_blood_team_id === teamId ? 1 : 0;
      ft += map.first_turret_team_id === teamId ? 1 : 0;
      killOver30 += num(map.total_kills) > 30.5 ? 1 : 0;
    }
    const twoZeroWins = matches.filter((match) => match.winner_id === teamId && matchScore(match, teamId)[0] === 2 && matchScore(match, teamId)[1] === 0).length;
    const twoZeroLosses = matches.filter((match) => match.winner_id !== teamId && matchScore(match, teamId)[0] === 0 && matchScore(match, teamId)[1] === 2).length;
    const go3 = matches.filter((match) => num(match.score_a) + num(match.score_b) >= 3).length;

    return {
      team_id: teamId,
      team,
      matches: matches.length,
      match_wins: matches.filter((match) => match.winner_id === teamId).length,
      match_win_rate: pct(matches.filter((match) => match.winner_id === teamId).length, matches.length).toFixed(3),
      maps: useMapStats ? maps.length : gol.games || '',
      map_wins: useMapStats ? mapWins : '',
      map_win_rate: useMapStats ? pct(mapWins, maps.length).toFixed(3) : parsePercent(gol.win_rate).toFixed(3),
      series_2_0_win_rate: pct(twoZeroWins, matches.length).toFixed(3),
      series_0_2_loss_rate: pct(twoZeroLosses, matches.length).toFixed(3),
      series_go_3_maps_rate: pct(go3, matches.length).toFixed(3),
      avg_kills: useMapStats ? avg(killsFor, maps.length, 2) : num(gol.kills_game).toFixed(2),
      avg_deaths: useMapStats ? avg(deaths, maps.length, 2) : num(gol.deaths_game).toFixed(2),
      avg_kill_diff: useMapStats ? avg(killsFor - deaths, maps.length, 2) : (num(gol.kills_game) - num(gol.deaths_game)).toFixed(2),
      avg_total_kills: useMapStats ? avg(killsFor + deaths, maps.length, 2) : (num(gol.kills_game) + num(gol.deaths_game)).toFixed(2),
      avg_game_time_min: useMapStats ? avg(gameTime, maps.length, 2) : parseDurationToMinutes(gol.game_duration).toFixed(2),
      first_blood_rate: useMapStats ? pct(fb, maps.length).toFixed(3) : parsePercent(gol.fbpct).toFixed(3),
      first_turret_rate: useMapStats ? pct(ft, maps.length).toFixed(3) : parsePercent(gol.ftpct).toFixed(3),
      dragon_control_rate: parsePercent(gol.drapct).toFixed(3),
      herald_control_rate: parsePercent(gol.herpct).toFixed(3),
      baron_control_rate: parsePercent(gol.nashpct).toFixed(3),
      dragons_per_game: num(gol.drapg).toFixed(2),
      voidgrubs_per_game: num(gol.vgpg).toFixed(2),
      gd_at_15: num(gol.gd_at_15),
      td_at_15: num(gol.td_at_15),
      dpm: num(gol.dpm),
      wpm: num(gol.wpm),
      total_kills_over_30_5_rate: useMapStats ? pct(killOver30, maps.length).toFixed(3) : '',
    };
  }).sort((a, b) => Number(b.map_win_rate) - Number(a.map_win_rate));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(RAW_DIR, { recursive: true });

  console.log(`采集 LCK 公开数据: ${TOURNAMENT}`);
  const urls = {
    matchlist: golUrl('matchlist', TOURNAMENT),
    teams: golUrl('teams', TOURNAMENT),
    players: golUrl('players', TOURNAMENT),
    champions: golUrl('champions', TOURNAMENT),
  };

  const [matchHtml, teamHtml, playerHtml, championHtml] = await Promise.all([
    fetchText(urls.matchlist),
    fetchText(urls.teams),
    fetchText(urls.players),
    fetchText(urls.champions),
  ]);
  await writeFile(path.join(RAW_DIR, 'gol_matchlist.html'), matchHtml, 'utf8');
  await writeFile(path.join(RAW_DIR, 'gol_teams.html'), teamHtml, 'utf8');
  await writeFile(path.join(RAW_DIR, 'gol_players.html'), playerHtml, 'utf8');
  await writeFile(path.join(RAW_DIR, 'gol_champions.html'), championHtml, 'utf8');

  const matchRows = parseMatchList(matchHtml);
  const teamTable = parseStatsTable(teamHtml, ['name', 'games', 'win_rate']);
  const playerTable = parseStatsTable(playerHtml, ['player', 'games', 'win_rate']);
  const championTable = parseStatsTable(championHtml, ['champion', 'picks', 'bans']);

  await writeCsv(path.join(DATA_DIR, 'public_sources', 'gol_matchlist_stats.csv'), matchRows, unionColumns(matchRows));
  await writeCsv(path.join(DATA_DIR, 'public_sources', 'gol_team_stats.csv'), teamTable.rows, unionColumns(teamTable.rows));
  await writeCsv(path.join(DATA_DIR, 'public_sources', 'gol_player_stats.csv'), playerTable.rows, unionColumns(playerTable.rows));
  await writeCsv(path.join(DATA_DIR, 'public_sources', 'gol_champion_stats.csv'), championTable.rows, unionColumns(championTable.rows));

  const { mapRows, playerRows } = SKIP_GAMES
    ? {
        mapRows: await readCsvIfExists(path.join(DATA_DIR, 'lck_map_details.csv')),
        playerRows: await readCsvIfExists(path.join(DATA_DIR, 'lck_player_map_details.csv')),
      }
    : await collectGameDetails(matchRows);

  const recentForm = buildRecentForm(matchRows);
  const teamSummary = buildTeamSummary(mapRows, matchRows, teamTable.rows);
  const teams = teamSummary.map((row) => ({ team_id: row.team_id, team_name: row.team }));

  await writeCsv(path.join(DATA_DIR, 'lck_matches.csv'), matchRows, [
    'match_id', 'game_id', 'tournament', 'match_name', 'match_date', 'status',
    'stage', 'patch', 'team_a_id', 'team_a', 'score_a', 'team_b_id', 'team_b',
    'score_b', 'winner_id', 'winner', 'source_url',
  ]);
  await writeCsv(path.join(DATA_DIR, 'lck_teams.csv'), teams, ['team_id', 'team_name']);
  await writeCsv(path.join(DATA_DIR, 'lck_recent_form.csv'), recentForm, [
    'team_id', 'team_name', 'played', 'wins', 'losses', 'maps_won', 'maps_lost',
    'win_rate', 'recent_5',
  ]);
  await writeCsv(path.join(DATA_DIR, 'lck_map_details.csv'), mapRows, unionColumns(mapRows));
  await writeCsv(path.join(DATA_DIR, 'lck_player_map_details.csv'), playerRows, unionColumns(playerRows));
  await writeCsv(path.join(DATA_DIR, 'lck_team_detail_summary.csv'), teamSummary, unionColumns(teamSummary));

  await writeFile(path.join(DATA_DIR, 'latest-summary.json'), JSON.stringify({
    source: 'Games of Legends public pages',
    tournament: TOURNAMENT,
    collected_at: new Date().toISOString(),
    max_matches: MAX_MATCHES || 'all',
    skipped_games: SKIP_GAMES,
    preserved_existing_game_details: SKIP_GAMES && mapRows.length > 0,
    urls,
    rows: {
      matches: matchRows.length,
      maps: mapRows.length,
      player_maps: playerRows.length,
      teams: teamSummary.length,
      gol_team_stats: teamTable.rows.length,
      gol_player_stats: playerTable.rows.length,
      gol_champion_stats: championTable.rows.length,
    },
  }, null, 2), 'utf8');

  await writeFile(path.join(DATA_DIR, 'public_sources', 'source_notes.txt'), [
    'LCK public source notes',
    '',
    `Tournament: ${TOURNAMENT}`,
    `GOL matchlist: ${urls.matchlist}`,
    `GOL team stats: ${urls.teams}`,
    `GOL player stats: ${urls.players}`,
    `GOL champion stats: ${urls.champions}`,
    '',
    'GOL team stats provide early-game and macro fields such as FB%, FT%, DRA%, HER%, GD@15, TD@15, DPM, WPM.',
    'Per-game GOL pages provide blue/red side, game time, kills, towers, dragons, barons, picks, bans, first blood and first tower.',
    'First dragon and first herald are not present on GOL game pages, so the model uses DRA% and HER% from team aggregate stats.',
  ].join('\n'), 'utf8');

  console.log(`完成。比赛 ${matchRows.length} 场，小局 ${mapRows.length} 局，队伍 ${teamSummary.length} 支。`);
  console.log(path.join(DATA_DIR, 'lck_matches.csv'));
}

main().catch((error) => {
  console.error(`LCK数据采集失败: ${error.message}`);
  process.exitCode = 1;
});
