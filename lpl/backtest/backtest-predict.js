import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { buildMarketsForMatch, buildProfiles } from '../build-market-analysis.js';
import { teamKey, num } from '../shared.js';
import {
  BACKTEST_DIR,
  beforeDate,
  buildSnapshotSummary,
  ensureBacktestDir,
  isFinishedMatch,
  readHistoryData,
  rowDate,
  splitForDate,
  writeBacktestCsv,
} from './common.js';

function trainingMapCount(mapRows, teamId, cutoffDate) {
  const key = teamKey(teamId);
  return mapRows.filter((row) => beforeDate(rowDate(row), cutoffDate)
    && (teamKey(row.team_a_id || row.team_a) === key || teamKey(row.team_b_id || row.team_b) === key)).length;
}

function trainingMaxDate(mapRows, teamAId, teamBId, cutoffDate) {
  const teamIds = new Set([teamKey(teamAId), teamKey(teamBId)]);
  const dates = mapRows
    .filter((row) => beforeDate(rowDate(row), cutoffDate)
      && (teamIds.has(teamKey(row.team_a_id || row.team_a)) || teamIds.has(teamKey(row.team_b_id || row.team_b))))
    .map(rowDate)
    .filter(Boolean)
    .sort();
  return dates.at(-1) || '';
}

function patchForMatch(match, maps) {
  return match.patch || maps.find((row) => row.match_id === match.match_id)?.patch || '';
}

async function main() {
  await ensureBacktestDir();
  const { matches, maps } = await readHistoryData();
  const finished = matches
    .filter(isFinishedMatch)
    .filter((row) => {
      const mapsPlayed = num(row.score_a) + num(row.score_b);
      return mapsPlayed >= 2 && mapsPlayed <= 3;
    })
    .filter((row) => splitForDate(row.match_date)) // 只保留 2024 / 2025 的比赛
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));

  const rows = [];
  let skippedSample = 0;
  let skippedNoMarket = 0;
  let skippedNoSplit = 0;
  const leakageChecks = [];
  const snapshotCache = new Map();
  const splitCounts = new Map();

  for (const match of finished) {
    const split = splitForDate(match.match_date);
    if (!split) { skippedNoSplit += 1; continue; }
    const cutoff = match.match_date;
    const teamAMaps = trainingMapCount(maps, match.team_a_id, cutoff);
    const teamBMaps = trainingMapCount(maps, match.team_b_id, cutoff);
    if (Math.min(teamAMaps, teamBMaps) < 8) {
      skippedSample += 1;
      continue;
    }

    if (!snapshotCache.has(cutoff)) {
      snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    }
    const snapshotSummary = snapshotCache.get(cutoff);
    const profiles = buildProfiles(matches, maps, snapshotSummary, cutoff);
    const a = profiles.get(match.team_a_id);
    const b = profiles.get(match.team_b_id);
    if (!a || !b || Math.min(num(a.maps), num(b.maps)) < 8) {
      skippedSample += 1;
      continue;
    }

    const { rates } = buildMarketsForMatch(match, profiles);
    if (!rates.length) {
      skippedNoMarket += 1;
      continue;
    }

    const trainMaxDate = trainingMaxDate(maps, match.team_a_id, match.team_b_id, cutoff);
    if (leakageChecks.length < 5) {
      leakageChecks.push({
        match_id: match.match_id,
        match_date: match.match_date,
        train_max_date: trainMaxDate,
        ok: trainMaxDate < match.match_date,
      });
    }

    for (const rate of rates) {
      rows.push({
        split,
        match_id: match.match_id,
        match_date: match.match_date,
        patch: patchForMatch(match, maps),
        tournament: match.tournament || '',
        match_name: match.match_name,
        market: rate.market,
        selection: rate.selection,
        line: rate.line,
        model_p: rate.probability,
        sample: rate.sample,
        scenario: rate.scenario,
        scenario_alignment: rate.scenario_alignment,
        team_a: match.team_a,
        team_b: match.team_b,
        team_a_id: match.team_a_id,
        team_b_id: match.team_b_id,
        score_a: match.score_a,
        score_b: match.score_b,
        winner_id: match.winner_id,
        winner: match.winner,
        team_a_train_maps: teamAMaps,
        team_b_train_maps: teamBMaps,
        train_max_date: trainMaxDate,
      });
    }
    splitCounts.set(split, (splitCounts.get(split) || 0) + 1);
  }

  await writeBacktestCsv('predictions.csv', rows, [
    'split',
    'match_id', 'match_date', 'patch', 'tournament', 'match_name',
    'market', 'selection', 'line', 'model_p', 'sample', 'scenario', 'scenario_alignment',
    'team_a', 'team_b', 'team_a_id', 'team_b_id', 'score_a', 'score_b', 'winner_id', 'winner',
    'team_a_train_maps', 'team_b_train_maps', 'train_max_date',
  ]);

  const logLines = [
    `finished_matches=${finished.length}`,
    `prediction_rows=${rows.length}`,
    `skipped_low_sample=${skippedSample}`,
    `skipped_no_market=${skippedNoMarket}`,
    `skipped_no_split=${skippedNoSplit}`,
    `snapshot_cutoffs=${snapshotCache.size}`,
    `split_counts=${JSON.stringify(Object.fromEntries(splitCounts))}`,
    'leakage_spot_checks=',
    ...leakageChecks.map((row) => JSON.stringify(row)),
  ];
  await writeFile(path.join(BACKTEST_DIR, 'predict.log'), `${logLines.join('\n')}\n`, 'utf8');
  console.log(logLines.join('\n'));
}

main().catch((error) => {
  console.error(`backtest-predict failed: ${error.message}`);
  process.exitCode = 1;
});
