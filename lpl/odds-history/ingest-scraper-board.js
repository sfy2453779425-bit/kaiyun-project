// Read D:/lol_scraper odds JSON and build a normalized LPL best-odds board.
// PANDA and IMDJ are treated as separate books; the same bet always keeps the higher odds.
import fs from 'node:fs';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  argValue,
  decimal,
  teamKey,
  writeCsv,
} from '../shared.js';

const SCRAPER_DIR = argValue('dir', 'D:/lol_scraper/data');
const BOARD_OUT = path.join(DATA_DIR, 'odds_history', 'scraper_board.csv');
const ANALYSIS_OUT = path.join(ANALYSIS_DIR, '小站盘口比价板.csv');

const TEAM_ALIASES = {
  anyoneslegend: 'AL',
  al: 'AL',
  teamwe: 'WE',
  西安we: 'WE',
  we: 'WE',
  thundertalkgaming: 'TT',
  thunderTalkgaming: 'TT',
  tt: 'TT',
  ttg: 'TT',
  lgdgaming: 'LGD',
  lgd: 'LGD',
  edwardgaming: 'EDG',
  edg: 'EDG',
  bilibiligaming: 'BLG',
  blg: 'BLG',
  blg星纪魅族: 'BLG',
  jdgaming: 'JDG',
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
  lng: 'LNG',
  ultraprime: 'UP',
  up: 'UP',
};

const BOARD_COLUMNS = [
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

function compactTeamName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s|\.|-/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normTeam(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const compact = compactTeamName(raw);
  if (TEAM_ALIASES[compact]) return TEAM_ALIASES[compact];
  const key = teamKey(raw);
  return key || raw.toUpperCase();
}

function utcDate(start) {
  let ms;
  if (typeof start === 'number') ms = start * 1000;
  else ms = Date.parse(String(start));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function findLatestScraperFile() {
  const candidates = fs
    .readdirSync(SCRAPER_DIR)
    .filter((file) => /^lpl_lck_odds_deduped_.*\.json$/i.test(file))
    .sort();
  if (!candidates.length) {
    throw new Error(`${SCRAPER_DIR} 下没有 lpl_lck_odds_deduped_*.json`);
  }
  return path.join(SCRAPER_DIR, candidates.at(-1));
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

function normalizeLine(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n > 0 ? `+${n}` : String(n);
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
  return platform.code || platform.engine?.toUpperCase() || platform.name || '?';
}

function parseMatch(match, markets, platform) {
  if (match.league && match.league !== 'LPL') return [];
  const { homeKey, awayKey } = parseTeams(match);
  if (!homeKey || !awayKey) return [];

  const date = utcDate(match.start_time);
  const matchKey = `${date}|${[homeKey, awayKey].sort().join('-')}`;
  const bo = String(match.bo || '').replace(/\D/g, '') || '';
  const base = {
    matchKey,
    match_date: date,
    league: match.league || 'LPL',
    match_name: [homeKey, awayKey].sort().join(' vs '),
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
          selection: /大于|>/.test(selection) ? 'over' : 'under',
          line: firstNumber(selection),
          odds,
        });
      }
    } else if (name === '击杀让分') {
      for (const [selection, odds] of entries) {
        const teamToken = selection.match(/@T[12]/)?.[0] || selection.match(/^(.+?)\s*[+-]/)?.[1] || '';
        const line = firstNumber(selection.replace(/@T[12]/g, ''));
        if (line == null) continue;
        rows.push({
          ...base,
          market: `team_kills_handicap${gameSuffix}`,
          selection: teamOf(teamToken),
          line: normalizeLine(line),
          odds,
        });
      }
    } else if (name === '比赛时间大小') {
      for (const [selection, odds] of entries) {
        rows.push({
          ...base,
          market: `game_time${gameSuffix}`,
          selection: /大于|>/.test(selection) ? 'over' : 'under',
          line: firstNumber(selection),
          odds,
        });
      }
    } else if (name === '单局-获胜' || name === '第一局胜利' || name === '第局胜利') {
      for (const [selection, odds] of entries) {
        rows.push({ ...base, market: 'game1_win', selection: teamOf(selection), line: '', odds });
      }
    } else if (/总比赛胜利|总比分胜利|总比賽勝利|SeriesWin/.test(nameRaw) || market.code === 'SeriesWin') {
      for (const [selection, odds] of entries) {
        rows.push({ ...base, market: 'match_win', selection: teamOf(selection), line: '', odds });
      }
    } else if (/让1\.5局/.test(name) || /^WinHandicap[AB]-15$/.test(String(market.code || ''))) {
      const giver = String(market.code || '').includes('B-15')
        ? awayKey
        : String(market.code || '').includes('A-15')
          ? homeKey
          : (() => {
            const explicit = nameRaw.match(/[:：]\s*(.+?)\s*让/)?.[1] || '';
            if (/TeamB/i.test(explicit)) return awayKey;
            if (/TeamA/i.test(explicit)) return homeKey;
            return normTeam(explicit);
          })();
      for (const [selection, odds] of entries) {
        const selectedTeam = teamOf(selection);
        rows.push({
          ...base,
          market: 'map_handicap',
          selection: selectedTeam,
          line: selectedTeam === giver ? '-1.5' : '+1.5',
          odds,
        });
      }
    } else if (/总局数/.test(name) || /^TotalMap-\d+$/.test(String(market.code || ''))) {
      const nameLine = String(nameRaw).match(/总局数\s*([0-9]+(?:\.[0-9]+)?)/)?.[1];
      const codeLine = String(market.code || '').match(/^TotalMap-(\d+)$/)?.[1];
      const line = nameLine != null
        ? Number(nameLine)
        : codeLine != null
          ? Number(codeLine) / 10
          : firstNumber(nameRaw);
      for (const [selection, odds] of entries) {
        rows.push({
          ...base,
          market: 'map_total',
          selection: /大于|>/.test(selection) ? 'over' : 'under',
          line,
          odds,
        });
      }
    }
  }

  return rows;
}

