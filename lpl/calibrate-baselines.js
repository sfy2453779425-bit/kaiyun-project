import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  num,
  parseCsv,
} from './shared.js';

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const LCK_HISTORY = path.join('lck', 'data', 'history');
const REPORT_PATH = path.join(DATA_DIR, 'baseline_comparison.md');
const TARGET_YEAR = '2024';

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return NaN;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function fmtNum(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

async function readCsvIfExists(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return parseCsv(text);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadLplHistoryYear(year) {
  const entries = await readdir(HISTORY_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const maps = [];
  const matches = [];
  const summaries = [];
  const sources = [];

  for (const slug of dirs) {
    const folder = path.join(HISTORY_DIR, slug);
    const m = await readCsvIfExists(path.join(folder, 'lpl_map_details.csv'));
    const mc = await readCsvIfExists(path.join(folder, 'lpl_matches.csv'));
    const sm = await readCsvIfExists(path.join(folder, 'lpl_team_detail_summary.csv'));
    if (!m.length && !mc.length) continue;
    const yrMatches = mc.filter((row) => String(row.match_date || '').startsWith(year));
    if (!yrMatches.length) continue;
    const yrMatchIds = new Set(yrMatches.map((row) => row.match_id));
    const yrMaps = m.filter((row) => yrMatchIds.has(row.match_id));
    if (!yrMaps.length) continue;
    matches.push(...yrMatches);
    maps.push(...yrMaps);
    summaries.push(...sm);
    sources.push(yrMatches[0]?.tournament || slug);
  }
  return { maps, matches, summaries, sources: [...new Set(sources)] };
}

async function loadLckHistoryYear(year) {
  const maps = await readCsvIfExists(path.join(LCK_HISTORY, 'all_map_details.csv'));
  const matches = await readCsvIfExists(path.join(LCK_HISTORY, 'all_matches.csv'));
  const summaries = await readCsvIfExists(path.join(LCK_HISTORY, 'all_team_summary.csv'));
  const yrMatches = matches.filter((row) => String(row.match_date || '').startsWith(year));
  const yrMatchIds = new Set(yrMatches.map((row) => row.match_id));
  const yrMaps = maps.filter((row) => yrMatchIds.has(row.match_id) || String(row.match_time || '').startsWith(year));
  const sources = [...new Set(yrMatches.map((row) => row.tournament).filter(Boolean))];
  return { maps: yrMaps, matches: yrMatches, summaries, sources };
}

function missingRate(rows, field) {
  if (!rows.length) return NaN;
  const blank = rows.filter((row) => {
    const v = row[field];
    return v == null || v === '' || v === '0' || v === 0;
  }).length;
  return blank / rows.length;
}

function blankRateStrict(rows, field) {
  if (!rows.length) return NaN;
  const blank = rows.filter((row) => row[field] == null || row[field] === '').length;
  return blank / rows.length;
}

function distributionStats(maps, field, asPercent = false) {
  const values = maps
    .map((row) => num(row[field]))
    .filter((v) => Number.isFinite(v) && v > 0);
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    stdev: stdev(values),
    p10: percentile(values, 0.1),
    p90: percentile(values, 0.9),
    asPercent,
  };
}

function teamSummaryStats(summaries) {
  const winRates = summaries
    .map((row) => num(row.match_win_rate))
    .filter((v) => Number.isFinite(v) && v > 0 && v < 1);
  return {
    n: winRates.length,
    p10: percentile(winRates, 0.1),
    p50: percentile(winRates, 0.5),
    p90: percentile(winRates, 0.9),
  };
}

function strengthProxyStats(maps, matches) {
  const teams = new Set();
  for (const m of matches) { teams.add(m.team_a_id); teams.add(m.team_b_id); }
  const stats = [];
  for (const tid of teams) {
    if (!tid) continue;
    const tMatches = matches.filter((m) => m.winner_id && (m.team_a_id === tid || m.team_b_id === tid));
    if (tMatches.length < 5) continue;
    const wins = tMatches.filter((m) => m.winner_id === tid).length;
    const tMaps = maps.filter((m) => m.team_a_id === tid || m.team_b_id === tid);
    const mapWins = tMaps.filter((m) => m.map_winner_id === tid).length;
    const matchWinRate = wins / tMatches.length;
    const mapWinRate = tMaps.length ? mapWins / tMaps.length : 0;
    const proxy = 50 + (matchWinRate - 0.5) * 28 + (mapWinRate - 0.5) * 38;
    stats.push(proxy);
  }
  return {
    n: stats.length,
    p10: percentile(stats, 0.1),
    p50: percentile(stats, 0.5),
    p90: percentile(stats, 0.9),
  };
}

function totalKillsBucketRates(maps, lines) {
  return Object.fromEntries(lines.map((line) => {
    const values = maps.map((row) => num(row.total_kills)).filter((v) => Number.isFinite(v) && v > 0);
    const above = values.filter((v) => v > line).length;
    return [line, values.length ? above / values.length : NaN];
  }));
}

function gameTimeBucketRates(maps, lines) {
  return Object.fromEntries(lines.map((line) => {
    const values = maps.map((row) => num(row.game_time_min)).filter((v) => Number.isFinite(v) && v > 0);
    const above = values.filter((v) => v > line).length;
    return [line, values.length ? above / values.length : NaN];
  }));
}

function paramSuggestion(lplVal, lckVal, lckCurrentParam, label, unit = '') {
  if (!Number.isFinite(lplVal) || !Number.isFinite(lckVal)) {
    return `  ${label}: 数据缺失,保持 LCK 原值 ${lckCurrentParam}${unit}`;
  }
  const ratio = (lplVal - lckVal) / Math.max(Math.abs(lckVal), 0.01);
  if (Math.abs(ratio) < 0.10) {
    return `  ${label}: LPL ${fmtNum(lplVal)} vs LCK ${fmtNum(lckVal)} 差距 ${(ratio * 100).toFixed(1)}% (<10%),建议保持原值 ${lckCurrentParam}${unit}`;
  }
  const delta = lplVal - lckVal;
  const suggested = Number((lckCurrentParam + delta).toFixed(2));
  return `  ${label}: LPL ${fmtNum(lplVal)} vs LCK ${fmtNum(lckVal)} 差距 ${(ratio * 100).toFixed(1)}%,建议 LCK ${lckCurrentParam}${unit} → LPL ${suggested}${unit}`;
}

async function main() {
  console.log(`Phase 2 baseline: 读取 LPL ${TARGET_YEAR} 与 LCK ${TARGET_YEAR}...`);
  const lpl = await loadLplHistoryYear(TARGET_YEAR);
  const lck = await loadLckHistoryYear(TARGET_YEAR);

  console.log(`  LPL: matches=${lpl.matches.length}, maps=${lpl.maps.length}, summaries=${lpl.summaries.length}`);
  console.log(`  LCK: matches=${lck.matches.length}, maps=${lck.maps.length}, summaries=${lck.summaries.length}`);
  if (!lpl.maps.length) {
    console.error('错误: 没有找到 LPL 2024 数据,Phase 4.1 数据采集是否完成?');
    process.exit(1);
  }

  const lckAvailable = lck.maps.length > 0;

  const lplTotalKills = distributionStats(lpl.maps, 'total_kills');
  const lplGameTime = distributionStats(lpl.maps, 'game_time_min');
  const lckTotalKills = distributionStats(lck.maps, 'total_kills');
  const lckGameTime = distributionStats(lck.maps, 'game_time_min');

  const lplStrength = strengthProxyStats(lpl.maps, lpl.matches);
  const lckStrength = strengthProxyStats(lck.maps, lck.matches);

  const lplKillBuckets = totalKillsBucketRates(lpl.maps, [27.5, 30.5, 33.5]);
  const lckKillBuckets = totalKillsBucketRates(lck.maps, [27.5, 30.5, 33.5]);
  const lplTimeBuckets = gameTimeBucketRates(lpl.maps, [31.5, 32.5, 33.5]);
  const lckTimeBuckets = gameTimeBucketRates(lck.maps, [31.5, 32.5, 33.5]);

  const missingFields = ['first_blood_team_id', 'first_turret_team_id', 'first_dragon_team_id', 'first_herald_team_id'];
  const lplMissing = Object.fromEntries(missingFields.map((f) => [f, blankRateStrict(lpl.maps, f)]));
  const lckMissing = Object.fromEntries(missingFields.map((f) => [f, blankRateStrict(lck.maps, f)]));

  const lines = [];
  lines.push('# LPL 2024 vs LCK 2024 baseline 对比');
  lines.push('');
  lines.push(`- 报告生成时间: ${new Date().toISOString()}`);
  lines.push(`- 采集来源: gol.gg (Games of Legends)`);
  lines.push(`- 数据范围: 仅 ${TARGET_YEAR}, 严格做 in-sample 调参隔离 (Phase 4 回测的 2025 段作为 out-of-sample)`);
  lines.push('');
  lines.push('## 用到的 tournament 名称');
  lines.push('');
  lines.push('LPL:');
  for (const s of lpl.sources) lines.push(`  - ${s}`);
  lines.push('');
  lines.push('LCK:');
  if (lck.sources.length) for (const s of lck.sources) lines.push(`  - ${s}`);
  else lines.push('  - (无数据)');
  lines.push('');
  lines.push('## 样本数');
  lines.push('');
  lines.push(`| | matches | maps | team summaries |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| LPL ${TARGET_YEAR} | ${lpl.matches.length} | ${lpl.maps.length} | ${lpl.summaries.length} |`);
  lines.push(`| LCK ${TARGET_YEAR} | ${lck.matches.length} | ${lck.maps.length} | ${lck.summaries.length} |`);
  lines.push('');
  if (!lckAvailable) {
    lines.push('> ⚠️ 警告:LCK 同期 2024 数据不可得,以下对比仅列 LPL 数值,无 LCK 对照。参数建议改回写为「无 LCK 对照,保守不调」。');
    lines.push('');
  }
  lines.push('## 字段缺失率(空字符串 / null 才算缺失)');
  lines.push('');
  lines.push(`| 字段 | LPL | LCK |`);
  lines.push(`|---|---:|---:|`);
  for (const f of missingFields) {
    lines.push(`| ${f} | ${fmtPct(lplMissing[f])} | ${lckAvailable ? fmtPct(lckMissing[f]) : '—'} |`);
  }
  lines.push('');
  lines.push('## 关键单局指标分布');
  lines.push('');
  lines.push(`| 指标 | LPL mean | LPL median | LPL stdev | LCK mean | LCK median | LCK stdev |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  lines.push(`| avg_total_kills (单局) | ${fmtNum(lplTotalKills.mean)} | ${fmtNum(lplTotalKills.median)} | ${fmtNum(lplTotalKills.stdev)} | ${fmtNum(lckTotalKills.mean)} | ${fmtNum(lckTotalKills.median)} | ${fmtNum(lckTotalKills.stdev)} |`);
  lines.push(`| avg_game_time_min (单局) | ${fmtNum(lplGameTime.mean)} | ${fmtNum(lplGameTime.median)} | ${fmtNum(lplGameTime.stdev)} | ${fmtNum(lckGameTime.mean)} | ${fmtNum(lckGameTime.median)} | ${fmtNum(lckGameTime.stdev)} |`);
  lines.push('');
  lines.push('## total_kills 各 line 上盘率');
  lines.push('');
  lines.push(`| line | LPL over% | LCK over% |`);
  lines.push(`|---|---:|---:|`);
  for (const line of [27.5, 30.5, 33.5]) {
    lines.push(`| ${line} | ${fmtPct(lplKillBuckets[line])} | ${lckAvailable ? fmtPct(lckKillBuckets[line]) : '—'} |`);
  }
  lines.push('');
  lines.push('## game_time 各 line 上盘率');
  lines.push('');
  lines.push(`| line | LPL over% | LCK over% |`);
  lines.push(`|---|---:|---:|`);
  for (const line of [31.5, 32.5, 33.5]) {
    lines.push(`| ${line} | ${fmtPct(lplTimeBuckets[line])} | ${lckAvailable ? fmtPct(lckTimeBuckets[line]) : '—'} |`);
  }
  lines.push('');
  lines.push('## 强度分代理分布 (用 match_win_rate / map_win_rate 推算)');
  lines.push('');
  lines.push(`| pct | LPL strength proxy | LCK strength proxy |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| p10 | ${fmtNum(lplStrength.p10)} | ${fmtNum(lckStrength.p10)} |`);
  lines.push(`| p50 | ${fmtNum(lplStrength.p50)} | ${fmtNum(lckStrength.p50)} |`);
  lines.push(`| p90 | ${fmtNum(lplStrength.p90)} | ${fmtNum(lckStrength.p90)} |`);
  lines.push(`| n teams | ${lplStrength.n} | ${lckStrength.n} |`);
  lines.push('');
  lines.push('## 建议 LPL 参数(待确认)');
  lines.push('');
  lines.push('注:`<10%` 表示 LPL/LCK 相对差距小于 10%,建议保持 LCK 原值。否则给出粗调建议(等于 LCK 原值 + 实测均值差)。');
  lines.push('');
  lines.push('### classifyScenario 阈值');
  lines.push('```');
  lines.push(paramSuggestion(lplTotalKills.mean, lckTotalKills.mean, 30, 'avgTotalKills 进入「混乱高击杀局」的阈值'));
  lines.push(paramSuggestion(lplGameTime.mean, lckGameTime.mean, 30.5, 'avgTime 进入「混乱高击杀局」的下限', ' 分'));
  lines.push(paramSuggestion(lplTotalKills.mean, lckTotalKills.mean, 28, 'avgTotalKills 进入「低击杀运营局」的上限'));
  lines.push('```');
  lines.push('');
  lines.push('### totalKillsProbability 的 mean 修正');
  lines.push('```');
  lines.push(paramSuggestion(lplTotalKills.mean, lckTotalKills.mean, 0, 'LPL 整体均值偏移 (LCK baseline = 0)'));
  lines.push('  → 这只是分布漂移的提示,实际剧本修正系数 (+2.2 / -2 等) 不建议变,除非 Phase 4 回测发现 Brier 系统偏。');
  lines.push('```');
  lines.push('');
  lines.push('### total_kills 默认 line');
  lines.push('```');
  const lplOver275 = lplKillBuckets[27.5];
  const lckOver275 = lckKillBuckets[27.5];
  const lplOver305 = lplKillBuckets[30.5];
  const lckOver305 = lckKillBuckets[30.5];
  const lplOver335 = lplKillBuckets[33.5];
  const lckOver335 = lckKillBuckets[33.5];
  if (lckAvailable) {
    lines.push(`  27.5 over%: LPL ${fmtPct(lplOver275)} vs LCK ${fmtPct(lckOver275)}`);
    lines.push(`  30.5 over%: LPL ${fmtPct(lplOver305)} vs LCK ${fmtPct(lckOver305)}`);
    lines.push(`  33.5 over%: LPL ${fmtPct(lplOver335)} vs LCK ${fmtPct(lckOver335)}`);
    lines.push('  → 如 LPL 在 27.5 over% > 70%,说明 27.5 是垃圾盘(几乎必上),建议放弃这条 line,改用 28.5 / 29.5。');
    lines.push('  → 如 LPL 在 33.5 over% > 50%,可能需要新增 35.5 line。');
    lines.push('  → 否则保持 LCK 的 27.5/30.5/33.5。');
  } else {
    lines.push(`  LPL 27.5 / 30.5 / 33.5 over%: ${fmtPct(lplOver275)} / ${fmtPct(lplOver305)} / ${fmtPct(lplOver335)}`);
    lines.push('  无 LCK 对照,建议第一版保持 LCK 默认 line (27.5/30.5/33.5),Phase 4 回测后再视 ROI 调整。');
  }
  lines.push('```');
  lines.push('');
  lines.push('### game_time 默认 line');
  lines.push('```');
  if (lckAvailable) {
    lines.push(`  31.5 over%: LPL ${fmtPct(lplTimeBuckets[31.5])} vs LCK ${fmtPct(lckTimeBuckets[31.5])}`);
    lines.push(`  32.5 over%: LPL ${fmtPct(lplTimeBuckets[32.5])} vs LCK ${fmtPct(lckTimeBuckets[32.5])}`);
    lines.push(`  33.5 over%: LPL ${fmtPct(lplTimeBuckets[33.5])} vs LCK ${fmtPct(lckTimeBuckets[33.5])}`);
    if (lplGameTime.mean < lckGameTime.mean - 1) {
      lines.push('  → LPL 平均时长明显短于 LCK(>1 分钟),建议把默认 game_time line 整体下移 1 分,即 30.5/31.5/32.5。');
    } else if (lplGameTime.mean > lckGameTime.mean + 1) {
      lines.push('  → LPL 平均时长明显长于 LCK,建议把默认 game_time line 整体上移 1 分,即 32.5/33.5/34.5。');
    } else {
      lines.push('  → 平均时长差距 < 1 分钟,建议保持 LCK 默认 31.5/32.5/33.5。');
    }
  } else {
    lines.push(`  LPL 31.5 / 32.5 / 33.5 over%: ${fmtPct(lplTimeBuckets[31.5])} / ${fmtPct(lplTimeBuckets[32.5])} / ${fmtPct(lplTimeBuckets[33.5])}`);
    lines.push('  无 LCK 对照,Phase 4 回测后再视分布调整。');
  }
  lines.push('```');
  lines.push('');
  lines.push('## 教训 1 提醒');
  lines.push('');
  lines.push('以下 LCK 魔法数在本报告中**不**自动改动,只有在你看完上面的对比后明确同意,才在 Phase 3 落地。其他保留原值,避免「LPL 参数恰好让 in-sample 看起来好」的 in-sample 优化偏差(教训 9)。');
  lines.push('');
  lines.push('- `strength_score` 权重 28/38/14/12/8/7/5: 涉及多维度耦合,**强烈建议保留**。');
  lines.push('- logistic 分母: match_win=13, total_kills=3.8, game_time=2.5, team_kills_handicap=4.8: 与方差挂钩,先看 Phase 4 Brier 表再决定是否调。**建议先保留**。');
  lines.push('- 剧本修正系数(‘混乱高击杀’ +2.2, ‘低击杀运营’ -2 等): 数值耦合 LCK 经验,**建议保留**,等 Phase 4 出 Brier 再说。');
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  lines.push('1. 请确认上面 classifyScenario 阈值 / total_kills line / game_time line 哪几个采纳。');
  lines.push('2. 没采纳的项目自动保持 LCK 原值。');
  lines.push('3. 我会在 Phase 3 build-market-analysis.js 里**只改**你点名采纳的参数。');
  lines.push('');

  await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`报告: ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(`calibrate-baselines 失败: ${error.message}`);
  process.exitCode = 1;
});
