import { webcrypto } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  DATA_DIR,
  argValue,
  clamp,
  decimal,
  fetchText,
  num,
  readCsv,
  teamKey,
  writeCsv,
} from './shared.js';

const ODDS_KEY = 'J*8sQ!p$7aD_fR2yW@gHn*3bVp#sAdLd_k';
const ODDS_SALT = '5b9a8f2c3e6d1a4b7c8e9d0f1a2b3c4d';
const BOOKIE_HASH = 'X262148X16384X0X0X134217728X0X0X0X0X0X0X0X0X134217729X0X0X1048576X0X1024X2088X131072X256X0X0X0X0X0X0X0X536903680X512X0X0X33554560X8519680X0X0X33562624X524288';
const USE_PREMIUM = 1;
const SPORT_ID = 36;

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const BACKTEST_DIR = path.join(DATA_DIR, 'backtest');
const ODDS_FILE = path.join(HISTORY_DIR, 'oddsportal_lpl_match_odds.csv');
const JOINED_FILE = path.join(BACKTEST_DIR, 'oddsportal_model_comparison.csv');
const SUMMARY_FILE = path.join(BACKTEST_DIR, 'oddsportal_model_comparison.md');
const PREDICTIONS_FILE = path.join(BACKTEST_DIR, 'predictions_with_outcomes.csv');

function tournamentUrl(year) {
  const suffix = String(year) === '2026' ? 'league-of-legends-lpl' : `league-of-legends-lpl-${year}`;
  return `https://www.oddsportal.com/esports/league-of-legends/${suffix}/results/`;
}

function extractArchiveRequest(html) {
  const text = String(html || '');
  const rawUrl = text.match(/\/ajax-sport-country-tournament-archive_\\?\/36\\?\/[^\\/"']+\\?\//)?.[0] || '';
  const url = rawUrl.replaceAll('\\/', '/');
  const encoded = url?.match(/\/36\/([^/]+)\//)?.[1]
    || text.match(/encodedTurnamentId(?:&quot;|"):(?:&quot;|")([^"&]+)(?:&quot;|")/)?.[1]
    || '';
  if (!url && encoded) return { url: `/ajax-sport-country-tournament-archive_/${SPORT_ID}/${encoded}/`, encoded };
  if (!url || !encoded) throw new Error('OddsPortal archive endpoint not found in page HTML');
  return { url, encoded };
}

function ajaxUrl(archiveUrl, page = 1) {
  const pagePart = page > 1 ? `/page/${page}/` : '/';
  return `https://www.oddsportal.com${archiveUrl}${BOOKIE_HASH}/${USE_PREMIUM}/0${pagePart}?_=${Date.now()}`;
}

async function decryptOddsPortalPayload(payload) {
  const decoded = Buffer.from(payload, 'base64').toString('binary');
  const [cipherTextBase64, ivHex] = decoded.split(':');
  if (!cipherTextBase64 || !ivHex) throw new Error('Unexpected encrypted OddsPortal payload');

  const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map((hex) => parseInt(hex, 16)));
  const encoder = new TextEncoder();
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(ODDS_KEY),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(ODDS_SALT),
      iterations: 1000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  );
  const cipherBytes = new Uint8Array(Buffer.from(cipherTextBase64, 'base64'));
  const plainBytes = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherBytes));
  const body = plainBytes[0] === 31 && plainBytes[1] === 139
    ? zlib.gunzipSync(plainBytes)
    : Buffer.from(plainBytes);
  return body.toString('utf8');
}