function buildBestOddsRows(rawRows, sourceFile, capturedAt) {
  const groups = new Map();
  for (const row of rawRows) {
    const key = [row.matchKey, row.market, row.selection, row.line ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, line: row.line ?? '' });
  }

  const out = [];
  for (const groupRows of groups.values()) {
    const platformOdds = {};
    for (const row of groupRows) {
      platformOdds[row.platform] = Math.max(platformOdds[row.platform] || 0, row.odds);
    }

    const best = groupRows.reduce((currentBest, row) => (row.odds > currentBest.odds ? row : currentBest));
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

async function main() {
  const file = argValue('file', '') || findLatestScraperFile();
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawRows = [];

  for (const platform of Object.values(json.platforms || {})) {
    for (const match of Object.values(platform.matches || {})) {
      rawRows.push(...parseMatch(match.match, match.markets, platform));
    }
  }

  const rows = buildBestOddsRows(rawRows, file, json.scraped_at || new Date().toISOString());
  await writeCsv(BOARD_OUT, rows, BOARD_COLUMNS);
  await writeCsv(ANALYSIS_OUT, rows, BOARD_COLUMNS);

  const shopRows = rows.filter((row) => row.shopping_edge);
  console.log(`读取盘口板: ${file}`);
  console.log(`解析出 ${rawRows.length} 条 LPL 原始盘口行`);
  console.log(`写入 ${BOARD_OUT}: ${rows.length} 个统一盘口`);
  console.log(`同步 ${ANALYSIS_OUT}`);
  console.log(`两平台同盘口可比价: ${shopRows.length} 个`);

  if (shopRows.length) {
    console.log('\n=== best-odds 比价机会 ===');
    for (const row of shopRows.slice(0, 20)) {
      console.log(`${row.match_name} | ${row.market} ${row.selection} ${row.line} | PANDA ${row.panda_odds || '-'} vs IMDJ ${row.imdj_odds || '-'} -> ${row.best_platform} ${row.best_odds}`);
    }
  }
}

main().catch((error) => {
  console.error(`ingest scraper board failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
