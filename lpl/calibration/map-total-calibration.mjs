// 系列赛局数(map_total)模型回测 / Series-length calibration (认真版)
// 假设: 系列赛打几局 由"差距量级"决定(不需要方向)。BO5 = 赢家拿满 3 局。
// ① 模型无关: 按 walk-forward 差距分桶, 看实际 P(≥4局)/P(打满5局) —— 验信号是否真存在(不靠任何参数)。
// ② 校准版: 差距→单图胜率 p→二项式→P(over3.5)/P(over4.5), 算 ECE + skill vs 基线 + bootstrap。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const MIN_PRIOR = 8;            // 每队最小先验图
const K = 2.2;                  // 差距→单图胜率的 logistic 尺度(校准版用)
const BOOT = 1000, SEED = 20260601;

function listFiles(dir) { const o = []; for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) o.push(...listFiles(f)); else if (e.name === 'lpl_map_details.csv') o.push(f); } return o; }
function parseMaps() {
  const seen = new Set(); const out = [];
  for (const f of listFiles(DATA_DIR)) {
    let L; try { L = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (L.length < 2) continue;
    const h = L[0].split(','); const ix = (n) => h.indexOf(n);
    const I = { mid: ix('match_id'), date: ix('match_time'), aId: ix('team_a_id'), aN: ix('team_a'), bId: ix('team_b_id'), bN: ix('team_b'), win: ix('map_winner_id'), winN: ix('map_winner'), gid: ix('game_id') };
    if (I.date < 0 || I.mid < 0 || (I.win < 0 && I.winN < 0)) continue;
    for (let i = 1; i < L.length; i += 1) {
      const c = L[i].split(',');
      const mid = c[I.mid]; const date = (c[I.date] || '').trim();
      const a = teamKey(c[I.aId] || c[I.aN]); const b = teamKey(c[I.bId] || c[I.bN]);
      const w = teamKey((I.win >= 0 ? c[I.win] : '') || (I.winN >= 0 ? c[I.winN] : ''));
      if (!mid || !date || !a || !b || !w) continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${mid}|${i}`;
      if (seen.has(gid)) continue; seen.add(gid);
      out.push({ mid, date, a, b, w });
    }
  }
  return out;
}
// 把图按 match_id 聚成系列
function buildSeries(maps) {
  const byMid = new Map();
  for (const m of maps) { if (!byMid.has(m.mid)) byMid.set(m.mid, []); byMid.get(m.mid).push(m); }
  const series = [];
  for (const [mid, ms] of byMid) {
    const teams = [...new Set(ms.flatMap((x) => [x.a, x.b]))];
    if (teams.length !== 2) continue;
    const [t1, t2] = teams;
    let w1 = 0, w2 = 0; for (const m of ms) { if (m.w === t1) w1 += 1; else if (m.w === t2) w2 += 1; }
    const len = ms.length; const maxW = Math.max(w1, w2);
    const date = ms.map((x) => x.date).sort()[0];
    series.push({ mid, date, t1, t2, w1, w2, len, isBO5: maxW === 3, maps: ms });
  }
  series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return series;
}
function mulberry32(s) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const logistic = (x) => 1 / (1 + Math.exp(-x));
const pc = (v) => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a';
const f3 = (v) => Number.isFinite(v) ? v.toFixed(3) : 'n/a';

function main() {
  const series = buildSeries(parseMaps());
  // walk-forward 各队 map 胜率
  const rec = new Map(); const get = (t) => { if (!rec.has(t)) rec.set(t, { n: 0, w: 0 }); return rec.get(t); };
  const samples = [];
  for (const s of series) {
    const r1 = get(s.t1), r2 = get(s.t2);
    if (s.isBO5 && r1.n >= MIN_PRIOR && r2.n >= MIN_PRIOR) {
      const wr1 = r1.w / r1.n, wr2 = r2.w / r2.n;
      const gap = Math.abs(wr1 - wr2);
      const p = logistic(K * gap);                 // 强方单图胜率 (>=0.5)
      const pOver35 = 1 - (p ** 3 + (1 - p) ** 3);  // 打 >=4 局
      const pOver45 = 6 * p ** 2 * (1 - p) ** 2;    // 打满 5 局
      samples.push({ year: s.date.slice(0, 4), gap, pOver35, pOver45, y35: s.len >= 4 ? 1 : 0, y45: s.len >= 5 ? 1 : 0, len: s.len });
    }
    // 更新(系列内每张图都计入两队 map 胜率)
    for (const m of s.maps) { const a = get(m.a), b = get(m.b); a.n += 1; if (m.w === m.a) a.w += 1; b.n += 1; if (m.w === m.b) b.w += 1; }
  }

  const L = []; const P = (x) => L.push(x);
  P('# 系列赛局数(map_total)模型回测 / Series-length Calibration (认真版)');
  P('');
  const bo5all = series.filter((s) => s.isBO5);
  P(`- 数据: 聚成系列 ${series.length} 个, 其中 **BO5(赢家拿满3局) ${bo5all.length} 个**; 合格(双方>=${MIN_PRIOR}先验图)样本 ${samples.length} (2024 ${samples.filter((s) => s.year === '2024').length} / 2025 ${samples.filter((s) => s.year === '2025').length} / 2026 ${samples.filter((s) => s.year === '2026').length})。`);
  P(`- BO5 局数分布(全体): 3局 ${pc(bo5all.filter((s) => s.len === 3).length / bo5all.length)}, 4局 ${pc(bo5all.filter((s) => s.len === 4).length / bo5all.length)}, 5局 ${pc(bo5all.filter((s) => s.len === 5).length / bo5all.length)}`);
  P('');
  // ① 模型无关: 按 gap 四分位
  P('## ① 模型无关检验: 差距量级 vs 实际局数(不靠任何参数)');
  const sorted = [...samples].sort((a, b) => a.gap - b.gap);
  const q = (arr, p) => arr[Math.floor(p * arr.length)] ? arr[Math.floor(p * arr.length)].gap : 1;
  const cuts = [q(sorted, 0.25), q(sorted, 0.5), q(sorted, 0.75)];
  const bins = [{ lo: 0, hi: cuts[0], lbl: '最均势(差距 Q1)' }, { lo: cuts[0], hi: cuts[1], lbl: 'Q2' }, { lo: cuts[1], hi: cuts[2], lbl: 'Q3' }, { lo: cuts[2], hi: 1.01, lbl: '最悬殊(Q4)' }];
  P('| 差距桶 | n | 平均胜率差 | 实际 P(≥4局) | 实际 P(打满5局) | 平均局数 |');
  P('|---|---:|---:|---:|---:|---:|');
  for (const bn of bins) {
    const g = samples.filter((s) => s.gap >= bn.lo && s.gap < bn.hi);
    if (!g.length) continue;
    P(`| ${bn.lbl} | ${g.length} | ${f3(g.reduce((s, x) => s + x.gap, 0) / g.length)} | ${pc(g.filter((x) => x.y35).length / g.length)} | ${pc(g.filter((x) => x.y45).length / g.length)} | ${(g.reduce((s, x) => s + x.len, 0) / g.length).toFixed(2)} |`);
  }
  P('');
  P('> 若"最均势"桶的 P(≥4局)明显高于"最悬殊"桶 → 差距确实预测局数(信号存在)。');
  P('');
  // ② 校准版
  function metrics(rs, pk, yk) {
    const N = rs.length; if (!N) return {};
    const b = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 })); let br = 0, base = 0;
    const rate = rs.reduce((s, r) => s + r[yk], 0) / N;
    for (const r of rs) { let i = Math.floor(r[pk] * 10); if (i > 9) i = 9; if (i < 0) i = 0; b[i].n++; b[i].sp += r[pk]; b[i].sy += r[yk]; br += (r[pk] - r[yk]) ** 2; base += (rate - r[yk]) ** 2; }
    let e = 0; for (const x of b) if (x.n) e += (x.n / N) * Math.abs(x.sp / x.n - x.sy / x.n);
    return { ece: e, brier: br / N, baseBrier: base / N, n: N };
  }
  function boot(rs, pk, yk, seed) { const rng = mulberry32(seed); const v = []; for (let i = 0; i < BOOT; i++) { const pool = []; for (let j = 0; j < rs.length; j++) pool.push(rs[Math.floor(rng() * rs.length)]); const m = metrics(pool, pk, yk); v.push(m.baseBrier - m.brier); } v.sort((a, b) => a - b); return [v[25], v[975]]; }
  P('## ② 校准版概率(差距→二项式, 给下注用)');
  for (const [lbl, pk, yk] of [['over 3.5 (≥4局)', 'pOver35', 'y35'], ['over 4.5 (打满5局)', 'pOver45', 'y45']]) {
    const mAll = metrics(samples, pk, yk); const m25 = metrics(samples.filter((s) => s.year === '2025'), pk, yk);
    const sk = boot(samples, pk, yk, SEED);
    P(`**${lbl}**: 全样本 ECE ${pc(mAll.ece)}, 模型Brier ${f3(mAll.brier)} vs 基线 ${f3(mAll.baseBrier)}; skill(基线−模型) ${f3(mAll.baseBrier - mAll.brier)}, 95%CI [${f3(sk[0])}, ${f3(sk[1])}]; 2025外 ECE ${pc(m25.ece)}。`);
  }
  P('');
  P('## ③ 结论 / Verdict');
  const gapBins = bins.map((bn) => samples.filter((s) => s.gap >= bn.lo && s.gap < bn.hi)).filter((g) => g.length);
  const monotone = gapBins.length >= 2 && (gapBins[0].filter((x) => x.y35).length / gapBins[0].length) > (gapBins[gapBins.length - 1].filter((x) => x.y35).length / gapBins[gapBins.length - 1].length);
  const sk35 = boot(samples, 'pOver35', 'y35', SEED);
  P(`- 模型无关: 均势桶 P(≥4局) ${monotone ? '**>** ' : '**未明显高于** '} 悬殊桶 → 差距${monotone ? '能' : '难'}预测局数。`);
  P(`- 校准版 over3.5 skill 95%CI [${f3(sk35[0])}, ${f3(sk35[1])}] → ${sk35[0] > 0 ? '**有正 skill(CI 全正)**' : sk35[1] < 0 ? '负 skill' : '无显著 skill(CI 跨 0)'}。`);
  const go = monotone && sk35[0] > 0;
  P(`- **判定: ${go ? '✅ 信号成立 → 值得让 Codex 产品化系列局数模型(新增可下盘口)' : '❌ 信号不足/不稳 → 暂不落地, 别下 map_total'}**`);
  P('');
  P('> 注: 样本小(尤其分年/打满5局), CI 会宽。校准版用了固定尺度 K=2.2, 若 ECE 高是尺度问题、不一定是信号没; 模型无关那张表更能说明"信号在不在"。即便信号在, 仍有"市场也定价了"和"没历史局数报价→+EV 验不了"两堵墙。');
  process.stdout.write(L.join('\n') + '\n');
}
main();
