// 2026 漂移体检 / 2026 drift check for the deployed total-kills model
// 问题: 模型 2024 拟合, 现在打 patch 16.x(模型没见过), 它在 2026 还准吗?
// 方法: walk-forward 重建每张 2026 图的特征(只用该图之前数据), 调已部署 predictTotalKills, 比预测均值 vs 实际。
// 注: strength_score 用 walk-forward 胜率代理(单局有噪声), 但聚合偏置对此不敏感, 适合漂移体检。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';
import { predictTotalKills } from './total-kills-model-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const OUT_MD = path.join(DATA_DIR, '盘口分析', '总杀模型-2026漂移体检.md');
const MIN_PRIOR = 8;
const LINES = [24.5, 26.5, 28.5, 30.5, 32.5, 34.5];

function listMapFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMapFiles(full));
    else if (e.name === 'lpl_map_details.csv') out.push(full);
  }
  return out;
}

function parseMaps() {
  const files = listMapFiles(DATA_DIR);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let lines;
    try { lines = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (lines.length < 2) continue;
    const head = lines[0].split(',');
    const ix = (n) => head.indexOf(n);
    const I = {
      date: ix('match_time'), patch: ix('patch'), win: ix('map_winner_id'),
      aId: ix('team_a_id'), aName: ix('team_a'), aK: ix('team_a_kills'),
      bId: ix('team_b_id'), bName: ix('team_b'), bK: ix('team_b_kills'),
      tot: ix('total_kills'), gt: ix('game_time_min'), ft: ix('first_turret_team_id'),
      gid: ix('game_id'), mid: ix('match_id'),
    };
    if (I.date < 0 || I.aK < 0 || I.bK < 0) continue;
    for (let i = 1; i < lines.length; i += 1) {
      const c = lines[i].split(',');
      const date = (c[I.date] || '').trim();
      const a = teamKey(c[I.aId] || c[I.aName]);
      const b = teamKey(c[I.bId] || c[I.bName]);
      const ak = Number(c[I.aK]);
      const bk = Number(c[I.bK]);
      let total = I.tot >= 0 ? Number(c[I.tot]) : NaN;
      if (!Number.isFinite(total)) total = ak + bk;
      const win = teamKey(c[I.win] || '');
      const gt = I.gt >= 0 ? Number(c[I.gt]) : NaN;
      const ftTeam = teamKey(c[I.ft] || '');
      const patch = (c[I.patch] || '').trim();
      if (!date || !a || !b || !Number.isFinite(total)) continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
      if (seen.has(gid)) continue;
      seen.add(gid);
      out.push({ date, patch, a, b, ak, bk, total, win, gt, ftTeam });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

function stat() { return { n: 0, sumTotal: 0, sumGt: 0, sumKd: 0, ft: 0, last10: [] }; }
function profileOf(s) {
  const wr = s.n ? s.last10All / s.n : 0.5; // overall win rate
  const recent = s.last10.length ? s.last10.reduce((x, y) => x + y, 0) / s.last10.length : 0.5;
  return {
    strength_score: 50 + (wr - 0.5) * 60, // walk-forward 胜率代理
    avg_total_kills: s.n ? s.sumTotal / s.n : 28,
    avg_game_time_min: s.gtN ? s.sumGt / s.gtN : 32,
    avg_kill_diff: s.n ? s.sumKd / s.n : 0,
    first_turret_rate: s.n ? s.ft / s.n : 0.5,
    recent_10_map_win_rate: recent,
    current_patch: '',
  };
}

function pct(v) { return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a'; }
function f2(v) { return Number.isFinite(v) ? v.toFixed(2) : 'n/a'; }

function main() {
  const maps = parseMaps();
  const stats = new Map();
  const get = (t) => { if (!stats.has(t)) { const s = stat(); s.gtN = 0; s.last10All = 0; stats.set(t, s); } return stats.get(t); };

  const recs = [];        // 2026 per-map: {predMean, actual, year}
  const lineRecs = [];    // 2026 per (map,line): {p, y}
  let qual2026 = 0;
  for (const m of maps) {
    const sa = get(m.a), sb = get(m.b);
    const year = m.date.slice(0, 4);
    if (year === '2026' && sa.n >= MIN_PRIOR && sb.n >= MIN_PRIOR) {
      const pa = profileOf(sa); const pb = profileOf(sb);
      pa.current_patch = m.patch; pb.current_patch = m.patch;
      const pred = predictTotalKills(pa, pb);
      if (pred) {
        qual2026 += 1;
        recs.push({ predMean: pred.mean, actual: m.total });
        for (const L of LINES) lineRecs.push({ p: pred.p_under(L), y: m.total < L ? 1 : 0 });
      }
    }
    // 记录后更新 (无泄漏)
    const aWon = m.win === m.a ? 1 : 0;
    const bWon = m.win === m.b ? 1 : 0;
    sa.n += 1; sa.sumTotal += m.total; sa.sumKd += (m.ak - m.bk); sa.last10All += aWon;
    sb.n += 1; sb.sumTotal += m.total; sb.sumKd += (m.bk - m.ak); sb.last10All += bWon;
    if (Number.isFinite(m.gt)) { sa.sumGt += m.gt; sa.gtN += 1; sb.sumGt += m.gt; sb.gtN += 1; }
    if (m.ftTeam === m.a) sa.ft += 1; if (m.ftTeam === m.b) sb.ft += 1;
    sa.last10.push(aWon); if (sa.last10.length > 10) sa.last10.shift();
    sb.last10.push(bWon); if (sb.last10.length > 10) sb.last10.shift();
  }

  // 聚合偏置
  const meanActual = recs.reduce((s, r) => s + r.actual, 0) / recs.length;
  const meanPred = recs.reduce((s, r) => s + r.predMean, 0) / recs.length;
  const meanResid = recs.reduce((s, r) => s + (r.actual - r.predMean), 0) / recs.length;
  const mae = recs.reduce((s, r) => s + Math.abs(r.actual - r.predMean), 0) / recs.length;

  // 2026 ECE (under)
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 }));
  for (const r of lineRecs) { let bi = Math.floor(r.p * 10); if (bi > 9) bi = 9; if (bi < 0) bi = 0; bins[bi].n += 1; bins[bi].sp += r.p; bins[bi].sy += r.y; }
  let ece = 0;
  for (const b of bins) if (b.n) ece += (b.n / lineRecs.length) * Math.abs(b.sp / b.n - b.sy / b.n);

  const L = [];
  const P = (x) => L.push(x);
  P('# 总杀模型 2026 漂移体检 / 2026 Drift Check');
  P('');
  P(`- 模型 2024 拟合; 本检查在 **2026 (patch 16.x)** 上 walk-forward 验偏移。合格 2026 图: ${qual2026}。`);
  P('- strength_score 用 walk-forward 胜率代理 → 单局有噪声, 但**聚合偏置/MAE 对此不敏感**, 是漂移体检的核心读数。');
  P('');
  P('## 聚合偏置 (核心)');
  P('');
  P('| 指标 | 值 |');
  P('|---|---:|');
  P(`| 2026 实际均总杀 | ${f2(meanActual)} |`);
  P(`| 模型预测均总杀 | ${f2(meanPred)} |`);
  P(`| 平均残差 (实际−预测) | ${meanResid >= 0 ? '+' : ''}${f2(meanResid)} |`);
  P(`| MAE | ${f2(mae)} |`);
  P('');
  P('## 2026 under 校准');
  P('');
  P('| model_p 区间 | n | 模型说 | 实际 |');
  P('|---|---:|---:|---:|');
  for (let i = 0; i < bins.length; i += 1) {
    const b = bins[i]; if (!b.n) continue;
    P(`| ${i * 10}-${i * 10 + 10}% | ${b.n} | ${pct(b.sp / b.n)} | ${pct(b.sy / b.n)} |`);
  }
  P('');
  P(`- 2026 ECE: **${pct(ece)}**`);
  P('');
  const drift = Math.abs(meanResid) < 1.0 ? '无明显漂移(|偏置|<1 杀)'
    : meanResid > 0 ? `模型**系统性低估** 2026 总杀 ${f2(meanResid)} 杀(meta 变血腥, 模型偏保守)`
      : `模型**系统性高估** 2026 总杀 ${f2(-meanResid)} 杀`;
  P('## 结论');
  P('');
  P(`- ${drift}。`);
  P(`- 2026 校准 ECE ${pct(ece)}(<5% 仍诚实; >10% 需警惕)。`);
  if (Math.abs(meanResid) >= 1.0) {
    P(`- 建议: 偏置 ≥1 杀, 值得让 Codex 在下次重拟合时纳入 2025-2026 数据 / 加 16.x patch 项。在那之前, 下注时把模型均值手动${meanResid > 0 ? '上调' : '下调'} ~${f2(Math.abs(meanResid))} 杀作粗修。`);
  } else {
    P('- 建议: 无需动模型, 继续用; 但 2026 样本仍少, 攒多再复查。');
  }

  writeFileSync(OUT_MD, L.join('\n') + '\n', 'utf8');
  process.stdout.write(`OK qual2026=${qual2026} meanActual=${f2(meanActual)} meanPred=${f2(meanPred)} resid=${f2(meanResid)} ECE=${pct(ece)}\n`);
}

main();
