// 6-02 TT vs LGD: 总杀决策 + 全盘口记录(总杀下注、其余观察)
import path from 'node:path';
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { readCsv, teamKey, clamp, logistic, num } from './shared.js';
import { buildProfiles } from './build-market-analysis.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';
import { predictTeamKillsHandicap } from './calibration/team-kills-nb-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const LOG = path.join(DATA_DIR, '盘口分析', '全盘口观察log.csv');
const DRIFT = 0.9, PATCH = '16.10', EV_MIN = 0.08, GAP_MIN = 1.5;
const fmtP = (v) => (v * 100).toFixed(1) + '%';
const winBo5 = (p) => p ** 3 * (1 + 3 * (1 - p) + 6 * (1 - p) ** 2);
const cover15 = (p) => p ** 3 * (4 - 3 * p);
const mapsOver35 = (p) => 1 - p ** 3 - (1 - p) ** 3;
const mapsOver45 = (p) => 6 * p ** 2 * (1 - p) ** 2;

function latest() { const d = 'D:/lol_scraper/data'; const f = readdirSync(d).filter((x) => /deduped_2026.*\.json$/.test(x)).sort(); return JSON.parse(readFileSync(path.join(d, f[f.length - 1]), 'utf8')); }

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')), readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')), readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const profiles = buildProfiles(matches, maps, summary);
  const a = profiles.get('TT'), b = profiles.get('LGD');
  if (!a || !b) { console.error('missing', !!a, !!b); process.exit(1); }
  const conf = clamp((num(a.maps) + num(b.maps)) / 40, 0.45, 1);
  const pMap = clamp(0.5 + (logistic((a.strength_score - b.strength_score) / 13) - 0.5) * conf, 0.05, 0.95);
  const tk = predictTotalKills(a, b); const meanAdj = tk.mean - DRIFT, sigma = tk.sigma;
  const erf = (x) => { const s = x < 0 ? -1 : 1; const z = Math.abs(x); const t = 1 / (1 + 0.3275911 * z); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z); return s * y; };
  const pUnderTot = (line) => 0.5 * (1 + erf((line - meanAdj) / (sigma * Math.SQRT2)));
  const gtMean = (a.avg_game_time_min + b.avg_game_time_min) / 2;
  const pTimeOver = (line) => clamp(logistic((gtMean - line) / 3), 0.05, 0.95);

  console.log(`TT str=${a.strength_score.toFixed(1)} avg_total=${a.avg_total_kills.toFixed(2)} | LGD str=${b.strength_score.toFixed(1)} avg_total=${b.avg_total_kills.toFixed(2)}`);
  console.log(`单图胜率 pMap=${fmtP(pMap)} | 总杀模型 ${tk.mean.toFixed(2)} 扣偏差→ ${meanAdj.toFixed(2)} (sigma ${sigma.toFixed(2)})`);

  const j = latest();
  const panda = Object.values(j.platforms.PANDA.matches).find((m) => /TT|Thunder/i.test(m.match?.teams || ''));
  const imdj = Object.values(j.platforms.IMDJ.matches).find((m) => /Thunder|LGD/i.test(m.match?.teams || ''));
  const rows = [];
  const push = (market, round, sel, line, odds, p, gate, note = '') => { if (Number.isFinite(odds) && p != null) rows.push({ market, round, sel, line, odds, p, gate, note }); };
  if (panda) for (const m of Object.values(panda.markets)) {
    const r = m.round;
    if (m.name === '击杀总数大小') { const line = Number((Object.keys(m.odds)[0].match(/[\d.]+/) || [])[0]); for (const [s, v] of Object.entries(m.odds)) { const u = /小|</.test(s); const p = u ? pUnderTot(line) : 1 - pUnderTot(line); push('total_kills', r, u ? 'under' : 'over', line, Number(v.odd), p, r === 1 && u && Math.abs(meanAdj - line) >= GAP_MIN ? '总杀生产信号' : '观察'); } }
    else if (m.name === '击杀让分') { for (const [s, v] of Object.entries(m.odds)) { const mm = s.match(/(-?[\d.]+)/); const hdp = mm ? Number(mm[1]) : 0; const isA = /T1/.test(s); const pr = predictTeamKillsHandicap(isA ? 'TT' : 'LGD', isA ? 'LGD' : 'TT', PATCH, '', hdp); push('kill_handicap', r, s, hdp, Number(v.odd), pr ? pr.probability : null, '闸门:让杀校准负项'); } }
    else if (m.name === '比赛时间大小') { const line = Number((Object.keys(m.odds)[0].match(/[\d.]+/) || [])[0]); for (const [s, v] of Object.entries(m.odds)) { const o = /大|>/.test(s); push('game_time', r, o ? 'over' : 'under', line, Number(v.odd), o ? pTimeOver(line) : 1 - pTimeOver(line), '闸门:封禁到6-22'); } }
    else if (m.name === '单局 - 获胜') { for (const [s, v] of Object.entries(m.odds)) { const isA = /T1/.test(s); push('G1_winner', r, isA ? 'TT' : 'LGD', null, Number(v.odd), isA ? pMap : 1 - pMap, '闸门:胜负无alpha'); } }
  }
  if (imdj) for (const m of Object.values(imdj.markets)) { const nm = m.name || ''; for (const [s, v] of Object.entries(m.odds || {})) { const odd = Number(v.odd); const isA = /Thunder|TT/i.test(s); if (/总比赛胜利|SeriesWin/i.test(nm + (m.code || ''))) push('series_win', 0, isA ? 'TT' : 'LGD', null, odd, isA ? winBo5(pMap) : 1 - winBo5(pMap), '闸门:胜负无alpha'); else if (/让局/.test(nm)) push('map_handicap', 0, s, num(v.hdp, 0), odd, isA ? cover15(pMap) : 1 - cover15(pMap), '闸门:让局校准负项'); else if (/总局数/.test(nm)) { const line = num((String(s).match(/[\d.]+/) || [])[0], 3.5); const o = /大|over|>/i.test(s); const p = line >= 4.5 ? mapsOver45(pMap) : mapsOver35(pMap); push('map_total', 0, (o ? 'over' : 'under') + ' ' + line, line, odd, o ? p : 1 - p, '闸门:map_total校准负项'); } else if (/第一局/.test(nm)) push('series_G1win', 0, isA ? 'TT' : 'LGD', null, odd, isA ? pMap : 1 - pMap, '闸门:胜负无alpha'); } }

  console.log('\n=== 总杀决策(只此盘可下; 阈值 EV>=+8% 且离线>=1.5)===');
  const tkRows = rows.filter((r) => r.market === 'total_kills' && r.round === 1);
  const picks = [];
  for (const r of tkRows.sort((x, y) => x.line - y.line)) { const ev = r.p * r.odds - 1; const gap = Math.abs(meanAdj - r.line); console.log(`${r.sel} ${r.line} @${r.odds} | 模型 ${fmtP(r.p)} | EV ${ev >= 0 ? '+' : ''}${fmtP(ev)} | 离线 ${gap.toFixed(1)}${r.sel === 'under' && ev >= EV_MIN && gap >= GAP_MIN ? '  ★候选' : ''}`); if (r.sel === 'under' && ev >= EV_MIN && gap >= GAP_MIN) picks.push({ ...r, ev, gap }); }
  if (!picks.length) console.log('→ PASS: 无 under 同时满足 EV>=8% 且离线>=1.5');
  else { picks.sort((a, b) => b.gap - a.gap); const best = picks[0]; console.log(`→ §4.1 相关性: under 各线同剧本, 取缓冲最大的一注: under ${best.line} @${best.odds} (模型 ${fmtP(best.p)}, EV +${fmtP(best.ev)}, 缓冲 ${best.gap.toFixed(1)})`); }

  // 写观察日志
  if (!existsSync(LOG)) writeFileSync(LOG, 'date,match,platform,market,round,selection,line,odds,implied_p,model_p,edge_pp,ev_pct,gate,actual_result,notes\n', 'utf8');
  let out = '';
  for (const r of rows) { const implied = 1 / r.odds; const plat = ['series_win', 'map_handicap', 'map_total', 'series_G1win'].includes(r.market) ? '电竞牛' : '开云'; out += ['2026-06-02', 'TT vs LGD', plat, r.market, r.round, JSON.stringify(r.sel), r.line ?? '', r.odds, implied.toFixed(3), r.p.toFixed(3), ((r.p - implied) * 100).toFixed(1), ((r.p * r.odds - 1) * 100).toFixed(1), r.gate, 'pending', r.note].join(',') + '\n'; }
  appendFileSync(LOG, out, 'utf8');
  console.log(`\n记录 ${rows.length} 行 -> 全盘口观察log.csv (只总杀决策下注, 其余观察)`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
