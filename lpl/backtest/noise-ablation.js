import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildMarketsForMatch, buildProfiles } from '../build-market-analysis.js';
import {
  DATA_DIR,
  clamp,
  num,
  parseCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from '../shared.js';
import {
  BACKTEST_DIR,
  beforeDate,
  buildSnapshotSummary,
  groupBy,
  isFinishedMatch,
  mapNumber,
  mapTeamKills,
  readHistoryData,
  rowDate,
  scoreForTeam,
} from './common.js';

const SEED = 20260606;
const BOOTSTRAP_N = 1000;
const MIN_PRIOR_MAPS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const ANALYSIS_DIR = path.join(DATA_DIR, '盘口分析');
const DETAIL_CSV = path.join(BACKTEST_DIR, 'noise_ablation_detail.csv');
const SUMMARY_CSV = path.join(BACKTEST_DIR, 'noise_ablation_summary.csv');
const BUCKET_CSV = path.join(BACKTEST_DIR, 'noise_ablation_bucket_summary.csv');
const MARKET_CANDIDATES_CSV = path.join(BACKTEST_DIR, 'noise_ablation_market_candidates.csv');
const CANDIDATE_JSON = path.join(process.cwd(), 'lpl', 'calibration', 'noise_filter_candidate.json');
const REPORT_MD = path.join(ANALYSIS_DIR, '噪音剔除-全盘口回测.md');

const METHOD_KEYS = [
  'baseline',
  'protected_gate',
  'sample_light_filter',
  'sample_filter',
  'sample_strict_filter',
  'calibration_filter',
  'line_stability_filter',
  'scenario_stability_filter',
  'patch_stability_filter',
  'patch_14d_filter',
  'edge_6_filter',
  'edge_filter',
  'edge_10_filter',
  'robust_filter',
  'sample_calibration_filter',
  'sample_calibration_edge_filter',
  'sample_calibration_patch_filter',
  'combined_noise_filter',
  'conservative_noise_filter',
  'shrink_10',
  'shrink_20',
  'shrink_30',
  'market_gap_adjust_50',
  'market_gap_adjust_100',
  'line_gap_adjust_50',
  'prior_blend_market_25',
];

const PER_MAP_MARKETS = new Set([
  'team_kills_handicap',
  'total_kills',
  'game_time',
  'first_blood',
  'first_turret',
]);

const HIGH_VARIANCE_MARKETS = new Set(['first_blood', 'first_turret', 'hero_group']);
const PROTECTED_NEGATIVE_SKILL_MARKETS = new Set(['map_total', 'team_kills_handicap', 'map_handicap']);

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function fmtPct(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '';
}

function seededRandom(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : NaN;
}

function boundP(value) {
  return clamp(num(value, 0.5), 0.02, 0.98);
}

function bucketNumber(value, cuts, labels) {
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return 'unknown';
  for (let i = 0; i < cuts.length; i += 1) {
    if (n < cuts[i]) return labels[i];
  }
  return labels.at(-1);
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

function normalizeLine(value) {
  if (value == null || value === '') return '';
  const n = Number(String(value).replace(/[^\-0-9.]/g, ''));
  return Number.isFinite(n) ? String(n) : String(value).trim();
}

function normalizeMarket(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'kill_handicap' || text.includes('kills handicap')) return 'team_kills_handicap';
  if (text.includes('total kills') || text === 'total_kills') return 'total_kills';
  if (text.includes('duration') || text === 'game_time') return 'game_time';
  if (text.includes('map winner') || text === 'game1_win') return 'game1_win';
  return text.replace(/_g\d+$/i, '');
}

function normalizeSelection(value) {
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  if (lower.includes('under') || text.includes('<') || text.includes('小')) return 'under';
  if (lower.includes('over') || text.includes('>') || text.includes('大')) return 'over';
  const atTeam = text.match(/@T([12])/i);
  if (atTeam) return atTeam[0].toUpperCase();
  return teamKey(text);
}

function canonicalMatchKeyFromTeams(a, b) {
  const teams = [teamKey(a), teamKey(b)].filter(Boolean).sort();
  return teams.length === 2 ? teams.join('_') : '';
}

function canonicalMatchKey(text, fallbackA = '', fallbackB = '') {
  if (fallbackA || fallbackB) return canonicalMatchKeyFromTeams(fallbackA, fallbackB);
  const parts = String(text || '').split(/\s+vs\s+|,|，/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return canonicalMatchKeyFromTeams(parts[0], parts[1]);
  return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function oddsKey({ date = '', matchKey = '', market = '', selection = '', line = '', round = '' }) {
  return [date, matchKey, normalizeMarket(market), normalizeSelection(selection), normalizeLine(line), round || ''].join('|');
}

function noDateOddsKey({ matchKey = '', market = '', selection = '', line = '', round = '' }) {
  return ['', matchKey, normalizeMarket(market), normalizeSelection(selection), normalizeLine(line), round || ''].join('|');
}

function readCsvByPath(filePath) {
  if (!existsSync(filePath)) return [];
  return parseCsv(readFileSync(filePath, 'utf8'));
}

function loadRealOdds() {
  const rows = [];
  const allMarketLog = readCsvByPath(path.join(ANALYSIS_DIR, '全盘口观察log.csv'));
  for (const row of allMarketLog) {
    rows.push({
      date: String(row.date || '').slice(0, 10),
      matchKey: canonicalMatchKey(row.match),
      market: normalizeMarket(row.market),
      selection: normalizeSelection(row.selection),
      line: normalizeLine(row.line),
      round: String(row.round || ''),
      odds: num(row.odds, NaN),
      source: row.platform || 'all_market_log',
    });
  }

  const totalKillsLog = readCsvByPath(path.join(ANALYSIS_DIR, '总杀报价log.csv'));
  for (const row of totalKillsLog) {
    rows.push({
      date: String(row.date || '').slice(0, 10),
      matchKey: canonicalMatchKey(row.match, row.team_a, row.team_b),
      market: normalizeMarket(row.market),
      selection: normalizeSelection(row.side),
      line: normalizeLine(row.line),
      round: '1',
      odds: num(row.odds, NaN),
      source: row.source || 'total_kills_log',
    });
  }

  const board = readCsvByPath(path.join(ANALYSIS_DIR, '小站盘口比价板.csv'));
  for (const row of board) {
    rows.push({
      date: String(row.match_date || '').slice(0, 10),
      matchKey: canonicalMatchKey(row.match_name),
      market: normalizeMarket(row.market),
      selection: normalizeSelection(row.selection),
      line: normalizeLine(row.line),
      round: String(row.round || ''),
      odds: num(row.best_odds, NaN),
      source: row.best_platform || 'best_odds_board',
    });
  }

  const byKey = new Map();
  for (const row of rows.filter((item) => Number.isFinite(item.odds) && item.odds > 1)) {
    const keys = [
      oddsKey(row),
      noDateOddsKey(row),
    ];
    for (const key of keys) {
      const current = byKey.get(key);
      if (!current || row.odds > current.odds) byKey.set(key, row);
    }
  }
  return byKey;
}

function realOddsFor(row, oddsMap) {
  const base = {
    date: row.match_date,
    matchKey: canonicalMatchKey(row.match_name, row.team_a_id, row.team_b_id),
    market: row.market,
    selection: row.selection,
    line: row.line,
    round: row.map_number ? String(row.map_number) : '',
  };
  return oddsMap.get(oddsKey(base))
    || oddsMap.get(noDateOddsKey(base))
    || oddsMap.get(oddsKey({ ...base, round: '1' }))
    || oddsMap.get(noDateOddsKey({ ...base, round: '1' }))
    || null;
}

function splitForYear(year) {
  if (year === '2024') return 'rolling_2024';
  if (year === '2025') return 'rolling_2025';
  if (year === '2026') return 'rolling_2026';
  return '';
}

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

function patchFirstDates(mapRows) {
  const out = new Map();
  for (const row of mapRows) {
    const patch = row.patch || '';
    const date = rowDate(row);
    if (!patch || !date) continue;
    if (!out.has(patch) || date < out.get(patch)) out.set(patch, date);
  }
  return out;
}

function daysBetween(later, earlier) {
  const a = Date.parse(`${String(later || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(earlier || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((a - b) / DAY_MS);
}

function outcomeForSeries(row, match, maps) {
  if (!match) return null;
  const selection = teamKey(row.selection);
  const [forScore, againstScore] = scoreForTeam(match, row.selection);

  if (row.market === 'match_win') return teamKey(match.winner_id || match.winner) === selection ? 1 : 0;
  if (row.market === 'map_handicap') return forScore + num(row.line) > againstScore ? 1 : 0;
  if (row.market === 'map_total') {
    const mapCount = num(match.score_a) + num(match.score_b);
    return row.selection === 'over' ? (mapCount > num(row.line) ? 1 : 0) : (mapCount < num(row.line) ? 1 : 0);
  }
  if (row.market === 'game1_win') {
    const game1 = maps.find((map) => mapNumber(map) === 1);
    const winnerKey = teamKey(game1?.map_winner_id || game1?.map_winner);
    return winnerKey ? (winnerKey === selection ? 1 : 0) : null;
  }
  return null;
}

function outcomeForMap(row, map) {
  const line = num(row.line);
  if (row.market === 'team_kills_handicap') {
    const kills = mapTeamKills(map, row.selection);
    if (!kills) return null;
    return kills.kills + line > kills.opponentKills ? 1 : 0;
  }
  if (row.market === 'total_kills') {
    return row.selection === 'over' ? (num(map.total_kills) > line ? 1 : 0) : (num(map.total_kills) < line ? 1 : 0);
  }
  if (row.market === 'game_time') {
    return row.selection === 'over' ? (num(map.game_time_min) > line ? 1 : 0) : (num(map.game_time_min) < line ? 1 : 0);
  }
  if (row.market === 'first_blood') {
    const winnerKey = teamKey(map.first_blood_team_id || map.first_blood_team);
    return winnerKey ? (winnerKey === teamKey(row.selection) ? 1 : 0) : null;
  }
  if (row.market === 'first_turret') {
    const winnerKey = teamKey(map.first_turret_team_id || map.first_turret_team);
    return winnerKey ? (winnerKey === teamKey(row.selection) ? 1 : 0) : null;
  }
  return null;
}

function patchForMatch(match, maps) {
  return match.patch || maps.find((row) => row.match_id === match.match_id)?.patch || '';
}

async function buildRollingRows() {
  const { matches, maps } = await readHistoryData();
  const mapsByMatch = groupBy(maps, (row) => row.match_id);
  const snapshotCache = new Map();
  const patchDates = patchFirstDates(maps);
  const finished = matches
    .filter(isFinishedMatch)
    .filter((row) => ['2024', '2025', '2026'].includes(String(row.match_date || '').slice(0, 4)))
    .sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)) || String(a.match_id).localeCompare(String(b.match_id)));

  const rows = [];
  const leakage = [];
  const skipped = { low_sample: 0, no_profile: 0, no_market: 0, no_outcome: 0 };

  for (const match of finished) {
    const cutoff = String(match.match_date || '').slice(0, 10);
    const year = cutoff.slice(0, 4);
    const split = splitForYear(year);
    if (!split) continue;
    const teamAMaps = trainingMapCount(maps, match.team_a_id, cutoff);
    const teamBMaps = trainingMapCount(maps, match.team_b_id, cutoff);
    if (Math.min(teamAMaps, teamBMaps) < MIN_PRIOR_MAPS) {
      skipped.low_sample += 1;
      continue;
    }
    if (!snapshotCache.has(cutoff)) snapshotCache.set(cutoff, buildSnapshotSummary(maps, cutoff));
    const profiles = buildProfiles(matches, maps, snapshotCache.get(cutoff), cutoff);
    const a = profiles.get(match.team_a_id);
    const b = profiles.get(match.team_b_id);
    if (!a || !b || Math.min(num(a.maps), num(b.maps)) < MIN_PRIOR_MAPS) {
      skipped.no_profile += 1;
      continue;
    }
    const { rates } = buildMarketsForMatch(match, profiles);
    if (!rates.length) {
      skipped.no_market += 1;
      continue;
    }
    const trainMaxDate = trainingMaxDate(maps, match.team_a_id, match.team_b_id, cutoff);
    if (leakage.length < 10) {
      leakage.push({
        match_id: match.match_id,
        match_date: cutoff,
        train_max_date: trainMaxDate,
        ok: trainMaxDate < cutoff,
      });
    }
    const matchMaps = (mapsByMatch.get(match.match_id) || []).sort((x, y) => mapNumber(x) - mapNumber(y));
    const patch = patchForMatch(match, matchMaps);
    const firstPatchDate = patchDates.get(patch) || cutoff;
    const patchAgeDays = daysBetween(cutoff, firstPatchDate);

    for (const rate of rates) {
      const base = {
        split,
        year,
        match_id: match.match_id,
        match_date: cutoff,
        patch,
        patch_age_days: Number.isFinite(patchAgeDays) ? patchAgeDays : '',
        patch_age_bucket: Number.isFinite(patchAgeDays) ? (patchAgeDays <= 7 ? '0-7' : patchAgeDays <= 14 ? '8-14' : '15+') : '',
        tournament: match.tournament || '',
        stage: match.stage || '',
        match_name: match.match_name,
        market: rate.market,
        selection: rate.selection,
        line: rate.line,
        model_p: num(rate.probability, NaN),
        sample: num(rate.sample, 0),
        scenario: rate.scenario || '',
        scenario_alignment: rate.scenario_alignment || '',
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
        min_team_train_maps: Math.min(teamAMaps, teamBMaps),
        train_max_date: trainMaxDate,
        line_edge_kills: rate.line_edge_kills || '',
      };
      if (!Number.isFinite(base.model_p)) continue;
      if (PER_MAP_MARKETS.has(rate.market)) {
        for (let i = 0; i < matchMaps.length; i += 1) {
          const map = matchMaps[i];
          const outcome = outcomeForMap(rate, map);
          if (outcome == null) {
            skipped.no_outcome += 1;
            continue;
          }
          rows.push({
            ...base,
            outcome,
            map_number: mapNumber(map, i),
            map_game_id: map.game_id,
            map_winner_id: map.map_winner_id,
            map_total_kills: map.total_kills,
            map_game_time_min: map.game_time_min,
          });
        }
      } else {
        const outcome = outcomeForSeries(rate, match, matchMaps);
        if (outcome == null) {
          skipped.no_outcome += 1;
          continue;
        }
        rows.push({
          ...base,
          outcome,
          map_number: '',
          map_game_id: '',
          map_winner_id: '',
          map_total_kills: '',
          map_game_time_min: '',
        });
      }
    }
  }
  return { rows, leakage, skipped };
}

function emptyStats() {
  return {
    n: 0,
    sumP: 0,
    sumY: 0,
    sumBrier: 0,
    wins: 0,
  };
}

function addStats(stats, row) {
  const p = num(row.model_p, NaN);
  const y = num(row.outcome, NaN);
  if (!Number.isFinite(p) || !Number.isFinite(y)) return;
  stats.n += 1;
  stats.sumP += p;
  stats.sumY += y;
  stats.sumBrier += (p - y) ** 2;
  stats.wins += y ? 1 : 0;
}

function statsMetric(stats) {
  if (!stats?.n) return { n: 0, ece: NaN, brier: NaN, gap: NaN, hit: NaN };
  return {
    n: stats.n,
    ece: Math.abs((stats.sumP / stats.n) - (stats.sumY / stats.n)),
    brier: stats.sumBrier / stats.n,
    gap: (stats.sumP / stats.n) - (stats.sumY / stats.n),
    hit: stats.sumY / stats.n,
  };
}

function rollingPriorAnnotate(rows) {
  const byDate = groupBy(rows, (row) => row.match_date);
  const marketStats = new Map();
  const lineStats = new Map();
  const scenarioStats = new Map();
  const annotated = [];

  for (const [date, dateRows] of [...byDate.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    for (const row of dateRows) {
      const marketKey = row.market;
      const lineKey = [row.market, row.line || ''].join('|');
      const scenarioKey = [row.market, row.line || '', row.scenario || ''].join('|');
      const market = statsMetric(marketStats.get(marketKey));
      const line = statsMetric(lineStats.get(lineKey));
      const scenario = statsMetric(scenarioStats.get(scenarioKey));
      annotated.push({
        ...row,
        prior_market_n: market.n,
        prior_market_ece: market.ece,
        prior_market_brier: market.brier,
        prior_market_gap: market.gap,
        prior_market_hit: market.hit,
        prior_line_n: line.n,
        prior_line_ece: line.ece,
        prior_line_brier: line.brier,
        prior_line_gap: line.gap,
        prior_line_hit: line.hit,
        prior_scenario_n: scenario.n,
        prior_scenario_ece: scenario.ece,
        prior_scenario_gap: scenario.gap,
        prior_scenario_hit: scenario.hit,
      });
    }

    for (const row of dateRows) {
      const keys = [
        [marketStats, row.market],
        [lineStats, [row.market, row.line || ''].join('|')],
        [scenarioStats, [row.market, row.line || '', row.scenario || ''].join('|')],
      ];
      for (const [store, key] of keys) {
        if (!store.has(key)) store.set(key, emptyStats());
        addStats(store.get(key), row);
      }
    }
  }
  return annotated;
}

function protectedBlock(row) {
  if (row.market === 'first_blood') return true;
  if (row.market === 'game_time' && String(row.map_number || '') === '1') return true;
  if (row.market === 'total_kills' && String(row.map_number || '') === '5') return true;
  if (PROTECTED_NEGATIVE_SKILL_MARKETS.has(row.market)) return true;
  return false;
}

function ruleFlags(row) {
  const p = num(row.model_p, 0.5);
  const odds = num(row.real_odds, NaN);
  const ev = Number.isFinite(odds) ? p * odds - 1 : NaN;
  const modelEdge = Math.abs(p - 0.5);
  const minMaps = num(row.min_team_train_maps, 0);
  const sample = num(row.sample, 0);
  const patchAge = num(row.patch_age_days, 999);
  const highVariance = HIGH_VARIANCE_MARKETS.has(row.market);
  const sampleLightAccept = minMaps >= 12 && sample >= 20 && num(row.prior_market_n, 0) >= 20;
  const sampleAccept = minMaps >= 16 && sample >= 32 && num(row.prior_market_n, 0) >= 30;
  const sampleStrictAccept = minMaps >= 24 && sample >= 64 && num(row.prior_market_n, 0) >= 60;
  const calibrationAccept = num(row.prior_market_n, 0) >= 60
    && num(row.prior_market_ece, 1) <= 0.08
    && (num(row.prior_line_n, 0) < 30 || num(row.prior_line_ece, 1) <= 0.10)
    && Math.abs(num(row.prior_market_gap, 0)) <= 0.08;
  const patchAccept = highVariance ? patchAge >= 15 : patchAge >= 8;
  const patch14Accept = highVariance ? patchAge >= 21 : patchAge >= 15;
  const lineStableAccept = num(row.prior_line_n, 0) >= 50 && num(row.prior_line_ece, 1) <= 0.08;
  const scenarioStableAccept = num(row.prior_scenario_n, 0) >= 40 && num(row.prior_scenario_ece, 1) <= 0.10;
  const edge6Accept = Number.isFinite(ev)
    ? ev >= 0.06 && modelEdge >= 0.035
    : modelEdge >= 0.06;
  const edgeAccept = Number.isFinite(ev)
    ? ev >= 0.08 && modelEdge >= 0.04
    : modelEdge >= 0.08;
  const edge10Accept = Number.isFinite(ev)
    ? ev >= 0.10 && modelEdge >= 0.05
    : modelEdge >= 0.10;
  const robustAccept = num(row.prior_market_n, 0) >= 100
    && num(row.prior_market_ece, 1) <= 0.06
    && num(row.prior_line_n, 0) >= 30;
  const protectedBlocked = protectedBlock(row);
  return {
    protected_block: protectedBlocked,
    protected_gate_accept: !protectedBlocked,
    sample_light_accept: sampleLightAccept && !protectedBlocked,
    sample_accept: sampleAccept && !protectedBlocked,
    sample_strict_accept: sampleStrictAccept && !protectedBlocked,
    calibration_accept: calibrationAccept && !protectedBlocked,
    line_stability_accept: lineStableAccept && !protectedBlocked,
    scenario_stability_accept: scenarioStableAccept && !protectedBlocked,
    patch_accept: patchAccept && !protectedBlocked,
    patch_14d_accept: patch14Accept && !protectedBlocked,
    edge_6_accept: edge6Accept && !protectedBlocked,
    edge_accept: edgeAccept && !protectedBlocked,
    edge_10_accept: edge10Accept && !protectedBlocked,
    robust_accept: robustAccept && !protectedBlocked,
    sample_calibration_accept: sampleAccept && calibrationAccept && !protectedBlocked,
    sample_calibration_edge_accept: sampleAccept && calibrationAccept && edgeAccept && !protectedBlocked,
    sample_calibration_patch_accept: sampleAccept && calibrationAccept && patchAccept && !protectedBlocked,
    combined_accept: sampleAccept && calibrationAccept && patchAccept && robustAccept && !protectedBlocked,
    conservative_accept: sampleStrictAccept && calibrationAccept && patch14Accept
      && (lineStableAccept || scenarioStableAccept) && !protectedBlocked,
    real_ev: ev,
    model_edge_abs: modelEdge,
  };
}

function methodAccept(row, method) {
  if (method === 'baseline') return true;
  if (method === 'protected_gate') return row.protected_gate_accept;
  if (method === 'sample_light_filter') return row.sample_light_accept;
  if (method === 'sample_filter') return row.sample_accept;
  if (method === 'sample_strict_filter') return row.sample_strict_accept;
  if (method === 'calibration_filter') return row.calibration_accept;
  if (method === 'line_stability_filter') return row.line_stability_accept;
  if (method === 'scenario_stability_filter') return row.scenario_stability_accept;
  if (method === 'patch_stability_filter') return row.patch_accept;
  if (method === 'patch_14d_filter') return row.patch_14d_accept;
  if (method === 'edge_6_filter') return row.edge_6_accept;
  if (method === 'edge_filter') return row.edge_accept;
  if (method === 'edge_10_filter') return row.edge_10_accept;
  if (method === 'robust_filter') return row.robust_accept;
  if (method === 'sample_calibration_filter') return row.sample_calibration_accept;
  if (method === 'sample_calibration_edge_filter') return row.sample_calibration_edge_accept;
  if (method === 'sample_calibration_patch_filter') return row.sample_calibration_patch_accept;
  if (method === 'combined_noise_filter') return row.combined_accept;
  if (method === 'conservative_noise_filter') return row.conservative_accept;
  if (method === 'shrink_10') return row.protected_gate_accept;
  if (method === 'shrink_20') return row.protected_gate_accept;
  if (method === 'shrink_30') return row.protected_gate_accept;
  if (method === 'market_gap_adjust_50') return row.protected_gate_accept;
  if (method === 'market_gap_adjust_100') return row.protected_gate_accept;
  if (method === 'line_gap_adjust_50') return row.protected_gate_accept;
  if (method === 'prior_blend_market_25') return row.protected_gate_accept;
  return false;
}

function methodProbability(row, method) {
  if (!methodAccept(row, method)) return 0.5;
  const p = num(row.model_p, 0.5);
  if (method === 'shrink_10') return boundP(0.5 + 0.90 * (p - 0.5));
  if (method === 'shrink_20') return boundP(0.5 + 0.80 * (p - 0.5));
  if (method === 'shrink_30') return boundP(0.5 + 0.70 * (p - 0.5));
  if (method === 'market_gap_adjust_50') {
    const gap = num(row.prior_market_gap, NaN);
    return boundP(num(row.prior_market_n, 0) >= 60 && Number.isFinite(gap) ? p - 0.5 * gap : p);
  }
  if (method === 'market_gap_adjust_100') {
    const gap = num(row.prior_market_gap, NaN);
    return boundP(num(row.prior_market_n, 0) >= 60 && Number.isFinite(gap) ? p - gap : p);
  }
  if (method === 'line_gap_adjust_50') {
    const gap = num(row.prior_line_gap, NaN);
    return boundP(num(row.prior_line_n, 0) >= 40 && Number.isFinite(gap) ? p - 0.5 * gap : p);
  }
  if (method === 'prior_blend_market_25') {
    const hit = num(row.prior_market_hit, NaN);
    return boundP(num(row.prior_market_n, 0) >= 60 && Number.isFinite(hit) ? 0.75 * p + 0.25 * hit : p);
  }
  return boundP(p);
}

function brier(rows, method) {
  if (!rows.length) return NaN;
  return mean(rows.map((row) => {
    const p = methodProbability(row, method);
    return (p - num(row.outcome)) ** 2;
  }));
}

function ece(rows, method, buckets = 10) {
  if (!rows.length) return NaN;
  let total = 0;
  for (let i = 0; i < buckets; i += 1) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const bucket = rows.filter((row) => {
      const p = methodProbability(row, method);
      return i === buckets - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
    });
    if (!bucket.length) continue;
    total += (bucket.length / rows.length)
      * Math.abs(mean(bucket.map((row) => methodProbability(row, method))) - mean(bucket.map((row) => num(row.outcome))));
  }
  return total;
}

function calibrationGap(rows, method) {
  if (!rows.length) return NaN;
  return mean(rows.map((row) => methodProbability(row, method) - num(row.outcome)));
}

function roiStats(rows, method) {
  const candidates = rows.filter((row) => {
    const odds = num(row.real_odds, NaN);
    if (!Number.isFinite(odds) || odds <= 1) return false;
    if (!methodAccept(row, method)) return false;
    return methodProbability(row, method) * odds - 1 >= 0.08;
  });
  const staked = candidates.length;
  const profit = candidates.reduce((sum, row) => sum + (num(row.outcome) ? num(row.real_odds) - 1 : -1), 0);
  return {
    real_bets: staked,
    real_profit: profit,
    real_roi: staked ? profit / staked : NaN,
    real_hit_rate: staked ? mean(candidates.map((row) => num(row.outcome))) : NaN,
  };
}

function derivedBuckets(row) {
  return {
    sample_bucket: bucketNumber(row.min_team_train_maps, [12, 20, 40], ['<12', '12-19', '20-39', '40+']),
    model_sample_bucket: bucketNumber(row.sample, [20, 50, 100], ['<20', '20-49', '50-99', '100+']),
    prior_market_ece_bucket: num(row.prior_market_n, 0) < 30
      ? 'n<30'
      : bucketNumber(row.prior_market_ece, [0.03, 0.06, 0.10], ['<3%', '3-6%', '6-10%', '10%+']),
    prior_line_ece_bucket: num(row.prior_line_n, 0) < 30
      ? 'n<30'
      : bucketNumber(row.prior_line_ece, [0.03, 0.06, 0.10], ['<3%', '3-6%', '6-10%', '10%+']),
    prior_line_n_bucket: bucketNumber(row.prior_line_n, [10, 30, 60], ['<10', '10-29', '30-59', '60+']),
    model_edge_bucket: bucketNumber(row.model_edge_abs, [0.03, 0.06, 0.10, 0.15], ['<3pp', '3-6pp', '6-10pp', '10-15pp', '15pp+']),
    line_edge_kills_bucket: row.line_edge_kills === ''
      ? 'none'
      : bucketNumber(Math.abs(num(row.line_edge_kills)), [1, 2, 3, 4], ['<1', '1-2', '2-3', '3-4', '4+']),
    real_ev_bucket: Number.isFinite(num(row.real_ev, NaN))
      ? bucketNumber(row.real_ev, [0, 0.04, 0.08, 0.12], ['<0', '0-4%', '4-8%', '8-12%', '12%+'])
      : 'no_odds',
  };
}

function bucketMetricRow(rows, fold, dimension, bucket, market = 'ALL') {
  const avgP = mean(rows.map((row) => num(row.model_p, NaN)));
  const hit = mean(rows.map((row) => num(row.outcome, NaN)));
  return {
    fold,
    market,
    dimension,
    bucket,
    n_rows: rows.length,
    avg_model_p: avgP,
    hit_rate: hit,
    calibration_gap: avgP - hit,
    brier: brier(rows, 'baseline'),
    ece: ece(rows, 'baseline'),
    real_bets: roiStats(rows, 'baseline').real_bets,
    real_roi: roiStats(rows, 'baseline').real_roi,
  };
}

function bucketSummary(rows) {
  const folds = ['rolling_2024', 'rolling_2025', 'rolling_2026', 'recent_2025_2026'];
  const dimensions = [
    'market',
    'patch_age_bucket',
    'sample_bucket',
    'model_sample_bucket',
    'prior_market_ece_bucket',
    'prior_line_ece_bucket',
    'prior_line_n_bucket',
    'model_edge_bucket',
    'line_edge_kills_bucket',
    'real_ev_bucket',
    'scenario',
  ];
  const out = [];
  for (const fold of folds) {
    const fRows = foldRows(rows, fold);
    for (const dimension of dimensions) {
      for (const [bucket, bucketRows] of groupBy(fRows, (row) => row[dimension] || 'unknown').entries()) {
        if (bucketRows.length >= 10) out.push(bucketMetricRow(bucketRows, fold, dimension, bucket));
      }
      for (const [market, marketRows] of groupBy(fRows, (row) => row.market).entries()) {
        if (dimension === 'market') continue;
        for (const [bucket, bucketRows] of groupBy(marketRows, (row) => row[dimension] || 'unknown').entries()) {
          if (bucketRows.length >= 10) out.push(bucketMetricRow(bucketRows, fold, dimension, bucket, market));
        }
      }
    }
  }
  return out;
}

function metricRow(rows, method, fold, market = 'ALL') {
  const accepted = rows.filter((row) => methodAccept(row, method)).length;
  const roi = roiStats(rows, method);
  return {
    method,
    fold,
    market,
    n_rows: rows.length,
    accepted_rows: accepted,
    trigger_rate: rows.length ? accepted / rows.length : NaN,
    brier: brier(rows, method),
    baseline_brier: brier(rows, 'baseline'),
    brier_delta: brier(rows, method) - brier(rows, 'baseline'),
    ece: ece(rows, method),
    baseline_ece: ece(rows, 'baseline'),
    ece_delta: ece(rows, method) - ece(rows, 'baseline'),
    calibration_gap: calibrationGap(rows, method),
    ...roi,
  };
}

function foldRows(rows, fold) {
  if (fold === 'rolling_2024') return rows.filter((row) => row.split === 'rolling_2024');
  if (fold === 'rolling_2025') return rows.filter((row) => row.split === 'rolling_2025');
  if (fold === 'rolling_2026') return rows.filter((row) => row.split === 'rolling_2026');
  if (fold === 'recent_2025_2026') return rows.filter((row) => row.split === 'rolling_2025' || row.split === 'rolling_2026');
  return rows;
}

function bootstrapDelta(rows, method, iterations = BOOTSTRAP_N, seed = SEED) {
  const groups = [...groupBy(rows, (row) => row.match_id).values()].map((matchRows) => {
    const baseSum = matchRows.reduce((sum, row) => sum + (methodProbability(row, 'baseline') - num(row.outcome)) ** 2, 0);
    const methodSum = matchRows.reduce((sum, row) => sum + (methodProbability(row, method) - num(row.outcome)) ** 2, 0);
    return { n: matchRows.length, baseSum, methodSum };
  });
  if (!groups.length) return { low: NaN, high: NaN };
  const random = seededRandom(seed);
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    let n = 0;
    let baseSum = 0;
    let methodSum = 0;
    for (let j = 0; j < groups.length; j += 1) {
      const group = groups[Math.floor(random() * groups.length)];
      n += group.n;
      baseSum += group.baseSum;
      methodSum += group.methodSum;
    }
    deltas.push((methodSum / n) - (baseSum / n));
  }
  return {
    low: percentile(deltas, 0.025),
    high: percentile(deltas, 0.975),
  };
}

function evaluate(rows) {
  const folds = ['rolling_2024', 'rolling_2025', 'rolling_2026', 'recent_2025_2026'];
  const summary = [];
  for (const fold of folds) {
    const fRows = foldRows(rows, fold);
    for (const method of METHOD_KEYS) summary.push(metricRow(fRows, method, fold));
    for (const [market, marketRows] of groupBy(fRows, (row) => row.market).entries()) {
      for (const method of METHOD_KEYS) summary.push(metricRow(marketRows, method, fold, market));
    }
  }
  return summary;
}

function methodSummary(summary, method, fold, market = 'ALL') {
  return summary.find((row) => row.fold === fold && row.market === market && row.method === method) || {};
}

function gateDecision(rows, summary, method = 'combined_noise_filter') {
  const s = (fold, market = 'ALL', m = method) => methodSummary(summary, m, fold, market);
  const s25 = s('rolling_2025');
  const s26 = s('rolling_2026');
  const base25 = s('rolling_2025', 'ALL', 'baseline');
  const base26 = s('rolling_2026', 'ALL', 'baseline');
  const recent = foldRows(rows, 'recent_2025_2026');
  const ci = bootstrapDelta(recent, method);
  const baselineRoi = roiStats(foldRows(rows, 'rolling_2026'), 'baseline');
  const methodRoi = roiStats(foldRows(rows, 'rolling_2026'), method);
  const realOddsEnough = baselineRoi.real_bets >= 30 && methodRoi.real_bets >= 30;
  const gates = {
    brier_2025_not_worse: num(s25.brier, Infinity) <= num(base25.brier, Infinity),
    ece_2025_not_worse: num(s25.ece, Infinity) <= num(base25.ece, Infinity) + 0.01,
    brier_2026_improves: num(s26.brier, Infinity) <= num(base26.brier, Infinity),
    ece_2026_improves: num(s26.ece, Infinity) < num(base26.ece, Infinity),
    bootstrap_brier_ci: Number.isFinite(ci.high) && ci.high <= 0,
    real_roi_not_worse: realOddsEnough && num(methodRoi.real_roi, -Infinity) >= num(baselineRoi.real_roi, -Infinity),
    min_real_odds_sample: realOddsEnough,
  };
  gates.deploy = Object.values(gates).every(Boolean);
  return {
    selected_method: method,
    gates,
    brier_delta_ci95: ci,
    baseline_2026_roi: baselineRoi,
    method_2026_roi: methodRoi,
  };
}

function methodGateScore(decision, summary, method) {
  const recent = methodSummary(summary, method, 'recent_2025_2026');
  const passCount = Object.entries(decision.gates)
    .filter(([gate, pass]) => gate !== 'deploy' && pass)
    .length;
  return {
    method,
    passCount,
    deploy: decision.gates.deploy,
    recent_brier_delta: num(recent.brier_delta, Infinity),
    recent_ece_delta: num(recent.ece_delta, Infinity),
  };
}

function selectBestGlobalDecision(rows, summary) {
  const decisions = METHOD_KEYS
    .filter((method) => method !== 'baseline')
    .map((method) => gateDecision(rows, summary, method));
  const ranked = decisions
    .map((decision) => ({
      decision,
      score: methodGateScore(decision, summary, decision.selected_method),
    }))
    .sort((a, b) => Number(b.score.deploy) - Number(a.score.deploy)
      || b.score.passCount - a.score.passCount
      || a.score.recent_brier_delta - b.score.recent_brier_delta
      || a.score.recent_ece_delta - b.score.recent_ece_delta);
  return {
    selected: ranked[0]?.decision || gateDecision(rows, summary),
    all: ranked.map((item) => ({
      ...item.score,
      brier_delta_ci_low: item.decision.brier_delta_ci95.low,
      brier_delta_ci_high: item.decision.brier_delta_ci95.high,
      gates: item.decision.gates,
    })),
  };
}

function marketCandidateRows(rows, summary) {
  const markets = [...new Set(rows.map((row) => row.market))].sort();
  const out = [];
  for (const market of markets) {
    for (const method of METHOD_KEYS.filter((key) => key !== 'baseline')) {
      const recentRows = foldRows(rows, 'recent_2025_2026').filter((row) => row.market === market);
      const rows25 = foldRows(rows, 'rolling_2025').filter((row) => row.market === market);
      const rows26 = foldRows(rows, 'rolling_2026').filter((row) => row.market === market);
      if (recentRows.length < 30) continue;
      const s25 = methodSummary(summary, method, 'rolling_2025', market);
      const s26 = methodSummary(summary, method, 'rolling_2026', market);
      const recent = methodSummary(summary, method, 'recent_2025_2026', market);
      const base26Roi = roiStats(rows26, 'baseline');
      const method26Roi = roiStats(rows26, method);
      const ci = bootstrapDelta(recentRows, method);
      const realOddsEnough = base26Roi.real_bets >= 30 && method26Roi.real_bets >= 30;
      const gates = {
        min_rows: recentRows.length >= 30,
        trigger_rate: num(recent.trigger_rate, 0) >= 0.05,
        brier_2025_not_worse: num(s25.brier_delta, 1) <= 0,
        ece_2025_not_worse: num(s25.ece_delta, 1) <= 0.01,
        brier_2026_not_worse: num(s26.brier_delta, 1) <= 0,
        ece_2026_improves: num(s26.ece_delta, 1) < 0,
        bootstrap_ci: Number.isFinite(ci.high) && ci.high <= 0,
        real_odds_enough: realOddsEnough,
        real_roi_not_worse: realOddsEnough && num(method26Roi.real_roi, -Infinity) >= num(base26Roi.real_roi, -Infinity),
      };
      const probabilityPass = gates.min_rows && gates.trigger_rate
        && gates.brier_2025_not_worse && gates.ece_2025_not_worse
        && gates.brier_2026_not_worse && gates.ece_2026_improves
        && gates.bootstrap_ci;
      const status = probabilityPass && gates.real_odds_enough && gates.real_roi_not_worse
        ? 'deployable'
        : probabilityPass
          ? 'paper_only'
          : 'reject';
      out.push({
        market,
        method,
        status,
        recent_n: recentRows.length,
        trigger_rate: recent.trigger_rate,
        recent_brier_delta: recent.brier_delta,
        recent_ece_delta: recent.ece_delta,
        brier_2025_delta: s25.brier_delta,
        ece_2025_delta: s25.ece_delta,
        brier_2026_delta: s26.brier_delta,
        ece_2026_delta: s26.ece_delta,
        brier_delta_ci_low: ci.low,
        brier_delta_ci_high: ci.high,
        baseline_2026_real_bets: base26Roi.real_bets,
        method_2026_real_bets: method26Roi.real_bets,
        baseline_2026_real_roi: base26Roi.real_roi,
        method_2026_real_roi: method26Roi.real_roi,
        gates_passed: Object.values(gates).filter(Boolean).length,
        gates: JSON.stringify(gates),
      });
    }
  }
  return out.sort((a, b) => {
    const rank = { deployable: 0, paper_only: 1, reject: 2 };
    return rank[a.status] - rank[b.status]
      || num(a.recent_brier_delta, 1) - num(b.recent_brier_delta, 1)
      || num(a.recent_ece_delta, 1) - num(b.recent_ece_delta, 1);
  });
}

function candidateJson(decision, summary, marketCandidates, allDecisions) {
  const byMarket = summary
    .filter((row) => row.fold === 'recent_2025_2026' && row.method === decision.selected_method && row.market !== 'ALL')
    .filter((row) => num(row.n_rows) >= 30 && num(row.brier_delta, 1) <= 0 && num(row.ece_delta, 1) <= 0)
    .map((row) => row.market);
  const usableCandidates = marketCandidates
    .filter((row) => row.status !== 'reject')
    .slice(0, 20)
    .map((row) => ({
      market: row.market,
      method: row.method,
      status: row.status,
      recent_brier_delta: num(row.recent_brier_delta),
      recent_ece_delta: num(row.recent_ece_delta),
      brier_delta_ci95: [num(row.brier_delta_ci_low), num(row.brier_delta_ci_high)],
      trigger_rate: num(row.trigger_rate),
    }));
  return {
    model: 'lpl_noise_filter_v1',
    deploy: decision.gates.deploy,
    generated_at: new Date().toISOString(),
    seed: SEED,
    selected_method: decision.selected_method,
    rules: {
      min_sample: 32,
      min_team_train_maps: 16,
      min_prior_market_n: 60,
      max_prior_market_ece: 0.08,
      max_prior_line_ece: 0.10,
      min_patch_age_days: 8,
      high_variance_min_patch_age_days: 15,
      min_ev_with_real_odds: 0.08,
      min_abs_model_edge_without_odds: 0.08,
      block_markets: decision.gates.deploy ? [...new Set(['first_blood', ...PROTECTED_NEGATIVE_SKILL_MARKETS])] : [],
      supported_recent_markets: [...new Set(byMarket)].sort(),
    },
    market_candidates: usableCandidates,
    validation: decision,
    all_method_gates: allDecisions,
  };
}

async function writeOutputs(rows, summary, bucketRows, marketCandidates, decision, candidate, leakage, skipped) {
  await mkdir(BACKTEST_DIR, { recursive: true });
  await mkdir(ANALYSIS_DIR, { recursive: true });
  await mkdir(path.dirname(CANDIDATE_JSON), { recursive: true });

  const detailRows = rows.map((row) => {
    const out = { ...row };
    for (const key of [
      'prior_market_ece', 'prior_market_brier', 'prior_market_gap', 'prior_line_ece', 'prior_line_brier',
      'prior_market_hit', 'prior_line_gap', 'prior_line_hit', 'prior_scenario_ece', 'prior_scenario_gap',
      'prior_scenario_hit', 'real_ev', 'model_edge_abs',
    ]) out[key] = fmt(row[key]);
    for (const method of METHOD_KEYS) {
      out[`${method}_accept`] = methodAccept(row, method) ? '1' : '0';
      out[`${method}_p`] = fmt(methodProbability(row, method));
    }
    return out;
  });
  await writeCsv(DETAIL_CSV, detailRows, unionColumns(detailRows));

  const summaryRows = summary.map((row) => ({
    ...row,
    trigger_rate: fmt(row.trigger_rate),
    brier: fmt(row.brier),
    baseline_brier: fmt(row.baseline_brier),
    brier_delta: fmt(row.brier_delta),
    ece: fmt(row.ece),
    baseline_ece: fmt(row.baseline_ece),
    ece_delta: fmt(row.ece_delta),
    calibration_gap: fmt(row.calibration_gap),
    real_profit: fmt(row.real_profit),
    real_roi: fmt(row.real_roi),
    real_hit_rate: fmt(row.real_hit_rate),
  }));
  await writeCsv(SUMMARY_CSV, summaryRows, unionColumns(summaryRows));

  const bucketOut = bucketRows.map((row) => ({
    ...row,
    avg_model_p: fmt(row.avg_model_p),
    hit_rate: fmt(row.hit_rate),
    calibration_gap: fmt(row.calibration_gap),
    brier: fmt(row.brier),
    ece: fmt(row.ece),
    real_roi: fmt(row.real_roi),
  }));
  await writeCsv(BUCKET_CSV, bucketOut, unionColumns(bucketOut));

  const marketCandidateOut = marketCandidates.map((row) => ({
    ...row,
    trigger_rate: fmt(row.trigger_rate),
    recent_brier_delta: fmt(row.recent_brier_delta),
    recent_ece_delta: fmt(row.recent_ece_delta),
    brier_2025_delta: fmt(row.brier_2025_delta),
    ece_2025_delta: fmt(row.ece_2025_delta),
    brier_2026_delta: fmt(row.brier_2026_delta),
    ece_2026_delta: fmt(row.ece_2026_delta),
    brier_delta_ci_low: fmt(row.brier_delta_ci_low),
    brier_delta_ci_high: fmt(row.brier_delta_ci_high),
    baseline_2026_real_roi: fmt(row.baseline_2026_real_roi),
    method_2026_real_roi: fmt(row.method_2026_real_roi),
  }));
  await writeCsv(MARKET_CANDIDATES_CSV, marketCandidateOut, unionColumns(marketCandidateOut));

  await writeFile(CANDIDATE_JSON, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');

  const mainRows = summary.filter((row) => row.market === 'ALL' && row.fold !== 'rolling_2024');
  const marketRows = summary
    .filter((row) => row.fold === 'recent_2025_2026' && row.method === decision.selected_method && row.market !== 'ALL')
    .sort((a, b) => num(a.brier_delta) - num(b.brier_delta))
    .slice(0, 20);

  const lines = [
    '# 噪音剔除-全盘口回测 / Noise Ablation Backtest',
    '',
    `- Generated / 生成时间: ${new Date().toISOString()}`,
    `- Detail CSV / 明细: \`${path.relative(process.cwd(), DETAIL_CSV).replaceAll(path.sep, '/')}\``,
    `- Summary CSV / 汇总: \`${path.relative(process.cwd(), SUMMARY_CSV).replaceAll(path.sep, '/')}\``,
    `- Bucket CSV / 噪音桶: \`${path.relative(process.cwd(), BUCKET_CSV).replaceAll(path.sep, '/')}\``,
    `- Market Candidates CSV / 分盘口候选: \`${path.relative(process.cwd(), MARKET_CANDIDATES_CSV).replaceAll(path.sep, '/')}\``,
    `- Candidate JSON / 候选: \`${path.relative(process.cwd(), CANDIDATE_JSON).replaceAll(path.sep, '/')}\``,
    `- Skipped / 跳过: ${JSON.stringify(skipped)}`,
    '',
    '## Verdict / 判定',
    '',
    candidate.deploy
      ? '- **DEPLOY / 已落地候选**: all gates passed. Online code will apply this filter because `deploy=true`.'
      : '- **NO DEPLOY / 不落地**: at least one hard gate failed. Online code will ignore the candidate because `deploy=false`.',
    '',
    markdownTable([
      { key: 'gate', label: 'gate / 闸门', align: 'left' },
      { key: 'pass', label: 'pass' },
    ], Object.entries(decision.gates).map(([gate, pass]) => ({ gate, pass: pass ? 'PASS' : 'FAIL' }))),
    '',
    `- Bootstrap CI / 2025+2026 Brier delta CI: [${fmt(decision.brier_delta_ci95.low)}, ${fmt(decision.brier_delta_ci95.high)}], seed=${SEED}, cluster=match_id.`,
    `- Real odds / 真实赔率: baseline 2026 bets=${decision.baseline_2026_roi.real_bets}, ROI=${fmtPct(decision.baseline_2026_roi.real_roi)}; candidate bets=${decision.method_2026_roi.real_bets}, ROI=${fmtPct(decision.method_2026_roi.real_roi)}.`,
    `- Selected method / 选中方法: \`${decision.selected_method}\`.`,
    '',
    '## All-Market Methods / 全盘口方法对比',
    '',
    markdownTable([
      { key: 'fold', label: 'fold', align: 'left' },
      { key: 'method', label: 'method', align: 'left' },
      { key: 'n_rows', label: 'n' },
      { key: 'trigger_rate', label: 'trigger', format: fmtPct },
      { key: 'brier', label: 'Brier', format: fmt },
      { key: 'brier_delta', label: 'delta', format: fmt },
      { key: 'ece', label: 'ECE', format: fmtPct },
      { key: 'ece_delta', label: 'ECE delta', format: fmtPct },
      { key: 'real_bets', label: 'real bets' },
      { key: 'real_roi', label: 'real ROI', format: fmtPct },
    ], mainRows),
    '',
    '## Market Candidates / 分盘口候选',
    '',
    markdownTable([
      { key: 'market', label: 'market', align: 'left' },
      { key: 'method', label: 'method', align: 'left' },
      { key: 'status', label: 'status', align: 'left' },
      { key: 'trigger_rate', label: 'trigger', format: fmtPct },
      { key: 'recent_brier_delta', label: 'recent Brier delta', format: fmt },
      { key: 'recent_ece_delta', label: 'recent ECE delta', format: fmtPct },
      { key: 'brier_delta_ci_high', label: 'CI high', format: fmt },
      { key: 'method_2026_real_bets', label: '2026 real bets' },
      { key: 'method_2026_real_roi', label: '2026 real ROI', format: fmtPct },
    ], marketCandidates.filter((row) => row.status !== 'reject').slice(0, 20)),
    '',
    '## Worst Noise Buckets / 主要噪音桶',
    '',
    markdownTable([
      { key: 'market', label: 'market', align: 'left' },
      { key: 'dimension', label: 'dimension', align: 'left' },
      { key: 'bucket', label: 'bucket', align: 'left' },
      { key: 'n_rows', label: 'n' },
      { key: 'brier', label: 'Brier', format: fmt },
      { key: 'ece', label: 'ECE', format: fmtPct },
      { key: 'calibration_gap', label: 'gap', format: fmtPct },
    ], bucketRows
      .filter((row) => row.fold === 'recent_2025_2026' && row.market !== 'ALL' && row.n_rows >= 30)
      .sort((a, b) => num(b.brier) - num(a.brier) || Math.abs(num(b.calibration_gap)) - Math.abs(num(a.calibration_gap)))
      .slice(0, 20)),
    '',
    '## Recent Market Detail / 2025+2026 分市场',
    '',
    markdownTable([
      { key: 'market', label: 'market', align: 'left' },
      { key: 'n_rows', label: 'n' },
      { key: 'trigger_rate', label: 'trigger', format: fmtPct },
      { key: 'brier_delta', label: 'Brier delta', format: fmt },
      { key: 'ece_delta', label: 'ECE delta', format: fmtPct },
      { key: 'real_bets', label: 'real bets' },
      { key: 'real_roi', label: 'real ROI', format: fmtPct },
    ], marketRows),
    '',
    '## Leakage Spot Check / 前视泄漏抽查',
    '',
    markdownTable([
      { key: 'match_id', label: 'match_id' },
      { key: 'match_date', label: 'match_date' },
      { key: 'train_max_date', label: 'train_max_date' },
      { key: 'ok', label: 'ok' },
    ], leakage),
    '',
    '## Notes / 备注',
    '',
    '- Rejected rows are scored as neutral probability 0.5, so Brier comparisons use the same row universe.',
    '- Existing protection remains: G5 total_kills, G1 game_time, first_blood, and known negative-skill markets are not unlocked by this experiment.',
    '- Sparse real-odds samples block deployment; ROI is reported but not over-trusted.',
    '',
  ];
  await writeFile(REPORT_MD, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const { rows: rawRows, leakage, skipped } = await buildRollingRows();
  const oddsMap = loadRealOdds();
  const withOdds = rawRows.map((row) => {
    const odds = realOddsFor(row, oddsMap);
    return {
      ...row,
      real_odds: odds?.odds || '',
      real_odds_source: odds?.source || '',
    };
  });
  const annotated = rollingPriorAnnotate(withOdds).map((row) => ({
    ...row,
    ...ruleFlags(row),
  })).map((row) => ({
    ...row,
    ...derivedBuckets(row),
  }));
  const summary = evaluate(annotated);
  const decisionSet = selectBestGlobalDecision(annotated, summary);
  const decision = decisionSet.selected;
  const buckets = bucketSummary(annotated);
  const marketCandidates = marketCandidateRows(annotated, summary);
  const candidate = candidateJson(decision, summary, marketCandidates, decisionSet.all);
  await writeOutputs(annotated, summary, buckets, marketCandidates, decision, candidate, leakage, skipped);

  console.log(`rolling_rows=${annotated.length}`);
  console.log(`markets=${[...new Set(annotated.map((row) => row.market))].sort().join(',')}`);
  console.log(`candidate_deploy=${candidate.deploy}`);
  console.log(`wrote ${REPORT_MD}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
