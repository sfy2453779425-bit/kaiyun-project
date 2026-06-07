import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  argValue,
  decimal,
  hasFlag,
  writeCsv,
} from '../shared.js';
import {
  BOARD_COLUMNS,
  RAW_COLUMNS,
  canonicalMatchName,
  normTeam,
  normalizeLine,
  readScraperBoard,
} from './scraper-board-core.js';
import {
  addNoVigProbabilities,
  initDb,
  insertSnapshot,
  openDb,
} from './db-init.js';
import {
  fetchEventOdds,
  fetchHtml,
  parseEventHeader,
} from './op-utils.js';

const ODDS_HISTORY_DIR = path.join(DATA_DIR, 'odds_history');
const SCRAPER_BOARD_CSV = path.join(ODDS_HISTORY_DIR, 'scraper_board.csv');
const RAW_SMALL_CSV = path.join(ODDS_HISTORY_DIR, 'scraper_raw_platform_odds.csv');
const RADAR_CSV = path.join(ODDS_HISTORY_DIR, 'price_radar.csv');
const ALERT_LOG = path.join(ODDS_HISTORY_DIR, 'alerts.log');
const ANALYSIS_BOARD_CSV = path.join(ANALYSIS_DIR, '小站盘口比价板.csv');
const REPORT_MD = path.join(ANALYSIS_DIR, '今日大站小站价差雷达.md');
const DEFAULT_WATCHLIST = path.join('lpl', 'odds-history', 'watchlist.json');
const DEFAULT_THRESHOLD = 1.08;

const SUPPORTED_MARKETS = new Set([
  'match_win',
  'game1_win',
  'map_handicap',
  'map_total',
  'team_kills_handicap',
  'total_kills',
  'game_time',
]);

const RADAR_COLUMNS = [
  'match_date',
  'match_name',
  'market',
  'selection',
  'line',
  'best_odds',
  'best_platform',
  'panda_odds',
  'imdj_odds',
  'op_fair_odds',
  'op_no_vig_p',
  'price_ratio',
  'price_diff_pct',
  'status',
  'alert',
  'captured_at',
  'source_file',
];

function pct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function dateText(value) {
  return String(value || '').slice(0, 10);
}

function radarKey(row) {
  return [
    row.match_date || '',
    row.match_name || '',
    row.market || '',
    row.selection || '',
    normalizeLine(row.line, row.market || ''),
  ].join('|');
}

