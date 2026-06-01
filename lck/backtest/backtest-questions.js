import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCsv, num } from '../shared.js';
import {
  BACKTEST_DIR,
  brier,
  decimal,
  formatPct,
  groupBy,
  hitRate,
  mean,
  parseOutcome,
  welchApproxPValue,
  wilsonInterval,
  writeBacktestCsv,
} from './common.js';

function usableRows(rows) {
  return rows
    .map((row) => ({ ...row, model_p: num(row.model_p), outcome: parseOutcome(row.outcome) }))
    .filter((row) => Number.isFinite(row.model_p) && row.outcome != null);
}

function safeDecimal(value, digits = 4) {
  return value === '' || value == null || !Number.isFinite(Number(value)) ? '' : decimal(value, digits);
}

function safeHitRate(rows) {
  return rows.length ? hitRate(rows) : '';
}

function safeBrier(rows) {
  return rows.length ? brier(rows) : '';
}

function summarizeCalibration(rows, label) {
  const successes = rows.filter((row) => row.outcome === 1).length;
  const interval = wilsonInterval(successes, rows.length);
  const model = mean(rows, (row) => row.model_p);
  const actual = hitRate(rows);
  return {
    bucket: label,
    n: rows.length,
    mean_model_p: decimal(model),
    actual_hit_rate: decimal(actual),
    bias_model_minus_actual: decimal(model - actual),
    wilson_95_low: decimal(interval.low),
    wilson_95_high: decimal(interval.high),
  };
}

function q1(rows) {
  const matchWin = rows.filter((row) => row.market === 'match_win' && row.model_p >= 0.60);
  const buckets = [
    ['all_p_ge_0.60', matchWin],
    ['0.60-0.70', matchWin.filter((row) => row.model_p >= 0.60 && row.model_p < 0.70)],
    ['0.70-0.80', matchWin.filter((row) => row.model_p >= 0.70 && row.model_p < 0.80)],
    ['0.80-1.00', matchWin.filter((row) => row.model_p >= 0.80 && row.model_p <= 1.00)],
  ];
  return buckets.map(([label, items]) => summarizeCalibration(items, label));
}

function dayDiff(a, b) {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 86400000);
}

function patchStartRows(rows) {
  const patchStarts = new Map();
  for (const row of rows) {
    const key = [row.tournament || 'unknown', row.patch || 'unknown'].join('|');
    const current = patchStarts.get(key);
    if (!current || row.match_date < current) patchStarts.set(key, row.match_date);
  }
  return rows.map((row) => {
    const key = [row.tournament || 'unknown', row.patch || 'unknown'].join('|');
    return { ...row, days_since_patch_start: dayDiff(patchStarts.get(key), row.match_date) };
  });
}

function q2(rows) {
  const stanceRows = patchStartRows(rows.filter((row) => row.model_p >= 0.55))
    .map((row) => ({
      ...row,
      patch_period: row.days_since_patch_start <= 14 ? 'patch_0_14_days' : 'stable_after_14_days',
    }));

  const out = [];
  for (const [market, items] of groupBy(stanceRows, (row) => row.market)) {
    const switching = items.filter((row) => row.patch_period === 'patch_0_14_days');
    const stable = items.filter((row) => row.patch_period === 'stable_after_14_days');
    const switchingErr = switching.map((row) => (row.model_p - row.outcome) ** 2);
    const stableErr = stable.map((row) => (row.model_p - row.outcome) ** 2);
    const pValue = welchApproxPValue(switchingErr, stableErr);
    const switchingBrier = safeBrier(switching);
    const stableBrier = safeBrier(stable);
    const hasBoth = switching.length > 0 && stable.length > 0;

    out.push({
      market,
      switch_n: switching.length,
      switch_hit_rate: safeDecimal(safeHitRate(switching)),
      switch_brier: safeDecimal(switchingBrier),
      stable_n: stable.length,
      stable_hit_rate: safeDecimal(safeHitRate(stable)),
      stable_brier: safeDecimal(stableBrier),
      hit_rate_delta_switch_minus_stable: hasBoth ? decimal(hitRate(switching) - hitRate(stable)) : '',
      brier_delta_switch_minus_stable: hasBoth ? decimal(switchingBrier - stableBrier) : '',
      welch_p_value: safeDecimal(pValue),
      flag_skip_after_patch: hasBoth && pValue !== '' && Number(pValue) < 0.1 && switchingBrier > stableBrier ? 'yes' : 'no',
    });
  }

  return out.sort((a, b) => Number(b.brier_delta_switch_minus_stable || -Infinity) - Number(a.brier_delta_switch_minus_stable || -Infinity));
}

