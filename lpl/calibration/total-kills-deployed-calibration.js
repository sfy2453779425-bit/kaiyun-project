// 已部署连续总杀模型的校准 / Calibration of the DEPLOYED continuous total-kills model
// 用 Codex 的 walk-forward 预测明细 total_kills_continuous_vs_scenario.csv (含 p_continuous, outcome)
// 问题: 部署模型说"70% under"时, 实际真有 ~70% 吗? (Codex 只报了 Brier, 没报校准)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CSV = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'total_kills_continuous_vs_scenario.csv');
const OUT_MD = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '总杀校准-已部署模型.md');
const BET_BAND = [0.65, 0.80];
const BOOT = 1000;
const SEED = 20260601;

function pct(v) { return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a'; }
function f3(v) { return Number.isFinite(v) ? v.toFixed(3) : 'n/a'; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parse() {
  const L = readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
  const h = L[0].split(',');
  const ix = (n) => h.indexOf(n);
  const I = { year: ix('split_year'), gid: ix('game_id'), line: ix('line'), sel: ix('selection'), out: ix('outcome'), pc: ix('p_continuous'), pb: ix('p_baseline') };
  const rows = [];
  for (let i = 1; i < L.length; i += 1) {
    const c = L[i].split(',');
    const y = Number(c[I.out]);
    const p = Number(c[I.pc]);
    const b = Number(c[I.pb]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    rows.push({ year: (c[I.year] || '').slice(0, 4), gid: c[I.gid], line: c[I.line], sel: c[I.sel], y, p, b });
  }
  return rows;
}

function reliability(rows, key) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 }));
  for (const r of rows) {
    let bi = Math.floor(r[key] * 10); if (bi > 9) bi = 9; if (bi < 0) bi = 0;
    bins[bi].n += 1; bins[bi].sp += r[key]; bins[bi].sy += r.y;
  }
  return bins.map((b, i) => ({ band: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? b.sp / b.n : NaN, actual: b.n ? b.sy / b.n : NaN }));
}
function ece(rows, key) {
  const N = rows.length; if (!N) return NaN;
  let e = 0;
  for (const b of reliability(rows, key)) if (b.n) e += (b.n / N) * Math.abs(b.predicted - b.actual);
  return e;
}
function brier(rows, key) { return rows.length ? rows.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / rows.length : NaN; }

// cluster bootstrap by game_id
function bootECE(rows, key, seed) {
  const byGid = new Map();
  for (const r of rows) { if (!byGid.has(r.gid)) byGid.set(r.gid, []); byGid.get(r.gid).push(r); }
  const groups = [...byGid.values()];
  const rng = mulberry32(seed);
  const vals = [];
  for (let b = 0; b < BOOT; b += 1) {
    const pool = [];
    for (let i = 0; i < groups.length; i += 1) { const g = groups[Math.floor(rng() * groups.length)]; for (const r of g) pool.push(r); }
    vals.push(ece(pool, key));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

function band(rows) {
  const u = rows.filter((r) => r.sel === 'under' && r.p >= BET_BAND[0] && r.p < BET_BAND[1]);
  const pred = u.length ? u.reduce((s, r) => s + r.p, 0) / u.length : NaN;
  const act = u.length ? u.reduce((s, r) => s + r.y, 0) / u.length : NaN;
  return { n: u.length, pred, act };
}

function main() {
  const all = parse();
  const r25 = all.filter((r) => r.year === '2025');
  const r24 = all.filter((r) => r.year === '2024');

  const L = [];
  const P = (x) => L.push(x);
  P('# 已部署连续总杀模型: 校准检查 / Deployed Model Calibration');
  P('');
  P(`- 数据: \`total_kills_continuous_vs_scenario.csv\` 的 walk-forward 预测, ${all.length} 条 (2024: ${r24.length}, 2025 OOS: ${r25.length})。`);
  P('- 被检对象: **已部署的** `predictTotalKills` (deploy=true)。Codex 已证它 Brier 优于剧本; 这里补 Codex 没做的**校准诚实度**。');
  P('');
  P('## 1. 可靠性曲线 (2025 样本外; predicted 应 ≈ actual)');
  P('');
  P('| model_p 区间 | n | 模型说 | 实际 | 偏差 |');
  P('|---|---:|---:|---:|---:|');
  for (const b of reliability(r25, 'p')) {
    if (!b.n) continue;
    const d = b.actual - b.predicted;
    P(`| ${b.band} | ${b.n} | ${pct(b.predicted)} | ${pct(b.actual)} | ${d >= 0 ? '+' : ''}${pct(d)} |`);
  }
  P('');
  const e25 = ece(r25, 'p'); const ci25 = bootECE(r25, 'p', SEED);
  const e25b = ece(r25, 'b');
  P(`- **ECE 2025 样本外 (连续模型)**: ${pct(e25)}, 95% CI [${pct(ci25[0])}, ${pct(ci25[1])}]。`);
  P(`- 对照 ECE 2025 (老剧本模型): ${pct(e25b)}。`);
  P('');
  P('## 2. ECE / Brier 汇总');
  P('');
  P('| 分段 | n | 连续 ECE | 剧本 ECE | 连续 Brier | 剧本 Brier |');
  P('|---|---:|---:|---:|---:|---:|');
  for (const [lab, rs] of [['全部', all], ['样本内 2024', r24], ['样本外 2025', r25]]) {
    P(`| ${lab} | ${rs.length} | ${pct(ece(rs, 'p'))} | ${pct(ece(rs, 'b'))} | ${f3(brier(rs, 'p'))} | ${f3(brier(rs, 'b'))} |`);
  }
  P('');
  P('## 3. 我们真实下注区间的诚实度 (under, model_p ∈ [65%,80%])');
  P('');
  P('| 分段 | 样本 | 模型平均说 | 实际 under 率 |');
  P('|---|---:|---:|---:|');
  for (const [lab, rs] of [['全部', all], ['样本内 2024', r24], ['样本外 2025', r25]]) {
    const bd = band(rs);
    P(`| ${lab} | ${bd.n} | ${pct(bd.pred)} | ${pct(bd.act)} |`);
  }
  P('');
  const bd25 = band(r25);
  const honest25 = e25 < 0.05 ? '诚实(ECE<5%)' : e25 < 0.10 ? '基本诚实但有偏(5-10%)' : '明显失真(>10%)';
  const bandGap = bd25.pred - bd25.act;
  P('## 4. 结论 / Verdict');
  P('');
  P(`- 2025 样本外校准: **${honest25}**, ECE=${pct(e25)}。`);
  P(`- 下注区间 (under 65-80%): 2025 模型说 ${pct(bd25.pred)}, 实际 ${pct(bd25.act)} → ${Math.abs(bandGap) < 0.03 ? '基本兑现, 可按标称小注' : bandGap > 0 ? `高估 ${pct(bandGap)}, 真钱该把概率打 ~${pct(bandGap)} 折再算 EV/stake` : `偏保守 ${pct(-bandGap)}, 实际更好`}。`);
  P('');
  P('> 注: 校准诚实 ≠ 盈利。仍未接市场报价, ROI 待每日采价。');

  const md = L.join('\n') + '\n';
  writeFileSync(OUT_MD, md, 'utf8');
  process.stdout.write(`OK rows=${all.length} oos=${r25.length} ECE25=${pct(e25)} bandPred=${pct(bd25.pred)} bandAct=${pct(bd25.act)}\n`);
}

main();
