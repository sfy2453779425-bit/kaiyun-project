// 总杀模型校准 / Total-kills model calibration
// 问题: 现行总杀公式 P(under)=1-logistic((mean-line)/3.8) 说"70%"时, 实际真有 ~70% 吗?
//       它比"无脑基线"强吗? (有没有 skill)
// 方法: 严格 walk-forward —— 每张图的 mean 只用该图之前两队的历史总杀; 基线用该图之前的全联盟 under 频率。
//       多条线 grid 取样; 按 MAP 做 cluster bootstrap(同一张图的多条线相关)。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const OUT_MD = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '总杀校准-可靠性曲线.md');
const MIN_PRIOR = 8;
const SCALE = 3.8;                 // 现行公式的 logistic 尺度
const CLAMP = [0.05, 0.95];        // 现行公式的截断
const LINES = [22.5, 24.5, 26.5, 28.5, 30.5, 32.5, 34.5];
const BET_BAND = [0.65, 0.80];     // 我们真实 under 注的 model_p 区间
const BOOT = 1000;
const SEED = 20260601;

function logistic(x) { return 1 / (1 + Math.exp(-x)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
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
      date: ix('match_time'), aId: ix('team_a_id'), aName: ix('team_a'), aKills: ix('team_a_kills'),
      bId: ix('team_b_id'), bName: ix('team_b'), bKills: ix('team_b_kills'),
      tot: ix('total_kills'), gid: ix('game_id'), mid: ix('match_id'),
    };
    if (I.date < 0 || I.aKills < 0 || I.bKills < 0) continue;
    for (let i = 1; i < lines.length; i += 1) {
      const c = lines[i].split(',');
      const date = (c[I.date] || '').trim();
      const a = teamKey(c[I.aId] || c[I.aName]);
      const b = teamKey(c[I.bId] || c[I.bName]);
      const ak = Number(c[I.aKills]);
      const bk = Number(c[I.bKills]);
      let total = I.tot >= 0 ? Number(c[I.tot]) : NaN;
      if (!Number.isFinite(total)) total = ak + bk;
      if (!date || !a || !b || !Number.isFinite(total)) continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
      if (seen.has(gid)) continue;
      seen.add(gid);
      out.push({ date, a, b, total });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

// 走一遍生成 per-map 记录: 每张合格图在每条线上的 (model_p_under, baseline_p_under, outcome_under)
function buildRecords(maps, scale = SCALE, delta = 0) {
  const teamHist = new Map();   // team -> {n, sum} 该队历史总杀
  const getT = (t) => { if (!teamHist.has(t)) teamHist.set(t, { n: 0, sum: 0 }); return teamHist.get(t); };
  const globalTotals = [];      // 全联盟历史每图总杀 (基线用)
  const mapRecs = [];           // 每张图一个 {year, recs:[{p,base,y}]}
  for (const m of maps) {
    const ta = getT(m.a), tb = getT(m.b);
    if (ta.n >= MIN_PRIOR && tb.n >= MIN_PRIOR && globalTotals.length >= 50) {
      const mean = (ta.sum / ta.n + tb.sum / tb.n) / 2 + delta;
      const recs = [];
      for (const L of LINES) {
        const pOver = clamp(logistic((mean - L) / scale), CLAMP[0], CLAMP[1]);
        const pUnder = 1 - pOver;
        // 基线: 该图之前全联盟 under L 的频率 (无队伍信息)
        let belowCount = 0;
        for (const t of globalTotals) if (t < L) belowCount += 1;
        const baseUnder = clamp(belowCount / globalTotals.length, 0.001, 0.999);
        const yUnder = m.total < L ? 1 : 0;
        recs.push({ line: L, p: pUnder, base: baseUnder, y: yUnder });
      }
      mapRecs.push({ year: m.date.slice(0, 4), recs });
    }
    // 记录后更新 (本图不泄漏给自己)
    ta.n += 1; ta.sum += m.total;
    tb.n += 1; tb.sum += m.total;
    globalTotals.push(m.total);
  }
  return mapRecs;
}

function flat(mapRecs) { return mapRecs.flatMap((mr) => mr.recs); }

function brier(recs, key) { return recs.length ? recs.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / recs.length : NaN; }

function reliability(recs) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const r of recs) {
    let b = Math.floor(r.p * 10); if (b > 9) b = 9; if (b < 0) b = 0;
    bins[b].n += 1; bins[b].sumP += r.p; bins[b].sumY += r.y;
  }
  return bins.map((b, i) => ({
    band: `${i * 10}-${i * 10 + 10}%`,
    n: b.n,
    predicted: b.n ? b.sumP / b.n : NaN,
    actual: b.n ? b.sumY / b.n : NaN,
  }));
}

