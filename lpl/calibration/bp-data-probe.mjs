// BP 数据探查: 我们手上的 pick/ban 数据格式/数量/版本分布, 以及各版本 meta(picks/bans 频率)
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'D:/kaiyun - 副本/lpl/data';

function listMapFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMapFiles(full));
    else if (e.name === 'lpl_map_details.csv') out.push(full);
  }
  return out;
}

const files = listMapFiles(DATA_DIR);
const seen = new Set();
const byPatch = new Map();           // patch -> count
const pickFreq = new Map();          // patch -> Map(champ->count)
const banFreq = new Map();
let sampleRow = null;
let withBP = 0, total = 0;

for (const f of files) {
  let lines;
  try { lines = readFileSync(f, 'utf8').trim().split(/\r?\n/); } catch { continue; }
  if (lines.length < 2) continue;
  const head = lines[0].split(',');
  const ix = (n) => head.indexOf(n);
  const I = {
    patch: ix('patch'), gid: ix('game_id'), mid: ix('match_id'),
    bp: ix('blue_picks'), rp: ix('red_picks'), bb: ix('blue_bans'), rb: ix('red_bans'),
  };
  if (I.bp < 0) continue;
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    const gid = (I.gid >= 0 && c[I.gid]) ? c[I.gid] : `${I.mid >= 0 ? c[I.mid] : f}|${i}`;
    if (seen.has(gid)) continue;
    seen.add(gid);
    total += 1;
    const patch = (c[I.patch] || '').trim() || '?';
    byPatch.set(patch, (byPatch.get(patch) || 0) + 1);
    const bp = (c[I.bp] || '').trim();
    const rp = (c[I.rp] || '').trim();
    const bb = (c[I.bb] || '').trim();
    const rb = (c[I.rb] || '').trim();
    if (bp || rp) withBP += 1;
    if (!sampleRow && bp) sampleRow = { patch, bp, rp, bb, rb };
    if (!pickFreq.has(patch)) { pickFreq.set(patch, new Map()); banFreq.set(patch, new Map()); }
    const pf = pickFreq.get(patch); const bf = banFreq.get(patch);
    for (const ch of (bp + '/' + rp).split('/').map((s) => s.trim()).filter(Boolean)) pf.set(ch, (pf.get(ch) || 0) + 1);
    for (const ch of (bb + '/' + rb).split('/').map((s) => s.trim()).filter(Boolean)) bf.set(ch, (bf.get(ch) || 0) + 1);
  }
}

const out = [];
out.push(`总图 ${total}, 含 BP 数据 ${withBP} (${(withBP / total * 100).toFixed(0)}%)`);
out.push('--- 版本分布(map 数) ---');
const patches = [...byPatch.entries()].sort((a, b) => b[1] - a[1]);
for (const [p, n] of patches.slice(0, 14)) out.push(`  ${p}: ${n}`);
out.push('--- 样本行(确认格式) ---');
if (sampleRow) {
  out.push(`  patch=${sampleRow.patch}`);
  out.push(`  blue_picks: ${sampleRow.bp}`);
  out.push(`  blue_bans : ${sampleRow.bb}`);
}
// 16.10 meta
for (const target of ['16.10', '16.9']) {
  if (pickFreq.has(target)) {
    const pf = [...pickFreq.get(target).entries()].sort((a, b) => b[1] - a[1]);
    const bf = [...banFreq.get(target).entries()].sort((a, b) => b[1] - a[1]);
    out.push(`--- ${target} 最常 pick (top10) ---`);
    out.push('  ' + pf.slice(0, 10).map(([c, n]) => `${c}(${n})`).join(', '));
    out.push(`--- ${target} 最常 ban (top10) ---`);
    out.push('  ' + bf.slice(0, 10).map(([c, n]) => `${c}(${n})`).join(', '));
  }
}
process.stdout.write(out.join('\n') + '\n');
