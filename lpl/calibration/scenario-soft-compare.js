import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SCENARIO_NAMES,
  buildProfiles,
  classifyScenario,
  classifyScenarioHard,
  totalKillsProbability,
} from '../build-market-analysis.js';
import { num, teamKey, writeCsv } from '../shared.js';
import {
  buildSnapshotSummary,
  isFinishedMatch,
  readHistoryData,
  rowDate,
} from '../backtest/common.js';

const REPORT_PATH = path.join(process.cwd(), 'lpl', 'data', '盘口分析', '剧本软分类校准对比.md');
const CSV_PATH = path.join(process.cwd(), 'lpl', 'data', 'backtest', 'scenario_soft_total_kills_under.csv');
const SEED = 20260530;
const LINES = [27.5, 30.5, 33.5];

function yearOf(value) {
  return String(value || '').slice(0, 4);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function pct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function brier(rows, key) {
  if (!rows.length) return NaN;
  return rows.reduce((sum, row) => sum + (num(row[key]) - num(row.outcome)) ** 2, 0) / rows.length;
}

function seededRandom(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function bootstrapDelta(rows) {
  const random = seededRandom(SEED);
  const deltas = [];
  for (let i = 0; i < 1000; i += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    deltas.push(brier(sample, 'p_soft') - brier(sample, 'p_hard'));
  }
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975),
  };
}

function mapRowsForMatch(maps, matchId) {
  return maps
    .filter((row) => String(row.match_id || '') === String(matchId || ''))
    .sort((a, b) => num(a.bo) - num(b.bo) || String(rowDate(a)).localeCompare(rowDate(b)));
}

function mapCountBefore(maps, teamId, cutoffDate) {
  const key = teamKey(teamId);
  return maps.filter((row) => rowDate(row) < cutoffDate
    && (teamKey(row.team_a_id || row.team_a) === key || teamKey(row.team_b_id || row.team_b) === key)).length;
}

