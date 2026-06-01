import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProfiles } from '../build-market-analysis.js';
import { num, readCsv, teamKey } from '../shared.js';
import {
  buildSnapshotSummary,
  isFinishedMatch,
  readHistoryData,
  rowDate,
} from '../backtest/common.js';

const OUT_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'scenario_thresholds.json');

function quantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function yearOf(value) {
  return String(value || '').slice(0, 4);
}

function matchMaps(maps, matchId) {
  return maps.filter((row) => String(row.match_id || '') === String(matchId || ''));
}

function mapCountBefore(maps, teamId, cutoffDate) {
  const key = teamKey(teamId);
  return maps.filter((row) => rowDate(row) < cutoffDate
    && (teamKey(row.team_a_id || row.team_a) === key || teamKey(row.team_b_id || row.team_b) === key)).length;
}

async function main() {
  const { matches, maps } = await readHistoryData();
  const allMaps = maps.filter((row) => Number.isFinite(num(row.total_kills, NaN)) && Number.isFinite(num(row.game_time_min, NaN)));
  const teamDeaths = allMaps.flatMap((row) => [num(row.team_a_kills), num(row.team_b_kills)]);

  const snapshotCache = new Map();
  const pairAvgTotalKills = [];
  const pairAvgGameTimes = [];
  const strengthDiffs = [];
  const chaosScores = [];
  const favoriteKills = [];
  const favoriteFirstTurrets = [];
  const underdogEarly = [];
  const matchScope = [];

  for (const match of matches.filter(isFinishedMatch).sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)))) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    if (!cutoff) continue;
    if (Math.min(mapCountBefore(maps, match.team_a_id, cutoff), mapCountBefore(maps, match.team_b_id, cutoff)) < 8) continue;
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    const profiles = buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff);
    const a = profiles.get(teamKey(match.team_a_id || match.team_a));
    const b = profiles.get(teamKey(match.team_b_id || match.team_b));
    if (!a || !b) continue;
    const favorite = a.strength_score >= b.strength_score ? a : b;
    const underdog = favorite === a ? b : a;
    pairAvgTotalKills.push((num(a.avg_total_kills) + num(b.avg_total_kills)) / 2);
    pairAvgGameTimes.push((num(a.avg_game_time_min) + num(b.avg_game_time_min)) / 2);
    const diff = Math.abs(num(a.strength_score) - num(b.strength_score));
    strengthDiffs.push(diff);
    chaosScores.push((num(a.tempo_score) + num(b.tempo_score)) / 2);
    favoriteKills.push(num(favorite.avg_kills));
    favoriteFirstTurrets.push(num(favorite.first_turret_rate));
    underdogEarly.push(Math.max(num(underdog.first_blood_rate), num(underdog.first_turret_rate)));
    matchScope.push({ year: yearOf(match.match_date), maps: matchMaps(maps, match.match_id).length });
  }

  const thresholds = {
    high_kills_p70: quantile(pairAvgTotalKills, 0.70),
    low_kills_p30: quantile(pairAvgTotalKills, 0.30),
    high_time_p70: quantile(pairAvgGameTimes, 0.70),
    low_time_p30: quantile(pairAvgGameTimes, 0.30),
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

  const samplesByYear = {};
  for (const row of matchScope) {
    if (!samplesByYear[row.year]) samplesByYear[row.year] = { matches: 0, maps: 0 };
    samplesByYear[row.year].matches += 1;
    samplesByYear[row.year].maps += row.maps;
  }

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify({
    generated_at: new Date().toISOString(),
    seed: 20260530,
    source_files: [
      'lpl/data/history/all_map_details.csv',
      'lpl/data/history/all_matches.csv',
    ],
    method: 'empirical quantiles from full available LPL history; kills/time/strength/chaos use shrunk pre-match pair profiles with min 8 prior maps per team',
    thresholds,
    samples: {
      maps_for_raw_deaths: allMaps.length,
      matches_for_kills_time: pairAvgTotalKills.length,
      matches_for_strength_chaos: strengthDiffs.length,
      by_year: samplesByYear,
    },
  }, null, 2)}\n`, 'utf8');
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
