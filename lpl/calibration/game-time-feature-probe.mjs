// 时间盘 模型无关探查: 单局时长 吃不吃 实力差/均时长 特征?
// 全 walk-forward。算 corr(特征, 实际时长) + 按实力差分桶看实际时长。signal 弱就别建。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';
const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const MIN_PRIOR = 8;
function listFiles(dir) { const o = []; for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) o.push(...listFiles(f)); else if (e.name === 'lpl_map_details.csv') o.push(f); } return o; }
function parseMaps() {
  const seen = new Set(); const out = [];
  for (const f of listFiles(DATA_DIR)) {
    let L; try { L = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (L.length < 2) continue;
    const h = L[0].split(','); const ix = (n) => h.indexOf(n);
    const I = { date: ix('match_time'), aId: ix('team_a_id'), aN: ix('team_a'), bId: ix('team_b_id'), bN: ix('team_b'), gt: ix('game_time_min'), win: ix('map_winner_id'), winN: ix('map_winner'), gid: ix('game_id') };
    if (I.date < 0 || I.gt < 0) continue;
    for (let i = 1; i < L.length; i += 1) {
      const c = L[i].split(',');
      const date = (c[I.date] || '').trim(); const a = teamKey(c[I.aId] || c[I.aN]); const b = teamKey(c[I.bId] || c[I.bN]); const gt = Number(c[I.gt]);
      const w = teamKey((I.win >= 0 ? c[I.win] : '') || (I.winN >= 0 ? c[I.winN] : ''));
      if (!date || !a || !b || !Number.isFinite(gt) || gt < 10 || gt > 70) continue;
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${date}|${i}`;
      if (seen.has(gid)) continue; seen.add(gid);
      out.push({ date, a, b, gt, w });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function corr(xs, ys) { const mx = mean(xs), my = mean(ys); let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; } return sxy / Math.sqrt(sx * sy); }

const maps = parseMaps();
const team = new Map(); const get = (t) => { if (!team.has(t)) team.set(t, { n: 0, w: 0, gt: 0 }); return team.get(t); };
const samples = [];
for (const m of maps) {
  const ra = get(m.a), rb = get(m.b);
  if (ra.n >= MIN_PRIOR && rb.n >= MIN_PRIOR) {
    const wrA = ra.w / ra.n, wrB = rb.w / rb.n;
    const avgTimeFeat = (ra.gt / ra.n + rb.gt / rb.n) / 2;   // 旧模型用的特征
    const mismatch = Math.abs(wrA - wrB);                     // 新特征: 实力差量级
    samples.push({ mismatch, avgTimeFeat, dur: m.gt });
  }
  ra.n += 1; ra.gt += m.gt; if (m.w === m.a) ra.w += 1;
  rb.n += 1; rb.gt += m.gt; if (m.w === m.b) rb.w += 1;
}
const durs = samples.map((s) => s.dur);
const out = [];
out.push('=== 时间盘 模型无关探查 ===');
out.push(`合格样本 ${samples.length} | 实际时长 均值 ${mean(durs).toFixed(2)} 标准差 ${sd(durs).toFixed(2)} 分钟`);
out.push('');
out.push('特征与"实际时长"的相关性(|r|越大越有料; <0.1 基本没料):');
out.push(`  实力差(mismatch)  vs 时长: r = ${corr(samples.map((s) => s.mismatch), durs).toFixed(3)}  (R²=${(corr(samples.map((s) => s.mismatch), durs) ** 2 * 100).toFixed(1)}%)`);
out.push(`  两队均时长(旧特征) vs 时长: r = ${corr(samples.map((s) => s.avgTimeFeat), durs).toFixed(3)}  (R²=${(corr(samples.map((s) => s.avgTimeFeat), durs) ** 2 * 100).toFixed(1)}%)`);
out.push('');
// 按实力差四分位
const sorted = [...samples].sort((a, b) => a.mismatch - b.mismatch);
const q = (p) => sorted[Math.floor(p * sorted.length)].mismatch;
const cuts = [q(0.25), q(0.5), q(0.75)];
const bins = [{ lo: 0, hi: cuts[0], l: '最均势 Q1' }, { lo: cuts[0], hi: cuts[1], l: 'Q2' }, { lo: cuts[1], hi: cuts[2], l: 'Q3' }, { lo: cuts[2], hi: 1.01, l: '最悬殊 Q4' }];
out.push('按实力差分桶看实际时长(若悬殊桶明显更短=有信号):');
out.push('| 桶 | n | 平均胜率差 | 平均时长 | P(<31min) | P(>33min) |');
out.push('|---|---:|---:|---:|---:|---:|');
for (const bn of bins) { const g = samples.filter((s) => s.mismatch >= bn.lo && s.mismatch < bn.hi); if (!g.length) continue; out.push(`| ${bn.l} | ${g.length} | ${mean(g.map((s) => s.mismatch)).toFixed(3)} | ${mean(g.map((s) => s.dur)).toFixed(2)} | ${(g.filter((s) => s.dur < 31).length / g.length * 100).toFixed(0)}% | ${(g.filter((s) => s.dur > 33).length / g.length * 100).toFixed(0)}% |`); }
out.push('');
const rMis = Math.abs(corr(samples.map((s) => s.mismatch), durs));
const spread = mean(bins.filter((bn)=>samples.some(s=>s.mismatch>=bn.lo&&s.mismatch<bn.hi)).map((bn) => { const g = samples.filter((s) => s.mismatch >= bn.lo && s.mismatch < bn.hi); return mean(g.map((s) => s.dur)); }));
const q1g = samples.filter((s) => s.mismatch < cuts[0]); const q4g = samples.filter((s) => s.mismatch >= cuts[2]);
const gap = mean(q1g.map((s) => s.dur)) - mean(q4g.map((s) => s.dur));
out.push('=== 判定 ===');
out.push(`- 实力差 vs 时长 |r| = ${rMis.toFixed(3)} → ${rMis < 0.1 ? '几乎没料' : rMis < 0.2 ? '弱信号' : '有点料'}`);
out.push(`- 均势桶 vs 悬殊桶 时长差 = ${gap.toFixed(2)} 分钟 → ${Math.abs(gap) < 1 ? '差距太小, 没用' : Math.abs(gap) < 2.5 ? '有差但弱' : '差距明显'}`);
out.push(`- 时长标准差 ${sd(durs).toFixed(1)} 分钟, 而 R² 才 ${(rMis ** 2 * 100).toFixed(1)}% → ${rMis ** 2 < 0.04 ? '绝大部分时长方差解释不了 → 建模也救不动' : '尚可一试'}`);
out.push(`- **结论: ${rMis < 0.15 && Math.abs(gap) < 2.5 ? '❌ 信号太弱, 不值得建时间模型, 维持封禁' : '🟡 有一点信号, 可考虑建正式模型再回测'}**`);
process.stdout.write(out.join('\n') + '\n');
