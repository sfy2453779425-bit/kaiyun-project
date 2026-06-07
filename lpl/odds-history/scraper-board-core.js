import fs from 'node:fs';
import path from 'node:path';
import { decimal, teamKey } from '../shared.js';

export const DEFAULT_SCRAPER_DIR = 'D:/lol_scraper/data';

export const BOARD_COLUMNS = [
  'match_date',
  'league',
  'match_name',
  'bo',
  'market',
  'selection',
  'line',
  'best_odds',
  'best_platform',
  'panda_odds',
  'imdj_odds',
  'platforms',
  'shopping_edge',
  'shopping_edge_pct',
  'captured_at',
  'source_file',
];

export const RAW_COLUMNS = [
  'match_date',
  'league',
  'match_name',
  'bo',
  'market',
  'selection',
  'line',
  'odds',
  'platform',
  'captured_at',
  'source_file',
];

const TEAM_ALIASES = {
  anyoneslegend: 'AL',
  al: 'AL',
  teamwe: 'WE',
  xianwe: 'WE',
  xi_anwe: 'WE',
  西安we: 'WE',
  we: 'WE',
  thundertalkgaming: 'TT',
  tt: 'TT',
  ttg: 'TT',
  lgdgaming: 'LGD',
  lgd: 'LGD',
  edwardgaming: 'EDG',
  edg: 'EDG',
  bilibiligaming: 'BLG',
  blg: 'BLG',
  jdgaming: 'JDG',
  jd: 'JDG',
  jdg: 'JDG',
  京东: 'JDG',
  invictusgaming: 'IG',
  ig: 'IG',
  topesports: 'TES',
  tes: 'TES',
  滔搏: 'TES',
  weibogaming: 'WBG',
  wbg: 'WBG',
  微博: 'WBG',
  funplusphoenix: 'FPX',
  fpx: 'FPX',
  royalnevergiveup: 'RNG',
  rng: 'RNG',
  ohmygod: 'OMG',
  omg: 'OMG',
  ninjasinpyjamas: 'NIP',
  nip: 'NIP',
  rareatom: 'RA',
  ra: 'RA',
  lnggaming: 'LNG',
  suzhoulng: 'LNG',
  苏州lng: 'LNG',
  lng: 'LNG',
  ultraprime: 'UP',
  up: 'UP',
};

function compactTeamName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s|\.|-/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function normTeam(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const compact = compactTeamName(raw);
  if (TEAM_ALIASES[compact]) return TEAM_ALIASES[compact];
  const key = teamKey(raw);
  return key || raw.toUpperCase();
}

export function canonicalMatchName(home, away) {
  const teams = [normTeam(home), normTeam(away)].filter(Boolean).sort();
  return teams.length === 2 ? `${teams[0]} vs ${teams[1]}` : teams.join(' vs ');
}

export function normalizeLine(value, market = '') {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (/handicap/i.test(market)) return n > 0 ? `+${n}` : String(n);
  return String(n);
}

export function findLatestScraperFile(scraperDir = DEFAULT_SCRAPER_DIR) {
  const candidates = fs
    .readdirSync(scraperDir)
    .filter((file) => /^lpl_lck_odds_deduped_.*\.json$/i.test(file))
    .sort();
  if (!candidates.length) throw new Error(`${scraperDir} 下没有 lpl_lck_odds_deduped_*.json`);
  return path.join(scraperDir, candidates.at(-1));
}

