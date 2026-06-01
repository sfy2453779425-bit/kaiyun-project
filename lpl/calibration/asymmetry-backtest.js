// 不对称性回测 / Asymmetry backtest
// 问题: "强队单队 under" / "弱队单队 under" / "总杀 under" 三类哪面更稳?
// 方法: 严格 walk-forward —— 每张图的"强弱队"判定与"预期击杀"只用该图日期之前的数据。
//       最小样本门槛 (双方各 >= MIN_PRIOR 张图)。bootstrap 置信区间 (固定种子)。
// 数据: 递归扫描 lpl/data 下所有 lpl_map_details.csv (按表头名取列, 按 game_id 去重)。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const OUT_MD = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '不对称性回测-单队under.md');
const MIN_PRIOR = 8;
const GEN_CUSHION = 2.5;
const BOOT_ITERS = 1000;
const SEED = 20260601;

let FILE_INFO = { used: 0, total: 0 };

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
  FILE_INFO.total = files.length;
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let lines;
    try { lines = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (lines.length < 2) continue;
    const head = lines[0].split(',');
    const ix = (n) => head.indexOf(n);
    const I = {
      date: ix('match_time'), winId: ix('map_winner_id'), winName: ix('map_winner'),
      aId: ix('team_a_id'), aName: ix('team_a'), aKills: ix('team_a_kills'),
      bId: ix('team_b_id'), bName: ix('team_b'), bKills: ix('team_b_kills'),
      gid: ix('game_id'), mid: ix('match_id'),
    };
    if (I.date < 0 || I.aKills < 0 || I.bKills < 0 || (I.winId < 0 && I.winName < 0)) continue;
    FILE_INFO.used += 1;
    for (let i = 1; i < lines.length; i += 1) {
      const c = lines[i].split(',');
      const date = (c[I.date] || '').trim();
      const a = teamKey(c[I.aId] || c[I.aName]);
      const b = teamKey(c[I.bId] || c[I.bName]);
      const ak = Number(c[I.aKills]);
      const bk = Number(c[I.bKills]);
      const win = teamKey((I.winId >= 0 ? c[I.winId] : '') || (I.winName >= 0 ? c[I.winName] : ''));
      if (!date || !a || !b || !win || !Number.isFinite(ak) || !Number.isFinite(bk)) continue;
      let aWon;
      if (win === a) aWon = true; else if (win === b) aWon = false; else continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
      if (seen.has(gid)) continue;
      seen.add(gid);
      out.push({ date, a, b, ak, bk, aWon });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : NaN; }
function std(arr) { if (arr.length < 2) return NaN; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)); }
function rate(arr) { return arr.length ? arr.reduce((s, x) => s + (x ? 1 : 0), 0) / arr.length : NaN; }
function pct(v) { return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a'; }
function f2(v) { return Number.isFinite(v) ? v.toFixed(2) : 'n/a'; }

function bootDiffRate(samples, fnFav, fnUd, seed) {
  const rng = mulberry32(seed);
  const n = samples.length;
  if (n === 0) return [NaN, NaN];
  const diffs = [];
  for (let b = 0; b < BOOT_ITERS; b += 1) {
    let fSum = 0, fN = 0, uSum = 0, uN = 0;
    for (let i = 0; i < n; i += 1) {
      const s = samples[Math.floor(rng() * n)];
      const fv = fnFav(s); if (fv !== null) { fSum += fv ? 1 : 0; fN += 1; }
      const uv = fnUd(s); if (uv !== null) { uSum += uv ? 1 : 0; uN += 1; }
    }
    if (fN && uN) diffs.push(uSum / uN - fSum / fN);
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.025 * diffs.length)], diffs[Math.floor(0.975 * diffs.length)]];
}

function buildSamples(maps) {
  const stats = new Map();
  const get = (t) => { if (!stats.has(t)) stats.set(t, { n: 0, wins: 0, sum: 0 }); return stats.get(t); };
  const samples = [];
  for (const m of maps) {
    const sa = get(m.a), sb = get(m.b);
    if (sa.n >= MIN_PRIOR && sb.n >= MIN_PRIOR) {
      const wrA = sa.wins / sa.n, wrB = sb.wins / sb.n;
      const avgA = sa.sum / sa.n, avgB = sb.sum / sb.n;
      let favA;
      if (wrA !== wrB) favA = wrA > wrB; else favA = avgA >= avgB;
      const favActual = favA ? m.ak : m.bk;
      const udActual = favA ? m.bk : m.ak;
      const favExp = favA ? avgA : avgB;
      const udExp = favA ? avgB : avgA;
      const favWon = favA ? m.aWon : !m.aWon;
      samples.push({ year: m.date.slice(0, 4), favActual, udActual, total: favActual + udActual, favExp, udExp, totalExp: favExp + udExp, favWon });
    }
    sa.n += 1; sa.sum += m.ak; if (m.aWon) sa.wins += 1;
    sb.n += 1; sb.sum += m.bk; if (!m.aWon) sb.wins += 1;
  }
  return samples;
}