function q2SevenDayProxy(rows) {
  const stanceRows = patchStartRows(rows.filter((row) => row.model_p >= 0.55))
    .filter((row) => row.days_since_patch_start <= 14);

  return [...groupBy(stanceRows, (row) => row.market).entries()].map(([market, items]) => {
    const early = items.filter((row) => row.days_since_patch_start <= 7);
    const later = items.filter((row) => row.days_since_patch_start > 7 && row.days_since_patch_start <= 14);
    const earlyBrier = safeBrier(early);
    const laterBrier = safeBrier(later);
    const pValue = welchApproxPValue(
      early.map((row) => (row.model_p - row.outcome) ** 2),
      later.map((row) => (row.model_p - row.outcome) ** 2),
    );

    return {
      market,
      early_0_7_n: early.length,
      early_0_7_hit_rate: safeDecimal(safeHitRate(early)),
      early_0_7_brier: safeDecimal(earlyBrier),
      later_8_14_n: later.length,
      later_8_14_hit_rate: safeDecimal(safeHitRate(later)),
      later_8_14_brier: safeDecimal(laterBrier),
      brier_delta_0_7_minus_8_14: early.length && later.length ? decimal(earlyBrier - laterBrier) : '',
      welch_p_value: safeDecimal(pValue),
    };
  }).sort((a, b) => Number(b.brier_delta_0_7_minus_8_14 || -Infinity) - Number(a.brier_delta_0_7_minus_8_14 || -Infinity));
}

function roiSummary(rows, groupFields) {
  const grouped = groupBy(rows, (row) => groupFields.map((field) => row[field]).join('|'));
  const out = [];

  for (const [key, items] of grouped) {
    const [line, selection = ''] = key.split('|');
    const marketHitRate = hitRate(items);
    if (marketHitRate <= 0) continue;

    const marketOdds = 1 / (marketHitRate * 1.025);
    const bets = items.filter((row) => row.model_p > 1 / marketOdds);
    const betHitRate = bets.length ? hitRate(bets) : '';
    const profit = bets.reduce((sum, row) => sum + (row.outcome ? marketOdds - 1 : -1), 0);

    out.push({
      line,
      selection,
      n_samples: items.length,
      market_hit_rate: decimal(marketHitRate),
      actual_rate_used_as_market: decimal(marketHitRate),
      market_odds_vig_5pct: decimal(marketOdds),
      n_bets: bets.length,
      bet_trigger_rate: decimal(bets.length / items.length),
      bet_hit_rate: safeDecimal(betHitRate),
      selection_edge: bets.length ? decimal(betHitRate - marketHitRate) : '',
      roi: bets.length ? decimal(profit / bets.length) : '',
      profit_units: decimal(profit),
    });
  }

  return out.sort((a, b) => Number(a.line) - Number(b.line) || String(a.selection).localeCompare(String(b.selection)));
}

