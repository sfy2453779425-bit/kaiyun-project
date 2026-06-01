import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCsv, num } from '../shared.js';
import {
  BACKTEST_DIR,
  SPLIT_IN_SAMPLE,
  SPLIT_OUT_SAMPLE,
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
      flag_skip_after_patch: hasBoth && pValue !== '' && Number(pValue) < 0.05 && switchingBrier > stableBrier ? 'yes' : 'no',
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

function brierSkill(rows, market) {
  const items = rows.filter((row) => row.market === market);
  if (!items.length) return '';
  const actual = hitRate(items);
  const score = brier(items);
  const baseline = actual * (1 - actual);
  return baseline ? decimal(1 - score / baseline) : '';
}

function buildSegmentSection(rows, split, label) {
  const inSampleRows = rows.filter((row) => row.split === split);
  if (!inSampleRows.length) {
    return {
      label,
      empty: true,
      lines: [`(段 ${label} 无样本,跳过)`],
      q1Rows: [],
      q2Rows: [],
      q2ProxyRows: [],
      q3Rows: [],
      rows: [],
    };
  }
  const q1Rows = q1(inSampleRows);
  const q2Rows = q2(inSampleRows);
  const strictHasStable = q2Rows.some((row) => Number(row.stable_n) > 0);
  const q2ProxyRows = strictHasStable ? [] : q2SevenDayProxy(inSampleRows);
  const q3Rows = q3(inSampleRows);

  const high = q1Rows[0] || {};
  const flagged = q2Rows.filter((row) => row.flag_skip_after_patch === 'yes');
  const proxySignificant = q2ProxyRows.filter((row) => row.welch_p_value !== '' && Number(row.welch_p_value) < 0.05);
  const proxySignificantWorse = proxySignificant.filter((row) => Number(row.brier_delta_0_7_minus_8_14) > 0);
  const over275 = q3Rows.find((row) => row.line === '27.5' && row.selection === 'over');
  const under335 = q3Rows.find((row) => row.line === '33.5' && row.selection === 'under');

  const lines = [
    `### Q1 (${label}): match_win p >= 0.60 校准`,
    '',
    `样本数 ${high.n || 0}。模型平均概率 ${formatPct(high.mean_model_p)}，实际命中率 ${formatPct(high.actual_hit_rate)}，偏差 p_model - p_actual = ${formatPct(high.bias_model_minus_actual)}。Wilson 95% CI: [${formatPct(high.wilson_95_low)}, ${formatPct(high.wilson_95_high)}]。`,
    '',
    markdownTable(q1Rows, ['bucket', 'n', 'mean_model_p', 'actual_hit_rate', 'bias_model_minus_actual', 'wilson_95_low', 'wilson_95_high']),
    '',
    `### Q2 (${label}): 版本切换后 14 天内 vs 稳定期`,
    '',
    '限定 `model_p >= 0.55` 的有立场样本。严格定义下,切换期 = `days_since_patch_start <= 14`,稳定期 = `> 14`。',
    '',
    markdownTable(q2Rows, ['market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate', 'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable', 'welch_p_value', 'flag_skip_after_patch']),
    '',
    strictHasStable
      ? (flagged.length ? `p < 0.05 且切换期 Brier 更高的 market: ${flagged.map((row) => row.market).join(', ')}。` : '没有 market 同时满足 p < 0.05 且切换期 Brier 更高,不建议加入版本跳过规则。')
      : '注意: 严格定义的"切换后稳定期"在本段数据中不存在(LPL patch 周期 ≤14 天)。下面的 0-7 vs 8-14 代理表是 fallback,每个 market 加了近似 Welch p-value;p < 0.05 才认为有版本切换效应。',
    '',
  ];

  if (q2ProxyRows.length) {
    lines.push(markdownTable(q2ProxyRows, ['market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier', 'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier', 'brier_delta_0_7_minus_8_14', 'welch_p_value']));
    lines.push('');
    lines.push(proxySignificant.length
      ? `p < 0.05 的 market: ${proxySignificant.map((row) => row.market).join(', ')}。其中前 7 天 Brier 更差的 market: ${proxySignificantWorse.length ? proxySignificantWorse.map((row) => row.market).join(', ') : '无'}。`
      : 'p < 0.05 的 market 为空,本段无法统计意义上证明版本切换敏感度。');
    lines.push('');
  }

  lines.push(`### Q3 (${label}): total_kills ROI, vig=5%`);
  lines.push('');
  lines.push('> ⚠️ 警告: 本节 ROI 数字是基于「庄家正好按历史均值定价 + vig=5%」的合成赔率算出来的,');
  lines.push('> 是上限估计,**不代表真实可交易 ROI**。真实 ROI 必须用真实庄家赔率纸面跑验证。');
  lines.push('');
  lines.push('优先看 `selection_edge`,再看 ROI:');
  lines.push('- 触发率 < 20% 且 selection_edge > 0 ⇒ 模型有真实选边能力');
  lines.push('- 触发率 > 95% ⇒ ROI 数学上等于 -vig/2,不是「模型差」,是「模型一直押同一边」');
  lines.push('');
  lines.push(markdownTable(q3Rows, ['line', 'selection', 'n_samples', 'market_hit_rate', 'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate', 'selection_edge', 'roi', 'profit_units']));
  lines.push('');
  if (over275) lines.push(`- 27.5 over: 触发率 ${pctCell(over275, 'bet_trigger_rate')}, 下注子集命中率 ${pctCell(over275, 'bet_hit_rate')}, 基准命中率 ${pctCell(over275, 'market_hit_rate')}, selection_edge ${pctCell(over275, 'selection_edge')}.`);
  if (under335) lines.push(`- 33.5 under: 触发率 ${pctCell(under335, 'bet_trigger_rate')}, selection_edge ${pctCell(under335, 'selection_edge')}, ROI ${pctCell(under335, 'roi')}.`);

  return { label, empty: false, lines, q1Rows, q2Rows, q2ProxyRows, q3Rows, rows: inSampleRows };
}

async function main() {
  const all = usableRows(await readCsv(path.join(BACKTEST_DIR, 'predictions_with_outcomes.csv')));
  const inSample = buildSegmentSection(all, SPLIT_IN_SAMPLE, 'in_sample_2024');
  const outSample = buildSegmentSection(all, SPLIT_OUT_SAMPLE, 'out_of_sample_2025');

  // CSV 输出按段拆分
  if (!inSample.empty) {
    await writeBacktestCsv('version_sensitivity_in_sample.csv', inSample.q2Rows, [
      'market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate',
      'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable',
      'welch_p_value', 'flag_skip_after_patch',
    ]);
    if (inSample.q2ProxyRows.length) {
      await writeBacktestCsv('version_sensitivity_proxy_7d_in_sample.csv', inSample.q2ProxyRows, [
        'market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier',
        'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier',
        'brier_delta_0_7_minus_8_14', 'welch_p_value',
      ]);
    }
    await writeBacktestCsv('total_kills_roi_in_sample.csv', inSample.q3Rows, [
      'line', 'selection', 'n_samples', 'market_hit_rate', 'actual_rate_used_as_market',
      'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate',
      'selection_edge', 'roi', 'profit_units',
    ]);
  }
  if (!outSample.empty) {
    await writeBacktestCsv('version_sensitivity_out_of_sample.csv', outSample.q2Rows, [
      'market', 'switch_n', 'switch_hit_rate', 'switch_brier', 'stable_n', 'stable_hit_rate',
      'stable_brier', 'hit_rate_delta_switch_minus_stable', 'brier_delta_switch_minus_stable',
      'welch_p_value', 'flag_skip_after_patch',
    ]);
    if (outSample.q2ProxyRows.length) {
      await writeBacktestCsv('version_sensitivity_proxy_7d_out_of_sample.csv', outSample.q2ProxyRows, [
        'market', 'early_0_7_n', 'early_0_7_hit_rate', 'early_0_7_brier',
        'later_8_14_n', 'later_8_14_hit_rate', 'later_8_14_brier',
        'brier_delta_0_7_minus_8_14', 'welch_p_value',
      ]);
    }
    await writeBacktestCsv('total_kills_roi_out_of_sample.csv', outSample.q3Rows, [
      'line', 'selection', 'n_samples', 'market_hit_rate', 'actual_rate_used_as_market',
      'market_odds_vig_5pct', 'n_bets', 'bet_trigger_rate', 'bet_hit_rate',
      'selection_edge', 'roi', 'profit_units',
    ]);
  }

  // 跨段对比表
  const compareRows = [];
  const q1In = inSample.q1Rows.find((row) => row.bucket === 'all_p_ge_0.60');
  const q1Out = outSample.q1Rows.find((row) => row.bucket === 'all_p_ge_0.60');
  compareRows.push({
    metric: 'Q1 match_win p>=0.60 偏差',
    in_sample: q1In ? formatPct(q1In.bias_model_minus_actual) : '—',
    out_of_sample: q1Out ? formatPct(q1Out.bias_model_minus_actual) : '—',
  });

  const inBrier = brierSkill(inSample.rows, 'match_win');
  const outBrier = brierSkill(outSample.rows, 'match_win');
  compareRows.push({
    metric: 'match_win Brier skill',
    in_sample: inBrier || '—',
    out_of_sample: outBrier || '—',
  });

  const in275 = inSample.q3Rows.find((r) => r.line === '27.5' && r.selection === 'over');
  const out275 = outSample.q3Rows.find((r) => r.line === '27.5' && r.selection === 'over');
  compareRows.push({
    metric: 'total_kills 27.5 over selection_edge',
    in_sample: in275 && in275.selection_edge !== '' ? formatPct(in275.selection_edge) : '—',
    out_of_sample: out275 && out275.selection_edge !== '' ? formatPct(out275.selection_edge) : '—',
  });

  function pctDecay(inVal, outVal) {
    const a = Number(inVal);
    const b = Number(outVal);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !a) return '';
    return ((b - a) / Math.abs(a) * 100).toFixed(1) + '%';
  }
  for (const r of compareRows) {
    const a = r.in_sample === '—' ? null : Number(String(r.in_sample).replace('%', ''));
    const b = r.out_of_sample === '—' ? null : Number(String(r.out_of_sample).replace('%', ''));
    if (Number.isFinite(a) && Number.isFinite(b) && a) {
      r.decay_pct = `${((b - a) / Math.abs(a) * 100).toFixed(1)}%`;
    } else {
      r.decay_pct = '—';
    }
  }

  // 综合判断: 衰减是否 > 30%
  let overfitFlag = '';
  if (!inSample.empty && !outSample.empty) {
    const inBrierNum = Number(inBrier);
    const outBrierNum = Number(outBrier);
    if (Number.isFinite(inBrierNum) && Number.isFinite(outBrierNum) && inBrierNum > 0) {
      const decay = (outBrierNum - inBrierNum) / inBrierNum;
      if (decay < -0.30) {
        overfitFlag = `⚠️ match_win Brier skill 衰减 ${(decay * 100).toFixed(1)}% (out-of-sample 比 in-sample 差 30%+),可能过拟合,Phase 2 参数建议需要重新考虑。`;
      } else {
        overfitFlag = `match_win Brier skill 衰减 ${(decay * 100).toFixed(1)}% (< 30%),无明显过拟合迹象。`;
      }
    }
  }

  const md = [
    '# 三个问题答案 (分段: 2024 in-sample / 2025 out-of-sample)',
    '',
    `- 段 A: in_sample_2024 (跟 Phase 2 baseline 同源,有 in-sample 调参偏置风险)`,
    `- 段 B: out_of_sample_2025 (纯验证)`,
    '',
    '## 段 A: in_sample_2024',
    '',
    ...inSample.lines,
    '',
    '## 段 B: out_of_sample_2025',
    '',
    ...outSample.lines,
    '',
    '## 段间对比 (in_sample vs out_of_sample)',
    '',
    markdownTable(compareRows, ['metric', 'in_sample', 'out_of_sample', 'decay_pct']),
    '',
    overfitFlag,
    '',
  ].join('\n');

  await writeFile(path.join(BACKTEST_DIR, '三个问题答案.md'), md, 'utf8');
  console.log('wrote 三个问题答案.md');
}

main().catch((error) => {
  console.error(`backtest-questions failed: ${error.message}`);
  process.exitCode = 1;
});
