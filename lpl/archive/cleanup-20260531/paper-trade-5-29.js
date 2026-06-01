// 5-29 TES vs LGD 纸面分析
import path from 'node:path';
import { readCsv, clamp, logistic, num } from './shared.js';
import { buildProfiles, classifyScenario } from './build-market-analysis.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');

function matchWinProbability(team, opponent) {
  const sample = Math.min(num(team.maps) + num(opponent.maps), 60);
  const confidence = clamp(sample / 40, 0.45, 1);
  const raw = logistic((team.strength_score - opponent.strength_score) / 13);
  return clamp(0.5 + (raw - 0.5) * confidence, 0.05, 0.95);
}
function coverProbability(team, opponent, line) {
  const expectedKillDiff = ((team.avg_kill_diff - opponent.avg_kill_diff) / 2)
    + ((team.strength_score - opponent.strength_score) / 9);
  const threshold = -Number(line);
  return clamp(logistic((expectedKillDiff - threshold) / 4.8), 0.05, 0.95);
}
function totalKillsProbability(team, opponent, line, selection, scenario) {
  let mean = (team.avg_total_kills + opponent.avg_total_kills) / 2;
  if (scenario === '混乱高击杀局') mean += 2.2;
  if (scenario === '低击杀运营局') mean -= 2;
  if (scenario === '强队速推碾压局') mean -= 0.8;
  const over = clamp(logistic((mean - Number(line)) / 3.8), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}
function mapHandicapProbability(favorite, underdog, scenario) {
  let p = (favorite.series_2_0_win_rate + underdog.series_0_2_loss_rate + matchWinProbability(favorite, underdog) ** 2) / 3;
  if (scenario === '强队速推碾压局') p += 0.09;
  if (scenario === '强队慢热终结局') p -= 0.08;
  if (scenario === '弱队能咬住但难赢') p -= 0.11;
  if (scenario === '混乱高击杀局') p -= 0.04;
  return clamp(p, 0.05, 0.9);
}
function singleTeamKillsProbability(team, opponent, line, selection) {
  let mean = team.avg_kills;
  mean -= (opponent.strength_score - 50) * 0.04;
  const over = clamp(logistic((mean - Number(line)) / 2.5), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}
function firstObjectiveProbability(team, opponent, field) {
  const p = team[field] * 0.62 + (1 - opponent[field]) * 0.28 + 0.5 * 0.10;
  return clamp(p, 0.12, 0.88);
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
  const tes = profiles.get('TES');
  const lgd = profiles.get('LGD');
  if (!tes || !lgd) { console.error('missing:', { tes: !!tes, lgd: !!lgd }); process.exit(1); }

  function teamLine(name, p) {
    console.log(`${name}: maps=${p.maps}, mwr=${fmtPct(p.match_win_rate)}, map_wr=${fmtPct(p.map_win_rate)}, strength=${p.strength_score.toFixed(1)}, avg_kills=${p.avg_kills.toFixed(2)}, avg_deaths=${p.avg_deaths.toFixed(2)}, avg_total=${p.avg_total_kills.toFixed(2)}, avg_time=${p.avg_game_time_min.toFixed(2)}, FB=${fmtPct(p.first_blood_rate)}`);
  }
  console.log('=== Profiles ===');
  teamLine('TES', tes);
  teamLine('LGD', lgd);

  const tesVsLgd = classifyScenario(tes, lgd);
  console.log('\n=== Scenario ===');
  console.log('TES vs LGD:', tesVsLgd.scenario, '(fav=' + tesVsLgd.favorite.team_id + ', strength diff =', (tesVsLgd.favorite.strength_score - tesVsLgd.underdog.strength_score).toFixed(1), ')');

  function bet(market, sel, odds, p, status = '') {
    const c = evCheck(p, odds);
    return { market, sel, odds, p, ...c, status };
  }

  const bets = [
    // 全局 -- match_win (校准: alpha=false,纸面跑也只观察)
    bet('match_win', 'TES @1.149', 1.149, matchWinProbability(tes, lgd), 'no-alpha 校准'),
    bet('match_win', 'LGD @5.656', 5.656, matchWinProbability(lgd, tes), 'no-alpha 校准'),
    // map_handicap (校准: alpha=false)
    bet('map_handicap', 'TES -1.5 @1.250', 1.250, mapHandicapProbability(tesVsLgd.favorite, tesVsLgd.underdog, tesVsLgd.scenario), 'no-alpha 校准'),
    bet('map_handicap', 'LGD +1.5 @3.872', 3.872, 1 - mapHandicapProbability(tesVsLgd.favorite, tesVsLgd.underdog, tesVsLgd.scenario), 'no-alpha 校准'),
    // 第一局 击杀让分 (kill_handicap)
    bet('kill_handicap_G1', 'TES -8.5 @1.910', 1.910, coverProbability(tes, lgd, -8.5)),
    bet('kill_handicap_G1', 'LGD +8.5 @1.910', 1.910, coverProbability(lgd, tes, 8.5)),
    // 第一局 击杀总数 28.5
    bet('total_kills_G1', 'over 28.5 @1.910', 1.910, totalKillsProbability(tes, lgd, 28.5, 'over', tesVsLgd.scenario)),
    bet('total_kills_G1', 'under 28.5 @1.910', 1.910, totalKillsProbability(tes, lgd, 28.5, 'under', tesVsLgd.scenario)),
    // TES 单队击杀
    bet('TES_kills_G1', 'over 18.5 @1.880', 1.880, singleTeamKillsProbability(tes, lgd, 18.5, 'over'), '单队击杀外推'),
    bet('TES_kills_G1', 'under 18.5 @1.880', 1.880, singleTeamKillsProbability(tes, lgd, 18.5, 'under'), '单队击杀外推'),
    // LGD 单队击杀
    bet('LGD_kills_G1', 'over 10.5 @1.850', 1.850, singleTeamKillsProbability(lgd, tes, 10.5, 'over'), '单队击杀外推'),
    bet('LGD_kills_G1', 'under 10.5 @1.910', 1.910, singleTeamKillsProbability(lgd, tes, 10.5, 'under'), '单队击杀外推'),
    // 第一滴血
    bet('first_blood_G1', 'TES @1.650', 1.650, firstObjectiveProbability(tes, lgd, 'first_blood_rate'), '一血高波动'),
    bet('first_blood_G1', 'LGD @2.157', 2.157, firstObjectiveProbability(lgd, tes, 'first_blood_rate'), '一血高波动'),
  ];

  console.log('\n=== 完整 EV 表 ===');
  console.log('market | selection | odds | model_p | break_even | edge | EV | 备注');
  for (const b of bets) {
    console.log(`${b.market} | ${b.sel} | ${b.odds} | ${fmtPct(b.p)} | ${fmtPct(b.breakEven)} | ${b.edge >= 0 ? '+' : ''}${fmtPct(b.edge)} | ${b.ev >= 0 ? '+' : ''}${fmtPct(b.ev)} | ${b.status}`);
  }

  console.log('\n=== 按规则筛选(排除封禁/无 alpha 盘口)===');
  const allowed = bets.filter((b) => {
    // 跳过被 Codex 校准证伪的 match_win + map_handicap (有 alpha=false 标)
    if (b.status.includes('no-alpha')) return false;
    // 跳过一血(高波动低权重,规则第 6 节)
    if (b.market === 'first_blood_G1') return false;
    return true;
  });
  const recommended = allowed.filter((b) => b.ev >= 0.05);
  if (recommended.length === 0) {
    console.log('无任何盘口 EV ≥ +5%');
  } else {
    for (const b of recommended.sort((a, b) => b.ev - a.ev)) {
      console.log(`★ ${b.market} | ${b.sel} | model ${fmtPct(b.p)} vs 隐含 ${fmtPct(b.breakEven)} | EV ${fmtPct(b.ev)} | ${b.status}`);
    }
  }

  console.log('\n=== 注意 ===');
  console.log('- 时间大小 30 分钟: 封禁中(到 6-22),不下');
  console.log('- match_win + map_handicap: Codex 校准 alpha=false,只观察不下');
  console.log('- 一血盘: 默认 C 档跳过');
  console.log('- 单队击杀: 模型外推,不在 backtest 验证内');
  console.log('- LGD maps='+ lgd.maps + ',若 < 20 strength_score 不稳');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