function q3(rows) {
  const totalKills = rows.filter((row) => row.market === 'total_kills' && ['27.5', '30.5', '33.5'].includes(String(row.line)));
  const byLineSelection = roiSummary(totalKills, ['line', 'selection']);
  const byLine = [];

  for (const [line, items] of groupBy(totalKills, (row) => row.line)) {
    const enriched = items
      .map((row) => {
        const side = byLineSelection.find((candidate) => candidate.line === line && candidate.selection === row.selection);
        return { ...row, market_odds: side ? Number(side.market_odds_vig_5pct) : 0 };
      })
      .filter((row) => row.market_odds > 0);
    const bets = enriched.filter((row) => row.model_p > 1 / row.market_odds);
    const profit = bets.reduce((sum, row) => sum + (row.outcome ? row.market_odds - 1 : -1), 0);

    byLine.push({
      line,
      selection: 'all',
      n_samples: items.length,
      market_hit_rate: '',
      actual_rate_used_as_market: '',
      market_odds_vig_5pct: '',
      n_bets: bets.length,
      bet_trigger_rate: decimal(bets.length / items.length),
      bet_hit_rate: bets.length ? decimal(hitRate(bets)) : '',
      selection_edge: '',
      roi: bets.length ? decimal(profit / bets.length) : '',
      profit_units: decimal(profit),
    });
  }

  return [
    ...byLine.sort((a, b) => Number(a.line) - Number(b.line)),
    ...byLineSelection,
  ];
}

function markdownTable(rows, columns) {
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => row[column] ?? '').join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function pctCell(row, field) {
  return row?.[field] === '' || row?.[field] == null ? '' : formatPct(row[field]);
}

function buildSection(rows, label) {
  const q1Rows = q1(rows);
  const q2Rows = q2(rows);
  const strictHasStable = q2Rows.some((row) => Number(row.stable_n) > 0);
  const q2ProxyRows = strictHasStable ? [] : q2SevenDayProxy(rows);
  const q3Rows = q3(rows);

  const high = q1Rows[0] || {};
  const flagged = q2Rows.filter((row) => row.flag_skip_after_patch === 'yes');
  const proxySignificant = q2ProxyRows.filter((row) => row.welch_p_value !== '' && Number(row.welch_p_value) < 0.05);
  const proxySignificantWorse = proxySignificant.filter((row) => Number(row.brier_delta_0_7_minus_8_14) > 0);
  const q3Bad = q3Rows
    .filter((row) => row.selection === 'all' && row.roi !== '')
    .sort((a, b) => Number(a.roi) - Number(b.roi));
  const cutLine = q3Bad.find((row) => Number(row.roi) < -0.10)?.line || q3Bad[0]?.line || '样本不足';
  const over275 = q3Rows.find((row) => row.line === '27.5' && row.selection === 'over');
  const under335 = q3Rows.find((row) => row.line === '33.5' && row.selection === 'under');

  return {
    q1Rows,
    q2Rows,
    q2ProxyRows,
    q3Rows,
    lines: [
      `## [${label}] Q1: match_win p >= 0.60 校准`,
      '',
      `样本数 ${high.n || 0}。模型平均概率 ${formatPct(high.mean_model_p)}，实际命中率 ${formatPct(high.actual_hit_rate)}，偏差 p_model - p_actual = ${formatPct(high.bias_model_minus_actual)}。Wilson 95% CI: [${formatPct(high.wilson_95_low)}, ${formatPct(high.wilson_95_high)}]。`,
      '',
      markdownTable(q1Rows, ['bucket', 'n', 'mean_model_p', 'actual_hit_rate', 'bias_model_minus_actual', 'wilson_95_low', 'wilson_95_high']),
      '',
      `## [${label}] Q2: 版本切换后 14 天内 vs 稳定期`,
      '',
      '限定 `model_p >= 0.55` 的有立场样本。严格定义下，切换期为 `days_since_patch_start <= 14`，稳定期为 `> 14`。',
      '',
      markdownTable(q2Rows, ['market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate', 'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable', 'welch_p_value', 'flag_skip_after_patch']),
      '',
      strictHasStable
        ? (flagged.length ? `p < 0.1 且切换期 Brier 更高的 market: ${flagged.map((row) => row.market).join(', ')}。` : '没有 market 同时满足 p < 0.1 且切换期 Brier 更高，不建议加入版本跳过规则。')
        : '注意: LCK patch 段最长 14 天，所以严格定义的“切换后稳定期”在本段不存在。下面的 0-7 vs 8-14 代理表只能粗略提示“补丁刚切换的前一周是否更差”，每个 market 加了近似 Welch p-value；p < 0.05 才认为有版本切换效应。',
      '',
      q2ProxyRows.length ? markdownTable(q2ProxyRows, ['market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier', 'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier', 'brier_delta_0_7_minus_8_14', 'welch_p_value']) : '',
      q2ProxyRows.length
        ? (proxySignificant.length
          ? `p < 0.05 的 market 为: ${proxySignificant.map((row) => row.market).join(', ')}。其中前 7 天 Brier 更差: ${proxySignificantWorse.length ? proxySignificantWorse.map((row) => row.market).join(', ') : '无'}。`
          : 'p < 0.05 的 market 为空。本段无法在统计意义上证明版本切换敏感度，不建议加入跳过规则。')
        : '',
      '',
      `## [${label}] Q3: total_kills ROI, vig=5%`,
      '',
      '市场赔率用历史实际命中率反推（假设市场有效）；赔率 = 1 / (p_actual_market * 1.025)。它测的是模型能否相对历史均值挑出正 EV 子集，**不代表真实盘口赔率，是合成上限估计**。',
      '',
      markdownTable(q3Rows, ['line', 'selection', 'n_samples', 'market_hit_rate', 'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate', 'selection_edge', 'roi', 'profit_units']),
      '',
      over275
        ? `- 27.5 over: 触发率 ${pctCell(over275, 'bet_trigger_rate')}，下注子集命中率 ${pctCell(over275, 'bet_hit_rate')}，基准 ${pctCell(over275, 'market_hit_rate')}，selection_edge ${pctCell(over275, 'selection_edge')}。`
        : '- 27.5 over: 没有可评估样本。',
      under335
        ? `- 33.5 under: 触发率 ${pctCell(under335, 'bet_trigger_rate')}，selection_edge ${pctCell(under335, 'selection_edge')}，ROI ${pctCell(under335, 'roi')}。触发率接近 100% 时 ROI≈-vig/2，是“一直押同一边”非“模型差”。`
        : '- 33.5 under: 没有可评估样本。',
      '',
    ],
  };
}