function markdownTable(rows, columns) {
  if (!rows.length) return '_none_';
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => String(row[col] ?? '')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

async function readWatchlist(watchlistPath) {
  if (!existsSync(watchlistPath)) return { events: [], warning: `watchlist_missing: ${watchlistPath}` };
  const parsed = JSON.parse(await readFile(watchlistPath, 'utf8'));
  const events = Array.isArray(parsed) ? parsed : parsed.events || [];
  return {
    events: events
      .map((item) => (typeof item === 'string' ? { event_url: item } : item))
      .filter((item) => item.event_url),
    warning: '',
  };
}

function canonicalSelection(row, event) {
  if (row.selection === 'home') return normTeam(event.home);
  if (row.selection === 'away') return normTeam(event.away);
  if (row.selection === 'over' || row.selection === 'under') return row.selection;
  return normTeam(row.selection);
}

function opRowsWithNoVig(event, oddsRows) {
  const matchDate = dateText(event.match_start_ts);
  const matchName = canonicalMatchName(event.home, event.away);
  const normalized = oddsRows
    .filter((row) => SUPPORTED_MARKETS.has(row.market))
    .map((row) => ({
      market: row.market,
      selection: canonicalSelection(row, event),
      line: normalizeLine(row.line, row.market),
      odds: Number(row.odds),
    }))
    .filter((row) => Number.isFinite(row.odds) && row.odds > 1);

  return addNoVigProbabilities(normalized).map((row) => ({
    ...row,
    source: 'oddsportal',
    match_date: matchDate,
    match_name: matchName,
    fair_odds: row.no_vig_p ? 1 / Number(row.no_vig_p) : null,
  }));
}

async function collectOddsPortal({ events, dryRun, db }) {
  const rows = [];
  const warnings = [];
  const inserted = [];

  for (const item of events) {
    try {
      const html = await fetchHtml(item.event_url);
      const event = parseEventHeader(html);
      const odds = await fetchEventOdds(event, item.event_url);
      const marketRows = opRowsWithNoVig(event, odds.rows);
      rows.push(...marketRows);

      if (!dryRun && marketRows.length) {
        const result = insertSnapshot({
          source: 'oddsportal',
          ts: new Date().toISOString(),
          match_id: event.event_id || null,
          match_name: canonicalMatchName(event.home, event.away),
          match_start_ts: event.match_start_ts,
          raw_blob: JSON.stringify({ event: event.raw, odds: odds.raw }),
          markets: marketRows.map((row) => ({
            market: row.market,
            selection: row.selection,
            line: row.line,
            odds: row.odds,
          })),
        }, db);
        inserted.push({ source: 'oddsportal', match_name: canonicalMatchName(event.home, event.away), ...result });
      }
    } catch (error) {
      warnings.push(`oddsportal_failed: ${item.match_name || item.event_url}: ${error.message}`);
    }
  }

  return { rows, warnings, inserted };
}

const SOURCE_ADAPTERS = {
  oddsportal: {
    collect: collectOddsPortal,
  },
};

function groupSmallRowsForDb(rawRows) {
  const groups = new Map();
  for (const row of rawRows) {
    const key = [row.platform, row.match_name, row.captured_at].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function insertSmallSnapshots(rawRows, db) {
  const inserted = [];
  for (const group of groupSmallRowsForDb(rawRows)) {
    const first = group[0];
    const result = insertSnapshot({
      source: first.platform,
      ts: first.captured_at || new Date().toISOString(),
      match_id: first.match_key || null,
      match_name: first.match_name,
      match_start_ts: null,
      raw_blob: JSON.stringify({
        source_file: first.source_file,
        platform: first.platform,
        rows: group,
      }),
      markets: group.map((row) => ({
        market: row.market,
        selection: row.selection,
        line: row.line,
        odds: row.odds,
      })),
    }, db);
    inserted.push({ source: first.platform, match_name: first.match_name, ...result });
  }
  return inserted;
}

function buildOpIndex(opRows) {
  const index = new Map();
  for (const row of opRows) {
    const key = radarKey(row);
    if (!index.has(key)) index.set(key, row);
    const existing = index.get(key);
    if (!existing.no_vig_p && row.no_vig_p) index.set(key, row);
  }
  return index;
}

function buildRadarRows(bestRows, opRows, threshold) {
  const opIndex = buildOpIndex(opRows);
  return bestRows
    .filter((row) => SUPPORTED_MARKETS.has(row.market))
    .map((row) => {
      const op = opIndex.get(radarKey(row));
      let status = 'no_big_market';
      let ratio = null;
      let fairOdds = null;
      let noVigP = null;
      if (op) {
        noVigP = Number(op.no_vig_p);
        fairOdds = Number(op.fair_odds);
        if (!Number.isFinite(noVigP) || !Number.isFinite(fairOdds) || fairOdds <= 1) {
          status = 'no_no_vig_pair';
        } else {
          ratio = Number(row.best_odds) / fairOdds;
          status = ratio >= threshold ? 'alert' : 'no_edge';
        }
      }
      return {
        match_date: row.match_date,
        match_name: row.match_name,
        market: row.market,
        selection: row.selection,
        line: normalizeLine(row.line, row.market),
        best_odds: row.best_odds,
        best_platform: row.best_platform,
        panda_odds: row.panda_odds,
        imdj_odds: row.imdj_odds,
        op_fair_odds: Number.isFinite(fairOdds) ? decimal(fairOdds, 3) : '',
        op_no_vig_p: Number.isFinite(noVigP) ? decimal(noVigP, 4) : '',
        price_ratio: Number.isFinite(ratio) ? decimal(ratio, 4) : '',
        price_diff_pct: Number.isFinite(ratio) ? decimal(ratio - 1, 4) : '',
        status,
        alert: status === 'alert' ? 'yes' : 'no',
        captured_at: row.captured_at,
        source_file: row.source_file,
      };
    });
}

function alertLine(row) {
  const timeText = String(row.captured_at || new Date().toISOString()).replace('T', ' ').slice(0, 16);
  return `[${timeText}] ${row.match_name} | ${row.market} ${row.selection}${row.line ? ` ${row.line}` : ''} | ${row.best_platform} ${Number(row.best_odds).toFixed(3)} vs OP fair ${Number(row.op_fair_odds).toFixed(3)} | +${pct(Number(row.price_diff_pct))} 价差 | OP no_vig_p ${pct(Number(row.op_no_vig_p))}`;
}

function summarizeStatuses(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([status, count]) => ({ status, count }));
}

function reportMarkdown({ file, threshold, dryRun, smallRawRows, bestRows, opRows, radarRows, alerts, warnings, inserted }) {
  return [
    '# LPL big-market vs small-site price radar',
    '',
    '## 大白话结论',
    '',
    alerts.length
      ? `- 找到 ${alerts.length} 条小站赔率高过 OP fair odds 阈值的价差机会。`
      : '- 这次没有找到达到阈值的正式价差 alert。',
    `- 阈值：小站赔率 / OP fair odds >= ${threshold.toFixed(3)}。`,
    `- dry_run=${dryRun ? 'true' : 'false'}；小站原始行 ${smallRawRows.length}，best-odds 行 ${bestRows.length}，OP 行 ${opRows.length}。`,
    warnings.length ? `- 注意：${warnings.join('；')}` : '- OP watchlist 和解析未报告阻塞错误。',
    '',
    '## Alerts / 正式价差',
    '',
    markdownTable(alerts.slice(0, 50), [
      'match_date',
      'match_name',
      'market',
      'selection',
      'line',
      'best_platform',
      'best_odds',
      'op_fair_odds',
      'price_diff_pct',
      'op_no_vig_p',
    ]),
    '',
    '## Status summary / 状态统计',
    '',
    markdownTable(summarizeStatuses(radarRows), ['status', 'count']),
    '',
    '## DB inserts / 入库记录',
    '',
    markdownTable(inserted.slice(0, 80), ['source', 'match_name', 'snapshotId', 'oddsRows']),
    '',
    '## Files / 输出文件',
    '',
    `- small board: ${SCRAPER_BOARD_CSV}`,
    `- raw small odds: ${RAW_SMALL_CSV}`,
    `- radar csv: ${RADAR_CSV}`,
    `- alert log: ${ALERT_LOG}`,
    `- source file: ${file}`,
    '',
  ].join('\n');
}

async function main() {
  const threshold = Number(argValue('threshold', String(DEFAULT_THRESHOLD)));
  const dryRun = hasFlag('dry-run');
  const watchlistPath = argValue('watchlist', DEFAULT_WATCHLIST);
  const scraper = readScraperBoard({
    file: argValue('file', ''),
    dir: argValue('dir', 'D:/lol_scraper/data'),
  });

  await mkdir(ODDS_HISTORY_DIR, { recursive: true });
  await writeCsv(SCRAPER_BOARD_CSV, scraper.rows, BOARD_COLUMNS);
  await writeCsv(ANALYSIS_BOARD_CSV, scraper.rows, BOARD_COLUMNS);
  await writeCsv(RAW_SMALL_CSV, scraper.rawRows, RAW_COLUMNS);

  const db = dryRun ? null : initDb(openDb());
  const inserted = [];
  if (!dryRun) inserted.push(...insertSmallSnapshots(scraper.rawRows, db));

  const warnings = [];
  const { events, warning } = await readWatchlist(watchlistPath);
  if (warning) warnings.push(warning);

  const opResult = await SOURCE_ADAPTERS.oddsportal.collect({ events, dryRun, db });
  warnings.push(...opResult.warnings);
  inserted.push(...opResult.inserted);

  const radarRows = buildRadarRows(scraper.rows, opResult.rows, Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD);
  const alerts = radarRows.filter((row) => row.status === 'alert');
  await writeCsv(RADAR_CSV, radarRows, RADAR_COLUMNS);
  await writeFile(REPORT_MD, reportMarkdown({
    file: scraper.file,
    threshold: Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD,
    dryRun,
    smallRawRows: scraper.rawRows,
    bestRows: scraper.rows,
    opRows: opResult.rows,
    radarRows,
    alerts,
    warnings,
    inserted,
  }), 'utf8');

  if (!dryRun && alerts.length) {
    await appendFile(ALERT_LOG, `${alerts.map(alertLine).join('\n')}\n`, 'utf8');
  }

  if (db) db.close();

  console.log(`small_raw_rows=${scraper.rawRows.length}`);
  console.log(`best_odds_rows=${scraper.rows.length}`);
  console.log(`op_rows=${opResult.rows.length}`);
  console.log(`radar_rows=${radarRows.length}`);
  console.log(`alerts=${alerts.length}`);
  console.log(`dry_run=${dryRun}`);
  console.log(`report=${REPORT_MD}`);
  for (const row of alerts.slice(0, 20)) console.log(alertLine(row));
}

main().catch((error) => {
  console.error(`market-price-radar failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
