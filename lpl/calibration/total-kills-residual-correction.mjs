// 总杀模型 滚动残差自动校正(候选, 不上线)
// 思路: 用模型最近 K 张图的残差均值(actual-mean)自动纠偏, 替代手搓 -0.9。walk-forward。
// 验证: 对 2025 样本外, 校正后 ECE/Brier 是否优于原模型(且不破坏)。只用 CSV 里的 mean+actual+sigma, 无泄漏。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSV = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'total_kills_continuous_vs_scenario.csv');
const LINES = [24.5, 26.5, 28.5, 30.5, 32.5];
const KS = [20, 40, 60];

function erf(x) { const s = x < 0 ? -1 : 1; const z = Math.abs(x); const t = 1 / (1 + 0.3275911 * z); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z); return s * y; }
const cdf = (x, m, sd) => 0.5 * (1 + erf((x - m) / (sd * Math.SQRT2)));
const pc = (v) => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a';
const f3 = (v) => Number.isFinite(v) ? v.toFixed(3) : 'n/a';

// 去重成 per-map
const L = readFileSync(CSV, 'utf8').trim().split(/\r?\n/);
const h = L[0].split(','); const ix = (n) => h.indexOf(n);
const I = { yr: ix('split_year'), gid: ix('game_id'), date: ix('match_date'), tot: ix('total_kills'), mean: ix('continuous_mean'), sigma: ix('sigma') };
const seen = new Set(); const maps = [];
for (let i = 1; i < L.length; i += 1) {
  const c = L[i].split(','); const gid = c[I.gid]; if (seen.has(gid)) continue; seen.add(gid);
  const mean = Number(c[I.mean]), tot = Number(c[I.tot]), sg = Number(c[I.sigma]);
  if (!Number.isFinite(mean) || !Number.isFinite(tot)) continue;
  maps.push({ year: c[I.yr], date: c[I.date], gid, mean, tot, sigma: Number.isFinite(sg) ? sg : 7.6 });
}
maps.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
process.stdout.write(`per-map 样本: ${maps.length} (2024 ${maps.filter((m) => m.year === '2024').length} / 2025 ${maps.filter((m) => m.year === '2025').length})\n`);

// 整体偏置(诊断)
const mean25 = maps.filter((m) => m.year === '2025');
const bias24 = (() => { const r = maps.filter((m) => m.year === '2024'); return r.reduce((s, m) => s + (m.tot - m.mean), 0) / r.length; })();
const bias25 = mean25.reduce((s, m) => s + (m.tot - m.mean), 0) / mean25.length;
process.stdout.write(`平均残差(actual-mean): 2024 ${f3(bias24)}, 2025 ${f3(bias25)} (接近0=无漂移)\n\n`);

function calib(rows, meanFn) {
  // rows: maps; meanFn(idx)->corrected mean; 对每张图每条线算 under 概率与命中
  const recs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i]; const mu = meanFn(i, m);
    for (const ln of LINES) { recs.push({ p: cdf(ln, mu, m.sigma), y: m.tot < ln ? 1 : 0, year: m.year }); }
  }
  return recs;
}
function ece(recs) { const N = recs.length; if (!N) return NaN; const b = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 })); for (const r of recs) { let i = Math.floor(r.p * 10); if (i > 9) i = 9; if (i < 0) i = 0; b[i].n++; b[i].sp += r.p; b[i].sy += r.y; } let e = 0; for (const x of b) if (x.n) e += (x.n / N) * Math.abs(x.sp / x.n - x.sy / x.n); return e; }
const brier = (recs) => recs.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / recs.length;

// 原模型
const orig = calib(maps, (i, m) => m.mean);
const orig25 = orig.filter((r) => r.year === '2025');
process.stdout.write(`原模型 2025外: ECE ${pc(ece(orig25))}, Brier ${f3(brier(orig25))}\n\n`);

// 滚动残差校正: correction(i) = 最近 K 张图(i 之前)的残差均值
process.stdout.write('滚动残差校正候选(2025 样本外):\n');
process.stdout.write('K | 2025外 ECE | 2025外 Brier | vs原(ECE差)\n');
for (const K of KS) {
  const corr = calib(maps, (i) => {
    let s = 0, n = 0; for (let j = Math.max(0, i - K); j < i; j += 1) { s += (maps[j].tot - maps[j].mean); n += 1; }
    const c = n ? s / n : 0; return maps[i].mean + c;
  });
  const c25 = corr.filter((r) => r.year === '2025');
  process.stdout.write(`${K} | ${pc(ece(c25))} | ${f3(brier(c25))} | ${pc(ece(c25) - ece(orig25))}\n`);
}
process.stdout.write('\n判定提示: 若校正后 2025外 ECE 没明显下降, 说明 2025 本就无漂移、这数据测不出价值; 真正价值在 2026(本 CSV 没有, 需 Codex 接 2026 walk-forward 才能验)。\n');
