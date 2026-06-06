import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  clamp,
  num,
  readCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from '../shared.js';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const MATCHES_CSV = path.join(HISTORY_DIR, 'all_matches.csv');
const MAPS_CSV = path.join(HISTORY_DIR, 'all_map_details.csv');
const CURRENT_PLAYERS_CSV = path.join(DATA_DIR, 'lpl_player_map_details.csv');
const DETAIL_CSV = path.join(DATA_DIR, 'backtest', 'sample_validity_detail.csv');
const SUMMARY_CSV = path.join(DATA_DIR, 'backtest', 'sample_validity_summary.csv');
const BREAKPOINT_CSV = path.join(DATA_DIR, 'backtest', 'sample_validity_breakpoints.csv');
const CONFIG_JSON = path.join(process.cwd(), 'lpl', 'calibration', 'sample_validity_config.json');
const REPORT_MD = path.join(ANALYSIS_DIR, '样本有效性-动态窗口分析.md');

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIOR_N = 20;
const MIN_PRIOR_MAPS = 8;
const ROSTER_OVERLAP_BREAK = 0.70;

const METHODS = [
  { name: 'all_history', label: 'All history', type: 'all' },
  { name: 'last_30_maps', label: 'Last 30 maps', lastN: 30 },
  { name: 'last_60_maps', label: 'Last 60 maps', lastN: 60 },
  { name: 'last_90_maps', label: 'Last 90 maps', lastN: 90 },
  { name: 'decay_30d', label: 'Exponential decay half-life 30d', halfLifeDays: 30 },
  { name: 'decay_60d', label: 'Exponential decay half-life 60d', halfLifeDays: 60 },
  { name: 'decay_90d', label: 'Exponential decay half-life 90d', halfLifeDays: 90 },
  { name: 'post_roster_break', label: 'Since last inferred roster break', since: 'roster' },
  { name: 'current_patch_only', label: 'Current patch only', patchOnly: true },
  { name: 'dynamic_break_decay_60', label: 'Roster/patch/meta break + 60d decay', dynamic: true, halfLifeDays: 60 },
];

function dateText(value) {
  return String(value || '').slice(0, 10);
}

function rowDate(row) {
  return dateText(row.match_time || row.match_date);
}

