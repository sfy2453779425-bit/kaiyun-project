// 时间盘校准回测 / Game-time calibration (认真版, 与总杀同标准)
// 模型: 单局时长 ~ Normal(mean, sigma); mean=两队先验均时长平均, sigma=联盟先验时长标准差。全 walk-forward。
// 检验: ECE(诚实度) + Brier vs 无队伍基线(skill) + bootstrap CI; 分 2024/2025。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const MIN_TEAM_PRIOR = 8, MIN_LEAGUE = 50;
const LINES = [27, 29, 31, 33, 35];
const BET_BAND = [0.60, 0.80];
const BOOT = 1000, SEED = 20260601;

function listFiles(dir) { const o = []; for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) o.push(...listFiles(f)); else if (e.name === 'lpl_map_details.csv') o.push(f); } return o; }
function parseMaps() {
  const seen = new Set(); const out = [];
  for (const f of listFiles(DATA_DIR)) {
    let L; try { L = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (L.length < 2) continue;
    const h = L[0].split(','); const ix = (n) => h.indexOf(n);
    const I = { date: ix('match_time'), aId: ix('team_a_id'), aN: ix('team_a'), bId: ix('team_b_id'), bN: ix('team_b'), gt: ix('game_time_min'), gid: ix('game_id'), mid: ix('match_id') };
    if (I.date < 0 || I.gt < 0) continue;
    for (let i = 1; i < L.length; i += 1) {
      const c = L[i].split(',');
      const date = (c[I.date] || '').trim(); const a = teamKey(c[I.aId] || c[I.aN]); const b = teamKey(c[I.bId] || c[I.bN]); const gt = Number(c[I.gt]);
      if (!date || !a || !b || !Number.isFinite(gt) || gt < 10 || gt > 70) continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
      if (seen.has(gid)) continue; seen.add(gid);
      out.push({ date, a, b, gt });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}
function mulberry32(s) { let a = s >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function erf(x) { const s = x < 0 ? -1 : 1; const z = Math.abs(x); const t = 1 / (1 + 0.3275911 * z); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z); return s * y; }
const cdf = (x, m, sd) => 0.5 * (1 + erf((x - m) / (sd * Math.SQRT2)));
const pc = (v) => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a';
const f3 = (v) => Number.isFinite(v) ? v.toFixed(3) : 'n/a';

function build(maps) {
  const team = new Map(); const get = (t) => { if (!team.has(t)) team.set(t, { n: 0, sum: 0 }); return team.get(t); };
  let gSum = 0, gSumSq = 0, gN = 0;          // 联盟时长 running mean/sd
  const lineBase = new Map(LINES.map((L) => [L, { over: 0, n: 0 }]));  // walk-forward 基线 over 率
  const mapRecs = [];
  for (const m of maps) {
    const ta = get(m.a), tb = get(m.b);
    if (ta.n >= MIN_TEAM_PRIOR && tb.n >= MIN_TEAM_PRIOR && gN >= MIN_LEAGUE) {
      const mean = (ta.sum / ta.n + tb.sum / tb.n) / 2;
      const lmean = gSum / gN; const sd = Math.sqrt(Math.max(gSumSq / gN - lmean * lmean, 1));
      const recs = [];
      for (const L of LINES) {
        const pOver = 1 - cdf(L, mean, sd);
        const lb = lineBase.get(L); const base = lb.n >= 30 ? lb.over / lb.n : 0.5;
        const y = m.gt > L ? 1 : 0;
        recs.push({ line: L, p: pOver, base, y });
      }
      mapRecs.push({ year: m.date.slice(0, 4), recs, mean, actual: m.gt });
    }
    // 更新
    ta.n += 1; ta.sum += m.gt; tb.n += 1; tb.sum += m.gt;
    gSum += m.gt; gSumSq += m.gt * m.gt; gN += 1;
    for (const L of LINES) { const lb = lineBase.get(L); lb.n += 1; if (m.gt > L) lb.over += 1; }
  }
  return mapRecs;
}
const flat = (mr) => mr.flatMap((x) => x.recs);
function reliability(recs, key = 'p') { const b = Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 })); for (const r of recs) { let i = Math.floor(r[key] * 10); if (i > 9) i = 9; if (i < 0) i = 0; b[i].n++; b[i].sp += r[key]; b[i].sy += r.y; } return b; }
function ece(recs, key = 'p') { const N = recs.length; if (!N) return NaN; let e = 0; for (const b of reliability(recs, key)) if (b.n) e += (b.n / N) * Math.abs(b.sp / b.n - b.sy / b.n); return e; }
const brier = (recs, key) => recs.length ? recs.reduce((s, r) => s + (r[key] - r.y) ** 2, 0) / recs.length : NaN;
function bootECEandSkill(mr, seed) {
  const rng = mulberry32(seed); const eceV = [], skV = [];
  for (let b = 0; b < BOOT; b++) { const pool = []; for (let i = 0; i < mr.length; i++) { for (const r of mr[Math.floor(rng() * mr.length)].recs) pool.push(r); } eceV.push(ece(pool, 'p')); skV.push(brier(pool, 'base') - brier(pool, 'p')); }
  eceV.sort((a, b) => a - b); skV.sort((a, b) => a - b);
  return { eceCI: [eceV[25], eceV[975]], skCI: [skV[25], skV[975]] };
}

