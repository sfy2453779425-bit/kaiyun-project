// 纸面下注 — 不烧钱,只记录模型判断,事后看准不准
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
  const wbg = profiles.get('WBG');
  const lgd = profiles.get('LGD');
  const nip = profiles.get('NIP');
  const edg = profiles.get('EDG');
  if (!wbg || !lgd || !nip || !edg) {
    console.error('missing:', { wbg: !!wbg, lgd: !!lgd, nip: !!nip, edg: !!edg });
    process.exit(1);
  }

  function teamLine(name, p) {
    console.log(`${name}: maps=${p.maps}, mwr=${fmtPct(p.match_win_rate)}, map_wr=${fmtPct(p.map_win_rate)}, strength=${p.strength_score.toFixed(1)}, avg_kills=${p.avg_kills.toFixed(2)}, avg_total=${p.avg_total_kills.toFixed(2)}, avg_time=${p.avg_game_time_min.toFixed(2)}`);
  }
  console.log('=== Profiles ===');
  teamLine('WBG', wbg);
  teamLine('LGD', lgd);
  teamLine('NIP', nip);
  teamLine('EDG', edg);

  console.log('\n=== Scenarios ===');
  const wbgVsLgd = classifyScenario(wbg, lgd);
  const nipVsEdg = classifyScenario(nip, edg);
  console.log('WBG vs LGD:', wbgVsLgd.scenario, '(fav=' + wbgVsLgd.favorite.team_id + ')');
  console.log('NIP vs EDG:', nipVsEdg.scenario, '(fav=' + nipVsEdg.favorite.team_id + ')');

  function bet(matchName, market, selection, odds, modelP, note = '') {
    const c = evCheck(modelP, odds);
    return { matchName, market, selection, odds, modelP, ...c, note };
  }

  // 雷火电竞 给的盘口
  const bets = [
    // WBG vs LGD
    bet('WBG vs LGD G1', 'match_win', 'WBG @1.19', 1.19, matchWinProbability(wbg, lgd)),
    bet('WBG vs LGD G1', 'match_win', 'LGD @4.84', 4.84, matchWinProbability(lgd, wbg)),
    bet('WBG vs LGD G1', 'kill_handicap', 'WBG -11.5 @2.17', 2.17, coverProbability(wbg, lgd, -11.5)),
    bet('WBG vs LGD G1', 'kill_handicap', 'LGD +11.5 @1.62', 1.62, coverProbability(lgd, wbg, 11.5)),
    bet('WBG vs LGD G1', 'kill_handicap', 'WBG -10.5 @1.94', 1.94, coverProbability(wbg, lgd, -10.5)),
    bet('WBG vs LGD G1', 'kill_handicap', 'LGD +10.5 @1.86', 1.86, coverProbability(lgd, wbg, 10.5)),
    bet('WBG vs LGD G1', 'kill_handicap', 'WBG -9.5 @1.75', 1.75, coverProbability(wbg, lgd, -9.5)),
    bet('WBG vs LGD G1', 'kill_handicap', 'LGD +9.5 @2.01', 2.01, coverProbability(lgd, wbg, 9.5)),
    bet('WBG vs LGD G1', 'total_kills', 'over 25.5 @1.69', 1.69, totalKillsProbability(wbg, lgd, 25.5, 'over', wbgVsLgd.scenario)),
    bet('WBG vs LGD G1', 'total_kills', 'under 25.5 @2.08', 2.08, totalKillsProbability(wbg, lgd, 25.5, 'under', wbgVsLgd.scenario)),
    bet('WBG vs LGD G1', 'total_kills', 'over 26.5 @1.86', 1.86, totalKillsProbability(wbg, lgd, 26.5, 'over', wbgVsLgd.scenario)),
    bet('WBG vs LGD G1', 'total_kills', 'under 26.5 @1.94', 1.94, totalKillsProbability(wbg, lgd, 26.5, 'under', wbgVsLgd.scenario)),
    bet('WBG vs LGD G1', 'total_kills', 'over 27.5 @2.07', 2.07, totalKillsProbability(wbg, lgd, 27.5, 'over', wbgVsLgd.scenario)),
    bet('WBG vs LGD G1', 'total_kills', 'under 27.5 @1.67', 1.67, totalKillsProbability(wbg, lgd, 27.5, 'under', wbgVsLgd.scenario)),
    // NIP vs EDG
    bet('NIP vs EDG G1', 'match_win', 'NIP @1.46', 1.46, matchWinProbability(nip, edg)),
    bet('NIP vs EDG G1', 'match_win', 'EDG @2.72', 2.72, matchWinProbability(edg, nip)),
    bet('NIP vs EDG G1', 'kill_handicap', 'NIP -8.5 @2.17', 2.17, coverProbability(nip, edg, -8.5)),
    bet('NIP vs EDG G1', 'kill_handicap', 'EDG +8.5 @1.62', 1.62, coverProbability(edg, nip, 8.5)),
    bet('NIP vs EDG G1', 'kill_handicap', 'NIP -7.5 @1.94', 1.94, coverProbability(nip, edg, -7.5)),
    bet('NIP vs EDG G1', 'kill_handicap', 'EDG +7.5 @1.86', 1.86, coverProbability(edg, nip, 7.5)),
    bet('NIP vs EDG G1', 'kill_handicap', 'NIP -6.5 @1.75', 1.75, coverProbability(nip, edg, -6.5)),
    bet('NIP vs EDG G1', 'kill_handicap', 'EDG +6.5 @2.01', 2.01, coverProbability(edg, nip, 6.5)),
    bet('NIP vs EDG G1', 'total_kills', 'over 25.5 @1.69', 1.69, totalKillsProbability(nip, edg, 25.5, 'over', nipVsEdg.scenario)),
    bet('NIP vs EDG G1', 'total_kills', 'under 25.5 @2.08', 2.08, totalKillsProbability(nip, edg, 25.5, 'under', nipVsEdg.scenario)),
    bet('NIP vs EDG G1', 'total_kills', 'over 26.5 @1.86', 1.86, totalKillsProbability(nip, edg, 26.5, 'over', nipVsEdg.scenario)),
    bet('NIP vs EDG G1', 'total_kills', 'under 26.5 @1.94', 1.94, totalKillsProbability(nip, edg, 26.5, 'under', nipVsEdg.scenario)),
    bet('NIP vs EDG G1', 'total_kills', 'over 27.5 @2.07', 2.07, totalKillsProbability(nip, edg, 27.5, 'over', nipVsEdg.scenario)),
    bet('NIP vs EDG G1', 'total_kills', 'under 27.5 @1.67', 1.67, totalKillsProbability(nip, edg, 27.5, 'under', nipVsEdg.scenario)),
  ];

  console.log('\n=== 完整 EV 表 ===');
  console.log('match | market | selection | odds | model_p | break_even | edge | EV');
  for (const b of bets) {
    console.log(
      `${b.matchName} | ${b.market} | ${b.selection} | ${b.odds} | ${fmtPct(b.modelP)} | ${fmtPct(b.breakEven)} | ${fmtPct(b.edge)} | ${fmtPct(b.ev)}`
    );
  }

  console.log('\n=== 模型自荐(EV ≥ +5%)===');
  const recommended = bets.filter((b) => b.ev >= 0.05).sort((a, b) => b.ev - a.ev);
  if (recommended.length === 0) {
    console.log('无任何盘口 EV ≥ +5%(说明模型对这两场没有显著偏离市场的判断)');
  } else {
    for (const b of recommended) {
      console.log(`★ ${b.matchName} | ${b.selection} | model ${fmtPct(b.modelP)} vs 隐含 ${fmtPct(b.breakEven)} | EV ${fmtPct(b.ev)}`);
    }
  }

  console.log('\n=== 标记:校准结论上不可信的盘口 ===');
  console.log('- match_win 全部不可信(Codex 校准: 模型 vs 市场 Brier 差 0.014, alpha=false)');
  console.log('- total_kills 27.5/30.5 over 在 self_check 5.10 节: in-sample 看起来有 edge 但 out-of-sample 不稳');
  console.log('- 总时间 (这里没列,因为被规则封禁 30 天)');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