function utcDate(start) {
  let ms;
  if (typeof start === 'number') ms = start * 1000;
  else ms = Date.parse(String(start));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function stripSpace(value) {
  return String(value || '').replace(/\s/g, '');
}

function firstNumber(value) {
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function oddOf(value) {
  const odds = Number(value?.odd != null ? value.odd : value);
  return Number.isFinite(odds) && odds > 1 ? odds : null;
}

function parseTeams(match) {
  const teams = String(match.teams_en || match.teams || '').split(',');
  const home = String(match.team_home || teams[0] || '').trim();
  const away = String(match.team_away || teams[1] || '').trim();
  return {
    home,
    away,
    homeKey: normTeam(home),
    awayKey: normTeam(away),
  };
}

function platformCode(platform) {
  return String(platform.code || platform.engine?.toUpperCase() || platform.name || '?').toUpperCase();
}

function selectionIsOver(selection) {
  return /大于|>|over/i.test(String(selection));
}

function mapTotalLine(nameRaw, market) {
  const nameLine = String(nameRaw).match(/总局数\s*([0-9]+(?:\.[0-9]+)?)/)?.[1];
  const codeLine = String(market.code || '').match(/^TotalMap-(\d+)$/)?.[1];
  if (nameLine != null) return Number(nameLine);
  if (codeLine != null) return Number(codeLine) / 10;
  return firstNumber(nameRaw);
}

function pushRowsForEntries(rows, base, entries, market, line, selectionFn) {
  for (const [selection, odds] of entries) {
    rows.push({
      ...base,
      market,
      selection: selectionFn(selection),
      line: normalizeLine(line, market),
      odds,
    });
  }
}

export function parseMatch(match, markets, platform) {
  if (match.league && match.league !== 'LPL') return [];
  const { homeKey, awayKey } = parseTeams(match);
  if (!homeKey || !awayKey) return [];

  const date = utcDate(match.start_time);
  const matchName = canonicalMatchName(homeKey, awayKey);
  const bo = String(match.bo || '').replace(/\D/g, '') || '';
  const base = {
    match_key: `${date}|${[homeKey, awayKey].sort().join('-')}`,
    match_date: date,
    league: match.league || 'LPL',
    match_name: matchName,
    bo,
    platform: platformCode(platform),
  };
  const rows = [];

  const teamOf = (selectionKey) => {
    if (selectionKey === '@T1') return homeKey;
    if (selectionKey === '@T2') return awayKey;
    return normTeam(selectionKey);
  };

  for (const market of Object.values(markets || {})) {
    if (market.visible === 0 || market.suspended === 1 || market.status === 0) continue;
    const nameRaw = market.name || market.code || '';
    const name = stripSpace(nameRaw);
    if (!name || name.includes('+') || /单双/.test(name)) continue;

    const round = Number(market.round || market.game_order || 0);
    const gameSuffix = round > 1 ? `_g${round}` : '';
    const entries = Object.entries(market.odds || {})
      .map(([selection, odds]) => [selection, oddOf(odds)])
      .filter(([, odds]) => odds != null);

    if (name === '击杀总数大小') {
      for (const [selection, odds] of entries) {
        rows.push({
          ...base,
          market: `total_kills${gameSuffix}`,
          selection: selectionIsOver(selection) ? 'over' : 'under',
          line: normalizeLine(firstNumber(selection), 'total_kills'),
          odds,
        });
      }
    } else if (name === '击杀让分') {
      for (const [selection, odds] of entries) {
        const teamToken = String(selection).match(/@T[12]/)?.[0] || String(selection).match(/^(.+?)\s*[+-]/)?.[1] || '';
        const line = firstNumber(String(selection).replace(/@T[12]/g, ''));
        if (line == null) continue;
        rows.push({
          ...base,
          market: `team_kills_handicap${gameSuffix}`,
          selection: teamOf(teamToken),
          line: normalizeLine(line, 'team_kills_handicap'),
          odds,
        });
      }
    } else if (name === '比赛时间大小') {
      for (const [selection, odds] of entries) {
        rows.push({
          ...base,
          market: `game_time${gameSuffix}`,
          selection: selectionIsOver(selection) ? 'over' : 'under',
          line: normalizeLine(firstNumber(selection), 'game_time'),
          odds,
        });
      }
    } else if (name === '单局-获胜' || name === '第一局胜利' || market.code === 'GameWin') {
      pushRowsForEntries(rows, base, entries, 'game1_win', '', teamOf);
    } else if (/总比赛胜利|总比分胜利|SeriesWin/i.test(nameRaw) || market.code === 'SeriesWin') {
      pushRowsForEntries(rows, base, entries, 'match_win', '', teamOf);
    } else if (/让\s*[12]\.5\s*局/.test(nameRaw) || /^WinHandicap[AB]-(15|25)$/.test(String(market.code || ''))) {
      const code = String(market.code || '');
      const lineValue = code.includes('-25') ? 2.5 : 1.5;
      const giver = code.includes('B-') ? awayKey : code.includes('A-') ? homeKey : '';
      for (const [selection, odds] of entries) {
        const selectedTeam = teamOf(selection);
        rows.push({
          ...base,
          market: 'map_handicap',
          selection: selectedTeam,
          line: normalizeLine(selectedTeam === giver ? -lineValue : lineValue, 'map_handicap'),
          odds,
        });
      }
    } else if (/总局数/.test(nameRaw) || /^TotalMap-\d+$/.test(String(market.code || ''))) {
      const line = mapTotalLine(nameRaw, market);
      for (const [selection, odds] of entries) {
        rows.push({
          ...base,
          market: 'map_total',
          selection: selectionIsOver(selection) ? 'over' : 'under',
          line: normalizeLine(line, 'map_total'),
          odds,
        });
      }
    }
  }

  return rows;
}

export function parseScraperJson(json, sourceFile = '') {
  const rawRows = [];
  for (const platform of Object.values(json.platforms || {})) {
    for (const match of Object.values(platform.matches || {})) {
      rawRows.push(...parseMatch(match.match, match.markets, platform));
    }
  }
  const capturedAt = json.scraped_at || new Date().toISOString();
  const normalizedRawRows = rawRows.map((row) => ({
    ...row,
    line: row.line ?? '',
    odds: Number(row.odds),
    captured_at: capturedAt,
    source_file: sourceFile,
  }));
  return {
    rawRows: normalizedRawRows,
    rows: buildBestOddsRows(normalizedRawRows, sourceFile, capturedAt),
    capturedAt,
  };
}

export function readScraperBoard({ file = '', dir = DEFAULT_SCRAPER_DIR } = {}) {
  const selectedFile = file || findLatestScraperFile(dir);
  const json = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
  return {
    file: selectedFile,
    ...parseScraperJson(json, selectedFile),
  };
}

export function buildBestOddsRows(rawRows, sourceFile, capturedAt) {
  const groups = new Map();
  for (const row of rawRows) {
    const key = [row.match_key, row.market, row.selection, row.line ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, line: row.line ?? '' });
  }

  const out = [];
  for (const groupRows of groups.values()) {
    const platformOdds = {};
    for (const row of groupRows) {
      platformOdds[row.platform] = Math.max(platformOdds[row.platform] || 0, Number(row.odds));
    }

    const best = groupRows.reduce((currentBest, row) => (Number(row.odds) > Number(currentBest.odds) ? row : currentBest));
    const platforms = Object.keys(platformOdds).sort();
    const oddsValues = Object.values(platformOdds);
    const minOdds = Math.min(...oddsValues);
    const maxOdds = Math.max(...oddsValues);
    const shoppingEdge = platforms.length >= 2 && maxOdds - minOdds > 0.001 ? maxOdds - minOdds : 0;
    const shoppingEdgePct = shoppingEdge > 0 ? (maxOdds / minOdds) - 1 : 0;

    out.push({
      match_date: best.match_date,
      league: best.league,
      match_name: best.match_name,
      bo: best.bo,
      market: best.market,
      selection: best.selection,
      line: best.line,
      best_odds: decimal(best.odds, 3),
      best_platform: best.platform,
      panda_odds: platformOdds.PANDA ? decimal(platformOdds.PANDA, 3) : '',
      imdj_odds: platformOdds.IMDJ ? decimal(platformOdds.IMDJ, 3) : '',
      platforms: platforms.join('+'),
      shopping_edge: shoppingEdge ? decimal(shoppingEdge, 3) : '',
      shopping_edge_pct: shoppingEdgePct ? decimal(shoppingEdgePct, 4) : '',
      captured_at: capturedAt,
      source_file: sourceFile,
    });
  }

  return out.sort((a, b) => (
    String(a.match_date).localeCompare(String(b.match_date))
    || String(a.match_name).localeCompare(String(b.match_name))
    || String(a.market).localeCompare(String(b.market))
    || String(a.line).localeCompare(String(b.line))
    || String(a.selection).localeCompare(String(b.selection))
  ));
}
