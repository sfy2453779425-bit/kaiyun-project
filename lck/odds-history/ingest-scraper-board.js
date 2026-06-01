// 读 D:/lol_scraper 的盘口板 JSON(开云Panda + 电竞牛IMDJ), 解析成统一结构,
// 跨平台对齐同一注取最高赔率(best-odds 比价), 输出统一比价板 CSV。
//
// 用法:
//   node lck/odds-history/ingest-scraper-board.js                 # 自动找最新 JSON
//   node lck/odds-history/ingest-scraper-board.js --file=路径
//   node lck/odds-history/ingest-scraper-board.js --dir=D:/lol_scraper/data
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, argValue, decimal, teamKey } from '../shared.js';

const SCRAPER_DIR = argValue('dir', 'D:/lol_scraper/data');
const OUT = path.join(DATA_DIR, 'odds_history', 'scraper_board.csv');

// 连接器本地队名归一(LPL+LCK 中/英/缩写 → 统一 key)。LCK 队走 shared.teamKey 兜底。
const TEAM_ALIASES = {
  // LPL
  anyoneslegend: 'AL', al: 'AL',
  teamwe: 'WE', 西安we: 'WE', we: 'WE',
  thundertalkgaming: 'TT', tt: 'TT', ttg: 'TT',
  lgdgaming: 'LGD', lgd: 'LGD',
  edwardgaming: 'EDG', edg: 'EDG',
  bilibiligaming: 'BLG', blg: 'BLG', blg星纪魅族: 'BLG',
  jdgaming: 'JDG', jdg: 'JDG', 京东: 'JDG',
  invictusgaming: 'IG', ig: 'IG',
  topesports: 'TES', tes: 'TES', 滔搏: 'TES',
  weibogaming: 'WBG', wbg: 'WBG', 微博: 'WBG',
  funplusphoenix: 'FPX', fpx: 'FPX',
  royalneverGiveup: 'RNG', rng: 'RNG',
  omg: 'OMG', oh啊my啊god: 'OMG',
  ninjasinpyjamas: 'NIP', nip: 'NIP',
  rareatom: 'RA', ra: 'RA',
  lng: 'LNG', lnggaming: 'LNG',
  ultraprime: 'UP', up: 'UP',
};

function normTeam(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/\s|\.|-/g, '').replace(/[^a-z0-9一-鿿]/g, '');
  if (TEAM_ALIASES[compact]) return TEAM_ALIASES[compact];
  const k = teamKey(raw); // LCK 队 + 通用
  return k || raw.toUpperCase();
}

