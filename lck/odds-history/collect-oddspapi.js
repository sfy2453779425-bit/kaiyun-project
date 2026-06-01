// OddsPapi 自动采集器: 抓当天/近期 LCK 的 pinnacle 收盘赔率(胜负/让分/总地图数),
// 扣水后写入 CSV, 供 model-vs-market 验证。OddsPapi 免费层只保留近期场次(无深历史)。
//
// 用法:
//   ODDSPAPI_KEY=你的key node lck/odds-history/collect-oddspapi.js
//   node lck/odds-history/collect-oddspapi.js --key=... --bookmaker=pinnacle
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, argValue, decimal, teamKey, writeCsv, readCsvIfExists } from '../shared.js';
import {
  getKey, listLckFixtures, loadLolMarketDefs, getHistoricalOdds, closingPrice,
} from './oddspapi-client.js';

const OUT = path.join(DATA_DIR, 'odds_history', 'oddspapi_market_lines.csv');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可用书商每场不同, 按优先级遍历(pinnacle 最锐, 其余兜底), 抓到的都收
const BOOKMAKERS = ['pinnacle', 'betway', '1xbet', '22bet', 'bet365', 'dafabet', 'sbobet'];

function noVigPair(oddsA, oddsB) {
  if (!(oddsA > 0) || !(oddsB > 0)) return [null, null, null];
  const invA = 1 / oddsA;
  const invB = 1 / oddsB;
  const over = invA + invB;
  return [invA / over, invB / over, over];
}

// 从一场比赛的 pinnacle markets 里抽出三类盘口的收盘价
function extractLines(fixture, markets, defs, bookmaker) {
  const p1 = fixture.participant1Name;
  const p2 = fixture.participant2Name;
  // 用全名映射(Dplus→DK / Brion→BRO 等), Abbr(DPL/BRI)不在别名表里会错
  const k1 = teamKey(p1);
  const k2 = teamKey(p2);
  const date = String(fixture.startTime || '').slice(0, 10);
  const matchName = `${p1} vs ${p2}`;
  const rows = [];
  const base = { match_date: date, match_name: matchName, fixture_id: fixture.fixtureId, bookmaker, team1_key: k1, team2_key: k2, captured_at: new Date().toISOString() };

  // 收盘价: markets[mid].outcomes[oid].players["0"] 的最后一个 price
  const close = (mid, oid) => {
    const series = markets?.[mid]?.outcomes?.[oid]?.players?.['0'];
    return closingPrice(series);
  };

  for (const [mid, m] of Object.entries(markets)) {
    const d = defs.get(mid);
    if (!d) continue;
    const outIds = Object.keys(m.outcomes || {});
    if (outIds.length < 2) continue;
    const [oidA, oidB] = outIds; // outcome "1"=participant1, "2"=participant2(按 outcomeName 顺序)
    const oddsA = close(mid, oidA);
    const oddsB = close(mid, oidB);
    if (!(oddsA > 0) || !(oddsB > 0)) continue;
    const [pA, pB, overround] = noVigPair(oddsA, oddsB);

    if (d.type === 'moneyline' && Number(d.handicap) === 0 && /^winner$/i.test(d.name)) {
      rows.push({ ...base, market: 'match_win', selection: k1, line: '', market_odds: decimal(oddsA, 3), no_vig_p: decimal(pA, 4), overround: decimal(overround, 4) });
      rows.push({ ...base, market: 'match_win', selection: k2, line: '', market_odds: decimal(oddsB, 3), no_vig_p: decimal(pB, 4), overround: decimal(overround, 4) });
    } else if (d.type === 'moneyline' && Number(d.handicap) === 0 && /^first map winner/i.test(d.name)) {
      rows.push({ ...base, market: 'game1_win', selection: k1, line: '', market_odds: decimal(oddsA, 3), no_vig_p: decimal(pA, 4), overround: decimal(overround, 4) });
      rows.push({ ...base, market: 'game1_win', selection: k2, line: '', market_odds: decimal(oddsB, 3), no_vig_p: decimal(pB, 4), overround: decimal(overround, 4) });
    } else if (d.type === 'totals' && Number(d.handicap) === 2.5) {
      // outcome 顺序 Over/Under
      rows.push({ ...base, market: 'map_total', selection: 'over', line: '2.5', market_odds: decimal(oddsA, 3), no_vig_p: decimal(pA, 4), overround: decimal(overround, 4) });
      rows.push({ ...base, market: 'map_total', selection: 'under', line: '2.5', market_odds: decimal(oddsB, 3), no_vig_p: decimal(pB, 4), overround: decimal(overround, 4) });
    } else if (d.type === 'spreads' && Math.abs(Number(d.handicap)) === 1.5) {
      // handicap 作用于 side1(participant1); side2 取反。只收 ±1.5 这条。
      const h = Number(d.handicap); // 例如 -1.5: side1 -1.5, side2 +1.5
      rows.push({ ...base, market: 'map_handicap', selection: k1, line: (h > 0 ? '+' : '') + h, market_odds: decimal(oddsA, 3), no_vig_p: decimal(pA, 4), overround: decimal(overround, 4) });
      rows.push({ ...base, market: 'map_handicap', selection: k2, line: (h > 0 ? '' : '+') + (-h), market_odds: decimal(oddsB, 3), no_vig_p: decimal(pB, 4), overround: decimal(overround, 4) });
    }
  }
  return rows;
}