function table(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `|${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join('|')}|`;
  const body = rows.map((row) => `| ${columns.map((col) => col.format ? col.format(row[col.key]) : row[col.key]).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

async function main() {
  const { matches, maps } = await readHistoryData();
  const eligibleMatches = matches
    .filter(isFinishedMatch)
    .filter((match) => ['2024', '2025'].includes(yearOf(match.match_date)))
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));

  const snapshotCache = new Map();
  const rows = [];
  const primaryCounts = Object.fromEntries(SCENARIO_NAMES.map((name) => [name, 0]));
  const probSums = Object.fromEntries(SCENARIO_NAMES.map((name) => [name, 0]));
  let mapWeight = 0;
  let skippedLowSample = 0;

  for (const match of eligibleMatches) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    const teamAMaps = mapCountBefore(maps, match.team_a_id, cutoff);
    const teamBMaps = mapCountBefore(maps, match.team_b_id, cutoff);
    if (Math.min(teamAMaps, teamBMaps) < 8) {
      skippedLowSample += 1;
      continue;
    }
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    const profiles = buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff);
    const a = profiles.get(teamKey(match.team_a_id || match.team_a));
    const b = profiles.get(teamKey(match.team_b_id || match.team_b));
    if (!a || !b) {
      skippedLowSample += 1;
      continue;
    }

    const hard = classifyScenarioHard(a, b);
    const soft = classifyScenario(a, b);
    const actualMaps = mapRowsForMatch(maps, match.match_id);
    for (const map of actualMaps) {
      if (!['2024', '2025'].includes(yearOf(rowDate(map)))) continue;
      primaryCounts[soft.primary_scenario] += 1;
      for (const name of SCENARIO_NAMES) probSums[name] += soft.scenario_probs[name] || 0;
      mapWeight += 1;
      for (const line of LINES) {
        rows.push({
          split: yearOf(match.match_date),
          match_id: match.match_id,
          match_date: match.match_date,
          match_name: match.match_name,
          map_bo: map.bo,
          line,
          total_kills: num(map.total_kills),
          outcome: num(map.total_kills) < line ? 1 : 0,
          hard_scenario: hard.scenario,
          soft_primary_scenario: soft.primary_scenario,
          p_hard: totalKillsProbability(a, b, line, 'under', hard.scenario),
          p_soft: totalKillsProbability(a, b, line, 'under', soft.scenario_probs),
          scenario_probs: JSON.stringify(soft.scenario_probs),
        });
      }
    }
  }

  const overall = {
    label: '2024+2025',
    n: rows.length,
    brier_hard: brier(rows, 'p_hard'),
    brier_soft: brier(rows, 'p_soft'),
  };
  overall.delta = overall.brier_soft - overall.brier_hard;
  const ci = bootstrapDelta(rows);
  const byLine = LINES.map((line) => {
    const lineRows = rows.filter((row) => num(row.line) === line);
    return {
      line,
      n: lineRows.length,
      brier_hard: brier(lineRows, 'p_hard'),
      brier_soft: brier(lineRows, 'p_soft'),
      delta: brier(lineRows, 'p_soft') - brier(lineRows, 'p_hard'),
    };
  });
  const scenarioRows = SCENARIO_NAMES.map((name) => ({
    scenario: name,
    primary_share: mapWeight ? primaryCounts[name] / mapWeight : NaN,
    mean_probability: mapWeight ? probSums[name] / mapWeight : NaN,
    primary_maps: primaryCounts[name],
  }));

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await mkdir(path.dirname(CSV_PATH), { recursive: true });
  await writeCsv(CSV_PATH, rows, [
    'split', 'match_id', 'match_date', 'match_name', 'map_bo', 'line', 'total_kills',
    'outcome', 'hard_scenario', 'soft_primary_scenario', 'p_hard', 'p_soft', 'scenario_probs',
  ]);

  const lines = [
    '# 剧本软分类校准对比 / Scenario Soft Classification Calibration',
    '',
    `- Scope / 范围: 2024+2025 finished LPL maps, total-kills under lines ${LINES.join(', ')}.`,
    `- Bootstrap / 自助法: 1000 resamples, seed=${SEED}, metric=Brier(soft)-Brier(hard).`,
    `- Skipped low-sample matches / 样本不足跳过: ${skippedLowSample}.`,
    `- Output CSV / 明细: \`${CSV_PATH}\`.`,
    '',
    '## Brier Summary / Brier 汇总',
    '',
    table([
      { key: 'label', label: 'segment / 分段', align: 'left' },
      { key: 'n', label: 'n' },
      { key: 'brier_hard', label: 'old hard Brier', format: fmt },
      { key: 'brier_soft', label: 'new soft Brier', format: fmt },
      { key: 'delta', label: 'soft-hard', format: fmt },
    ], [overall]),
    '',
    `- 95% bootstrap CI for delta / delta 置信区间: **${fmt(ci.low)} to ${fmt(ci.high)}**.`,
    `- Decision / 判断: **${overall.delta < 0 ? 'soft lower Brier / 软分类更好' : 'soft not lower / 软分类未改善'}**.`,
    '',
    '## By Line / 按盘口线',
    '',
    table([
      { key: 'line', label: 'line' },
      { key: 'n', label: 'n' },
      { key: 'brier_hard', label: 'old hard Brier', format: fmt },
      { key: 'brier_soft', label: 'new soft Brier', format: fmt },
      { key: 'delta', label: 'soft-hard', format: fmt },
    ], byLine),
    '',
    '## Scenario Distribution / 剧本分布',
    '',
    table([
      { key: 'scenario', label: 'scenario / 剧本', align: 'left' },
      { key: 'primary_maps', label: 'primary maps' },
      { key: 'primary_share', label: 'primary share', format: pct },
      { key: 'mean_probability', label: 'mean probability', format: pct },
    ], scenarioRows),
    '',
  ];
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`wrote ${REPORT_PATH}`);
  console.log(`wrote ${CSV_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