function dateMs(value) {
  const text = dateText(value);
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function daysBetween(later, earlier) {
  const a = dateMs(later);
  const b = dateMs(earlier);
  if (a == null || b == null) return NaN;
  return Math.max(0, (a - b) / DAY_MS);
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function fmtPct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function rmse(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? Math.sqrt(mean(clean.map((value) => value ** 2))) : NaN;
}

function sideKills(row, teamId) {
  return teamKey(row.team_a_id || row.team_a) === teamKey(teamId) ? num(row.team_a_kills) : num(row.team_b_kills);
}

function sideDeaths(row, teamId) {
  return teamKey(row.team_a_id || row.team_a) === teamKey(teamId) ? num(row.team_b_kills) : num(row.team_a_kills);
}

function mapWinner(row, teamId) {
  return teamKey(row.map_winner_id || row.map_winner) === teamKey(teamId) ? 1 : 0;
}

function mapTeams(row) {
  return [
    teamKey(row.team_a_id || row.team_a),
    teamKey(row.team_b_id || row.team_b),
  ].filter(Boolean);
}

function foldOf(date) {
  const year = dateText(date).slice(0, 4);
  if (year === '2024') return 'rolling_2024';
  if (year === '2025') return 'rolling_2025';
  if (year === '2026') return 'rolling_2026';
  return '';
}

function shrinkRate(rate, n, prior = 0.5, priorN = PRIOR_N) {
  if (!Number.isFinite(rate) || n <= 0) return prior;
  return clamp((rate * n + prior * priorN) / (n + priorN), 0.02, 0.98);
}

function shrinkMean(value, n, prior, priorN = PRIOR_N) {
  if (!Number.isFinite(value) || n <= 0) return prior;
  return (value * n + prior * priorN) / (n + priorN);
}

function weightedStats(rows, teamId, cutoff, leaguePrior, halfLifeDays = null) {
  let weightSum = 0;
  let winSum = 0;
  let killsSum = 0;
  let deathsSum = 0;
  let totalKillsSum = 0;
  let gameTimeSum = 0;
  const cutoffMs = dateMs(cutoff);

  for (const row of rows) {
    const ms = dateMs(rowDate(row));
    let weight = 1;
    if (halfLifeDays && cutoffMs != null && ms != null) {
      const ageDays = Math.max(0, (cutoffMs - ms) / DAY_MS);
      weight = 0.5 ** (ageDays / halfLifeDays);
    }
    weightSum += weight;
    winSum += weight * mapWinner(row, teamId);
    killsSum += weight * sideKills(row, teamId);
    deathsSum += weight * sideDeaths(row, teamId);
    totalKillsSum += weight * num(row.total_kills);
    gameTimeSum += weight * num(row.game_time_min);
  }

  return {
    n: rows.length,
    effectiveN: weightSum,
    mapWinRate: shrinkRate(weightSum ? winSum / weightSum : NaN, weightSum),
    avgKills: shrinkMean(weightSum ? killsSum / weightSum : NaN, weightSum, leaguePrior.avgKills),
    avgDeaths: shrinkMean(weightSum ? deathsSum / weightSum : NaN, weightSum, leaguePrior.avgDeaths),
    avgTotalKills: shrinkMean(weightSum ? totalKillsSum / weightSum : NaN, weightSum, leaguePrior.avgTotalKills),
    avgGameTime: shrinkMean(weightSum ? gameTimeSum / weightSum : NaN, weightSum, leaguePrior.avgGameTime),
  };
}

async function loadPlayerRows() {
  const rows = [];
  rows.push(...await readCsvIfExists(CURRENT_PLAYERS_CSV));
  if (!existsSync(HISTORY_DIR)) return dedupePlayers(rows);
  for (const entry of await readdir(HISTORY_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(HISTORY_DIR, entry.name, 'lpl_player_map_details.csv');
    rows.push(...await readCsvIfExists(file));
  }
  return dedupePlayers(rows);
}

function dedupePlayers(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      row.match_id,
      row.game_id,
      teamKey(row.team_id || row.team),
      row.role || '',
      String(row.player_name || '').toLowerCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildRosterIndex(playerRows) {
  const byMapTeam = new Map();
  for (const row of playerRows) {
    const key = [row.match_id, row.game_id, teamKey(row.team_id || row.team)].join('|');
    if (!byMapTeam.has(key)) byMapTeam.set(key, new Map());
    const role = String(row.role || '').toUpperCase() || String(byMapTeam.get(key).size);
    byMapTeam.get(key).set(role, String(row.player_name || '').trim());
  }

  const normalized = new Map();
  for (const [key, roles] of byMapTeam.entries()) {
    const players = [...roles.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, player]) => player)
      .filter(Boolean);
    normalized.set(key, new Set(players.map((player) => player.toLowerCase())));
  }
  return normalized;
}

function rosterForMap(row, teamId, rosterIndex) {
  return rosterIndex.get([row.match_id, row.game_id, teamKey(teamId)].join('|')) || null;
}

function rosterOverlap(a, b) {
  if (!a || !b || !a.size || !b.size) return NaN;
  let same = 0;
  for (const item of a) if (b.has(item)) same += 1;
  return same / Math.max(a.size, b.size);
}

function buildBreakpoints(maps, rosterIndex) {
  const byTeam = new Map();
  for (const row of maps) {
    for (const team of mapTeams(row)) {
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(row);
    }
  }

  const breakpoints = [];
  const rosterBreaks = new Map();
  for (const [team, rows] of byTeam.entries()) {
    rows.sort((a, b) => rowDate(a).localeCompare(rowDate(b)) || num(a.bo) - num(b.bo));
    let previousRoster = null;
    for (const row of rows) {
      const roster = rosterForMap(row, team, rosterIndex);
      const overlap = rosterOverlap(previousRoster, roster);
      if (Number.isFinite(overlap) && overlap < ROSTER_OVERLAP_BREAK) {
        const date = rowDate(row);
        const item = {
          type: 'roster',
          team,
          date,
          patch: row.patch || '',
          severity: Number((1 - overlap).toFixed(3)),
          reason: `starter overlap ${(overlap * 100).toFixed(0)}%`,
        };
        breakpoints.push(item);
        if (!rosterBreaks.has(team)) rosterBreaks.set(team, []);
        rosterBreaks.get(team).push(item);
      }
      if (roster?.size) previousRoster = roster;
    }
  }

  const patches = new Map();
  for (const row of maps) {
    if (!row.patch) continue;
    const date = rowDate(row);
    if (!patches.has(row.patch) || date < patches.get(row.patch)) patches.set(row.patch, date);
  }
  const patchRows = [...patches.entries()]
    .map(([patch, date]) => ({ type: 'patch', team: 'LEAGUE', date, patch, severity: 1, reason: 'new patch first seen' }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const metaRows = [];
  const sorted = [...maps].sort((a, b) => rowDate(a).localeCompare(rowDate(b)));
  for (const patchRow of patchRows) {
    const before = sorted.filter((row) => rowDate(row) < patchRow.date).slice(-80);
    const current = sorted.filter((row) => row.patch === patchRow.patch).slice(0, 80);
    if (before.length < 30 || current.length < 20) continue;
    const killDiff = mean(current.map((row) => num(row.total_kills))) - mean(before.map((row) => num(row.total_kills)));
    const timeDiff = mean(current.map((row) => num(row.game_time_min))) - mean(before.map((row) => num(row.game_time_min)));
    if (Math.abs(killDiff) >= 1.5 || Math.abs(timeDiff) >= 1.0) {
      metaRows.push({
        type: 'meta',
        team: 'LEAGUE',
        date: patchRow.date,
        patch: patchRow.patch,
        severity: Number(Math.max(Math.abs(killDiff) / 1.5, Math.abs(timeDiff) / 1.0).toFixed(3)),
        reason: `meta shift kills=${killDiff.toFixed(2)}, time=${timeDiff.toFixed(2)}`,
      });
    }
  }

  return {
    rows: [...breakpoints, ...patchRows, ...metaRows].sort((a, b) => a.date.localeCompare(b.date)),
    rosterBreaks,
    patchFirstDate: patches,
    metaBreakDates: new Set(metaRows.map((row) => row.date)),
  };
}

function latestBefore(items, date) {
  const cutoff = dateText(date);
  return (items || []).filter((row) => row.date < cutoff).sort((a, b) => a.date.localeCompare(b.date)).at(-1) || null;
}

function leaguePrior(beforeRows) {
  return {
    avgKills: mean(beforeRows.flatMap((row) => [num(row.team_a_kills), num(row.team_b_kills)])) || 14,
    avgDeaths: mean(beforeRows.flatMap((row) => [num(row.team_b_kills), num(row.team_a_kills)])) || 14,
    avgTotalKills: mean(beforeRows.map((row) => num(row.total_kills))) || 28,
    avgGameTime: mean(beforeRows.map((row) => num(row.game_time_min))) || 31.5,
  };
}

function methodRows(priorRows, method, context) {
  let rows = priorRows;
  if (method.lastN) rows = rows.slice(-method.lastN);
  if (method.since === 'roster' && context.rosterBreakDate) {
    rows = rows.filter((row) => rowDate(row) >= context.rosterBreakDate);
  }
  if (method.patchOnly && context.patch) {
    rows = rows.filter((row) => row.patch === context.patch);
  }
  if (method.dynamic) {
    const sinceDates = [context.rosterBreakDate];
    if (context.patchAgeDays <= 14) sinceDates.push(context.patchFirstDate);
    if (context.metaBreakDate) sinceDates.push(context.metaBreakDate);
    const since = sinceDates.filter(Boolean).sort().at(-1);
    if (since) rows = rows.filter((row) => rowDate(row) >= since);
    if (rows.length < MIN_PRIOR_MAPS) rows = priorRows.slice(-60);
  }
  return rows;
}

function statsForMethod(priorRows, teamId, method, context, prior) {
  const rows = methodRows(priorRows, method, context);
  return weightedStats(rows, teamId, context.cutoff, prior, method.halfLifeDays || null);
}

function ece(rows, pKey = 'prediction', yKey = 'actual', buckets = 10) {
  if (!rows.length) return NaN;
  let total = 0;
  for (let i = 0; i < buckets; i += 1) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const bucket = rows.filter((row) => {
      const p = num(row[pKey], NaN);
      return i === buckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
    });
    if (!bucket.length) continue;
    total += (bucket.length / rows.length) * Math.abs(mean(bucket.map((row) => num(row[pKey], NaN))) - mean(bucket.map((row) => num(row[yKey], NaN))));
  }
  return total;
}

function metricSummary(rows, method, metric, fold) {
  const group = rows.filter((row) => row.method === method && row.metric === metric
    && (fold === 'recent_2025_2026' ? ['rolling_2025', 'rolling_2026'].includes(row.fold) : row.fold === fold));
  const errors = group.map((row) => num(row.prediction, NaN) - num(row.actual, NaN));
  const base = {
    method,
    metric,
    fold,
    n_rows: group.length,
    bias: mean(errors),
    mae: mean(errors.map((value) => Math.abs(value))),
    rmse: rmse(errors),
  };
  if (metric === 'map_win') {
    base.brier = mean(group.map((row) => (num(row.prediction, NaN) - num(row.actual, NaN)) ** 2));
    base.ece = ece(group);
  }
  return base;
}

function bestMethod(summaryRows, metric) {
  const baseline25 = summaryRows.find((row) => row.metric === metric && row.fold === 'rolling_2025' && row.method === 'all_history') || {};
  const baseline26 = summaryRows.find((row) => row.metric === metric && row.fold === 'rolling_2026' && row.method === 'all_history') || {};
  const candidates = summaryRows
    .filter((row) => row.metric === metric && row.fold === 'recent_2025_2026' && row.method !== 'all_history')
    .map((recent) => {
      const y25 = summaryRows.find((row) => row.metric === metric && row.fold === 'rolling_2025' && row.method === recent.method) || {};
      const y26 = summaryRows.find((row) => row.metric === metric && row.fold === 'rolling_2026' && row.method === recent.method) || {};
      const primary = metric === 'map_win' ? 'brier' : 'mae';
      const gates = {
        y2025_not_worse: num(y25[primary], Infinity) <= num(baseline25[primary], Infinity),
        y2026_improves: num(y26[primary], Infinity) < num(baseline26[primary], Infinity),
        enough_rows: num(recent.n_rows, 0) >= 100,
      };
      return {
        method: recent.method,
        metric,
        status: Object.values(gates).every(Boolean) ? 'candidate' : 'paper_only',
        recent_value: num(recent[primary], NaN),
        baseline_recent_value: num((summaryRows.find((row) => row.metric === metric && row.fold === 'recent_2025_2026' && row.method === 'all_history') || {})[primary], NaN),
        y2025_value: num(y25[primary], NaN),
        y2026_value: num(y26[primary], NaN),
        gates,
      };
    })
    .sort((a, b) => num(a.recent_value, Infinity) - num(b.recent_value, Infinity));
  return candidates[0] || null;
}

function markdownTable(columns, rows) {
  const header = `| ${columns.map((col) => col.label).join(' | ')} |`;
  const sep = `|${columns.map((col) => (col.align === 'left' ? '---' : '---:')).join('|')}|`;
  const body = rows.map((row) => `| ${columns.map((col) => {
    const value = row[col.key];
    return col.format ? col.format(value) : (value ?? '');
  }).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

async function main() {
  const [matches, maps, players] = await Promise.all([
    readCsv(MATCHES_CSV),
    readCsv(MAPS_CSV),
    loadPlayerRows(),
  ]);

  const rosterIndex = buildRosterIndex(players);
  const breakpoints = buildBreakpoints(maps, rosterIndex);
  const sortedMaps = maps
    .filter((row) => ['2024', '2025', '2026'].includes(rowDate(row).slice(0, 4)))
    .sort((a, b) => rowDate(a).localeCompare(rowDate(b)) || String(a.game_id).localeCompare(String(b.game_id)));

  const priorByTeam = new Map();
  const priorLeague = [];
  const detailRows = [];
  let skippedLowSample = 0;

  for (const map of sortedMaps) {
    const date = rowDate(map);
    const fold = foldOf(date);
    if (!fold) continue;
    const prior = leaguePrior(priorLeague);
    const teams = mapTeams(map);
    const patchFirstDate = breakpoints.patchFirstDate.get(map.patch) || date;
    const patchAgeDays = daysBetween(date, patchFirstDate);
    const metaBreakDate = [...breakpoints.metaBreakDates].filter((item) => item < date).sort().at(-1) || '';
    const teamStats = new Map();

    for (const team of teams) {
      const priorRows = priorByTeam.get(team) || [];
      if (priorRows.length < MIN_PRIOR_MAPS) {
        skippedLowSample += 1;
        continue;
      }
      const rosterBreak = latestBefore(breakpoints.rosterBreaks.get(team), date);
      const context = {
        cutoff: date,
        patch: map.patch || '',
        patchFirstDate,
        patchAgeDays,
        rosterBreakDate: rosterBreak?.date || '',
        metaBreakDate,
      };
      for (const method of METHODS) {
        const stats = statsForMethod(priorRows, team, method, context, prior);
        teamStats.set([team, method.name].join('|'), stats);
        detailRows.push({
          fold,
          year: date.slice(0, 4),
          metric: 'map_win',
          method: method.name,
          match_id: map.match_id,
          game_id: map.game_id,
          match_date: date,
          patch: map.patch || '',
          team,
          n_maps: stats.n,
          effective_maps: Number(stats.effectiveN.toFixed(3)),
          roster_break_date: context.rosterBreakDate,
          patch_age_days: Number.isFinite(patchAgeDays) ? Number(patchAgeDays.toFixed(1)) : '',
          prediction: Number(stats.mapWinRate.toFixed(4)),
          actual: mapWinner(map, team),
        });
      }
    }

    if (teams.length === 2) {
      for (const method of METHODS) {
        const a = teamStats.get([teams[0], method.name].join('|'));
        const b = teamStats.get([teams[1], method.name].join('|'));
        if (!a || !b) continue;
        detailRows.push({
          fold,
          year: date.slice(0, 4),
          metric: 'total_kills',
          method: method.name,
          match_id: map.match_id,
          game_id: map.game_id,
          match_date: date,
          patch: map.patch || '',
          team: `${teams[0]} vs ${teams[1]}`,
          n_maps: Math.min(a.n, b.n),
          effective_maps: Number(Math.min(a.effectiveN, b.effectiveN).toFixed(3)),
          prediction: Number(((a.avgTotalKills + b.avgTotalKills) / 2).toFixed(3)),
          actual: num(map.total_kills),
        });
        detailRows.push({
          fold,
          year: date.slice(0, 4),
          metric: 'game_time',
          method: method.name,
          match_id: map.match_id,
          game_id: map.game_id,
          match_date: date,
          patch: map.patch || '',
          team: `${teams[0]} vs ${teams[1]}`,
          n_maps: Math.min(a.n, b.n),
          effective_maps: Number(Math.min(a.effectiveN, b.effectiveN).toFixed(3)),
          prediction: Number(((a.avgGameTime + b.avgGameTime) / 2).toFixed(3)),
          actual: num(map.game_time_min),
        });
      }
    }

    for (const team of teams) {
      if (!priorByTeam.has(team)) priorByTeam.set(team, []);
      priorByTeam.get(team).push(map);
    }
    priorLeague.push(map);
  }

  const folds = ['rolling_2024', 'rolling_2025', 'rolling_2026', 'recent_2025_2026'];
  const metrics = ['map_win', 'total_kills', 'game_time'];
  const summaryRows = [];
  for (const metric of metrics) {
    for (const method of METHODS.map((item) => item.name)) {
      for (const fold of folds) summaryRows.push(metricSummary(detailRows, method, metric, fold));
    }
  }

  const recommendations = Object.fromEntries(metrics.map((metric) => [metric, bestMethod(summaryRows, metric)]));
  const config = {
    model: 'lpl_sample_validity_v1',
    deploy: false,
    generated_at: new Date().toISOString(),
    min_prior_maps: MIN_PRIOR_MAPS,
    tested_methods: METHODS.map((method) => method.name),
    structural_break_rules: {
      roster_overlap_break_below: ROSTER_OVERLAP_BREAK,
      patch_new_days_soft_reset: 14,
      meta_shift_flags: {
        total_kills_diff: 1.5,
        game_time_diff_minutes: 1.0,
      },
      coach_changes: 'not available in current local data; add manual override file before using coach breaks online',
    },
    recommendations,
  };

  await writeCsv(DETAIL_CSV, detailRows.map((row) => ({
    ...row,
    prediction: fmt(row.prediction),
    actual: fmt(row.actual),
  })), unionColumns(detailRows));
  await writeCsv(SUMMARY_CSV, summaryRows.map((row) => ({
    ...row,
    bias: fmt(row.bias),
    mae: fmt(row.mae),
    rmse: fmt(row.rmse),
    brier: fmt(row.brier),
    ece: fmt(row.ece),
  })), unionColumns(summaryRows));
  await writeCsv(BREAKPOINT_CSV, breakpoints.rows, ['type', 'team', 'date', 'patch', 'severity', 'reason']);
  await writeFile(CONFIG_JSON, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const recentRows = summaryRows.filter((row) => row.fold === 'recent_2025_2026');
  const report = [
    '# 样本有效性-动态窗口分析 / Sample Validity Analysis',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Detail CSV: \`${path.relative(process.cwd(), DETAIL_CSV).replaceAll(path.sep, '/')}\``,
    `- Summary CSV: \`${path.relative(process.cwd(), SUMMARY_CSV).replaceAll(path.sep, '/')}\``,
    `- Breakpoints CSV: \`${path.relative(process.cwd(), BREAKPOINT_CSV).replaceAll(path.sep, '/')}\``,
    `- Config JSON: \`${path.relative(process.cwd(), CONFIG_JSON).replaceAll(path.sep, '/')}\``,
    `- Input: matches=${matches.length}, maps=${maps.length}, player rows=${players.length}, skipped low sample team observations=${skippedLowSample}`,
    '',
    '## Plain Conclusion / 大白话结论',
    '',
    '- This is a shadow analysis. It does not change live picks because `deploy=false`.',
    '- It compares all-history, last 30/60/90 maps, 30/60/90 day decay, current patch only, inferred roster-break reset, and a dynamic hybrid.',
    '- Roster breaks are inferred from starter overlap. Coach changes are not in the local data yet, so they require a manual override file before going live.',
    '',
    '## Recent 2025+2026 Results / 近期OOS结果',
    '',
    markdownTable([
      { key: 'metric', label: 'metric', align: 'left' },
      { key: 'method', label: 'method', align: 'left' },
      { key: 'n_rows', label: 'n' },
      { key: 'brier', label: 'Brier', format: fmt },
      { key: 'ece', label: 'ECE', format: fmtPct },
      { key: 'mae', label: 'MAE', format: fmt },
      { key: 'rmse', label: 'RMSE', format: fmt },
      { key: 'bias', label: 'bias', format: fmt },
    ], recentRows
      .sort((a, b) => String(a.metric).localeCompare(String(b.metric))
        || num(a.brier ?? a.mae, Infinity) - num(b.brier ?? b.mae, Infinity))
      .slice(0, 36)),
    '',
    '## Recommended Shadow Methods / 建议观察方法',
    '',
    markdownTable([
      { key: 'metric', label: 'metric', align: 'left' },
      { key: 'method', label: 'method', align: 'left' },
      { key: 'status', label: 'status', align: 'left' },
      { key: 'recent_value', label: 'recent value', format: fmt },
      { key: 'baseline_recent_value', label: 'all-history value', format: fmt },
      { key: 'y2025_value', label: '2025', format: fmt },
      { key: 'y2026_value', label: '2026', format: fmt },
    ], Object.entries(recommendations).map(([metric, item]) => ({ metric, ...(item || {}) }))),
    '',
    '## Breakpoint Counts / 断点数量',
    '',
    markdownTable([
      { key: 'type', label: 'type', align: 'left' },
      { key: 'count', label: 'count' },
    ], [...new Map([...new Set(breakpoints.rows.map((row) => row.type))].map((type) => [
      type,
      breakpoints.rows.filter((row) => row.type === type).length,
    ])).entries()].map(([type, count]) => ({ type, count }))),
    '',
  ].join('\n');
  await writeFile(REPORT_MD, `${report}\n`, 'utf8');

  console.log(`detail_rows=${detailRows.length}`);
  console.log(`breakpoints=${breakpoints.rows.length}`);
  console.log(`deploy=${config.deploy}`);
  console.log(`wrote ${REPORT_MD}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