async function main() {
  const key = getKey();
  if (!key) { console.error('缺 API key: ODDSPAPI_KEY=... 或 --key='); process.exitCode = 1; return; }
  // --bookmaker 可指定单个, 否则按优先级列表全试
  const books = argValue('bookmaker', '') ? [argValue('bookmaker', '')] : BOOKMAKERS;

  const defs = await loadLolMarketDefs({ key });
  await sleep(1200);
  const fixtures = (await listLckFixtures({ key })).filter((f) => f.hasOdds);
  console.log(`hasOdds=true 的 LCK 比赛: ${fixtures.length} 场(OddsPapi 免费层只留近期)`);

  const all = [];
  for (const f of fixtures) {
    const label = `${f.participant1Name} vs ${f.participant2Name} (${String(f.startTime).slice(0, 10)})`;
    let hitBooks = 0;
    for (const bk of books) {
      await sleep(1100);
      const hist = await getHistoricalOdds(f.fixtureId, bk, { key });
      const markets = hist.json?.bookmakers?.[bk]?.markets;
      if (!markets) continue;
      const rows = extractLines(f, markets, defs, bk);
      if (rows.length) { all.push(...rows); hitBooks += 1; console.log(`  ${label} [${bk}]: 抽到 ${rows.length} 条`); }
    }
    if (!hitBooks) console.warn(`  ${label}: 列表内书商都无赔率`);
  }

  if (!all.length) { console.log('没抓到任何盘口(可能当前无 hasOdds 场)。'); return; }

  // 追加去重写入(同 fixture+market+selection+line 以最新一次为准)
  await mkdir(path.dirname(OUT), { recursive: true });
  const existing = await readCsvIfExists(OUT);
  const keyOf = (r) => [r.fixture_id, r.bookmaker, r.market, r.selection, r.line].join('|');
  const merged = new Map(existing.map((r) => [keyOf(r), r]));
  for (const r of all) merged.set(keyOf(r), r);
  const rows = [...merged.values()];
  await writeCsv(OUT, rows, [
    'match_date', 'match_name', 'fixture_id', 'bookmaker', 'team1_key', 'team2_key',
    'market', 'selection', 'line', 'market_odds', 'no_vig_p', 'overround', 'captured_at',
  ]);
  console.log(`\n写入 ${OUT}(本次 ${all.length} 条, 合并后共 ${rows.length} 条)`);
}

main().catch((e) => { console.error(`collect-oddspapi failed: ${e.message}`); process.exitCode = 1; });