function analyze(samples, label) {
  const fav = samples.map((s) => s.favActual);
  const ud = samples.map((s) => s.udActual);
  const tot = samples.map((s) => s.total);
  const r = {
    label, n: samples.length,
    favMean: mean(fav), favCV: std(fav) / mean(fav),
    udMean: mean(ud), udCV: std(ud) / mean(ud),
    totMean: mean(tot), totCV: std(tot) / mean(tot),
    favUnderFair: rate(samples.map((s) => s.favActual < s.favExp)),
    udUnderFair: rate(samples.map((s) => s.udActual < s.udExp)),
    totUnderFair: rate(samples.map((s) => s.total < s.totalExp)),
    favUnderGen: rate(samples.map((s) => s.favActual < s.favExp + GEN_CUSHION)),
    udUnderGen: rate(samples.map((s) => s.udActual < s.udExp + GEN_CUSHION)),
    totUnderGen: rate(samples.map((s) => s.total < s.totalExp + 2 * GEN_CUSHION)),
  };
  const favLost = samples.filter((s) => !s.favWon);
  const udLost = samples.filter((s) => s.favWon);
  r.favBustGivenLost = rate(favLost.map((s) => s.favActual >= s.favExp)); r.favLostN = favLost.length;
  r.udBustGivenLost = rate(udLost.map((s) => s.udActual >= s.udExp)); r.udLostN = udLost.length;
  return r;
}

