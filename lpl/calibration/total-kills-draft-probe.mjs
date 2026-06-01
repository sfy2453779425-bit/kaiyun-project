// BP→击杀 信号粗探(独立, 不碰线上模型)
// 假设: 一套阵容的"杀气倾向"能解释"队伍基准总杀预测"漏掉的残差。
// 做法: 每英雄按其出场比赛的总杀、近期加权算 kill_assoc(walk-forward); 一套 10 英雄均值(去联盟均值)= draft_lean。
//      检验 draft_lean 与 (实际总杀 - 队伍基准) 的相关 + 样本外能否降误差。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { teamKey } from '../shared.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const MIN_TEAM_PRIOR = 8;
const CHAMP_DECAY = 0.95;       // 每次出场的近期衰减(近版本权重高 → 解决小样本/版本漂移)
const CHAMP_MIN_W = 4;          // 英雄有效权重门槛, 不足按中性
const BOOT = 1000, SEED = 20260601;

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
  const seen = new Set(); const out = [];
  for (const f of files) {
    let lines; try { lines = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
    if (lines.length < 2) continue;
    const head = lines[0].split(','); const ix = (n) => head.indexOf(n);
    const I = { date: ix('match_time'), aId: ix('team_a_id'), aName: ix('team_a'), bId: ix('team_b_id'), bName: ix('team_b'),
      tot: ix('total_kills'), aK: ix('team_a_kills'), bK: ix('team_b_kills'), bp: ix('blue_picks'), rp: ix('red_picks'), gid: ix('game_id'), mid: ix('match_id') };
    if (I.date < 0 || I.bp < 0) continue;
    for (let i = 1; i < lines.length; i += 1) {
      const c = lines[i].split(',');
      const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
      if (seen.has(gid)) continue; seen.add(gid);
      const date = (c[I.date] || '').trim();
      const a = teamKey(c[I.aId] || c[I.aName]); const b = teamKey(c[I.bId] || c[I.bName]);
      let total = I.tot >= 0 ? Number(c[I.tot]) : NaN;
      if (!Number.isFinite(total)) total = Number(c[I.aK]) + Number(c[I.bK]);
      const champs = ((c[I.bp] || '') + '/' + (c[I.rp] || '')).split('/').map((s) => s.trim()).filter(Boolean);
      if (!date || !a || !b || !Number.isFinite(total) || champs.length < 6) continue;
      out.push({ date, a, b, total, champs });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;}
function pearson(xs, ys){const n=xs.length;const mx=mean(xs),my=mean(ys);let sxy=0,sx=0,sy=0;for(let i=0;i<n;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sx+=dx*dx;sy+=dy*dy;}return sxy/Math.sqrt(sx*sy);}
function rmse(a){return Math.sqrt(mean(a.map((x)=>x*x)));}
function f3(v){return Number.isFinite(v)?v.toFixed(3):'n/a';}

function main(){
  const maps = parseMaps();
  const champ = new Map();   // champ -> {w, sum} 衰减加权
  const team = new Map();    // team -> {n, sum}
  let leagueSum = 0, leagueN = 0;   // 衰减加权联盟均总杀
  const recs = [];

  for (const m of maps) {
    const ta = team.get(m.a), tb = team.get(m.b);
    const leagueAvg = leagueN > 0 ? leagueSum / leagueN : 28;
    if (ta && tb && ta.n >= MIN_TEAM_PRIOR && tb.n >= MIN_TEAM_PRIOR) {
      const baseline = (ta.sum / ta.n + tb.sum / tb.n) / 2;
      // draft_lean: 10 英雄 (assoc - leagueAvg) 均值; 无历史按 0(中性)
      let s = 0, cnt = 0;
      for (const ch of m.champs) {
        const cc = champ.get(ch);
        if (cc && cc.w >= CHAMP_MIN_W) { s += (cc.sum / cc.w - leagueAvg); cnt += 1; }
        else { cnt += 1; } // 中性贡献 0
      }
      const draftLean = cnt ? s / cnt : 0;
      recs.push({ year: m.date.slice(0, 4), actual: m.total, baseline, residual: m.total - baseline, draftLean });
    }
    // 更新(无泄漏)
    for (const ch of m.champs) { const cc = champ.get(ch) || { w: 0, sum: 0 }; cc.w = cc.w * CHAMP_DECAY + 1; cc.sum = cc.sum * CHAMP_DECAY + m.total; champ.set(ch, cc); }
    const A = team.get(m.a) || { n: 0, sum: 0 }; A.n += 1; A.sum += m.total; team.set(m.a, A);
    const B = team.get(m.b) || { n: 0, sum: 0 }; B.n += 1; B.sum += m.total; team.set(m.b, B);
    leagueSum = leagueSum * 0.999 + m.total; leagueN = leagueN * 0.999 + 1;
  }

  const r24 = recs.filter((r) => r.year === '2024');
  const r25 = recs.filter((r) => r.year === '2025');
  const r26 = recs.filter((r) => r.year === '2026');

  // 相关性: draft_lean vs residual
  const corrAll = pearson(recs.map((r) => r.draftLean), recs.map((r) => r.residual));
  const corr25 = r25.length ? pearson(r25.map((r) => r.draftLean), r25.map((r) => r.residual)) : NaN;

  // 拟合 k(2024): residual ≈ k*draftLean ; 看样本外能否降残差
  const x24 = r24.map((r) => r.draftLean), y24 = r24.map((r) => r.residual);
  const mx = mean(x24);
  let num = 0, den = 0; for (let i = 0; i < x24.length; i++) { num += (x24[i] - mx) * y24[i]; den += (x24[i] - mx) ** 2; }
  const k = den ? num / den : 0;
  function oosImprove(rs) {
    if (!rs.length) return { base: NaN, withDraft: NaN };
    const base = rmse(rs.map((r) => r.residual));
    const withDraft = rmse(rs.map((r) => r.residual - k * r.draftLean));
    return { base, withDraft };
  }
  const oos25 = oosImprove(r25), oos26 = oosImprove(r26);

  // bootstrap CI of corrAll
  const rng = mulberry32(SEED); const cs = [];
  for (let b = 0; b < BOOT; b++) { const xs = [], ys = []; for (let i = 0; i < recs.length; i++) { const r = recs[Math.floor(rng() * recs.length)]; xs.push(r.draftLean); ys.push(r.residual); } cs.push(pearson(xs, ys)); }
  cs.sort((a, b) => a - b); const ciLo = cs[Math.floor(0.025 * cs.length)], ciHi = cs[Math.floor(0.975 * cs.length)];

  const L = [];
  L.push('=== BP→击杀 信号粗探 ===');
  L.push(`样本(合格图): 全 ${recs.length} (2024 ${r24.length} / 2025 ${r25.length} / 2026 ${r26.length})`);
  L.push(`draft_lean 范围: [${f3(Math.min(...recs.map(r=>r.draftLean)))}, ${f3(Math.max(...recs.map(r=>r.draftLean)))}], 标准差 ${f3(Math.sqrt(mean(recs.map(r=>(r.draftLean-mean(recs.map(x=>x.draftLean)))**2))))}`);
  L.push('');
  L.push('【核心】draft_lean 与 队伍基准残差 的相关:');
  L.push(`  全样本 r = ${f3(corrAll)}  95%CI [${f3(ciLo)}, ${f3(ciHi)}]`);
  L.push(`  2025 样本外 r = ${f3(corr25)}`);
  L.push('');
  L.push(`拟合系数 k(2024) = ${f3(k)} (residual ≈ k*draft_lean)`);
  L.push('样本外残差 RMSE (越低越好):');
  L.push(`  2025: 基准 ${f3(oos25.base)} → 加 draft ${f3(oos25.withDraft)}  (差 ${f3(oos25.withDraft - oos25.base)})`);
  L.push(`  2026: 基准 ${f3(oos26.base)} → 加 draft ${f3(oos26.withDraft)}  (差 ${f3(oos26.withDraft - oos26.base)})`);
  L.push('');
  const sig = (ciLo > 0 || ciHi < 0);
  const helps25 = oos25.withDraft < oos25.base - 0.02;
  const helps26 = oos26.withDraft < oos26.base - 0.02;   // 必须在我们真正下注的 2026 也降误差才算数
  const helps = helps26;
  L.push('【判定】');
  L.push(`  相关显著(CI 不跨 0): ${sig ? '是 r=' + f3(corrAll) + ' (但极小, 仅解释约 ' + (corrAll * corrAll * 100).toFixed(1) + '% 残差)' : '否(CI 跨 0)'}`);
  L.push(`  样本外降误差: 2025 ${helps25 ? '是' : '否'} / 2026 ${helps26 ? '是' : '否(几乎为 0)'}`);
  L.push(`  结论: ${sig && helps ? '★ 在当前 meta(2026) 仍有信号 → 值得让 Codex 建正式版' : '✗ 信号在 2026(下注期)消失 + 本就极小 → 按约定收手, BP 这层不值得做'}`);
  process.stdout.write(L.join('\n') + '\n');
}
main();
