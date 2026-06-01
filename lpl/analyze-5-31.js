// 5-31 JDG vs TES 分析 (用已部署连续总杀模型 + NB 单队/让杀)
import path from 'node:path';
import { readCsv, teamKey } from './shared.js';
import { buildProfiles, classifyScenario } from './build-market-analysis.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';
import { predictTeamKills, predictTeamKillsHandicap } from './calibration/team-kills-nb-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const PATCH = '16.10';
function pct(v) { return Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : 'n/a'; }
function ev(p, odds) { return { implied: 1 / odds, edge: p - 1 / odds, ev: p * odds - 1 }; }
function singleNb(a, b, line, sel) {
  const blue = predictTeamKills(a, b, PATCH, 'blue');
  const red = predictTeamKills(a, b, PATCH, 'red');
  if (!blue || !red) return null;
  const over = (blue.p_over(line) + red.p_over(line)) / 2;
  return { p: sel === 'over' ? over : 1 - over, mean: (blue.mean + red.mean) / 2 };
}

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const profiles = buildProfiles(matches, maps, summary);
  const jdg = profiles.get('JDG'); const tes = profiles.get('TES');
  if (!jdg || !tes) { console.error('missing', !!jdg, !!tes); process.exit(1); }

  const tk = predictTotalKills(jdg, tes);
  console.log('=== Profiles ===');
  for (const [n, p] of [['JDG', jdg], ['TES', tes]]) {
    console.log(`${n}: maps=${p.maps}, strength=${p.strength_score.toFixed(1)}, avg_kills=${p.avg_kills.toFixed(2)}, avg_total=${p.avg_total_kills.toFixed(2)}, avg_time=${p.avg_game_time_min.toFixed(2)}`);
  }
  const sc = classifyScenario(jdg, tes);
  console.log(`\nScenario: ${sc.scenario} (fav=${sc.favorite.team_id}, diff=${(sc.favorite.strength_score - sc.underdog.strength_score).toFixed(1)})`);
  console.log(`总杀模型: mean=${tk ? tk.mean.toFixed(2) : 'n/a'}, sigma=${tk ? tk.sigma.toFixed(2) : 'n/a'}`);
  const jn = singleNb('JDG', 'TES', 0, 'over'); const tn = singleNb('TES', 'JDG', 0, 'over');
  console.log(`NB 单队均值: JDG=${jn ? jn.mean.toFixed(2) : 'n/a'}, TES=${tn ? tn.mean.toFixed(2) : 'n/a'}`);

  const bets = [];
  const add = (market, sel, odds, p, note = '') => { if (p == null) return; bets.push({ market, sel, odds, p, ...ev(p, odds), note }); };
  // 总杀 (主力)
  for (const [line, oOver, oUnder] of [[26.5, 1.725, 2.138], [27.5, 1.910, 1.910], [28.5, 2.138, 1.725]]) {
    if (tk) { add('total_kills', `over ${line} @${oOver}`, oOver, tk.p_over(line)); add('total_kills', `under ${line} @${oUnder}`, oUnder, tk.p_under(line)); }
  }
  // 单队 (NB)
  add('JDG_kills', 'over 15.5 @1.860', 1.860, singleNb('JDG', 'TES', 15.5, 'over')?.p, 'NB');
  add('JDG_kills', 'under 15.5 @1.900', 1.900, singleNb('JDG', 'TES', 15.5, 'under')?.p, 'NB');
  add('TES_kills', 'over 12.5 @1.810', 1.810, singleNb('TES', 'JDG', 12.5, 'over')?.p, 'NB');
  add('TES_kills', 'under 12.5 @1.954', 1.954, singleNb('TES', 'JDG', 12.5, 'under')?.p, 'NB');
  // 击杀让分 (NB)
  add('kill_handicap', 'JDG -4.5 @2.200', 2.200, predictTeamKillsHandicap('JDG', 'TES', PATCH, '', -4.5)?.probability, 'NB');
  add('kill_handicap', 'TES +4.5 @1.687', 1.687, predictTeamKillsHandicap('TES', 'JDG', PATCH, '', 4.5)?.probability, 'NB');
  add('kill_handicap', 'JDG -3.5 @2.000', 2.000, predictTeamKillsHandicap('JDG', 'TES', PATCH, '', -3.5)?.probability, 'NB');
  add('kill_handicap', 'TES +3.5 @1.827', 1.827, predictTeamKillsHandicap('TES', 'JDG', PATCH, '', 3.5)?.probability, 'NB');

  console.log('\n=== 完整 EV 表 ===');
  console.log('market | selection | odds | 模型p | 隐含 | edge | EV | note');
  for (const b of bets) console.log(`${b.market} | ${b.sel} | ${b.odds} | ${pct(b.p)} | ${pct(b.implied)} | ${b.edge >= 0 ? '+' : ''}${pct(b.edge)} | ${b.ev >= 0 ? '+' : ''}${pct(b.ev)} | ${b.note}`);

  console.log('\n=== 允许盘里 EV>=+5% (排除封禁: 时间/胜负/让分/一血/最高金钱) ===');
  const ok = bets.filter((b) => b.ev >= 0.05).sort((a, b) => b.ev - a.ev);
  if (!ok.length) console.log('无 EV>=+5%');
  else for (const b of ok) console.log(`★ ${b.market} | ${b.sel} | model ${pct(b.p)} vs 隐含 ${pct(b.implied)} | EV ${b.ev >= 0 ? '+' : ''}${pct(b.ev)} | ${b.note}`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
