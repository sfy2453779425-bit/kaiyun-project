// 从 odds.db 里 stake>0 的实际下注计算真实 ROI(按 market / 合规分组)。
// 数据来源是你每天实际下的注 + settle-outcomes 自动结算的 outcome。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initDb, ODDS_HISTORY_DIR } from './db-init.js';

function pct(x) {
  return x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`;
}

function summarize(rows) {
  const staked = rows.reduce((s, r) => s + r.stake, 0);
  const settled = rows.filter((r) => r.outcome != null);
  const settledStake = settled.reduce((s, r) => s + r.stake, 0);
  // profit: 命中 = stake*(odds-1), 未命中 = -stake
  const profit = settled.reduce((s, r) => s + (r.outcome ? r.stake * (r.odds - 1) : -r.stake), 0);
  const wins = settled.filter((r) => r.outcome === 1).length;
  return {
    bets: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    staked,
    settled_stake: settledStake,
    wins,
    losses: settled.length - wins,
    hit_rate: settled.length ? wins / settled.length : null,
    profit,
    roi: settledStake ? profit / settledStake : null,
  };
}

function table(title, groups) {
  const lines = [`## ${title}`, '', '| 分组 | 注数 | 已结算 | 命中率 | 投入(已结算) | 盈亏 | ROI |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const [key, s] of groups) {
    lines.push(`| ${key} | ${s.bets} | ${s.settled} | ${pct(s.hit_rate)} | ${s.settled_stake.toFixed(1)} | ${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(2)} | ${pct(s.roi)} |`);
  }
  lines.push('');
  return lines;
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function main() {
  const db = initDb();
  const bets = db.prepare(`
    SELECT s.match_name, s.event_date, s.league, o.market, o.selection, o.line, o.odds,
           o.stake, o.model_p, o.recommended, o.compliance, o.outcome, o.actual_value
    FROM odds o JOIN snapshots s ON s.id = o.snapshot_id
    WHERE o.stake > 0
    ORDER BY s.event_date, s.match_name
  `).all();

  if (!bets.length) {
    console.log('odds.db 里还没有 stake>0 的实际下注记录。先用 record-bet 录入今天的下注。');
    return;
  }

  const overall = summarize(bets);
  const byLeague = [...groupBy(bets, (r) => r.league || '(未标注)').entries()]
    .map(([k, v]) => [k, summarize(v)])
    .sort((a, b) => b[1].staked - a[1].staked);
  const byMarket = [...groupBy(bets, (r) => r.market).entries()]
    .map(([k, v]) => [k, summarize(v)])
    .sort((a, b) => (b[1].roi ?? -9) - (a[1].roi ?? -9));
  const byCompliance = [...groupBy(bets, (r) => r.compliance || '(未标注)').entries()]
    .map(([k, v]) => [k, summarize(v)]);
  // LCK 专项: 按 market 看(这是模型主战场)
  const lckBets = bets.filter((r) => r.league === 'LCK');
  const lckByMarket = [...groupBy(lckBets, (r) => r.market).entries()]
    .map(([k, v]) => [k, summarize(v)])
    .sort((a, b) => (b[1].roi ?? -9) - (a[1].roi ?? -9));

  const lines = [
    '# LCK 真实下注 ROI 报告 (odds.db)',
    '',
    `生成时间: ${new Date().toISOString()}`,
    '',
    '> 这是你**实际下注**的真实 ROI(用真实赔率 + 真实结算结果 + 真实下注金额)。',
    '> 跟合成回测(三个问题答案.md)和胜负盘市场对账(oddsportal_model_comparison.md)是三条独立证据。',
    '> 样本 < 30 时所有数字都只是噪声, 不要据此调整策略。',
    '',
    '## 总览',
    '',
    `- 总注数: ${overall.bets} (已结算 ${overall.settled}, 待结算 ${overall.pending})`,
    `- 已结算投入: ${overall.settled_stake.toFixed(1)} 单位`,
    `- 命中率: ${pct(overall.hit_rate)} (${overall.wins} 胜 / ${overall.losses} 负)`,
    `- 净盈亏: ${overall.profit >= 0 ? '+' : ''}${overall.profit.toFixed(2)} 单位`,
    `- 真实 ROI: ${pct(overall.roi)}`,
    '',
    ...table('按 league 分组(LCK/LPL/EWC 不要混着看)', byLeague),
    ...table('LCK 专项 · 按 market 分组(模型主战场, 决定盘口去留)', lckByMarket),
    ...table('全部 league · 按 market 分组', byMarket),
    ...table('按合规性分组(规则内 vs 规则外)', byCompliance),
    '## 判读规则',
    '',
    '- 某 market 真实 ROI < -5% 且样本 ≥ 30 → 停下该 market',
    '- 规则外(违规)ROI 若长期高于规则内 → 说明白名单需要复查',
    '- 规则外 ROI 若低于规则内 → 纪律在保护你, 继续遵守',
    '',
  ];

  const outPath = path.join(ODDS_HISTORY_DIR, 'roi-report.md');
  writeFile(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log(`\n报告写入: ${outPath}`);
}

main();
