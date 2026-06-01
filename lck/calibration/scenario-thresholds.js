// 在 LCK 历史数据上算剧本分类的百分位阈值, 写到 scenario_thresholds.json。
// 用法: node lck/calibration/scenario-thresholds.js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProfiles } from '../build-market-analysis.js';
import { num, teamKey } from '../shared.js';
import {
  buildSnapshotSummary,
  isFinishedMatch,
  readHistoryData,
  rowDate,
} from '../backtest/common.js';

const OUT_PATH = path.join(process.cwd(), 'lck', 'calibration', 'scenario_thresholds.json');

function quantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mapCountBefore(maps, teamId, cutoffDate) {
  const key = teamKey(teamId);
  return maps.filter((row) => rowDate(row) < cutoffDate
    && (teamKey(row.team_a_id || row.team_a) === key || teamKey(row.team_b_id || row.team_b) === key)).length;
}

async function main() {
  const { matches, maps } = await readHistoryData();
  const teamDeaths = maps
    .filter((row) => Number.isFinite(num(row.total_kills, NaN)))
    .flatMap((row) => [num(row.team_a_kills), num(row.team_b_kills)]);

  const snapshotCache = new Map();
  const pairKills = [];
  const pairTimes = [];
  const strengthDiffs = [];
  const chaosScores = [];
  const favoriteKills = [];
  const favoriteFirstTurrets = [];
  const underdogEarly = [];
  let used = 0;

  for (const match of matches.filter(isFinishedMatch).sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)))) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    if (!cutoff) continue;
    if (Math.min(mapCountBefore(maps, match.team_a_id, cutoff), mapCountBefore(maps, match.team_b_id, cutoff)) < 8) continue;
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    const profiles = buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff);
    const a = profiles.get(match.team_a_id);
    const b = profiles.get(match.team_b_id);
    if (!a || !b) continue;
    const favorite = a.strength_score >= b.strength_score ? a : b;
    const underdog = favorite === a ? b : a;
    pairKills.push((num(a.avg_total_kills) + num(b.avg_total_kills)) / 2);
    pairTimes.push((num(a.avg_game_time_min) + num(b.avg_game_time_min)) / 2);
    strengthDiffs.push(Math.abs(num(a.strength_score) - num(b.strength_score)));
    chaosScores.push((num(a.tempo_score) + num(b.tempo_score)) / 2);
    favoriteKills.push(num(favorite.avg_kills));
    favoriteFirstTurrets.push(num(favorite.first_turret_rate));
    underdogEarly.push(Math.max(num(underdog.first_blood_rate), num(underdog.first_turret_rate)));
    used += 1;
  }

  const thresholds = {
    high_kills_p70: quantile(pairKills, 0.70),
    low_kills_p30: quantile(pairKills, 0.30),
    high_time_p70: quantile(pairTimes, 0.70),
    low_time_p30: quantile(pairTimes, 0.30),
    chaos_p70: quantile(chaosScores, 0.70),
    chaos_p30: quantile(chaosScores, 0.30),
    strength_diff_p70: quantile(strengthDiffs, 0.70),
    strength_diff_p50: quantile(strengthDiffs, 0.50),
    strength_diff_p30: quantile(strengthDiffs, 0.30),
    avg_deaths_p70: quantile(teamDeaths, 0.70),
    favorite_kills_p50: quantile(favoriteKills, 0.50),
    first_turret_p60: quantile(favoriteFirstTurrets, 0.60),
    underdog_early_p50: quantile(underdogEarly, 0.50),
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    method: 'LCK 全量历史经验百分位; kills/time/strength/chaos 用赛前(近期权重)对位画像, 每队至少 8 张赛前小局',
    source_files: ['lck/data/history/all_map_details.csv', 'lck/data/history/all_matches.csv'],
    matches_used: used,
    maps_for_deaths: teamDeaths.length,
    thresholds,
  }, null, 2)}\n`, 'utf8');
  console.log(`wrote ${OUT_PATH} (matches_used=${used})`);
  console.log(thresholds);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