function utcDate(start) {
  // PANDA: unix 秒; IMDJ: ISO 字符串
  let ms;
  if (typeof start === 'number') ms = start * 1000;
  else ms = Date.parse(String(start));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function noVig(oddsA, oddsB) {
  if (!(oddsA > 0) || !(oddsB > 0)) return [null, null, null];
  const a = 1 / oddsA;
  const b = 1 / oddsB;
  const t = a + b;
  return [a / t, b / t, t];
}

const stripSpace = (s) => String(s || '').replace(/\s/g, '');
const numIn = (s) => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

// 解析一场比赛(单平台)→ 统一行数组
function parseMatch(mt, markets, platform) {
  const home = (mt.team_home || (mt.teams_en || mt.teams || '').split(',')[0] || '').trim();
  const away = (mt.team_away || (mt.teams_en || mt.teams || '').split(',')[1] || '').trim();
  const hk = normTeam(home);
  const ak = normTeam(away);
  const date = utcDate(mt.start_time);
  const matchKey = `${date}|${[hk, ak].sort().join('-')}`;
  const bo = String(mt.bo || '').replace(/\D/g, '') || '';
  // match_name 用排序后的队 key, 保证同一场跨平台(主客顺序不同)显示一致
  const base = { matchKey, date, league: mt.league || '', home_key: hk, away_key: ak, match_name: [hk, ak].sort().join(' vs '), bo, platform };
  const rows = [];

  const teamOf = (selKey) => {
    if (selKey === '@T1') return hk;
    if (selKey === '@T2') return ak;
    const n = normTeam(selKey);
    return n;
  };

  for (const mk of Object.values(markets || {})) {
    if (mk.visible === 0 || mk.suspended === 1) continue;
    const nameRaw = mk.name || mk.code || '';
    const name = stripSpace(nameRaw);
    if (/\$\+|\+/.test(nameRaw)) continue; // 跳过组合盘
    if (/单双/.test(name)) continue; // 跳过单双(odd/even)
    const round = Number(mk.round || 0);
    const entries = Object.entries(mk.odds || {}).filter(([, o]) => Number(o.odd || o) > 0);
    const oddOf = (o) => Number(o.odd != null ? o.odd : o);

    // ---- 击杀总数大小 → total_kills(per-map, round=1 即第一局)----
    if (name === '击杀总数大小') {
      for (const [sel, o] of entries) {
        const over = /大于|^大|>/.test(sel);
        rows.push({ ...base, market: round === 1 ? 'total_kills' : `total_kills_g${round}`, selection: over ? 'over' : 'under', line: numIn(sel), odds: oddOf(o) });
      }
    } else if (name === '击杀让分') {
      for (const [sel, o] of entries) {
        const t = sel.match(/@T[12]/)?.[0] || (sel.match(/^(.+?)\s*[+-]/)?.[1]) || '';
        // 先剥掉 @T1/@T2(否则 numIn 会把 "T1" 的 1 当成线), 再取带符号的让分数
        const line = numIn(sel.replace(/@T[12]/g, ''));
        if (line == null) continue;
        rows.push({ ...base, market: round === 1 ? 'team_kills_handicap' : `team_kills_handicap_g${round}`, selection: teamOf(t), line: (line > 0 ? '+' : '') + line, odds: oddOf(o) });
      }
    } else if (name === '比赛时间大小') {
      for (const [sel, o] of entries) {
        const over = /大于|>/.test(sel);
        rows.push({ ...base, market: round === 1 ? 'game_time' : `game_time_g${round}`, selection: over ? 'over' : 'under', line: numIn(sel), odds: oddOf(o) });
      }
    } else if (name === '单局-获胜' || name === '第一局胜利') {
      for (const [sel, o] of entries) rows.push({ ...base, market: 'game1_win', selection: teamOf(sel), line: '', odds: oddOf(o) });
    } else if (/^BO\d*总比赛胜利$|^总比赛胜利$|^总比分$/.test(name)) {
      for (const [sel, o] of entries) rows.push({ ...base, market: 'match_win', selection: teamOf(sel), line: '', odds: oddOf(o) });
    } else if (/让1\.5局/.test(name)) {
      // "{TeamX} 让 1.5 局": 名字里的队 -1.5, 另一队 +1.5。odds 键是真实队名。
      const giverEn = nameRaw.match(/[:：]\s*(.+?)\s*让/)?.[1] || '';
      const giver = /TeamB/i.test(giverEn) ? ak : (/TeamA/i.test(giverEn) ? hk : normTeam(giverEn));
      for (const [sel, o] of entries) {
        const sk = teamOf(sel);
        const line = sk === giver ? '-1.5' : '+1.5';
        rows.push({ ...base, market: 'map_handicap', selection: sk, line, odds: oddOf(o) });
      }
    } else if (/总局数/.test(name)) {
      const line = numIn(nameRaw);
      for (const [sel, o] of entries) {
        const over = /大于|>/.test(sel);
        rows.push({ ...base, market: 'map_total', selection: over ? 'over' : 'under', line, odds: oddOf(o) });
      }
    }
    // 其它(首杀/首塔/小龙/经济等)暂不收
  }
  return rows;
}

function main() {
  let file = argValue('file', '');
  if (!file) {
    const cands = fs.readdirSync(SCRAPER_DIR).filter((f) => /lpl_lck_odds_deduped_.*\.json$/.test(f)).sort();
    if (!cands.length) { console.error(`${SCRAPER_DIR} 下没找到 lpl_lck_odds_deduped_*.json`); process.exitCode = 1; return; }
    file = path.join(SCRAPER_DIR, cands.at(-1));
  }
  console.log(`读取盘口板: ${file}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));

  const all = [];
  for (const [, p] of Object.entries(j.platforms || {})) {
    const platform = p.code || p.name || '?';
    for (const m of Object.values(p.matches || {})) {
      all.push(...parseMatch(m.match, m.markets, platform));
    }
  }
  console.log(`解析出 ${all.length} 条盘口行(${[...new Set(all.map((r) => r.platform))].join(' / ')})`);

  // 跨平台聚合: key = matchKey|market|selection|line
  const groups = new Map();
  for (const r of all) {
    if (r.line == null || Number.isNaN(r.line)) r.line = '';
    const k = [r.matchKey, r.market, r.selection, r.line].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const out = [];
  let shopCount = 0;
  for (const g of groups.values()) {
    const byPlat = {};
    for (const r of g) byPlat[r.platform] = Math.max(byPlat[r.platform] || 0, r.odds);
    const best = g.reduce((a, b) => (b.odds > a.odds ? b : a));
    const plats = Object.keys(byPlat);
    const shop = plats.length >= 2 && (Math.max(...Object.values(byPlat)) - Math.min(...Object.values(byPlat))) > 0.001;
    if (shop) shopCount += 1;
    out.push({
      match_date: best.date, league: best.league, match_name: best.match_name, bo: best.bo,
      market: best.market, selection: best.selection, line: best.line,
      best_odds: decimal(best.odds, 3), best_platform: best.platform,
      panda_odds: byPlat.PANDA != null ? decimal(byPlat.PANDA, 3) : '',
      imdj_odds: byPlat.IMDJ != null ? decimal(byPlat.IMDJ, 3) : '',
      platforms: plats.join('+'),
      shopping_edge: shop ? decimal(Math.max(...Object.values(byPlat)) - Math.min(...Object.values(byPlat)), 3) : '',
      captured_at: j.scraped_at || new Date().toISOString(),
    });
  }
  out.sort((a, b) => a.match_name.localeCompare(b.match_name) || a.market.localeCompare(b.market) || String(a.line).localeCompare(String(b.line)));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const cols = ['match_date', 'league', 'match_name', 'bo', 'market', 'selection', 'line', 'best_odds', 'best_platform', 'panda_odds', 'imdj_odds', 'platforms', 'shopping_edge', 'captured_at'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(OUT, `﻿${[cols.join(','), ...out.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')}\n`, 'utf8');

  console.log(`写入 ${OUT}: ${out.length} 个统一盘口`);
  console.log(`其中两平台都有的同盘口(可比价): ${shopCount} 个`);
  // 打印比价机会(best-odds 比另一家高的)
  const shops = out.filter((r) => r.shopping_edge).slice(0, 20);
  if (shops.length) {
    console.log('\n=== best-odds 比价机会(取高的那家)===');
    for (const r of shops) console.log(`  ${r.match_name} | ${r.market} ${r.selection} ${r.line} | 开云 ${r.panda_odds || '-'} vs 电竞牛 ${r.imdj_odds || '-'} → 下 ${r.best_platform}(${r.best_odds})`);
  }
}

main();
