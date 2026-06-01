// 5-30 纸面分析: AL vs EDG (15:00) + BLG vs 西安WE (18:00)
// 只跑允许盘口, 封禁: game_time(到6-22) / match_win+map_handicap(校准 alpha=false) / first_blood(C档)
import path from 'node:path';
import { readCsv, clamp, logistic, num } from './shared.js';
import { buildProfiles, classifyScenario } from './build-market-analysis.js';
import { predictTeamKills, predictTeamKillsHandicap, isTeamKillsNbReady } from './calibration/team-kills-nb-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const PATCH = '16.10';

function totalKillsProbability(team, opponent, line, selection, scenario) {
  let mean = (team.avg_total_kills + opponent.avg_total_kills) / 2;
  if (scenario === '混乱高击杀局') mean += 2.2;
  if (scenario === '低击杀运营局') mean -= 2;
  if (scenario === '强队速推碾压局') mean -= 0.8;
  const over = clamp(logistic((mean - Number(line)) / 3.8), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}
// 单队击杀: NB 模型, 取蓝/红方均值 (未来局不知边)
function singleTeamKillsNb(teamId, oppId, line, selection) {
  const blue = predictTeamKills(teamId, oppId, PATCH, 'blue');
  const red = predictTeamKills(teamId, oppId, PATCH, 'red');
  if (!blue || !red) return null;
  const overBlue = blue.p_over(line);
  const overRed = red.p_over(line);
  const over = (overBlue + overRed) / 2;
  const mean = (blue.mean + red.mean) / 2;
  return { p: selection === 'over' ? over : 1 - over, mean };
}
// 击杀让分: NB 联合分布 (双方取边均值)
function killHandicapNb(teamId, oppId, line) {
  const r = predictTeamKillsHandicap(teamId, oppId, PATCH, '', line);
  return r ? r.probability : null;
}
function evCheck(p, odds) {
  const breakEven = 1 / odds;
  return { breakEven, edge: p - breakEven, ev: p * odds - 1 };
}
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const profiles = buildProfiles(matches, maps, summary);
  console.log('NB ready:', isTeamKillsNbReady());

  const ids = ['AL', 'EDG', 'BLG', 'WE'];
  const P = {};
  for (const id of ids) { P[id] = profiles.get(id); }
  const missing = ids.filter((id) => !P[id]);
  if (missing.length) { console.error('missing profiles:', missing.join(',')); process.exit(1); }

  function teamLine(name, p) {
    console.log(`${name}: maps=${p.maps}, mwr=${fmtPct(p.match_win_rate)}, strength=${p.strength_score.toFixed(1)}, avg_kills=${p.avg_kills.toFixed(2)}, avg_total=${p.avg_total_kills.toFixed(2)}, avg_time=${p.avg_game_time_min.toFixed(2)}`);
  }
  console.log('\n=== Profiles ===');
  for (const id of ids) teamLine(id, P[id]);

  const scAlEdg = classifyScenario(P.AL, P.EDG);
  const scBlgWe = classifyScenario(P.BLG, P.WE);
  console.log('\n=== Scenarios ===');
  console.log('AL vs EDG :', scAlEdg.scenario, '(fav=' + scAlEdg.favorite.team_id + ', diff=' + (scAlEdg.favorite.strength_score - scAlEdg.underdog.strength_score).toFixed(1) + ')');
  console.log('BLG vs WE :', scBlgWe.scenario, '(fav=' + scBlgWe.favorite.team_id + ', diff=' + (scBlgWe.favorite.strength_score - scBlgWe.underdog.strength_score).toFixed(1) + ')');

  function bet(matchName, market, sel, odds, p, note = '') {
    if (p == null) return { matchName, market, sel, odds, p: null, note: note + ' [模型缺失]' };
    return { matchName, market, sel, odds, p, ...evCheck(p, odds), note };
  }

  const bets = [
    // ===== AL vs EDG (G1) =====
    // 击杀让分 (NB)
    bet('AL vs EDG', 'kill_handicap', 'AL -9.5 @2.063', 2.063, killHandicapNb('AL', 'EDG', -9.5), 'NB'),
    bet('AL vs EDG', 'kill_handicap', 'EDG +9.5 @1.778', 1.778, killHandicapNb('EDG', 'AL', 9.5), 'NB'),
    bet('AL vs EDG', 'kill_handicap', 'AL -8.5 @1.800', 1.800, killHandicapNb('AL', 'EDG', -8.5), 'NB'),
    bet('AL vs EDG', 'kill_handicap', 'EDG +8.5 @2.034', 2.034, killHandicapNb('EDG', 'AL', 8.5), 'NB'),
    bet('AL vs EDG', 'kill_handicap', 'AL -7.5 @1.718', 1.718, killHandicapNb('AL', 'EDG', -7.5), 'NB'),
    bet('AL vs EDG', 'kill_handicap', 'EDG +7.5 @2.150', 2.150, killHandicapNb('EDG', 'AL', 7.5), 'NB'),
    // 总击杀
    bet('AL vs EDG', 'total_kills', 'over 23.5 @1.659', 1.659, totalKillsProbability(P.AL, P.EDG, 23.5, 'over', scAlEdg.scenario)),
    bet('AL vs EDG', 'total_kills', 'under 23.5 @2.250', 2.250, totalKillsProbability(P.AL, P.EDG, 23.5, 'under', scAlEdg.scenario)),
    bet('AL vs EDG', 'total_kills', 'over 24.5 @1.799', 1.799, totalKillsProbability(P.AL, P.EDG, 24.5, 'over', scAlEdg.scenario)),
    bet('AL vs EDG', 'total_kills', 'under 24.5 @2.035', 2.035, totalKillsProbability(P.AL, P.EDG, 24.5, 'under', scAlEdg.scenario)),
    bet('AL vs EDG', 'total_kills', 'over 25.5 @2.070', 2.070, totalKillsProbability(P.AL, P.EDG, 25.5, 'over', scAlEdg.scenario)),
    bet('AL vs EDG', 'total_kills', 'under 25.5 @1.772', 1.772, totalKillsProbability(P.AL, P.EDG, 25.5, 'under', scAlEdg.scenario)),
    // 单队击杀 (NB)
    bet('AL vs EDG', 'AL_kills', 'over 17.5 @2.077', 2.077, singleTeamKillsNb('AL', 'EDG', 17.5, 'over')?.p, 'NB'),
    bet('AL vs EDG', 'AL_kills', 'under 17.5 @1.716', 1.716, singleTeamKillsNb('AL', 'EDG', 17.5, 'under')?.p, 'NB'),
    bet('AL vs EDG', 'EDG_kills', 'over 9.5 @1.910', 1.910, singleTeamKillsNb('EDG', 'AL', 9.5, 'over')?.p, 'NB'),
    bet('AL vs EDG', 'EDG_kills', 'under 9.5 @1.850', 1.850, singleTeamKillsNb('EDG', 'AL', 9.5, 'under')?.p, 'NB'),

    // ===== BLG vs 西安WE (G1) =====
    // 击杀让分 (NB)
    bet('BLG vs WE', 'kill_handicap', 'BLG -10.5 @2.100', 2.100, killHandicapNb('BLG', 'WE', -10.5), 'NB'),
    bet('BLG vs WE', 'kill_handicap', 'WE +10.5 @1.751', 1.751, killHandicapNb('WE', 'BLG', 10.5), 'NB'),
    bet('BLG vs WE', 'kill_handicap', 'BLG -9.5 @1.879', 1.879, killHandicapNb('BLG', 'WE', -9.5), 'NB'),
    bet('BLG vs WE', 'kill_handicap', 'WE +9.5 @1.942', 1.942, killHandicapNb('WE', 'BLG', 9.5), 'NB'),
    bet('BLG vs WE', 'kill_handicap', 'BLG -8.5 @1.700', 1.700, killHandicapNb('BLG', 'WE', -8.5), 'NB'),
    bet('BLG vs WE', 'kill_handicap', 'WE +8.5 @2.179', 2.179, killHandicapNb('WE', 'BLG', 8.5), 'NB'),
    // 总击杀
    bet('BLG vs WE', 'total_kills', 'over 31.5 @1.751', 1.751, totalKillsProbability(P.BLG, P.WE, 31.5, 'over', scBlgWe.scenario)),
    bet('BLG vs WE', 'total_kills', 'under 31.5 @2.100', 2.100, totalKillsProbability(P.BLG, P.WE, 31.5, 'under', scBlgWe.scenario)),
    bet('BLG vs WE', 'total_kills', 'over 32.5 @1.941', 1.941, totalKillsProbability(P.BLG, P.WE, 32.5, 'over', scBlgWe.scenario)),
    bet('BLG vs WE', 'total_kills', 'under 32.5 @1.879', 1.879, totalKillsProbability(P.BLG, P.WE, 32.5, 'under', scBlgWe.scenario)),
    bet('BLG vs WE', 'total_kills', 'over 33.5 @2.219', 2.219, totalKillsProbability(P.BLG, P.WE, 33.5, 'over', scBlgWe.scenario)),
    bet('BLG vs WE', 'total_kills', 'under 33.5 @1.676', 1.676, totalKillsProbability(P.BLG, P.WE, 33.5, 'under', scBlgWe.scenario)),
    // 单队击杀 (NB)
    bet('BLG vs WE', 'BLG_kills', 'over 20.5 @1.970', 1.970, singleTeamKillsNb('BLG', 'WE', 20.5, 'over')?.p, 'NB'),
    bet('BLG vs WE', 'BLG_kills', 'under 20.5 @1.797', 1.797, singleTeamKillsNb('BLG', 'WE', 20.5, 'under')?.p, 'NB'),
    bet('BLG vs WE', 'WE_kills', 'over 12.5 @2.040', 2.040, singleTeamKillsNb('WE', 'BLG', 12.5, 'over')?.p, 'NB'),
    bet('BLG vs WE', 'WE_kills', 'under 12.5 @1.742', 1.742, singleTeamKillsNb('WE', 'BLG', 12.5, 'under')?.p, 'NB'),
  ];

  // NB 模型均值参考
  console.log('\n=== NB 单队击杀均值 (蓝红平均) ===');
  for (const [a, b] of [['AL', 'EDG'], ['EDG', 'AL'], ['BLG', 'WE'], ['WE', 'BLG']]) {
    const r = singleTeamKillsNb(a, b, 0, 'over');
    console.log(`${a} vs ${b}: NB mean kills = ${r ? r.mean.toFixed(2) : 'n/a'}`);
  }

  console.log('\n=== 完整 EV 表 ===');
  console.log('match | market | selection | odds | model_p | break_even | edge | EV | note');
  for (const b of bets) {
    if (b.p == null) { console.log(`${b.matchName} | ${b.market} | ${b.sel} | ${b.odds} | -- | -- | -- | -- | ${b.note}`); continue; }
    console.log(`${b.matchName} | ${b.market} | ${b.sel} | ${b.odds} | ${fmtPct(b.p)} | ${fmtPct(b.breakEven)} | ${b.edge >= 0 ? '+' : ''}${fmtPct(b.edge)} | ${b.ev >= 0 ? '+' : ''}${fmtPct(b.ev)} | ${b.note}`);
  }

  console.log('\n=== 允许盘口里 EV >= +5% (排除封禁) ===');
  const allowed = bets.filter((b) => b.p != null && b.ev >= 0.05);
  if (!allowed.length) {
    console.log('无任何允许盘口 EV >= +5%');
  } else {
    for (const b of allowed.sort((a, b) => b.ev - a.ev)) {
      console.log(`★ ${b.matchName} | ${b.market} | ${b.sel} | model ${fmtPct(b.p)} vs 隐含 ${fmtPct(b.breakEven)} | EV ${b.ev >= 0 ? '+' : ''}${fmtPct(b.ev)} | ${b.note}`);
    }
  }

  console.log('\n=== 封禁/不下注盘口提醒 ===');
  console.log('- game_time 29/30/31: 封禁中(到 6-22)');
  console.log('- match_win (AL 1.314 / BLG 1.083 等): 校准 alpha=false, 只观察');
  console.log('- map_handicap / 正确比分: 校准 alpha=false, 只观察');
  console.log('- first_blood: 默认 C 档跳过');
  console.log('- 单队击杀/击杀让分: NB 模型 (line 12.5 附近历史偏弱, 仅低权重纸面)');
  console.log('- WE maps=' + P.WE.maps + ' / AL maps=' + P.AL.maps + ' (样本不足则 strength 不稳)');
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
