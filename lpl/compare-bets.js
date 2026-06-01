// 临时脚本: 用 LPL 历史数据库给 user 7 注做模型概率对比。
// 这两场都是 电竞世界杯中国预选赛, 不是 LPL 联赛,所以 profile 来自 LPL 2026 Split 2 (最近数据)。
// 注意: 我模型现在没有 (单队单局击杀 / BO5 地图总数 / 任意 game_time 线),
//       这些用 logistic 现场推断 + 显著标注 "外推,不在 backtest 覆盖内"。
import path from 'node:path';
import { readCsv, clamp, logistic, num } from './shared.js';
import { buildProfiles, classifyScenario } from './build-market-analysis.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');

// --- 复制 build-market-analysis.js 里没 export 的函数 ---
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
function gameTimeProbability(team, opponent, line, selection, scenario) {
  let mean = (team.avg_game_time_min + opponent.avg_game_time_min) / 2;
  if (scenario === '强队速推碾压局') mean -= 1.8;
  if (scenario === '强队慢热终结局') mean += 0.8;
  if (scenario === '弱队能咬住但难赢') mean += 1.1;
  if (scenario === '混乱高击杀局') mean += 1;
  if (scenario === '低击杀运营局') mean += 0.9;
  const over = clamp(logistic((mean - Number(line)) / 2.5), 0.05, 0.95);
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

// --- 外推 (不在 backtest 覆盖内, 仅近似) ---
// 单队单局击杀 over line: 用 profile.avg_kills 做均值,divisor 2.5 (比 total_kills 3.8 小,因为单队方差小)
function singleTeamKillsProbability(team, opponent, line, selection) {
  // team.avg_kills 是该队每 map 平均击杀
  // 对手强弱也影响 — 强对手压制下击杀少 ~= 对手 strength 高时 mean 减少
  let mean = team.avg_kills;
  mean -= (opponent.strength_score - 50) * 0.04; // 对手每高 1 强度分,本队击杀 -0.04
  const over = clamp(logistic((mean - Number(line)) / 2.5), 0.05, 0.95);
  return selection === 'over' ? over : 1 - over;
}

// BO5 五局率 (恰好打 5 局) 用单局胜率推
function bo5MapTotalOver45(favorite, underdog) {
  const pSeries = matchWinProbability(favorite, underdog);
  // 用 logit 倒推单局胜率近似: 假设 BO5 series win prob 来自单局 p_g
  // P(series) = sum 单局 p_g 的 binomial(2+;maps>=3 wins). 简化: p_series ~= p_g^3 * (1 + 3(1-p_g) + 6(1-p_g)^2)
  // 用数值求解 (单调,简单二分)
  let lo = 0.5, hi = 0.99;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    const pSer = mid ** 3 + 3 * mid ** 3 * (1 - mid) + 6 * mid ** 3 * (1 - mid) ** 2;
    if (pSer < pSeries) lo = mid; else hi = mid;
  }
  const pG = (lo + hi) / 2;
  // P(5 maps) = 6 * p_g^2 * (1-p_g)^2  (无论谁赢都 5 局结束)
  return 6 * pG ** 2 * (1 - pG) ** 2;
}

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  console.log(`数据: matches=${matches.length}, maps=${maps.length}, summary=${summary.length}`);

  const profiles = buildProfiles(matches, maps, summary);
  const blg = profiles.get('BLG');
  const wbg = profiles.get('WBG');
  const jdg = profiles.get('JDG');
  const al = profiles.get('AL');
  if (!blg || !wbg || !jdg || !al) {
    console.error('missing profile:', { blg: !!blg, wbg: !!wbg, jdg: !!jdg, al: !!al });
    process.exit(1);
  }

  console.log('\n=== 队伍画像 (LPL 2026 Split 2 snapshot) ===');
  for (const [name, p] of [['BLG', blg], ['WBG', wbg], ['JDG', jdg], ['AL', al]]) {
    console.log(`${name}: maps=${p.maps}, mwr=${(p.match_win_rate*100).toFixed(1)}%, map_wr=${(p.map_win_rate*100).toFixed(1)}%, strength=${p.strength_score.toFixed(1)}, avg_kills=${p.avg_kills.toFixed(2)}, avg_deaths=${p.avg_deaths.toFixed(2)}, avg_total=${p.avg_total_kills.toFixed(2)}, avg_time=${p.avg_game_time_min.toFixed(2)}, FB=${(p.first_blood_rate*100).toFixed(1)}%, FT=${(p.first_turret_rate*100).toFixed(1)}%`);
  }

  // 两场剧本判断
  const blgVsWbg = classifyScenario(blg, wbg);
  const jdgVsAl = classifyScenario(jdg, al);
  console.log('\n=== 剧本 ===');
  console.log(`BLG vs WBG: ${blgVsWbg.scenario} (fav=${blgVsWbg.favorite.team_id})`);
  console.log(`JDG vs AL: ${jdgVsAl.scenario} (fav=${jdgVsAl.favorite.team_id})`);

  // --- 对比 7 注 ---
  function evCheck(modelP, odds) {
    const breakEven = 1 / odds;
    const edge = modelP - breakEven;
    const ev = modelP * odds - 1;
    return { breakEven, edge, ev };
  }
  function fmtPct(v, digits = 1) { return `${(v * 100).toFixed(digits)}%`; }

  const bets = [
    {
      name: 'BLG 第一局击杀数 > 18.5',
      odds: 1.688,
      user_p_range: [0.66, 0.70],
      user_grade: 'A',
      model_p: singleTeamKillsProbability(blg, wbg, 18.5, 'over'),
      coverage: '外推',
      note: '单队单局击杀,不在 backtest 验证范围,divisor=2.5 假设',
    },
    {
      name: 'BLG -1.5 地图 (BLG 2-0)',
      odds: 1.650,
      user_p_range: [0.67, 0.72],
      user_grade: 'A-',
      model_p: mapHandicapProbability(blgVsWbg.favorite, blgVsWbg.underdog, blgVsWbg.scenario),
      coverage: '✅ 直接',
      note: 'map_handicap -1.5, backtest 覆盖',
    },
    {
      name: 'BLG 第一局时间 > 30',
      odds: 1.860,
      user_p_range: [0.59, 0.63],
      user_grade: 'A-',
      model_p: gameTimeProbability(blg, wbg, 30, 'over', blgVsWbg.scenario),
      coverage: '⚠️ 同公式但 line 30 不在默认 lines',
      note: 'game_time 默认 lines 是 31.5/32.5/33.5,我用同公式给 line=30',
    },
    {
      name: 'JDG vs AL 第一局时间 > 32',
      odds: 1.900,
      user_p_range: [0.56, 0.60],
      user_grade: 'B+',
      model_p: gameTimeProbability(jdg, al, 32, 'over', jdgVsAl.scenario),
      coverage: '⚠️ 同公式但 line 32 不在默认 lines',
      note: 'game_time 默认 lines 是 31.5/32.5/33.5',
    },
    {
      name: 'JDG vs AL 地图总数 > 4.5 (BO5 满 5 局)',
      odds: 2.500,
      user_p_range: [0.41, 0.45],
      user_grade: 'B',
      model_p: bo5MapTotalOver45(jdgVsAl.favorite, jdgVsAl.underdog),
      coverage: '外推',
      note: 'BO5 满 5 局,我的 map_total 模型是 BO3 line 2.5,这里用 binomial 倒推单局胜率',
    },
    {
      name: 'JDG vs AL 第一局 AL 击杀 < 12.5',
      odds: 2.026,
      user_p_range: [0.52, 0.56],
      user_grade: 'B',
      model_p: singleTeamKillsProbability(al, jdg, 12.5, 'under'),
      coverage: '外推',
      note: '同 #1 单队单局击杀',
    },
    {
      name: 'BLG 第一局击杀总数 > 30.5',
      odds: 1.992,
      user_p_range: [0.51, 0.54],
      user_grade: 'B-',
      model_p: totalKillsProbability(blg, wbg, 30.5, 'over', blgVsWbg.scenario),
      coverage: '✅ 直接 (total_kills 30.5 over)',
      note: 'backtest 覆盖,Phase 5 self_check 5.10 节: 此线 out_of_sample n=9, edge CI 含负',
    },
  ];

  console.log('\n=== 7 注模型对比 ===');
  console.log('');
  for (const b of bets) {
    const c = evCheck(b.model_p, b.odds);
    const userMidP = (b.user_p_range[0] + b.user_p_range[1]) / 2;
    const modelVsUser = (b.model_p - userMidP) * 100;
    console.log(`### ${b.name}`);
    console.log(`  覆盖度: ${b.coverage}`);
    console.log(`  备注: ${b.note}`);
    console.log(`  赔率: ${b.odds}, 隐含 ${fmtPct(c.breakEven)}`);
    console.log(`  用户模型: ${fmtPct(b.user_p_range[0])}-${fmtPct(b.user_p_range[1])}, 中位 ${fmtPct(userMidP)}, 用户给档 ${b.user_grade}`);
    console.log(`  我的模型: ${fmtPct(b.model_p)} (与用户中位差 ${modelVsUser > 0 ? '+' : ''}${modelVsUser.toFixed(1)}pp)`);
    console.log(`  edge: ${fmtPct(c.edge)}, EV: ${fmtPct(c.ev)}`);
    const verdict = c.ev > 0.10 ? '✅ 我模型也认为有显著 EV' : c.ev > 0 ? '⚠️ 我模型 EV 正但薄' : '❌ 我模型不认可';
    console.log(`  判定: ${verdict}`);
    console.log('');
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
