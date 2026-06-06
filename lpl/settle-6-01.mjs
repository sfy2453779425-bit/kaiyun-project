// 结算 6-01 AL vs WE 全盘口观察 (WE 3-0; G1 14-17 tot31, G2 10-18 tot28, G3 7-14 tot21)
import { readFileSync, writeFileSync } from 'node:fs';
const LOG = 'D:/kaiyun - 副本/lpl/data/盘口分析/全盘口观察log.csv';
const R = { 1: { al: 14, we: 17, tot: 31, win: 'WE' }, 2: { al: 10, we: 18, tot: 28, win: 'WE' }, 3: { al: 7, we: 14, tot: 21, win: 'WE' } };
const SERIES = { alMaps: 0, weMaps: 3, mapsPlayed: 3, win: 'WE' };

function settle(market, round, selRaw, line) {
  const sel = selRaw.replace(/^"|"$/g, '');
  const L = Number(line);
  const teamInSel = /Anyone|AL|T1/i.test(sel) && !/西安|WE|T2/i.test(sel) ? 'AL' : (/西安|WE|T2/i.test(sel) ? 'WE' : null);
  if (market === 'total_kills') {
    const g = R[round]; if (!g) return ['NA', null];
    const win = /under|小/.test(sel) ? g.tot < L : g.tot > L;
    return [win ? 'win' : 'loss', /under|小/.test(sel) ? g.tot < L : g.tot > L];
  }
  if (market === 'kill_handicap') {
    const g = R[round]; if (!g) return ['NA', null];
    const t = /T1/.test(sel) ? 'AL' : 'WE'; const me = t === 'AL' ? g.al : g.we; const opp = t === 'AL' ? g.we : g.al;
    const win = (me + L) > opp;   // line 已含符号
    return [win ? 'win' : 'loss', win];
  }
  if (market === 'game_time') return ['NA(无时长数据)', null];
  if (market === 'G1_winner' || market === 'series_G1win') {
    const g = R[round || 1]; const win = teamInSel === g.win; return [win ? 'win' : 'loss', win];
  }
  if (market === 'series_win') { const win = teamInSel === SERIES.win; return [win ? 'win' : 'loss', win]; }
  if (market === 'map_handicap') { const myMaps = teamInSel === 'AL' ? SERIES.alMaps : SERIES.weMaps; const oppMaps = teamInSel === 'AL' ? SERIES.weMaps : SERIES.alMaps; const win = (myMaps + L) > oppMaps; return [win ? 'win' : 'loss', win]; }
  if (market === 'map_total') { const over = /over|大/.test(sel); const win = over ? SERIES.mapsPlayed > L : SERIES.mapsPlayed < L; return [win ? 'win' : 'loss', win]; }
  return ['NA', null];
}

const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/);
const head = lines[0].split(',');
const ci = (n) => head.indexOf(n);
const out = [lines[0]];
const summary = {};   // gate -> {leanWin, leanLoss}
let settled = 0;
for (let i = 1; i < lines.length; i += 1) {
  const c = lines[i].split(',');
  if (!/AL vs 西安WE/.test(c[ci('match')])) { out.push(lines[i]); continue; }
  const market = c[ci('market')]; const round = Number(c[ci('round')]); const sel = c[ci('selection')]; const line = c[ci('line')];
  const modelP = Number(c[ci('model_p')]); const gate = c[ci('gate')];
  const [res, won] = settle(market, round, sel, line);
  c[ci('actual_result')] = res;
  out.push(c.join(','));
  if (res === 'win' || res === 'loss') {
    settled += 1;
    // 模型偏向(model_p>0.5)对不对
    const leanCorrect = (modelP > 0.5) === (res === 'win');
    const key = gate.split(':')[0] === '闸门' ? gate : (gate.includes('生产') ? '总杀生产' : '观察');
    if (!summary[key]) summary[key] = { n: 0, leanRight: 0, picks: [] };
    summary[key].n += 1; if (leanCorrect) summary[key].leanRight += 1;
    summary[key].picks.push(`${market} r${round} ${sel.replace(/"/g, '')} ${line || ''}: ${res} (模型${(modelP * 100).toFixed(0)}%${modelP > 0.5 ? '偏此' : '偏反'})`);
  }
}
writeFileSync(LOG, out.join('\n') + '\n', 'utf8');
console.log('已结算 AL-WE 行:', settled, '(game_time 因无时长跳过)');
console.log('\n=== 按闸门: 模型偏向命中率(复验闸门) ===');
for (const [k, v] of Object.entries(summary)) console.log(`${k}: 模型偏向命中 ${v.leanRight}/${v.n}`);
console.log('\n=== 关键盘口逐条 ===');
for (const [k, v] of Object.entries(summary)) { console.log('['+k+']'); for (const p of v.picks) console.log('  '+p); }