function ece(recs) {
  const bins = reliability(recs);
  const N = recs.length;
  let e = 0;
  for (const b of bins) if (b.n) e += (b.n / N) * Math.abs(b.predicted - b.actual);
  return e;
}

function bootCI(mapRecs, statFn, seed) {
  const rng = mulberry32(seed);
  const n = mapRecs.length;
  if (!n) return [NaN, NaN];
  const vals = [];
  for (let b = 0; b < BOOT; b += 1) {
    const pool = [];
    for (let i = 0; i < n; i += 1) { const mr = mapRecs[Math.floor(rng() * n)]; for (const r of mr.recs) pool.push(r); }
    vals.push(statFn(pool));
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

function segment(mapRecs, label) {
  const recs = flat(mapRecs);
  const rel = reliability(recs);
  const bModel = brier(recs, 'p');
  const bBase = brier(recs, 'base');
  const bNaive = recs.length ? recs.reduce((s, r) => s + (0.5 - r.y) ** 2, 0) / recs.length : NaN;
  const e = ece(recs);
  // 我们真实下注区间 [0.65,0.80] 的诚实度
  const band = recs.filter((r) => r.p >= BET_BAND[0] && r.p < BET_BAND[1]);
  const bandPred = band.length ? band.reduce((s, r) => s + r.p, 0) / band.length : NaN;
  const bandAct = band.length ? band.reduce((s, r) => s + r.y, 0) / band.length : NaN;
  return { label, nMaps: mapRecs.length, nRecs: recs.length, rel, bModel, bBase, bNaive, ece: e, bandN: band.length, bandPred, bandAct };
}

function main() {
  const maps = parseMaps();
  const mapRecs = buildRecords(maps);
  const all = mapRecs;
  const m24 = mapRecs.filter((mr) => mr.year === '2024');
  const m25 = mapRecs.filter((mr) => mr.year === '2025');
  const segAll = segment(all, '全部');
  const seg24 = segment(m24, '样本内 2024');
  const seg25 = segment(m25, '样本外 2025');

  const ciEce = bootCI(all, ece, SEED);
  const ciSkill = bootCI(all, (pool) => brier(pool, 'base') - brier(pool, 'p'), SEED + 1); // >0 = 模型比基线好

  const L = [];
  const P = (x) => L.push(x);
  P('# 总杀模型校准: 它的"70%"诚实吗? / Total-kills Calibration');
  P('');
  P(`- 数据: 递归扫描 \`lpl/data/**/lpl_map_details.csv\`, 去重后 ${maps.length} 张图。`);
  P(`- 被校准对象: 现行公式 \`P(under)=1-clamp(logistic((mean-line)/${SCALE}),${CLAMP[0]},${CLAMP[1]})\`, mean=两队先验场均总杀的平均(walk-forward)。`);
  P(`- 基线(无队伍信息): 该图之前全联盟 under 频率。线 grid: ${LINES.join(', ')}。`);
  P(`- 合格图: ${all.length} (2024: ${m24.length}, 2025: ${m25.length}); 每图 ${LINES.length} 条线。cluster bootstrap 按图重采样, ${BOOT} 次, seed=${SEED}。`);
  P('');
  P('## 1. 可靠性曲线 (全样本; predicted 应 ≈ actual 才叫诚实)');
  P('');
  P('| model_p 区间 | n | 模型说(predicted) | 实际(actual) | 偏差 |');
  P('|---|---:|---:|---:|---:|');
  for (const b of segAll.rel) {
    if (!b.n) continue;
    const diff = b.actual - b.predicted;
    P(`| ${b.band} | ${b.n} | ${pct(b.predicted)} | ${pct(b.actual)} | ${diff >= 0 ? '+' : ''}${pct(diff)} |`);
  }
  P('');
  P(`- **ECE (期望校准误差)**: ${pct(segAll.ece)}, 95% CI [${pct(ciEce[0])}, ${pct(ciEce[1])}] (越小越诚实; <5% 算不错, >10% 偏差明显)。`);
  P('');
  P('## 2. 有没有 skill (Brier, 越低越好)');
  P('');
  P('| 分段 | n图 | 模型 Brier | 基线 Brier(无队伍信息) | 无脑0.5 Brier | 模型−基线 |');
  P('|---|---:|---:|---:|---:|---:|');
  for (const s of [segAll, seg24, seg25]) {
    P(`| ${s.label} | ${s.nMaps} | ${f3(s.bModel)} | ${f3(s.bBase)} | ${f3(s.bNaive)} | ${(s.bModel - s.bBase) >= 0 ? '+' : ''}${f3(s.bModel - s.bBase)} |`);
  }
  P('');
  P(`- 模型 vs 基线 Brier 差 (基线−模型, >0=模型更好): **${f3(segAll.bBase - segAll.bModel)}**, 95% CI [${f3(ciSkill[0])}, ${f3(ciSkill[1])}]。`);
  P('');
  P('## 3. 我们真实下注区间的诚实度 (model_p ∈ [65%,80%])');
  P('');
  P('| 分段 | 该区间样本 | 模型平均说 | 实际 under 率 |');
  P('|---|---:|---:|---:|');
  for (const s of [segAll, seg24, seg25]) {
    P(`| ${s.label} | ${s.bandN} | ${pct(s.bandPred)} | ${pct(s.bandAct)} |`);
  }
  P('');
  P('## 4. 结论 / Verdict');
  P('');
  const honest = segAll.ece < 0.05 ? '诚实(ECE<5%)' : segAll.ece < 0.10 ? '基本诚实但有偏(ECE 5-10%)' : '明显失真(ECE>10%)';
  const hasSkill = ciSkill[0] > 0 ? '有 skill(模型显著优于无队伍基线, CI 全正)'
    : ciSkill[1] < 0 ? '负 skill(模型比基线还差, CI 全负)'
      : '无显著 skill(模型 vs 基线 CI 跨 0)';
  P(`- 诚实度: **${honest}**, ECE=${pct(segAll.ece)}。`);
  P(`- skill: **${hasSkill}**。`);
  const bandHonest = Number.isFinite(segAll.bandPred) && Number.isFinite(segAll.bandAct)
    ? `下注区间: 模型说 ${pct(segAll.bandPred)}, 实际 ${pct(segAll.bandAct)} (${segAll.bandAct >= segAll.bandPred - 0.03 ? '兑现/略保守, 可继续' : '高估, 真实命中不如标称→该降注或修尺度'})`
    : '下注区间样本不足';
  P(`- ${bandHonest}。`);
  P('');
  P('> 注: 本校准只验证"概率诚实度/可预测性", **未接市场报价**, 不等于 +EV(价格含抽水)。下注区间诚实 + 有 skill 才是"可小注", 真盈利仍需对真实总杀盘报价算 ROI。');
  P('> 公式被 clamp 在 [0.05,0.95], 两端无法完美校准, 属已知上限。');
  P('');
  P('## 5. 修正方向探索 (尺度 scale 与均值偏置 delta 的网格)');
  P('');
  P('目标: 让下注区间的"模型说" ≈ "实际", 且 ECE 最小。delta>0 = 给 mean 加偏置(补 meta 涨势)。');
  P('');
  P('| scale | mean+delta | ECE | 65-80% 区间模型说 | 实际 |');
  P('|---:|---:|---:|---:|---:|');
  const combos = [
    [3.8, 0], [5.0, 0], [6.0, 0],
    [3.8, 2], [3.8, 3], [5.0, 2], [5.5, 2.5], [6.0, 3],
  ];
  let best = null;
  for (const [sc, dl] of combos) {
    const recs = flat(buildRecords(maps, sc, dl));
    const e = ece(recs);
    const band = recs.filter((r) => r.p >= BET_BAND[0] && r.p < BET_BAND[1]);
    const bp = band.length ? band.reduce((s, r) => s + r.p, 0) / band.length : NaN;
    const ba = band.length ? band.reduce((s, r) => s + r.y, 0) / band.length : NaN;
    const gap = Math.abs((bp || 0) - (ba || 0));
    P(`| ${sc} | +${dl} | ${pct(e)} | ${pct(bp)} | ${pct(ba)} |`);
    if (best === null || e < best.e) best = { sc, dl, e, bp, ba, gap };
  }
  P('');
  P(`- ECE 最小的组合: **scale=${best.sc}, mean+${best.dl}** → ECE ${pct(best.e)}, 下注区间 模型 ${pct(best.bp)} vs 实际 ${pct(best.ba)}。`);
  P('- 解读: 若需要 **delta>0** 才校准, 说明静态均值系统性偏低(meta 击杀涨势没跟上) —— 印证"该上带版本杀率+近期衰减的连续总杀模型"(Codex 任务)。');

  const md = L.join('\n') + '\n';
  writeFileSync(OUT_MD, md, 'utf8');
  process.stdout.write(`OK maps=${maps.length} qualMaps=${all.length} recs=${segAll.nRecs} ECE=${pct(segAll.ece)} skillCI=[${f3(ciSkill[0])},${f3(ciSkill[1])}]\n`);
}

main();
