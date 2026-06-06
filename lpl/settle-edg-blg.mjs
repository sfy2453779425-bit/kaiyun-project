// 结算 6-03 EDG vs BLG (BLG 3-0; team1=EDG team2=BLG; G1 22-6 tot28, G2 17-8 tot25; 3图)
import { readFileSync, writeFileSync } from 'node:fs';
const LOG = 'D:/kaiyun - 副本/lpl/data/盘口分析/全盘口观察log.csv';
const R = { 1: { edg: 22, blg: 6, tot: 28, win: 'BLG' }, 2: { edg: 17, blg: 8, tot: 25, win: 'BLG' } };
const SERIES = { edgMaps: 0, blgMaps: 3, mapsPlayed: 3, win: 'BLG' };
function teamOf(sel, market) { if (market === 'kill_handicap') return /T1/.test(sel) ? 'EDG' : 'BLG'; if (/BLG|Bilibili/i.test(sel)) return 'BLG'; if (/EDG|EDward|T1/i.test(sel)) return 'EDG'; return null; }
function settle(market, round, selRaw, line) {
  const sel = selRaw.replace(/^"|"$/g, ''); const L = Number(line);
  if (market === 'total_kills') { const g = R[round]; if (!g) return 'NA'; return ((/under|小/.test(sel) ? g.tot < L : g.tot > L)) ? 'win' : 'loss'; }
  if (market === 'kill_handicap') { const g = R[round]; if (!g) return 'NA'; const t = teamOf(sel, market); const me = t === 'EDG' ? g.edg : g.blg; const opp = t === 'EDG' ? g.blg : g.edg; return (me + L) > opp ? 'win' : 'loss'; }
  if (market === 'game_time') return 'NA(无时长)';
  if (market === 'G1_winner' || market === 'series_G1win') { const g = R[round || 1]; return teamOf(sel, market) === g.win ? 'win' : 'loss'; }
  if (market === 'series_win') return teamOf(sel, market) === SERIES.win ? 'win' : 'loss';
  if (market === 'map_handicap') { const t = teamOf(sel, market); const me = t === 'EDG' ? SERIES.edgMaps : SERIES.blgMaps; const opp = t === 'EDG' ? SERIES.blgMaps : SERIES.edgMaps; return (me + L) > opp ? 'win' : 'loss'; }
  if (market === 'map_total') { const over = /over|大/.test(sel); return (over ? SERIES.mapsPlayed > L : SERIES.mapsPlayed < L) ? 'win' : 'loss'; }
  return 'NA';
}
const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/);
const head = lines[0].split(','); const ci = (n) => head.indexOf(n);
const out = [lines[0]]; const sum = {}; let settled = 0;
for (let i = 1; i < lines.length; i += 1) {
  const c = lines[i].split(',');
  if (c[ci('match')] !== 'EDG vs BLG') { out.push(lines[i]); continue; }
  const market = c[ci('market')], round = Number(c[ci('round')]), sel = c[ci('selection')], line = c[ci('line')], modelP = Number(c[ci('model_p')]), gate = c[ci('gate')];
  const res = settle(market, round, sel, line); c[ci('actual_result')] = res; out.push(c.join(','));
  if (res === 'win' || res === 'loss') { settled += 1; const lc = (modelP > 0.5) === (res === 'win'); const k = gate.startsWith('闸门') ? gate : (gate.includes('生产') ? '总杀生产' : '观察'); if (!sum[k]) sum[k] = { n: 0, r: 0 }; sum[k].n++; if (lc) sum[k].r++; }
}
writeFileSync(LOG, out.join('\n') + '\n', 'utf8');
console.log('已结算 EDG-BLG 行:', settled);
console.log('按闸门 模型偏向命中:'); for (const [k, v] of Object.entries(sum)) console.log('  ' + k + ': ' + v.r + '/' + v.n);
