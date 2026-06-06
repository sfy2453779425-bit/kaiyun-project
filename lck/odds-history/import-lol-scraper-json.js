import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  argValue,
  decimal,
  teamKey,
  writeCsv,
} from '../shared.js';

const DEFAULT_SOURCE_DIR = 'D:\\lol_scraper\\data';
const DEFAULT_OUT = path.join(DATA_DIR, 'odds_history', 'lol_scraper_market_lines.csv');

function hashText(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

async function latestInputFile(sourceDir) {
  const files = await readdir(sourceDir);
  const candidates = [];
  for (const file of files) {
    if (!/^lpl_lck_odds_deduped_.*\.json$/i.test(file)) continue;
    const full = path.join(sourceDir, file);
    candidates.push({ full, mtime: (await stat(full)).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error(`no lpl_lck_odds_deduped_*.json found in ${sourceDir}`);
  return candidates[0].full;
}

function splitTeams(match) {
  const rawTeams = String(match.teams || '').split(',').map((item) => item.trim()).filter(Boolean);
  return {
    teamA: rawTeams[0] || match.team_home || '',
    teamB: rawTeams[1] || match.team_away || '',
  };
}

function datePartsKst(value) {
  const date = typeof value === 'number'
    ? new Date(value * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return { match_date: '', start_time_kst: '', start_time_utc: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const matchDate = `${parts.year}-${parts.month}-${parts.day}`;
  const startTimeKst = `${matchDate} ${parts.hour}:${parts.minute}:${parts.second}`;
  return {
    match_date: matchDate,
    start_time_kst: startTimeKst,
    start_time_utc: date.toISOString(),
  };
}

function normalizeBo(value) {
  const text = String(value || '');
  const found = text.match(/\d+/)?.[0] || '';
  return found ? `BO${found}` : text;
}

function overUnderSelection(raw) {
  const text = String(raw || '').toLowerCase();
  if (/大于|大\b|over|^o\b/.test(text)) return 'over';
  if (/小于|小\b|under|^u\b/.test(text)) return 'under';
  return '';
}

function extractLine(raw, fallback = '') {
  const text = String(raw || '');
  const signed = text.match(/([+-]\d+(?:\.\d+)?)/)?.[1];
  if (signed) return signed;
  return text.match(/([+-]?\d+(?:\.\d+)?)/)?.[1] || fallback || '';
}

function resolvePandaTeamSelection(raw, teamA, teamB) {
  const text = String(raw || '').replace(/^@/, '').trim();
  if (/^T1$/i.test(text) || /^Team\s*1$/i.test(text)) return teamA;
  if (/^T2$/i.test(text) || /^Team\s*2$/i.test(text)) return teamB;
  return text;
}

function resolvePandaHandicap(raw, teamA, teamB) {
  const text = String(raw || '').replace(/^@/, '').trim();
  const selection = /T1/i.test(text) ? teamA : /T2/i.test(text) ? teamB : text.replace(/[+-]?\d+(?:\.\d+)?/, '').trim();
  const line = extractLine(text);
  return { selection, line };
}

function commonMatchFields({ capturedAt, inputFile, platformCode, platform, match }) {
  const { teamA, teamB } = splitTeams(match);
  const time = datePartsKst(platform.engine === 'panda' ? Number(match.start_time) : match.start_time);
  return {
    captured_at: capturedAt,
    import_file: path.basename(inputFile),
    source: 'lol_scraper',
    source_platform: platformCode,
    source_name: platform.name || platformCode,
    source_engine: platform.engine || platformCode.toLowerCase(),
    source_used: platform.source_used?.code || platformCode,
    league: match.league || '',
    tournament: match.tournament || '',
    match_id: String(match.match_id || ''),
    external_match_id: String(match.external_match_id || match.game_id || ''),
    match_date: time.match_date,
    start_time_kst: time.start_time_kst,
    start_time_utc: time.start_time_utc,
    match_name: `${teamA} vs ${teamB}`,
    teams_raw: match.teams || '',
    team_a: teamA,
    team_b: teamB,
    team_a_key: teamKey(teamA),
    team_b_key: teamKey(teamB),
    bo: normalizeBo(match.bo),
  };
}

function addNoVig(rows) {
  const overround = rows.reduce((sum, row) => sum + (Number(row.odds) > 0 ? 1 / Number(row.odds) : 0), 0);
  return rows.map((row) => {
    const implied = Number(row.odds) > 0 ? 1 / Number(row.odds) : '';
    return {
      ...row,
      implied_p: implied === '' ? '' : decimal(implied),
      overround: overround ? decimal(overround) : '',
      no_vig_p: implied !== '' && overround ? decimal(implied / overround) : '',
    };
  });
}

function parsePandaMarket({ base, marketId, market }) {
  const name = String(market.name || '');
  const enName = String(market.en_name || '');
  const round = Number(market.round || market.stage_id || 0);
  const period = round ? `game${round}` : 'series';
  const rawRows = [];
  const push = (selectionRaw, oddRow, parsed) => {
    const odds = Number(oddRow?.odd ?? oddRow?.org_odd);
    if (!(odds > 0)) return;
    rawRows.push({
      ...base,
      period,
      map_number: round || '',
      market: parsed.market,
      market_name: name,
      market_en_name: enName,
      market_code: '',
      market_id: marketId,
      selection: parsed.selection,
      selection_key: teamKey(parsed.selection),
      selection_raw: selectionRaw,
      line: parsed.line || '',
      odds: decimal(odds),
      return_rate: market.return_rate ?? '',
      suspended: market.suspended ?? oddRow?.suspended ?? '',
      visible: market.visible ?? oddRow?.visible ?? '',
      locked: '',
      parse_status: parsed.market === 'unknown' ? 'unknown' : 'ok',
      raw_text_hash: hashText(JSON.stringify({ base, marketId, market, selectionRaw })),
    });
  };

  for (const [selectionRaw, oddRow] of Object.entries(market.odds || {})) {
    const label = `${name} ${enName}`;
    let parsed = { market: 'unknown', selection: selectionRaw, line: '' };
    if (/单局\s*-\s*获胜|Map Winner/i.test(label)) {
      parsed = {
        market: round === 1 ? 'game1_win' : `game${round}_win`,
        selection: resolvePandaTeamSelection(selectionRaw, base.team_a, base.team_b),
        line: '',
      };
    } else if (/总比赛胜利|Series/i.test(label)) {
      parsed = { market: 'match_win', selection: resolvePandaTeamSelection(selectionRaw, base.team_a, base.team_b), line: '' };
    } else if (/击杀总数大小|Total Kills/i.test(label)) {
      parsed = { market: 'total_kills', selection: overUnderSelection(selectionRaw), line: extractLine(selectionRaw) };
    } else if (/比赛时间大小|Game Time|Duration/i.test(label)) {
      parsed = { market: 'game_time', selection: overUnderSelection(selectionRaw), line: extractLine(selectionRaw) };
    } else if (/总局数|Total Maps/i.test(label)) {
      parsed = { market: 'map_total', selection: overUnderSelection(selectionRaw), line: extractLine(selectionRaw) };
    } else if (/击杀让分|Kill Handicap/i.test(label)) {
      parsed = { market: 'team_kills_handicap', ...resolvePandaHandicap(selectionRaw, base.team_a, base.team_b) };
    } else if (/让局|Map Handicap|Maps Handicap/i.test(label)) {
      parsed = { market: 'map_handicap', ...resolvePandaHandicap(selectionRaw, base.team_a, base.team_b) };
    }
    push(selectionRaw, oddRow, parsed);
  }
  return addNoVig(rawRows);
}

function parseImdjLineFromCode(code) {
  const digits = String(code || '').match(/-(\d+)$/)?.[1] || '';
  if (!digits) return '';
  if (digits.length === 2) return `${digits[0]}.${digits[1]}`;
  return String(Number(digits) / 10);
}

function parseImdjMarket({ base, marketId, market }) {
  const code = String(market.code || '');
  const name = String(market.name || '');
  const order = Number(market.game_order || 0);
  const period = order ? `game${order}` : 'series';
  const rawRows = [];
  const push = (selectionRaw, oddRow, parsed) => {
    const odds = Number(oddRow?.odd);
    if (!(odds > 0)) return;
    rawRows.push({
      ...base,
      period,
      map_number: order || '',
      market: parsed.market,
      market_name: name,
      market_en_name: '',
      market_code: code,
      market_id: marketId,
      selection: parsed.selection,
      selection_key: teamKey(parsed.selection),
      selection_raw: selectionRaw,
      line: parsed.line || '',
      odds: decimal(odds),
      return_rate: '',
      suspended: market.status === 1 ? 0 : 1,
      visible: '',
      locked: oddRow?.locked ?? '',
      parse_status: parsed.market === 'unknown' ? 'unknown' : 'ok',
      raw_text_hash: hashText(JSON.stringify({ base, marketId, market, selectionRaw })),
    });
  };

  const lineFromCode = parseImdjLineFromCode(code);
  for (const [selectionRaw, oddRow] of Object.entries(market.odds || {})) {
    let parsed = { market: 'unknown', selection: selectionRaw, line: '' };
    if (code === 'SeriesWin') {
      parsed = { market: 'match_win', selection: selectionRaw, line: '' };
    } else if (code === 'GameWin') {
      parsed = { market: order === 1 ? 'game1_win' : `game${order}_win`, selection: selectionRaw, line: '' };
    } else if (/^TotalMap-/i.test(code)) {
      parsed = { market: 'map_total', selection: overUnderSelection(selectionRaw), line: lineFromCode };
    } else if (/^WinHandicapA-/i.test(code)) {
      const isTeamA = teamKey(selectionRaw) === teamKey(base.team_a);
      parsed = { market: 'map_handicap', selection: selectionRaw, line: `${isTeamA ? '-' : '+'}${lineFromCode}` };
    } else if (/^WinHandicapB-/i.test(code)) {
      const isTeamB = teamKey(selectionRaw) === teamKey(base.team_b);
      parsed = { market: 'map_handicap', selection: selectionRaw, line: `${isTeamB ? '-' : '+'}${lineFromCode}` };
    }
    push(selectionRaw, oddRow, parsed);
  }
  return addNoVig(rawRows);
}

async function main() {
  const sourceDir = argValue('source-dir', DEFAULT_SOURCE_DIR);
  const inputFile = path.resolve(argValue('file') || await latestInputFile(sourceDir));
  const outPath = path.resolve(argValue('out', DEFAULT_OUT));
  const league = argValue('league', 'LCK');
  const data = JSON.parse(await readFile(inputFile, 'utf8'));
  const capturedAt = data.scraped_at || '';
  const rows = [];

  for (const [platformCode, platform] of Object.entries(data.platforms || {})) {
    for (const [matchId, item] of Object.entries(platform.matches || {})) {
      const match = item.match || {};
      if (String(match.league || '').toUpperCase() !== league.toUpperCase()) continue;
      const base = commonMatchFields({
        capturedAt,
        inputFile,
        platformCode,
        platform,
        match: { ...match, match_id: match.match_id || matchId },
      });
      for (const [marketId, market] of Object.entries(item.markets || {})) {
        const parsedRows = platform.engine === 'panda'
          ? parsePandaMarket({ base, marketId, market })
          : parseImdjMarket({ base, marketId, market });
        rows.push(...parsedRows);
      }
    }
  }

  rows.sort((a, b) => [
    String(a.match_date).localeCompare(String(b.match_date)),
    String(a.source_platform).localeCompare(String(b.source_platform)),
    String(a.match_name).localeCompare(String(b.match_name)),
    String(a.market).localeCompare(String(b.market)),
    String(a.line).localeCompare(String(b.line)),
    String(a.selection).localeCompare(String(b.selection)),
  ].find((value) => value !== 0) || 0);

  const columns = [
    'captured_at', 'import_file', 'source', 'source_platform', 'source_name', 'source_engine', 'source_used',
    'league', 'tournament', 'match_id', 'external_match_id', 'match_date', 'start_time_kst', 'start_time_utc',
    'match_name', 'teams_raw', 'team_a', 'team_b', 'team_a_key', 'team_b_key', 'bo',
    'period', 'map_number', 'market', 'market_name', 'market_en_name', 'market_code', 'market_id',
    'selection', 'selection_key', 'selection_raw', 'line', 'odds', 'implied_p', 'no_vig_p', 'overround',
    'return_rate', 'suspended', 'visible', 'locked', 'parse_status', 'raw_text_hash',
  ];
  await writeCsv(outPath, rows, columns);

  const counts = rows.reduce((acc, row) => {
    const key = `${row.source_platform}/${row.market}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log(`import_file=${inputFile}`);
  console.log(`out=${outPath}`);
  console.log(`league=${league} rows=${rows.length}`);
  for (const [key, count] of Object.entries(counts).sort()) console.log(`${key}=${count}`);
}

main().catch((error) => {
  console.error(`import-lol-scraper-json failed: ${error.message}`);
  process.exitCode = 1;
});
