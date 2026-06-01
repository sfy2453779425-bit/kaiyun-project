// 总杀 edge 粗预览: 对已存真实报价, 比"模型当时概率 vs 真实赔率", 再用实际结果结算。
// 回答: 模型说 +EV 的那些总杀盘, 真的赚吗? (样本小, 只看方向)
import path from 'node:path';
import { readCsv, teamKey } from '../shared.js';
import { buildProfiles } from '../build-market-analysis.js';
import { predictTotalKills } from './total-kills-model-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const LOG = path.join(DATA_DIR, '盘口分析', '总杀报价log.csv');

function pct(v) { return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a'; }

async function main() {
  const [matches, maps, summary, log] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
    readCsv(LOG),
  ]);
  const profiles = buildProfiles(matches, maps, summary);

  const rows = [];
  for (const r of log) {
    const a = profiles.get(teamKey(r.team_a));
    const b = profiles.get(teamKey(r.team_b));
    if (!a || !b) { rows.push({ ...r, skip: `missing profile ${r.team_a}/${r.team_b}` }); continue; }
    const pred = predictTotalKills(a, b);
    if (!pred) { rows.push({ ...r, skip: 'model null' }); continue; }
    const line = Number(r.line);
    const odds = Number(r.odds);
    const modelP = r.side === 'under' ? pred.p_under(line) : pred.p_over(line);
    const implied = 1 / odds;
    const edge = modelP - implied;
    const ev = modelP * odds - 1;
    const win = String(r.result).toLowerCase() === 'win';
    const profit = win ? odds - 1 : -1;
    rows.push({ ...r, line, odds, modelMean: pred.mean, modelP, implied, edge, ev, win, profit });
  }

  console.log('=== 逐条 ===');
  console.log('date | match | line | side | odds | 模型均值 | 模型p | 隐含 | edge | EV | 结果 | 盈亏');
  for (const r of rows) {
    if (r.skip) { console.log(`${r.date} | ${r.match} | ${r.line} | ${r.side} | SKIP ${r.skip}`); continue; }
    console.log(`${r.date} | ${r.match} | ${r.line} | ${r.side} | ${r.odds} | ${r.modelMean.toFixed(1)} | ${pct(r.modelP)} | ${pct(r.implied)} | ${r.edge >= 0 ? '+' : ''}${pct(r.edge)} | ${r.ev >= 0 ? '+' : ''}${pct(r.ev)} | ${r.win ? 'WIN' : 'loss'} | ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(3)}`);
  }

  const valid = rows.filter((r) => !r.skip);
  function agg(label, subset) {
    const n = subset.length;
    if (!n) { console.log(`${label}: 无样本`); return; }
    const staked = n;
    const net = subset.reduce((s, r) => s + r.profit, 0);
    const wins = subset.filter((r) => r.win).length;
    console.log(`${label}: n=${n}, 命中 ${wins}/${n} (${pct(wins / n)}), 投 ${staked}, 净 ${net >= 0 ? '+' : ''}${net.toFixed(2)}, ROI ${net / staked >= 0 ? '+' : ''}${pct(net / staked)}`);
  }

  console.log('\n=== 汇总 ===');
  agg('全部 15 行', valid);
  agg('模型 +EV (edge>0) 的', valid.filter((r) => r.ev > 0));
  agg('模型 +EV 且 under (我们真实策略)', valid.filter((r) => r.ev > 0 && r.side === 'under'));
  agg('模型说该避开 (EV<0) 的', valid.filter((r) => r.ev <= 0));

  // 校准粗看: 模型 +EV under 这组, 模型平均说多少 vs 实际命中
  const edgeUnder = valid.filter((r) => r.ev > 0 && r.side === 'under');
  if (edgeUnder.length) {
    const meanP = edgeUnder.reduce((s, r) => s + r.modelP, 0) / edgeUnder.length;
    const act = edgeUnder.filter((r) => r.win).length / edgeUnder.length;
    console.log(`\n模型+EV under 组诚实度: 模型平均说 ${pct(meanP)}, 实际命中 ${pct(act)}`);
  }
  console.log('\n注: 样本仅 15, 仅看方向; 5-23/5-29 三行 profile 略有泄漏(偏乐观)。');
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