function main() {
  const maps = parseMaps();
  const mr = build(maps);
  const all = flat(mr), r24 = flat(mr.filter((x) => x.year === '2024')), r25 = flat(mr.filter((x) => x.year === '2025'));
  const L = [];
  const P = (x) => L.push(x);
  P('# 时间盘校准回测 / Game-time Calibration (认真版)');
  P('');
  P(`- 数据: 全 lpl_map_details.csv 的 game_time_min, 有效图 ${maps.length}, 合格(双方>=${MIN_TEAM_PRIOR}先验) ${mr.length}。`);
  P(`- 模型: 单局时长~Normal(均=两队先验均时长平均, sd=联盟先验时长标准差), walk-forward。线 grid: ${LINES.join(',')} 分钟。`);
  P(`- 联盟时长均值/标准差(最终): ${(maps.reduce((s, m) => s + m.gt, 0) / maps.length).toFixed(1)} / ${Math.sqrt(maps.reduce((s, m) => s + m.gt * m.gt, 0) / maps.length - (maps.reduce((s, m) => s + m.gt, 0) / maps.length) ** 2).toFixed(1)} 分钟。`);
  P('');
  P('## 1. 可靠性曲线 (全样本; 模型说 vs 实际 over 率)');
  P('| p_over 区间 | n | 模型说 | 实际 | 偏差 |');
  P('|---|---:|---:|---:|---:|');
  reliability(all).forEach((b, i) => { if (b.n) P(`| ${i * 10}-${i * 10 + 10}% | ${b.n} | ${pc(b.sp / b.n)} | ${pc(b.sy / b.n)} | ${(b.sy / b.n - b.sp / b.n) >= 0 ? '+' : ''}${pc(b.sy / b.n - b.sp / b.n)} |`); });
  P('');
  const eAll = ece(all), eAll25 = ece(r25); const { eceCI, skCI } = bootECEandSkill(mr, SEED);
  P('## 2. ECE / Brier / skill');
  P('| 分段 | n | ECE | 模型Brier | 基线Brier | 模型−基线 |');
  P('|---|---:|---:|---:|---:|---:|');
  for (const [lab, rs] of [['全部', all], ['样本内2024', r24], ['样本外2025', r25]]) P(`| ${lab} | ${rs.length} | ${pc(ece(rs))} | ${f3(brier(rs, 'p'))} | ${f3(brier(rs, 'base'))} | ${(brier(rs, 'p') - brier(rs, 'base')) >= 0 ? '+' : ''}${f3(brier(rs, 'p') - brier(rs, 'base'))} |`);
  P('');
  P(`- 全样本 ECE **${pc(eAll)}**, 95% CI [${pc(eceCI[0])}, ${pc(eceCI[1])}]`);
  P(`- skill(基线−模型 Brier, >0=模型有用) **${f3(brier(all, 'base') - brier(all, 'p'))}**, 95% CI [${f3(skCI[0])}, ${f3(skCI[1])}]`);
  P('');
  const band = all.filter((r) => r.p >= BET_BAND[0] && r.p < BET_BAND[1]);
  P('## 3. 下注区间诚实度 (p_over ∈ [60%,80%])');
  P(`- n=${band.length}, 模型平均说 ${pc(band.reduce((s, r) => s + r.p, 0) / band.length)}, 实际 over ${pc(band.reduce((s, r) => s + r.y, 0) / band.length)}`);
  P('');
  const honest = eAll < 0.05 ? '诚实(ECE<5%)' : eAll < 0.10 ? '基本诚实(5-10%)' : '明显失真(>10%)';
  const hasSkill = skCI[0] > 0 ? '有 skill(CI 全正)' : skCI[1] < 0 ? '负 skill' : '无显著 skill(CI 跨 0)';
  P('## 4. 结论 / Verdict');
  P(`- 诚实度: **${honest}** (ECE ${pc(eAll)}, 2025外 ${pc(eAll25)})`);
  P(`- skill: **${hasSkill}**`);
  const lift = eAll < 0.06 && skCI[0] > 0;
  P(`- **解禁判定: ${lift ? '✅ 校准好+有skill → 可考虑解禁时间盘(真钱小注)' : '❌ 不达标 → 时间盘维持封禁(它输过钱, 没翻案数据)'}**`);
  P('');
  P('> 注: 校准 ≠ 盈利, 即便解禁也需结合真实报价+线差阈值, 且仍受单日/相关性等纪律约束。模型只是这个粗 Normal 估计; 若想要更准的时间模型需 Codex 另建。');
  process.stdout.write(L.join('\n') + '\n');
}
main();
