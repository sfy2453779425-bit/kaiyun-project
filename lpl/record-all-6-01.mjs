// 6-01 AL vs WE 全盘口预测+记录(只总杀下注, 其余仅观察, 用于持续复验闸门)
import path from 'node:path';
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { readCsv, teamKey, clamp, logistic, num } from './shared.js';
import { buildProfiles } from './build-market-analysis.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';
import { predictTeamKillsHandicap } from './calibration/team-kills-nb-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const LOG = path.join(DATA_DIR, '盘口分析', '全盘口观察log.csv');
const DRIFT = 0.9;
const PATCH = '16.10';
const fmtP = (v) => (v * 100).toFixed(1) + '%';

function latestOdds() {
  const dir = 'D:/lol_scraper/data';
  const files = readdirSync(dir).filter((f) => /deduped_.*\.json$/.test(f)).sort();
  return JSON.parse(readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
}
// BO5 系列赛公式(给定单图胜率 p)
const winBo5 = (p) => p ** 3 * (1 + 3 * (1 - p) + 6 * (1 - p) ** 2);
const cover15 = (p) => p ** 3 * (4 - 3 * p);              // 让 -1.5 (赢 ≥2 图差)
const mapsOver35 = (p) => 1 - p ** 3 - (1 - p) ** 3;       // 打 ≥4 图
const mapsOver45 = (p) => 6 * p ** 2 * (1 - p) ** 2;       // 打满 5 图

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const profiles = buildProfiles(matches, maps, summary);
  const a = profiles.get('AL'); const b = profiles.get('WE');

  // 单图胜率(简单)
  const conf = clamp((num(a.maps) + num(b.maps)) / 40, 0.45, 1);
  const pMap = clamp(0.5 + (logistic((a.strength_score - b.strength_score) / 13) - 0.5) * conf, 0.05, 0.95);
  const tk = predictTotalKills(a, b);
  const meanAdj = tk.mean - DRIFT; const sigma = tk.sigma;
  const erf = (x) => { const s = x < 0 ? -1 : 1; const z = Math.abs(x); const t = 1 / (1 + 0.3275911 * z); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z); return s * y; };
  const pUnderTot = (line) => 0.5 * (1 + erf((line - meanAdj) / (sigma * Math.SQRT2)));
  const gtMean = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const pTimeOver = (line) => clamp(logistic((gtMean - line) / 3), 0.05, 0.95);

  const j = latestOdds();
  const panda = Object.values(j.platforms.PANDA.matches).find((m) => /AL/.test(m.match?.teams || ''));
  const imdj = Object.values(j.platforms.IMDJ.matches).find((m) => /Anyone|AL/.test(m.match?.teams || ''));

  const rows = [];   // {market,round,sel,line,odds,modelP,gate,note}
  const push = (market, round, sel, line, odds, modelP, gate, note = '') => {
    if (!Number.isFinite(odds) || modelP == null) return;
    rows.push({ market, round, sel, line, odds, modelP, gate, note });
  };

  // ---- PANDA G1 盘口 ----
  if (panda) for (const m of Object.values(panda.markets)) {
    const r = m.round;
    if (m.name === '击杀总数大小') {
      const line = Number((Object.keys(m.odds)[0].match(/[\d.]+/) || [])[0]);
      for (const [s, v] of Object.entries(m.odds)) {
        const isUnder = /小于|</.test(s); const p = isUnder ? pUnderTot(line) : 1 - pUnderTot(line);
        push('total_kills', r, isUnder ? 'under' : 'over', line, Number(v.odd), p, r === 1 && isUnder && Math.abs(meanAdj - line) >= 1.5 ? '总杀生产信号' : '观察');
      }
    } else if (m.name === '击杀让分') {
      const ent = Object.entries(m.odds);
      for (const [s, v] of ent) {
        const mm = s.match(/(-?[\d.]+)/); const hdp = mm ? Number(mm[1]) : 0;
        const isA = /AL/i.test(s) || ent.indexOf([s, v]) === 0;
        const pred = predictTeamKillsHandicap(isA ? 'AL' : 'WE', isA ? 'WE' : 'AL', PATCH, '', hdp);
        push('kill_handicap', r, s, hdp, Number(v.odd), pred ? pred.probability : null, '闸门:让杀校准负项');
      }
    } else if (m.name === '比赛时间大小') {
      const line = Number((Object.keys(m.odds)[0].match(/[\d.]+/) || [])[0]);
      for (const [s, v] of Object.entries(m.odds)) {
        const isOver = /大于|>/.test(s); const p = isOver ? pTimeOver(line) : 1 - pTimeOver(line);
        push('game_time', r, isOver ? 'over' : 'under', line, Number(v.odd), p, '闸门:封禁到6-22');
      }
    } else if (m.name === '单局 - 获胜') {
      for (const [s, v] of Object.entries(m.odds)) {
        const isA = /T1/.test(s); const p = isA ? pMap : 1 - pMap;
        push('G1_winner', r, isA ? 'AL' : 'WE', null, Number(v.odd), p, '闸门:胜负无alpha');
      }
    }
  }
  // ---- IMDJ 系列盘 ----
  if (imdj) for (const m of Object.values(imdj.markets)) {
    const nm = m.name || '';
    for (const [s, v] of Object.entries(m.odds || {})) {
      const odd = Number(v.odd); const isA = /Anyone|AL/i.test(s);
      if (/总比赛胜利|SeriesWin/i.test(nm + (m.code || ''))) push('series_win', 0, isA ? 'AL' : 'WE', null, odd, isA ? winBo5(pMap) : 1 - winBo5(pMap), '闸门:胜负无alpha');
      else if (/让局/.test(nm)) { const hdp = num(v.hdp, 0); push('map_handicap', 0, s + (hdp ? `(${hdp})` : ''), hdp, odd, isA ? cover15(pMap) : 1 - cover15(pMap), '闸门:让局校准负项'); }
      else if (/总局数/.test(nm)) { const line = num((String(s).match(/[\d.]+/) || [])[0], 3.5); const over = /大|over|>/i.test(s); const p = line >= 4.5 ? mapsOver45(pMap) : mapsOver35(pMap); push('map_total', 0, (over ? 'over' : 'under') + ' ' + line, line, odd, over ? p : 1 - p, '闸门:map_total校准负项'); }
      else if (/第一局/.test(nm)) push('series_G1win', 0, isA ? 'AL' : 'WE', null, odd, isA ? pMap : 1 - pMap, '闸门:胜负无alpha');
    }
  }

  // 计算 EV + 打印 + 写日志
  console.log(`AL str=${a.strength_score.toFixed(1)} WE str=${b.strength_score.toFixed(1)} | 单图胜率pMap=${fmtP(pMap)} | 总杀模型(扣偏差)=${meanAdj.toFixed(2)}`);
  console.log('\nmarket | r | selection | line | odds | implied | model_p | edge | EV | gate');
  const header = 'date,match,platform,market,round,selection,line,odds,implied_p,model_p,edge_pp,ev_pct,gate,actual_result,notes\n';
  if (!existsSync(LOG)) writeFileSync(LOG, header, 'utf8');
  const date = '2026-06-01'; const matchN = 'AL vs 西安WE';
  let out = '';
  for (const r of rows) {
    const implied = 1 / r.odds; const edge = r.modelP - implied; const ev = r.modelP * r.odds - 1;
    const plat = ['series_win', 'map_handicap', 'map_total', 'series_G1win'].includes(r.market) ? '电竞牛' : '开云';
    console.log(`${r.market} | ${r.round} | ${r.sel} | ${r.line ?? ''} | ${r.odds} | ${fmtP(implied)} | ${fmtP(r.modelP)} | ${edge >= 0 ? '+' : ''}${fmtP(edge)} | ${ev >= 0 ? '+' : ''}${fmtP(ev)} | ${r.gate}`);
    out += [date, matchN, plat, r.market, r.round, JSON.stringify(r.sel), r.line ?? '', r.odds, implied.toFixed(3), r.modelP.toFixed(3), (edge * 100).toFixed(1), (ev * 100).toFixed(1), r.gate, 'pending', r.note].join(',') + '\n';
  }
  appendFileSync(LOG, out, 'utf8');
  console.log(`\n写入 ${rows.length} 行 -> 全盘口观察log.csv`);
  console.log('注: 只有总杀 under(生产信号)真下注; 其余全部"观察pending", 赛后回填用来复验闸门。');
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
