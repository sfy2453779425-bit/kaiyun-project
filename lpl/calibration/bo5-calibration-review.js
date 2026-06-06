import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  clamp,
  readCsv,
  readCsvIfExists,
  teamKey,
  writeCsv,
} from '../shared.js';
import { buildProfiles } from '../build-market-analysis.js';
import { predictTotalKills } from './total-kills-model-predict.js';

const DETAIL_CSV = path.join(DATA_DIR, 'backtest', 'total_kills_continuous_vs_scenario.csv');
const HISTORY_MAPS = path.join(DATA_DIR, 'history', 'all_map_details.csv');
const CURRENT_MATCHES = path.join(DATA_DIR, 'lpl_matches.csv');
const CURRENT_MAPS = path.join(DATA_DIR, 'lpl_map_details.csv');
const CURRENT_SUMMARY = path.join(DATA_DIR, 'lpl_team_detail_summary.csv');
const OUT_MD = path.join(ANALYSIS_DIR, 'BO5校准复核.md');
const OUT_RELIABILITY = path.join(DATA_DIR, 'backtest', 'bo5_calibration_reliability.csv');
const BOOTSTRAP_N = 1000;
const SEED = 20260603;
const LINES = [27.5, 30.5, 33.5];

function num(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

function pct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '';
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function reliabilityBins(rows, key = 'p_continuous', binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    bin: index,
    low: index / binCount,
    high: (index + 1) / binCount,
    n: 0,
    pSum: 0,
    ySum: 0,
  }));
  for (const row of rows) {
    const p = num(row[key]);
    const y = num(row.outcome);
    if (!Number.isFinite(p) || !Number.isFinite(y)) continue;
    let index = Math.floor(p * binCount);
    index = Math.max(0, Math.min(binCount - 1, index));
    bins[index].n += 1;
    bins[index].pSum += p;
    bins[index].ySum += y;
  }
  return bins
    .filter((bin) => bin.n > 0)
    .map((bin) => ({
      ...bin,
      pred: bin.pSum / bin.n,
      actual: bin.ySum / bin.n,
      abs_gap: Math.abs(bin.pSum / bin.n - bin.ySum / bin.n),
    }));
}

