// 结算 6-02 TT vs LGD (LGD 3-2; G1 TT6-LGD16 tot22, G2 8-24 tot32; 5图)
import { readFileSync, writeFileSync } from 'node:fs';
const LOG = 'D:/kaiyun - 副本/lpl/data/盘口分析/全盘口观察log.csv';
const R = { 1: { tt: 6, lgd: 16, tot: 22, win: 'LGD' }, 2: { tt: 8, lgd: 24, tot: 32, win: 'LGD' } };
const SERIES = { ttMaps: 2, lgdMaps: 3, mapsPlayed: 5, win: 'LGD' };
function teamOf(sel, market) {
  if (market === 'kill_handicap') return /T1/.test(sel) ? 'TT' : 'LGD';
  if (/LGD/i.test(sel)) return 'LGD'; if (/TT|Thunder|T1/i.test(sel)) return 'TT'; return null;
}
function settle(market, round, selRaw, line) {
  const sel = selRaw.replace(/^"|"$/g, ''); const L = Number(line);
  if (market === 'total_kills') { const g = R[round]; if (!g) return 'NA'; const w = /under|小/.test(sel) ? g.tot < L : g.tot > L; return w ? 'win' : 'loss'; }
  if (market === 'kill_handicap') { const g = R[round]; if (!g) return 'NA'; const t = teamOf(sel, market); const me = t === 'TT' ? g.tt : g.lgd; const opp = t === 'TT' ? g.lgd : g.tt; return (me + L) > opp ? 'win' : 'loss'; }
  if (market === 'game_time') return 'NA(无时长)';
  if (market === 'G1_winner' || market === 'series_G1win') { const g = R[round || 1]; return teamOf(sel, market) === g.win ? 'win' : 'loss'; }
  if (market === 'series_win') return teamOf(sel, market) === SERIES.win ? 'win' : 'loss';
  if (market === 'map_handicap') { const t = teamOf(sel, market); const me = t === 'TT' ? SERIES.ttMaps : SERIES.lgdMaps; const opp = t === 'TT' ? SERIES.lgdMaps : SERIES.ttMaps; return (me + L) > opp ? 'win' : 'loss'; }
  if (market === 'map_total') { const over = /over|大/.test(sel); return (over ? SERIES.mapsPlayed > L : SERIES.mapsPlayed < L) ? 'win' : 'loss'; }
  return 'NA';
}
const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/);
const head = lines[0].split(','); const ci = (n) => head.indexOf(n);
const out = [lines[0]]; const summary = {}; let settled = 0;
for (let i = 1; i < lines.length; i += 1) {
  const c = lines[i].split(',');
  if (c[ci('match')] !== 'TT vs LGD') { out.push(lines[i]); continue; }
  const market = c[ci('market')], round = Number(c[ci('round')]), sel = c[ci('selection')], line = c[ci('line')], modelP = Number(c[ci('model_p')]), gate = c[ci('gate')];
  const res = settle(market, round, sel, line); c[ci('actual_result')] = res; out.push(c.join(','));
  if (res === 'win' || res === 'loss') {
    settled += 1; const leanCorrect = (modelP > 0.5) === (res === 'win');
    const key = gate.startsWith('闸门') ? gate : (gate.includes('生产') ? '总杀生产' : '观察');
    if (!summary[key]) summary[key] = { n: 0, right: 0, picks: [] };
    summary[key].n += 1; if (leanCorrect) summary[key].right += 1;
    summary[key].picks.push(`${market} r${round} ${sel.replace(/"/g, '')} ${line || ''}: ${res} (模型${(modelP * 100).toFixed(0)}%${modelP > 0.5 ? '偏此' : '偏反'})`);
  }
}
writeFileSync(LOG, out.join('\n') + '\n', 'utf8');
console.log('已结算 TT-LGD 行:', settled, '(game_time 跳过)');
console.log('\n=== 按闸门: 模型偏向命中率 ===');
for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${v.right}/${v.n}`);
console.log('\n=== 总杀逐条(看模型vs市场谁对)===');
for (const p of (summary['总杀生产']?.picks || [])) console.log('  ' + p);
for (const p of (summary['观察']?.picks || []).filter(x => /total_kills/.test(x))) console.log('  ' + p);
console.log('\n=== 胜负/系列盘 ===');
for (const k of ['闸门:胜负无alpha', '闸门:map_total校准负项']) for (const p of (summary[k]?.picks || [])) console.log('  ' + p);