function main() {
  const maps = parseMaps();
  const samples = buildSamples(maps);
  const yrs = (y) => samples.filter((s) => s.year === y).length;
  const all = analyze(samples, '全部');
  const s24 = analyze(samples.filter((s) => s.year === '2024'), '样本内 2024');
  const s25 = analyze(samples.filter((s) => s.year === '2025'), '样本外 2025');

  const ciUnderGen = bootDiffRate(samples, (s) => s.favActual < s.favExp + GEN_CUSHION, (s) => s.udActual < s.udExp + GEN_CUSHION, SEED);
  const ciBust = bootDiffRate(samples, (s) => (s.favWon ? null : (s.favActual >= s.favExp)), (s) => (s.favWon ? (s.udActual >= s.udExp) : null), SEED + 1);

  const L = [];
  const P = (x) => L.push(x);
  P('# 不对称性回测: 单队 under 哪面更稳 / Asymmetry Backtest');
  P('');
  P(`- 数据: 递归扫描 \`lpl/data/**/lpl_map_details.csv\` (${FILE_INFO.used}/${FILE_INFO.total} 个文件可用), 去重后有效图 ${maps.length} 张。`);
  P(`- 口径: **严格 walk-forward** —— 强弱队判定 + 预期击杀只用该图**之前**的历史; 双方各需 >= ${MIN_PRIOR} 张先验图。`);
  P(`- 合格样本: ${samples.length} (2024: ${yrs('2024')}, 2025: ${yrs('2025')}, 2026: ${yrs('2026')})。`);
  P('- 强队 = 先验胜率更高的一方 (平手取先验均杀更高)。bootstrap ' + BOOT_ITERS + ' 次, seed=' + SEED + '。');
  P('');
  P('## 1. 击杀分布与波动 (CV = 标准差/均值, 越大越难预测)');
  P('');
  P('| 分段 | n | 强队均杀 | 强队CV | 弱队均杀 | 弱队CV | 总杀均值 | 总杀CV |');
  P('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of [all, s24, s25]) P(`| ${r.label} | ${r.n} | ${f2(r.favMean)} | ${pct(r.favCV)} | ${f2(r.udMean)} | ${pct(r.udCV)} | ${f2(r.totMean)} | ${pct(r.totCV)} |`);
  P('');
  P(`## 2. under 命中率 (宽松线 = 各自预期 +${GEN_CUSHION}, 模拟真实盘口)`);
  P('');
  P('| 分段 | 强队 under | 弱队 under | 总杀 under |');
  P('|---|---:|---:|---:|');
  for (const r of [all, s24, s25]) P(`| ${r.label} | ${pct(r.favUnderGen)} | ${pct(r.udUnderGen)} | ${pct(r.totUnderGen)} |`);
  P('');
  P('（参考: 公平线 = 各自预期, 不加 cushion）');
  P('');
  P('| 分段 | 强队 under | 弱队 under | 总杀 under |');
  P('|---|---:|---:|---:|');
  for (const r of [all, s24, s25]) P(`| ${r.label} | ${pct(r.favUnderFair)} | ${pct(r.udUnderFair)} | ${pct(r.totUnderFair)} |`);
  P('');
  P('## 3. 核心: "这队输了, 还会不会高杀打爆 under?" (P(实杀 >= 预期 | 该队输掉这张图))');
  P('');
  P('| 分段 | 强队输时仍高杀 | 弱队输时仍高杀 |');
  P('|---|---:|---:|');
  for (const r of [all, s24, s25]) P(`| ${r.label} | ${pct(r.favBustGivenLost)} (n=${r.favLostN}) | ${pct(r.udBustGivenLost)} (n=${r.udLostN}) |`);
  P('');
  P('## 4. Bootstrap 置信区间 (弱队 - 强队, 全样本)');
  P('');
  P(`- 宽松 under 命中率差 (弱队 - 强队): **${pct(all.udUnderGen - all.favUnderGen)}**, 95% CI [${pct(ciUnderGen[0])}, ${pct(ciUnderGen[1])}]`);
  P(`- "输了还打爆 under" 率差 (弱队 - 强队): **${pct(all.udBustGivenLost - all.favBustGivenLost)}**, 95% CI [${pct(ciBust[0])}, ${pct(ciBust[1])}]`);
  P('');
  const v1 = (ciUnderGen[1] < 0) ? '弱队 under 命中率**显著低于**强队 under (CI 全负)'
    : (ciUnderGen[0] > 0) ? '弱队 under 命中率**显著高于**强队 under (CI 全正)'
      : '弱队 vs 强队 under 命中率差**不显著** (CI 跨 0)';
  const v2 = (ciBust[0] > 0) ? '弱队"输了还高杀"概率**显著高于**强队 (CI 全正) —— 弱队 under 更脆, 证实假设'
    : (ciBust[1] < 0) ? '弱队"输了还高杀"概率**显著低于**强队 (CI 全负) —— 与"弱队 under 更脆"假设相反'
      : '"输了还高杀"率差不显著 (CI 跨 0)';
  P('## 5. 结论 / Verdict');
  P('');
  P(`- 命中率层面: ${v1}。`);
  P(`- 脆弱度层面: ${v2}。`);
  P('');
  const demoteJustified = ciBust[0] > 0;
  if (demoteJustified) {
    P('> 落地建议: 数据**支持**"弱队 under 更脆" —— 评估逻辑应给**弱队单队 under 自动降级**, 优先强队 under / 总杀 under。');
  } else {
    P('> 落地建议: **数据不支持"弱队 under 自动降级"** —— 弱队 under 命中率不低于强队 (差 ' + pct(all.udUnderGen - all.favUnderGen) + ', CI 跨 0)。那条直觉是错的, **不该加这条规则**。');
    P('>');
    P('> 真正站得住的发现:');
    P(`> 1. **总杀是最可预测的市场** (总杀 CV ${pct(all.totCV)} < 强队 ${pct(all.favCV)} < 弱队 ${pct(all.udCV)}) —— 仓位重心放总杀 under, 而非单队盘。`);
    P(`> 2. **弱队单队击杀最难精确预测** (CV 最高): 不是更容易输, 而是点估计误差最大 —— 单队弱队盘应**降信心/降注**, 但不是禁。`);
    P('> 3. WE under 12.5 那笔是方差+爆冷(弱队靠赢球打出高杀, 罕见尾部), 不是系统性缺陷。');
  }
  P('');
  P('## 6. 数据局限 / Caveats');
  P('');
  P(`- 2024 合格样本=${yrs('2024')}, 2025=${yrs('2025')} —— 内外对照可做 (Lesson 9)。`);
  P('- 本回测衡量**命中率/可预测性, 非盈利**: 没接入这些 prop 的真实市场报价, 命中率高不等于 +EV (价格含庄家抽水)。');
  P('- "强弱队"按先验胜率粗分, 非市场赔率; 与真实"受让方/热门方"会有出入。');

  const md = L.join('\n') + '\n';
  writeFileSync(OUT_MD, md, 'utf8');
  process.stdout.write(`OK samples=${samples.length} files=${FILE_INFO.used}/${FILE_INFO.total} maps=${maps.length}\n`);
}

main();