async function main() {
  const allRows = usableRows(await readCsv(path.join(BACKTEST_DIR, 'predictions_with_outcomes.csv')));
  const inRows = allRows.filter((row) => row.split === 'in_sample_2024');
  const outRows = allRows.filter((row) => row.split === 'out_of_sample_2025');

  // CSV 产物保持 all 口径, 供 recommend.js 消费 (不破坏下游)
  const all = buildSection(allRows, 'all');
  await writeBacktestCsv('version_sensitivity.csv', all.q2Rows, [
    'market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate',
    'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable',
    'welch_p_value', 'flag_skip_after_patch',
  ]);
  if (all.q2ProxyRows.length) {
    await writeBacktestCsv('version_sensitivity_proxy_7d.csv', all.q2ProxyRows, [
      'market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier',
      'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier',
      'brier_delta_0_7_minus_8_14', 'welch_p_value',
    ]);
  }
  await writeBacktestCsv('total_kills_roi.csv', all.q3Rows, [
    'line', 'selection', 'n_samples', 'market_hit_rate', 'actual_rate_used_as_market',
    'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate',
    'selection_edge', 'roi', 'profit_units',
  ]);

  // 分段产物: 2025 out-of-sample 是纯验证段
  const sectionIn = inRows.length ? buildSection(inRows, 'in_sample_2024') : null;
  const sectionOut = outRows.length ? buildSection(outRows, 'out_of_sample_2025') : null;
  const versionCols = [
    'market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate',
    'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable',
    'welch_p_value', 'flag_skip_after_patch',
  ];
  const proxyCols = [
    'market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier',
    'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier',
    'brier_delta_0_7_minus_8_14', 'welch_p_value',
  ];
  const roiCols = [
    'line', 'selection', 'n_samples', 'market_hit_rate', 'actual_rate_used_as_market',
    'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate', 'selection_edge', 'roi', 'profit_units',
  ];
  if (sectionIn) {
    await writeBacktestCsv('total_kills_roi_in_sample.csv', sectionIn.q3Rows, roiCols);
    await writeBacktestCsv('version_sensitivity_in_sample.csv', sectionIn.q2Rows, versionCols);
    if (sectionIn.q2ProxyRows.length) {
      await writeBacktestCsv('version_sensitivity_proxy_7d_in_sample.csv', sectionIn.q2ProxyRows, proxyCols);
    }
  }
  if (sectionOut) {
    await writeBacktestCsv('total_kills_roi_out_of_sample.csv', sectionOut.q3Rows, roiCols);
    await writeBacktestCsv('version_sensitivity_out_of_sample.csv', sectionOut.q2Rows, versionCols);
    if (sectionOut.q2ProxyRows.length) {
      await writeBacktestCsv('version_sensitivity_proxy_7d_out_of_sample.csv', sectionOut.q2ProxyRows, proxyCols);
    }
  }

  // 5.7 段间对比: match_win Brier skill 衰减 + 过拟合 flag
  const skillFor = (rows, market) => {
    const sub = rows.filter((r) => r.market === market);
    if (!sub.length) return null;
    const b = brier(sub);
    const pbar = hitRate(sub);
    const baseline = pbar * (1 - pbar) || 0.25;
    return 1 - b / 0.25;
  };
  const inSkill = skillFor(inRows, 'match_win');
  const outSkill = skillFor(outRows, 'match_win');
  const decayPct = (inSkill && outSkill && inSkill !== 0)
    ? ((inSkill - outSkill) / Math.abs(inSkill)) * 100 : null;
  const overfitFlag = decayPct != null && decayPct > 30;
  const comparisonLines = [
    '# 段间对比 (in_sample vs out_of_sample, 衰减检查)',
    '',
    '| 指标 | in_sample_2024 | out_of_sample_2025 | 衰减 decay_pct |',
    '|---|---:|---:|---:|',
    `| match_win Brier skill | ${inSkill == null ? '—' : inSkill.toFixed(4)} | ${outSkill == null ? '—' : outSkill.toFixed(4)} | ${decayPct == null ? '—' : decayPct.toFixed(1) + '%'} |`,
    '',
    overfitFlag
      ? '⚠️ 段间衰减 > 30%, 存在过拟合风险, Phase 2 参数建议需要重新考虑。'
      : '段间衰减 < 30%, 未触发过拟合 flag。注意: LCK match_win 概率本就不是用 2024 赔率拟合的, in/out 接近属正常, 不要据此推断"模型很稳"。',
    '',
    '---',
    '',
  ];

  const md = [
    '# 三个问题答案 (分段: 2024 in-sample / 2025 out-of-sample)',
    '',
    '- 段 A: in_sample_2024 (注意 LCK match_win/props 概率并非用 2024 赔率拟合, 此处 in-sample 仅指与 baseline 同期)',
    '- 段 B: out_of_sample_2025 (纯验证)',
    '- Q3 ROI 为合成赔率上限估计, 真实可交易 ROI 需用真实盘口赔率(见 oddsportal_model_comparison.md 或 odds-history)验证。',
    '',
    '---',
    '',
    ...comparisonLines,
    ...(sectionOut ? ['# 段 B: out_of_sample_2025 (优先看这段)', '', ...sectionOut.lines, '---', ''] : []),
    ...(sectionIn ? ['# 段 A: in_sample_2024', '', ...sectionIn.lines, '---', ''] : []),
    '# 全量 (all, 仅供参考)',
    '',
    ...all.lines,
  ].join('\n');

  await writeFile(path.join(BACKTEST_DIR, '三个问题答案.md'), md, 'utf8');
  console.log('wrote 三个问题答案.md (split: in_sample_2024 / out_of_sample_2025 / all)');
}

main().catch((error) => {
  console.error(`backtest-questions failed: ${error.message}`);
  process.exitCode = 1;
});
