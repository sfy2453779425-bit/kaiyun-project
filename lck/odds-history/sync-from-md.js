// 以 投注记录.md(人看账, 唯一真相)为准, 重建 odds.db 里的真实下注。
// 清掉所有旧的导入来源(ledger-import / manual-backfill / md-sync), 再从 md 重新插入。
// 用法: node lck/odds-history/sync-from-md.js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, num, teamKey } from '../shared.js';
import { initDb } from './db-init.js';

const MD_PATH = path.join(ROOT, '投注记录.md');

// 解析一行 "比赛/盘口" 中文描述 -> {match_name, market, selection, line, period}
function parseDesc(desc) {
  const text = String(desc).trim();
  const periodMatch = text.match(/(第一局|全局)/);
  const period = periodMatch ? periodMatch[1] : '';
  const idx = periodMatch ? text.indexOf(periodMatch[1]) : -1;
  const left = idx >= 0 ? text.slice(0, idx).trim() : text;
  const right = idx >= 0 ? text.slice(idx + periodMatch[1].length).trim() : '';
  const matchName = left; // 形如 "NS vs HLE" / "BNK FearX vs T1"

  // 总击杀
  let m;
  if (/总击杀/.test(right)) {
    const over = /大|over/i.test(right);
    const line = (right.match(/([\d.]+)/) || [])[1] || '';
    return { matchName, market: 'total_kills', selection: over ? 'over' : 'under', line, period };
  }
  // 地图让分: "TEAM ±X 地图"
  if (/地图/.test(right) && (m = right.match(/^(.+?)\s*([+-][\d.]+)\s*地图/))) {
    return { matchName, market: 'map_handicap', selection: teamKey(m[1]), line: m[2], period };
  }
  // 击杀让分: "TEAM ±X 击杀"
  if (/击杀/.test(right) && (m = right.match(/^(.+?)\s*([+-][\d.]+)\s*击杀/))) {
    return { matchName, market: 'team_kills_handicap', selection: teamKey(m[1]), line: m[2], period };
  }
  // 独赢 / 胜
  if ((m = right.match(/^(.+?)\s*(独赢|胜)/))) {
    return { matchName, market: period === '全局' ? 'match_win' : 'game1_win', selection: teamKey(m[1]), line: '', period };
  }
  return { matchName, market: 'unknown:' + right, selection: '', line: '', period };
}

function main() {
  const md = readFileSync(MD_PATH, 'utf8');
  const bets = [];
  for (const line of md.split('\n')) {
    const r = line.match(/^\|\s*(2026-\d\d-\d\d)\s*\|\s*(.+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(赢|输)\s*\|\s*([+\-\d.]+)\s*\|$/);
    if (!r) continue;
    const date = r[1];
    const desc = r[2];
    const stake = num(r[3]);
    const odds = num(r[4]);
    const win = r[5] === '赢';
    const profit = num(r[6]);
    const parsed = parseDesc(desc);
    bets.push({ date, desc, stake, odds, win, profit, ...parsed });
  }

  const db = initDb();
  // 幂等清理(robust): 删掉所有"含 stake>0 下注"的快照(不论来源), 保证下注唯一来自 md。
  // 不碰纯赔率快照(stake=0/NULL, 如剪贴板采集), 那些不计入 ROI。
  db.prepare('DELETE FROM snapshots WHERE id IN (SELECT DISTINCT snapshot_id FROM odds WHERE stake > 0)').run();
  db.prepare('DELETE FROM odds WHERE snapshot_id NOT IN (SELECT id FROM snapshots)').run(); // 清孤儿(防 FK 未级联)

  const insSnap = db.prepare('INSERT INTO snapshots (captured_at, source, match_name, event_date, league, notes) VALUES (?,?,?,?,?,?)');
  const insOdds = db.prepare(`INSERT INTO odds (snapshot_id, market, selection, line, odds, implied_p, no_vig_p, stake, model_p, recommended, compliance, outcome, actual_value, settled_at, model_mode)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  let n = 0;
  const unknowns = [];
  const tx = db.transaction(() => {
    for (const b of bets) {
      if (b.market.startsWith('unknown')) { unknowns.push(b.desc); continue; }
      const snap = insSnap.run(now, 'md-sync', b.matchName, b.date, 'LCK', `原始: ${b.desc}`);
      insOdds.run(
        snap.lastInsertRowid, b.market, b.selection, b.line, b.odds,
        b.odds > 0 ? 1 / b.odds : null, null, b.stake, null, 1, b.period || '',
        b.win ? 1 : 0, b.win ? '赢' : '输', now, 'legacy',
      );
      n += 1;
    }
  });
  tx();

  console.log(`同步完成: 从 投注记录.md 写入 ${n} 注 (来源 md-sync, 已清旧导入)`);
  if (unknowns.length) console.log('未能解析的描述(跳过):', unknowns);
  // 校验: 按 market 汇总
  const rows = db.prepare(`SELECT o.market, COUNT(*) n, SUM(o.stake) stake, SUM(CASE WHEN o.outcome=1 THEN o.stake*(o.odds-1) ELSE -o.stake END) profit
    FROM odds o JOIN snapshots s ON s.id=o.snapshot_id WHERE s.source='md-sync' GROUP BY o.market ORDER BY profit DESC`).all();
  console.log('\n按 market 校验:');
  for (const r of rows) console.log(`  ${r.market.padEnd(22)} ${r.n}注 投${r.stake.toFixed(0)} 盈亏${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(2)}`);
  const tot = db.prepare(`SELECT COUNT(*) n, SUM(o.stake) stake, SUM(CASE WHEN o.outcome=1 THEN o.stake*(o.odds-1) ELSE -o.stake END) profit FROM odds o JOIN snapshots s ON s.id=o.snapshot_id WHERE s.source='md-sync'`).get();
  console.log(`\n合计: ${tot.n}注 投${tot.stake.toFixed(0)} 净${tot.profit >= 0 ? '+' : ''}${tot.profit.toFixed(2)} ROI ${(tot.profit / tot.stake * 100).toFixed(1)}%`);
}

main();