async function fetchArchivePage(archiveUrl, referer, page = 1) {
  const res = await fetch(ajaxUrl(archiveUrl, page), {
    headers: {
      'user-agent': 'Mozilla/5.0 LPL odds history collector',
      accept: 'application/json,text/plain,*/*',
      referer,
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`OddsPortal archive request failed: ${res.status} ${res.statusText}`);
  return JSON.parse(await decryptOddsPortalPayload(await res.text()));
}

function timestampDate(row) {
  const ts = num(row['date-start-timestamp'] || row['date-start-base']);
  if (!ts) return '';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function noVigProb(homeOdds, awayOdds, side) {
  const invHome = homeOdds > 1 ? 1 / homeOdds : 0;
  const invAway = awayOdds > 1 ? 1 / awayOdds : 0;
  const total = invHome + invAway;
  if (!total) return '';
  return side === 'home' ? invHome / total : invAway / total;
}

function extractMatchOdds(row, year) {
  const home = row.odds?.[0] || null;
  const away = row.odds?.[1] || null;
  if (!home?.avgOdds || !away?.avgOdds) return null;

  const homeAvg = num(home.avgOdds);
  const awayAvg = num(away.avgOdds);
  const homeMax = num(home.maxOdds);
  const awayMax = num(away.maxOdds);
  if (homeAvg <= 1 || awayAvg <= 1) return null;

  return {
    source: 'oddsportal',
    year,
    event_id: row.id,
    encoded_event_id: row.encodeEventId,
    match_date: timestampDate(row),
    tournament: row['tournament-name'] || '',
    stage: row['tournament-stage-name'] || '',
    home_team: row['home-name'] || '',
    away_team: row['away-name'] || '',
    home_key: teamKey(row['home-name']),
    away_key: teamKey(row['away-name']),
    result: row.result || row.postmatchResult || '',
    home_score: row.homeResult || '',
    away_score: row.awayResult || '',
    winner_key: row['home-winner'] === 'win' ? teamKey(row['home-name']) : teamKey(row['away-name']),
    home_avg_odds: decimal(homeAvg, 3),
    away_avg_odds: decimal(awayAvg, 3),
    home_max_odds: decimal(homeMax, 3),
    away_max_odds: decimal(awayMax, 3),
    home_market_p: decimal(noVigProb(homeAvg, awayAvg, 'home'), 4),
    away_market_p: decimal(noVigProb(homeAvg, awayAvg, 'away'), 4),
    home_bookmakers: home.cntActive || '',
    away_bookmakers: away.cntActive || '',
    source_url: `https://www.oddsportal.com${row.url || ''}`,
  };
}

function matchKey(date, teamA, teamB) {
  return [date, [teamKey(teamA), teamKey(teamB)].sort().join('|')].join('|');
}

function probabilityForSelection(oddsRow, selection) {
  const key = teamKey(selection);
  if (key === oddsRow.home_key) return num(oddsRow.home_market_p);
  if (key === oddsRow.away_key) return num(oddsRow.away_market_p);
  return null;
}

function decimalOddsForSelection(oddsRow, selection) {
  const key = teamKey(selection);
  if (key === oddsRow.home_key) return num(oddsRow.home_avg_odds);
  if (key === oddsRow.away_key) return num(oddsRow.away_avg_odds);
  return null;
}

function logLoss(p, outcome) {
  const safe = clamp(p, 0.0001, 0.9999);
  return outcome ? -Math.log(safe) : -Math.log(1 - safe);
}

function mean(rows, key) {
  const values = rows.map((row) => num(row[key], NaN)).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function summarizeSelectionRows(rows, split) {
  const scoped = split ? rows.filter((row) => row.split === split) : rows;
  return {
    split: split || 'all',
    selections: scoped.length,
    matches: new Set(scoped.map((row) => row.match_id)).size,
    model_brier: mean(scoped, 'model_brier'),
    market_brier: mean(scoped, 'market_brier'),
    model_logloss: mean(scoped, 'model_logloss'),
    market_logloss: mean(scoped, 'market_logloss'),
    avg_abs_p_diff: mean(scoped, 'abs_p_diff'),
  };
}

function favoriteSummary(rows, split) {
  const scoped = split ? rows.filter((row) => row.split === split) : rows;
  const groups = new Map();
  for (const row of scoped) {
    if (!groups.has(row.match_id)) groups.set(row.match_id, []);
    groups.get(row.match_id).push(row);
  }

  let matches = 0;
  let agreement = 0;
  let modelHits = 0;
  let marketHits = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const modelFav = [...group].sort((a, b) => num(b.model_p) - num(a.model_p))[0];
    const marketFav = [...group].sort((a, b) => num(b.market_p) - num(a.market_p))[0];
    matches += 1;
    if (modelFav.selection_key === marketFav.selection_key) agreement += 1;
    if (num(modelFav.outcome) === 1) modelHits += 1;
    if (num(marketFav.outcome) === 1) marketHits += 1;
  }

  return {
    split: split || 'all',
    matches,
    favorite_agreement: matches ? agreement / matches : 0,
    model_favorite_hit: matches ? modelHits / matches : 0,
    market_favorite_hit: matches ? marketHits / matches : 0,
  };
}

function edgeSummaries(rows, split) {
  const scoped = split ? rows.filter((row) => row.split === split) : rows;
  return [0.03, 0.05, 0.08, 0.10].map((threshold) => {
    const bets = scoped.filter((row) => num(row.model_edge) >= threshold);
    const profit = bets.reduce((sum, row) => sum + (num(row.outcome) ? num(row.market_decimal_odds) - 1 : -1), 0);
    return {
      split: split || 'all',
      edge_threshold: threshold,
      bets: bets.length,
      hit_rate: bets.length ? bets.filter((row) => num(row.outcome) === 1).length / bets.length : 0,
      roi: bets.length ? profit / bets.length : 0,
      profit,
    };
  });
}

function markdownReport({ oddsRows, joinedRows, unmatchedCount, selectionSummaries, favoriteSummaries, edgeRows }) {
  const lines = [];
  lines.push('# OddsPortal LPL 历史赔率 vs 模型');
  lines.push('');
  lines.push(`- 历史胜负盘赔率: ${oddsRows.length} 场`);
  lines.push(`- 已对齐模型 selection: ${joinedRows.length} 行 / 未对齐 ${unmatchedCount} 行`);
  lines.push(`- 已对齐比赛: ${new Set(joinedRows.map((row) => row.match_id)).size} 场`);
  lines.push(`- 赔率口径: OddsPortal 历史赛果页胜负盘 avgOdds, 转 no-vig 概率后对比。`);
  lines.push('');
  lines.push('## 概率误差');
  lines.push('');
  lines.push('| split | selections | matches | model_brier | market_brier | model_logloss | market_logloss | avg_abs_p_diff |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of selectionSummaries) {
    lines.push(`| ${row.split} | ${row.selections} | ${row.matches} | ${row.model_brier.toFixed(4)} | ${row.market_brier.toFixed(4)} | ${row.model_logloss.toFixed(4)} | ${row.market_logloss.toFixed(4)} | ${row.avg_abs_p_diff.toFixed(4)} |`);
  }
  lines.push('');
  lines.push('## 热门方向');
  lines.push('');
  lines.push('| split | matches | model/market favorite agreement | model favorite hit | market favorite hit |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of favoriteSummaries) {
    lines.push(`| ${row.split} | ${row.matches} | ${pct(row.favorite_agreement)} | ${pct(row.model_favorite_hit)} | ${pct(row.market_favorite_hit)} |`);
  }
  lines.push('');
  lines.push('## 模型高于盘口概率的模拟下注');
  lines.push('');
  lines.push('| split | edge >= | bets | hit_rate | roi | profit_units |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of edgeRows) {
    lines.push(`| ${row.split} | ${(row.edge_threshold * 100).toFixed(0)}% | ${row.bets} | ${pct(row.hit_rate)} | ${pct(row.roi)} | ${row.profit.toFixed(2)} |`);
  }
  lines.push('');
  lines.push('说明: ROI 只是按历史 avgOdds 每注 1u 的机械回测, 未扣除实际限额、盘口时间差、交易成本和可成交性。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function collectOdds(years) {
  const allRows = [];
  for (const year of years) {
    const referer = tournamentUrl(year);
    const html = await fetchText(referer, { headers: { referer: 'https://www.oddsportal.com/' } });
    const { url: archiveUrl } = extractArchiveRequest(html);
    const first = await fetchArchivePage(archiveUrl, referer, 1);
    const pageCount = num(first.d?.pagination?.pageCount, 1);
    const pages = [first];
    for (let page = 2; page <= pageCount; page += 1) {
      pages.push(await fetchArchivePage(archiveUrl, referer, page));
    }

    const rows = pages
      .flatMap((page) => page.d?.rows || [])
      .map((row) => extractMatchOdds(row, year))
      .filter(Boolean);
    console.log(`OddsPortal ${year}: ${rows.length} match odds from ${pageCount} pages`);
    allRows.push(...rows);
  }
  return allRows;
}

function compareToModel(oddsRows, predictionRows) {
  const oddsByKey = new Map();
  for (const row of oddsRows) oddsByKey.set(matchKey(row.match_date, row.home_key, row.away_key), row);

  const joined = [];
  let unmatched = 0;
  for (const row of predictionRows) {
    if (row.market !== 'match_win') continue;
    const key = matchKey(row.match_date, row.team_a_id || row.team_a, row.team_b_id || row.team_b);
    const odds = oddsByKey.get(key);
    if (!odds) {
      unmatched += 1;
      continue;
    }
    const marketP = probabilityForSelection(odds, row.selection);
    const decimalOdds = decimalOddsForSelection(odds, row.selection);
    if (marketP == null || decimalOdds == null) {
      unmatched += 1;
      continue;
    }
    const modelP = num(row.model_p);
    const outcome = num(row.outcome);
    joined.push({
      split: row.split || '',
      match_id: row.match_id,
      match_date: row.match_date,
      tournament: row.tournament,
      match_name: row.match_name,
      selection: row.selection,
      selection_key: teamKey(row.selection),
      outcome,
      model_p: decimal(modelP, 4),
      market_p: decimal(marketP, 4),
      model_edge: decimal(modelP - marketP, 4),
      abs_p_diff: decimal(Math.abs(modelP - marketP), 4),
      market_decimal_odds: decimal(decimalOdds, 3),
      model_brier: decimal((modelP - outcome) ** 2, 6),
      market_brier: decimal((marketP - outcome) ** 2, 6),
      model_logloss: decimal(logLoss(modelP, outcome), 6),
      market_logloss: decimal(logLoss(marketP, outcome), 6),
      odds_event_id: odds.event_id,
      odds_home: odds.home_team,
      odds_away: odds.away_team,
      odds_result: odds.result,
      odds_source_url: odds.source_url,
    });
  }
  return { joined, unmatched };
}

async function main() {
  const years = argValue('years', '2024,2025').split(',').map((year) => year.trim()).filter(Boolean);
  const oddsRows = await collectOdds(years);
  await writeCsv(ODDS_FILE, oddsRows, [
    'source', 'year', 'event_id', 'encoded_event_id', 'match_date', 'tournament', 'stage',
    'home_team', 'away_team', 'home_key', 'away_key', 'result', 'home_score', 'away_score',
    'winner_key', 'home_avg_odds', 'away_avg_odds', 'home_max_odds', 'away_max_odds',
    'home_market_p', 'away_market_p', 'home_bookmakers', 'away_bookmakers', 'source_url',
  ]);

  const predictions = await readCsv(PREDICTIONS_FILE);
  const { joined, unmatched } = compareToModel(oddsRows, predictions);
  await writeCsv(JOINED_FILE, joined, [
    'split', 'match_id', 'match_date', 'tournament', 'match_name', 'selection', 'selection_key',
    'outcome', 'model_p', 'market_p', 'model_edge', 'abs_p_diff', 'market_decimal_odds',
    'model_brier', 'market_brier', 'model_logloss', 'market_logloss', 'odds_event_id',
    'odds_home', 'odds_away', 'odds_result', 'odds_source_url',
  ]);

  const splits = ['', 'in_sample_2024', 'out_of_sample_2025'];
  const selectionSummaries = splits.map((split) => summarizeSelectionRows(joined, split));
  const favoriteSummaries = splits.map((split) => favoriteSummary(joined, split));
  const edgeRows = splits.flatMap((split) => edgeSummaries(joined, split));
  await writeCsv(path.join(BACKTEST_DIR, 'oddsportal_model_summary.csv'), selectionSummaries, [
    'split', 'selections', 'matches', 'model_brier', 'market_brier',
    'model_logloss', 'market_logloss', 'avg_abs_p_diff',
  ]);
  await writeCsv(path.join(BACKTEST_DIR, 'oddsportal_edge_roi.csv'), edgeRows, [
    'split', 'edge_threshold', 'bets', 'hit_rate', 'roi', 'profit',
  ]);
  await writeCsv(path.join(BACKTEST_DIR, 'oddsportal_favorite_summary.csv'), favoriteSummaries, [
    'split', 'matches', 'favorite_agreement', 'model_favorite_hit', 'market_favorite_hit',
  ]);

  await writeFile(
    SUMMARY_FILE,
    markdownReport({ oddsRows, joinedRows: joined, unmatchedCount: unmatched, selectionSummaries, favoriteSummaries, edgeRows }),
    'utf8',
  );

  console.log(`Historical odds written: ${ODDS_FILE}`);
  console.log(`Joined comparison written: ${JOINED_FILE}`);
  console.log(`Summary written: ${SUMMARY_FILE}`);
}

main().catch((error) => {
  console.error(`OddsPortal historical odds comparison failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