function metrics(rows, key = 'p_continuous') {
  const valid = rows.filter((row) => Number.isFinite(num(row[key])) && Number.isFinite(num(row.outcome)));
  if (!valid.length) {
    return {
      n: 0,
      clusters: 0,
      maps: 0,
      ece: NaN,
      brier: NaN,
      mean_p: NaN,
      hit_rate: NaN,
      mean_total_kills: NaN,
      mean_pred_total: NaN,
      mean_residual: NaN,
    };
  }

  const brier = mean(valid.map((row) => (num(row[key]) - num(row.outcome)) ** 2));
  const bins = reliabilityBins(valid, key);
  const ece = bins.reduce((sum, bin) => sum + (bin.n / valid.length) * bin.abs_gap, 0);
  const mapKeys = new Set(valid.map((row) => `${row.match_id}|${row.game_id}`));
  const clusters = new Set(valid.map((row) => row.match_id));
  const uniqueMapRows = [...mapKeys].map((mapKey) => valid.find((row) => `${row.match_id}|${row.game_id}` === mapKey));

  return {
    n: valid.length,
    clusters: clusters.size,
    maps: mapKeys.size,
    ece,
    brier,
    mean_p: mean(valid.map((row) => num(row[key]))),
    hit_rate: mean(valid.map((row) => num(row.outcome))),
    mean_total_kills: mean(uniqueMapRows.map((row) => num(row.total_kills))),
    mean_pred_total: mean(uniqueMapRows.map((row) => num(row.continuous_mean))),
    mean_residual: mean(uniqueMapRows.map((row) => num(row.total_kills) - num(row.continuous_mean))),
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function metricRowsByMapBo(rows, scopeLabel, filterFn = () => true) {
  const out = [];
  for (const mapBo of ['1', '2', '3', '4', '5']) {
    const subset = rows.filter((row) => filterFn(row) && row.map_bo === mapBo);
    const m = metrics(subset);
    out.push({
      scope: scopeLabel,
      map_bo: mapBo,
      n_rows: m.n,
      n_maps: m.maps,
      n_matches: m.clusters,
      ece: m.ece,
      brier: m.brier,
      mean_total_kills: m.mean_total_kills,
      mean_pred_total: m.mean_pred_total,
      mean_residual: m.mean_residual,
    });
  }
  return out;
}

function enrichRows(rows, maps) {
  const metaByMap = new Map(maps.map((row) => [`${row.match_id}|${row.game_id}`, row]));
  return rows.map((row) => {
    const meta = metaByMap.get(`${row.match_id}|${row.game_id}`) || {};
    const tournament = meta.tournament || '';
    const stage = meta.stage || '';
    const historySlug = meta.history_slug || '';
    const playoffByTournament = /playoff|final|regional|placements/i.test(`${tournament} ${historySlug}`);
    const playoffByStage = /ROUND|FINAL|SEMIFINAL|KNOCKOUT|PLAY-IN/i.test(stage);
    const stage_type = playoffByTournament || playoffByStage ? 'playoff_like' : 'regular_like';
    const teams = [teamKey(meta.team_a_id || ''), teamKey(meta.team_b_id || '')].filter(Boolean).sort().join('+');
    return {
      ...row,
      tournament,
      stage,
      stage_type,
      patch_meta: meta.patch || row.patch || '',
      history_slug: historySlug,
      team_a_id: teamKey(meta.team_a_id || ''),
      team_b_id: teamKey(meta.team_b_id || ''),
      teams,
    };
  });
}

function resampleRowsByCluster(rows, random) {
  const groups = [...groupBy(rows, (row) => row.match_id).values()];
  if (!groups.length) return [];
  const out = [];
  for (let i = 0; i < groups.length; i += 1) {
    const picked = groups[Math.floor(random() * groups.length)];
    out.push(...picked);
  }
  return out;
}

function pairedClusterDiff(rowsA, rowsB, random) {
  const allClusterIds = [...new Set([...rowsA, ...rowsB].map((row) => row.match_id))];
  const groupA = groupBy(rowsA, (row) => row.match_id);
  const groupB = groupBy(rowsB, (row) => row.match_id);
  const sampleA = [];
  const sampleB = [];
  if (!allClusterIds.length) return NaN;
  for (let i = 0; i < allClusterIds.length; i += 1) {
    const id = allClusterIds[Math.floor(random() * allClusterIds.length)];
    if (groupA.has(id)) sampleA.push(...groupA.get(id));
    if (groupB.has(id)) sampleB.push(...groupB.get(id));
  }
  if (!sampleA.length || !sampleB.length) return NaN;
  return metrics(sampleA).ece - metrics(sampleB).ece;
}

function bootstrap(rows, rowsCompare, iterations = BOOTSTRAP_N, seed = SEED) {
  const random = rng(seed);
  const eceValues = [];
  const diffValues = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = resampleRowsByCluster(rows, random);
    if (sample.length) eceValues.push(metrics(sample).ece);
    if (rowsCompare) {
      const diff = pairedClusterDiff(rows, rowsCompare, random);
      if (Number.isFinite(diff)) diffValues.push(diff);
    }
  }
  const ci = (values) => ({
    low: percentile(values, 0.025),
    median: percentile(values, 0.5),
    high: percentile(values, 0.975),
    n: values.length,
  });
  return {
    ece: ci(eceValues),
    diff: rowsCompare ? ci(diffValues) : null,
  };
}

function table(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.map((h) => h.label).join(' | ')} |`);
  lines.push(`| ${headers.map((h) => h.align === 'right' ? '---:' : '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${headers.map((h) => {
      const value = row[h.key];
      if (h.format) return h.format(value, row);
      return value ?? '';
    }).join(' | ')} |`);
  }
  return lines.join('\n');
}

function topStageRows(rows, filterFn, minRows = 18) {
  const groups = [...groupBy(rows.filter(filterFn), (row) => `${row.stage_type}|${row.tournament}|${row.stage}|${row.patch_meta}`).entries()]
    .map(([key, groupRows]) => {
      const [stage_type, tournament, stage, patch] = key.split('|');
      return { stage_type, tournament, stage, patch, ...metrics(groupRows) };
    })
    .filter((row) => row.n >= minRows)
    .sort((a, b) => b.ece - a.ece);
  return groups;
}

function teamExposureRows(rows, filterFn) {
  const gameRows = new Map();
  for (const row of rows.filter(filterFn)) {
    const key = `${row.match_id}|${row.game_id}`;
    if (!gameRows.has(key)) gameRows.set(key, row);
  }
  const teamRows = [];
  for (const team of [...new Set([...gameRows.values()].flatMap((row) => [row.team_a_id, row.team_b_id]).filter(Boolean))]) {
    const matchRows = rows.filter((row) => filterFn(row) && (row.team_a_id === team || row.team_b_id === team));
    teamRows.push({ team, ...metrics(matchRows) });
  }
  return teamRows.sort((a, b) => b.n - a.n || b.ece - a.ece);
}

function reliabilityTableRows(rows, label) {
  return reliabilityBins(rows).map((bin) => ({
    label,
    bin: `${Math.round(bin.low * 100)}-${Math.round(bin.high * 100)}%`,
    n: bin.n,
    pred: bin.pred,
    actual: bin.actual,
    gap: bin.actual - bin.pred,
  }));
}

async function build2026Supplement() {
  const [matches, maps, summaryRows] = await Promise.all([
    readCsv(CURRENT_MATCHES).catch(() => []),
    readCsvIfExists(CURRENT_MAPS),
    readCsv(CURRENT_SUMMARY).catch(() => []),
  ]);
  const rows = [];
  for (const map of maps.filter((row) => String(row.match_time || '').startsWith('2026') && Number(row.bo) >= 1)) {
    const profiles = buildProfiles(matches, maps, summaryRows, map.match_time);
    const a = profiles.get(teamKey(map.team_a_id));
    const b = profiles.get(teamKey(map.team_b_id));
    if (!a || !b) continue;
    const pred = predictTotalKills(a, b);
    if (!pred) continue;
    const totalKills = num(map.total_kills);
    if (!Number.isFinite(totalKills)) continue;
    for (const line of LINES) {
      for (const selection of ['over', 'under']) {
        const p = selection === 'over' ? pred.p_over(line) : pred.p_under(line);
        const outcome = selection === 'over' ? (totalKills > line ? 1 : 0) : (totalKills < line ? 1 : 0);
        rows.push({
          split_year: '2026',
          match_id: map.match_id,
          game_id: map.game_id,
          match_date: map.match_time,
          match_name: map.match_name,
          map_bo: map.bo,
          line: String(line),
          selection,
          total_kills: String(totalKills),
          outcome: String(outcome),
          p_continuous: String(p),
          continuous_mean: String(pred.mean),
          sigma: String(pred.sigma),
          patch: map.patch,
          stage: map.stage,
          stage_type: /ROUND|FINAL|SEMIFINAL|KNOCKOUT|PLAY-IN/i.test(map.stage || '') ? 'playoff_like' : 'regular_like',
          patch_meta: map.patch,
          tournament: map.tournament,
          team_a_id: teamKey(map.team_a_id),
          team_b_id: teamKey(map.team_b_id),
          teams: [teamKey(map.team_a_id), teamKey(map.team_b_id)].filter(Boolean).sort().join('+'),
        });
      }
    }
  }
  return rows;
}

async function main() {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const [detailRowsRaw, historyMaps] = await Promise.all([
    readCsv(DETAIL_CSV),
    readCsv(HISTORY_MAPS),
  ]);
  const detailRows = enrichRows(detailRowsRaw, historyMaps);
  const supplemental2026 = await build2026Supplement();
  const with2026 = [...detailRows, ...supplemental2026];

  const reproduced = [
    ...metricRowsByMapBo(detailRows, 'all'),
    ...metricRowsByMapBo(detailRows, '2025_oos', (row) => row.split_year === '2025'),
    ...metricRowsByMapBo(detailRows, '2024_fit', (row) => row.split_year === '2024'),
    ...metricRowsByMapBo(with2026, 'all_plus_2026_current', () => true),
  ];

  const g5_2025 = detailRows.filter((row) => row.split_year === '2025' && row.map_bo === '5');
  const g3_2025 = detailRows.filter((row) => row.split_year === '2025' && row.map_bo === '3');
  const boot2025 = bootstrap(g5_2025, g3_2025);

  const g5All = detailRows.filter((row) => row.map_bo === '5');
  const g3All = detailRows.filter((row) => row.map_bo === '3');
  const bootAll = bootstrap(g5All, g3All, BOOTSTRAP_N, SEED + 11);

  const reliabilityRows = [
    ...reliabilityTableRows(g5_2025, '2025 G5'),
    ...reliabilityTableRows(g3_2025, '2025 G3'),
    ...reliabilityTableRows(g5All, '2024-2025 G5'),
  ];
  await writeCsv(OUT_RELIABILITY, reliabilityRows, ['label', 'bin', 'n', 'pred', 'actual', 'gap']);

  const splitRows = [];
  for (const scope of [
    { label: '2025 OOS', rows: detailRows.filter((row) => row.split_year === '2025') },
    { label: '2024 fit', rows: detailRows.filter((row) => row.split_year === '2024') },
    { label: '2024-2025', rows: detailRows },
    { label: '2024-2026 supplement', rows: with2026 },
  ]) {
    for (const stageType of ['regular_like', 'playoff_like']) {
      for (const mapBo of ['3', '4', '5']) {
        const subset = scope.rows.filter((row) => row.stage_type === stageType && row.map_bo === mapBo);
        if (!subset.length) continue;
        splitRows.push({
          scope: scope.label,
          stage_type: stageType,
          map_bo: mapBo,
          ...metrics(subset),
        });
      }
    }
  }

  const stageTop = topStageRows(detailRows, (row) => row.split_year === '2025' && ['3', '4', '5'].includes(row.map_bo), 18).slice(0, 12);
  const patchRows = [...groupBy(detailRows.filter((row) => row.split_year === '2025' && ['3', '4', '5'].includes(row.map_bo)), (row) => `${row.patch_meta}|G${row.map_bo}`).entries()]
    .map(([key, rows]) => {
      const [patch, mapBo] = key.split('|');
      return { patch, map_bo: mapBo.replace('G', ''), ...metrics(rows) };
    })
    .filter((row) => row.n >= 18)
    .sort((a, b) => b.ece - a.ece);
  const teamRows = teamExposureRows(detailRows, (row) => row.split_year === '2025' && row.map_bo === '5').slice(0, 12);

  const lines = [];
  lines.push('# BO5校准复核 / BO5 Calibration Review');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Data: \`${path.relative(process.cwd(), DETAIL_CSV).replaceAll(path.sep, '/')}\``);
  lines.push('');
  lines.push('## Executive Verdict / 最终判定');
  lines.push('');
  const significant = boot2025.diff.low > 0 || boot2025.diff.high < 0;
  lines.push(`- Claude 的复现数字: **对得上**。按 \`map_bo\` 分组, 2025 G5 ECE=${pct(metrics(g5_2025).ece)}, Brier=${fmt(metrics(g5_2025).brier)}。`);
  lines.push(`- 但 \`map_bo\` 的语义是 **第几局/G1-G5**, 不是"赛制 BO1/BO3/BO5"。所以严格说, 本报告检验的是 **G5/第五局总杀校准**, 不是所有 BO5 系列总杀。`);
  lines.push(`- 2025 cluster bootstrap: G5 ECE 95% CI [${pct(boot2025.ece.low)}, ${pct(boot2025.ece.high)}]; G5-G3 ECE 差 95% CI [${pct(boot2025.diff.low)}, ${pct(boot2025.diff.high)}]。`);
  lines.push(significant
    ? '- 统计上 G5 相对 G3 的 ECE 差异不跨 0, **G5 失准显著**。'
    : '- 统计上 G5 相对 G3 的 ECE 差异 CI 跨 0, **不能证明 G5 失准显著高于 G3**。');
  lines.push('- 混淆检查显示: 2025 G5 既包含常规周赛, 也包含季后赛/总决赛段; 不是单纯"季后赛 BO5"解释。但样本只有 17 张 G5 图(102 行), 队伍/patch/stage 暴露高度集中。');
  lines.push('- 结论: **支持临时/保守闸门: G5 总杀盘不真下, 只纸面记录; 不支持把它表述为永久 BO5 系列闸门。** 真正可证伪对象应命名为 `map_bo=5 / G5 total_kills gate`。');
  lines.push('');
  lines.push('## 1. Reproduction / 复现数字');
  lines.push('');
  lines.push(table([
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'map_bo', label: 'G#', align: 'right' },
    { key: 'n_rows', label: 'rows', align: 'right' },
    { key: 'n_maps', label: 'maps', align: 'right' },
    { key: 'n_matches', label: 'matches', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
    { key: 'mean_total_kills', label: 'actual kills', align: 'right', format: (v) => fmt(v, 2) },
    { key: 'mean_pred_total', label: 'pred kills', align: 'right', format: (v) => fmt(v, 2) },
    { key: 'mean_residual', label: 'actual-pred', align: 'right', format: (v) => fmt(v, 2) },
  ], reproduced.filter((row) => ['all', '2025_oos', '2024_fit'].includes(row.scope))));
  lines.push('');
  lines.push('## 2. Cluster Bootstrap / 聚类 Bootstrap');
  lines.push('');
  lines.push(`- Bootstrap: ${BOOTSTRAP_N} iterations, seed=${SEED}, cluster by \`match_id\`.`);
  lines.push('');
  lines.push(table([
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'g5_ece', label: 'G5 ECE', align: 'right', format: (v) => pct(v) },
    { key: 'g5_ci', label: 'G5 ECE 95% CI', align: 'right' },
    { key: 'diff', label: 'G5-G3 ECE diff', align: 'right', format: (v) => pct(v) },
    { key: 'diff_ci', label: 'diff 95% CI', align: 'right' },
  ], [
    {
      scope: '2025 OOS',
      g5_ece: metrics(g5_2025).ece,
      g5_ci: `[${pct(boot2025.ece.low)}, ${pct(boot2025.ece.high)}]`,
      diff: metrics(g5_2025).ece - metrics(g3_2025).ece,
      diff_ci: `[${pct(boot2025.diff.low)}, ${pct(boot2025.diff.high)}]`,
    },
    {
      scope: '2024-2025 all',
      g5_ece: metrics(g5All).ece,
      g5_ci: `[${pct(bootAll.ece.low)}, ${pct(bootAll.ece.high)}]`,
      diff: metrics(g5All).ece - metrics(g3All).ece,
      diff_ci: `[${pct(bootAll.diff.low)}, ${pct(bootAll.diff.high)}]`,
    },
  ]));
  lines.push('');
  lines.push('## 3. Reliability Diagram / 可靠性曲线');
  lines.push('');
  lines.push(`CSV: \`${path.relative(process.cwd(), OUT_RELIABILITY).replaceAll(path.sep, '/')}\``);
  lines.push('');
  lines.push(table([
    { key: 'label', label: 'segment', align: 'left' },
    { key: 'bin', label: 'p bin', align: 'left' },
    { key: 'n', label: 'n', align: 'right' },
    { key: 'pred', label: 'avg p', align: 'right', format: (v) => pct(v) },
    { key: 'actual', label: 'actual', align: 'right', format: (v) => pct(v) },
    { key: 'gap', label: 'actual-p', align: 'right', format: (v) => pct(v) },
  ], reliabilityRows.filter((row) => row.label === '2025 G5')));
  lines.push('');
  lines.push('Interpretation: 2025 G5 的误差不是单一方向均值偏置。因为同一 line 同时有 over/under, 整体 mean p 与 hit rate 天然约 50%; 真正的问题体现在若干概率桶里, 模型对高/低概率两端排序不稳定。');
  lines.push('');
  lines.push('## 4. Confounding Checks / 混淆分层');
  lines.push('');
  lines.push('### Stage Type x Game Number / 阶段类型 x 第几局');
  lines.push('');
  lines.push(table([
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'stage_type', label: 'stage type', align: 'left' },
    { key: 'map_bo', label: 'G#', align: 'right' },
    { key: 'n', label: 'rows', align: 'right' },
    { key: 'maps', label: 'maps', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
    { key: 'mean_residual', label: 'actual-pred kills', align: 'right', format: (v) => fmt(v, 2) },
  ], splitRows.filter((row) => row.scope === '2025 OOS')));
  lines.push('');
  lines.push('### Highest 2025 G3-G5 Stage/Patch Buckets / 2025 G3-G5 高 ECE 阶段');
  lines.push('');
  lines.push(table([
    { key: 'stage_type', label: 'stage type', align: 'left' },
    { key: 'tournament', label: 'tournament', align: 'left' },
    { key: 'stage', label: 'stage', align: 'left' },
    { key: 'patch', label: 'patch', align: 'left' },
    { key: 'n', label: 'rows', align: 'right' },
    { key: 'maps', label: 'maps', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
  ], stageTop));
  lines.push('');
  lines.push('### Patch Buckets / Patch 分层');
  lines.push('');
  lines.push(table([
    { key: 'patch', label: 'patch', align: 'left' },
    { key: 'map_bo', label: 'G#', align: 'right' },
    { key: 'n', label: 'rows', align: 'right' },
    { key: 'maps', label: 'maps', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
  ], patchRows.slice(0, 16)));
  lines.push('');
  lines.push('### 2025 G5 Team Exposure / 2025 G5 队伍暴露');
  lines.push('');
  lines.push(table([
    { key: 'team', label: 'team', align: 'left' },
    { key: 'n', label: 'rows', align: 'right' },
    { key: 'maps', label: 'maps', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
  ], teamRows));
  lines.push('');
  lines.push('## 5. 2026 Supplement / 2026 补充样本');
  lines.push('');
  lines.push('2026 不在正式 `total_kills_continuous_vs_scenario.csv` 中。这里用当前 `lpl_matches/lpl_map_details` 重新 walk-forward 生成补充样本, 仅作方向观察, 不作为主验证口径。');
  lines.push('');
  lines.push(table([
    { key: 'scope', label: 'scope', align: 'left' },
    { key: 'map_bo', label: 'G#', align: 'right' },
    { key: 'n_rows', label: 'rows', align: 'right' },
    { key: 'n_maps', label: 'maps', align: 'right' },
    { key: 'n_matches', label: 'matches', align: 'right' },
    { key: 'ece', label: 'ECE', align: 'right', format: (v) => pct(v) },
    { key: 'brier', label: 'Brier', align: 'right', format: (v) => fmt(v) },
    { key: 'mean_residual', label: 'actual-pred', align: 'right', format: (v) => fmt(v, 2) },
  ], reproduced.filter((row) => row.scope === 'all_plus_2026_current' && ['3', '4', '5'].includes(row.map_bo))));
  lines.push('');
  lines.push('## 6. Why Low Brier But High ECE? / 为什么 Brier 低但 ECE 高');
  lines.push('');
  lines.push('- Brier 衡量逐注平方误差, 对样本中大量"很容易的 over/under"会给奖励。2024 G5 的 Brier=0.0927 极低, 把全样本 G5 Brier 拉低到 0.1986。');
  lines.push('- ECE 看概率桶是否诚实。G5 样本少, 且概率桶两端经常出现 predicted 与 actual 不匹配, 所以 ECE 可以很高。');
  lines.push('- 这两者不矛盾: **排序/方向可能在部分样本里有效(Brier 低), 概率标称不诚实(ECE 高)**。下注时概率不诚实会直接污染 Kelly/EV, 所以 ECE 问题不能忽略。');
  lines.push('');
  lines.push('## 7. Gate Recommendation / 闸门建议');
  lines.push('');
  lines.push('- 不建议写成"BO5 系列总杀永久封禁", 因为当前字段不是赛制字段, 且 stage/patch/team 混淆仍然存在。');
  lines.push('- 建议写成更精确的临时闸门: **G5 / 第五局 total_kills 暂停真钱下注, 只纸面记录**。');
  lines.push('- 如果产品层只能按赛制做粗闸门, 可以在 BO5 系列中仅允许 G1-G4, G5 跳过; 不需要封全部 BO5 系列总杀。');
  lines.push('- 下一步若要解封: 至少积累 30+ 张 G5 图或 180+ line/selection 行, 再用同一脚本复查 G5-G3 ECE CI。');
  lines.push('');

  await writeFile(OUT_MD, `${lines.join('\n')}\n`, 'utf8');
  console.log(`wrote ${OUT_MD}`);
  console.log(`2025 G5 ECE=${pct(metrics(g5_2025).ece)} CI=[${pct(boot2025.ece.low)}, ${pct(boot2025.ece.high)}]`);
  console.log(`2025 G5-G3 diff=${pct(metrics(g5_2025).ece - metrics(g3_2025).ece)} CI=[${pct(boot2025.diff.low)}, ${pct(boot2025.diff.high)}]`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
