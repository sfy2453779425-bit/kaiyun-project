import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCsv, readCsvIfExists, num, clamp } from '../shared.js';
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
} from './common.js';

function usableRows(rows) {
  return rows
    .map((row) => ({ ...row, model_p: num(row.model_p), outcome: parseOutcome(row.outcome), sample: num(row.sample) }))
    .filter((row) => Number.isFinite(row.model_p) && row.outcome != null);
}

function adjustedProbability(raw, k) {
  return clamp(0.5 + (raw - 0.5) * k, 0.01, 0.99);
}

function shrinkageBrier(rows, k) {
  return mean(rows, (row) => (adjustedProbability(row.model_p, k) - row.outcome) ** 2);
}

function fitShrinkageK(rows) {
  let best = { k: 1, score: Infinity };
  for (let i = 0; i <= 120; i += 1) {
    const k = i / 100;
    const score = shrinkageBrier(rows, k);
    if (score < best.score) best = { k, score };
  }
  return best;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return '';
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * p)));
  return sortedValues[index];
}

function bootstrapShrinkage(rows, iterations = 1000) {
  if (!rows.length) return { k_p5: '', k_median: '', k_p95: '', ci_contains_1: false };
  const rand = seededRandom(20260521);
  const fitted = [];

  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < rows.length; j += 1) {
      sample.push(rows[Math.floor(rand() * rows.length)]);
    }
    fitted.push(fitShrinkageK(sample).k);
  }

  fitted.sort((a, b) => a - b);
  const kP5 = percentile(fitted, 0.05);
  const kMedian = percentile(fitted, 0.50);
  const kP95 = percentile(fitted, 0.95);
  return {
    k_p5: kP5,
    k_median: kMedian,
    k_p95: kP95,
    ci_contains_1: kP5 <= 1 && kP95 >= 1,
  };
}

function shrinkageRecommendation(rows, label) {
  const target = rows.filter((row) => row.market === 'match_win' && row.model_p >= 0.60 && row.model_p <= 0.95);
  if (target.length < 30) {
    return {
      label,
      k: '',
      n: target.length,
      brier_raw: '',
      brier_adj: '',
      brier_improvement: '',
      k_p5: '',
      k_median: '',
      k_p95: '',
      ci_contains_1: false,
      formula: '',
      advice: `${label}: 样本不足 (n=${target.length} < 30),不建议自动收缩。`,
    };
  }

  const best = fitShrinkageK(target);
  const boot = bootstrapShrinkage(target);
  const raw = brier(target);
  const improvement = raw - best.score;
  const advice = boot.ci_contains_1
    ? `${label}: Bootstrap 95% CI [${decimal(boot.k_p5, 2)}, ${decimal(boot.k_p95, 2)}] 包含 1.0,收缩效果不显著,不建议落地。`
    : `${label}: Bootstrap 95% CI [${decimal(boot.k_p5, 2)}, ${decimal(boot.k_p95, 2)}] 不包含 1.0,可以小流量验证。`;

  return {
    label,
    k: decimal(best.k, 2),
    n: target.length,
    brier_raw: decimal(raw),
    brier_adj: decimal(best.score),
    brier_improvement: decimal(improvement),
    k_p5: decimal(boot.k_p5, 2),
    k_median: decimal(boot.k_median, 2),
    k_p95: decimal(boot.k_p95, 2),
    ci_contains_1: boot.ci_contains_1 ? 'yes' : 'no',
    formula: `p_adj = 0.5 + (p_raw - 0.5) * ${decimal(best.k, 2)}`,
    advice,
  };
}

function marketsToCut(brierRows, roiRows) {
  const cuts = [];
  for (const row of brierRows) {
    if (row.skill !== '' && Number(row.skill) < 0) {
      cuts.push({ item: row.market, reason: `Brier skill=${row.skill}` });
    }
  }
  for (const row of roiRows) {
    if (row.selection === 'all' && row.roi !== '' && Number(row.roi) < -0.10) {
      cuts.push({ item: `total_kills line ${row.line}`, reason: `ROI=${row.roi}` });
    }
  }
  return cuts;
}

function sampleThreshold(rows) {
  const stance = rows.filter((row) => row.model_p >= 0.55);
  const low = stance.filter((row) => row.sample < 20);
  const high = stance.filter((row) => row.sample >= 20);
  const lowBrier = brier(low);
  const highBrier = brier(high);
  return {
    low_n: low.length,
    low_hit_rate: decimal(hitRate(low)),
    low_brier: decimal(lowBrier),
    high_n: high.length,
    high_hit_rate: decimal(hitRate(high)),
    high_brier: decimal(highBrier),
    recommendation: low.length >= 30 && high.length >= 30 && lowBrier > highBrier + 0.03
      ? '建议把可下注样本门槛提高到 sample >= 20。'
      : '暂不需要按 sample >= 20 硬切,继续保留当前门槛并观察。',
  };
}

function markdownList(items) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- 无';
}

async function main() {
  const predictionRows = await readCsv(path.join(BACKTEST_DIR, 'predictions_with_outcomes.csv'));
  const rows = usableRows(predictionRows);

  const inRows = rows.filter((row) => row.split === SPLIT_IN_SAMPLE);
  const outRows = rows.filter((row) => row.split === SPLIT_OUT_SAMPLE);

  const shrinkIn = shrinkageRecommendation(inRows, 'in_sample_2024');
  const shrinkOut = shrinkageRecommendation(outRows, 'out_of_sample_2025');

  const inBrier = await readCsvIfExists(path.join(BACKTEST_DIR, 'brier_scores_in_sample.csv'));
  const outBrier = await readCsvIfExists(path.join(BACKTEST_DIR, 'brier_scores_out_of_sample.csv'));
  const inRoi = await readCsvIfExists(path.join(BACKTEST_DIR, 'total_kills_roi_in_sample.csv'));
  const outRoi = await readCsvIfExists(path.join(BACKTEST_DIR, 'total_kills_roi_out_of_sample.csv'));
  const inVer = await readCsvIfExists(path.join(BACKTEST_DIR, 'version_sensitivity_in_sample.csv'));
  const outVer = await readCsvIfExists(path.join(BACKTEST_DIR, 'version_sensitivity_out_of_sample.csv'));

  const cutsIn = marketsToCut(inBrier, inRoi);
  const cutsOut = marketsToCut(outBrier, outRoi);
  const skipsIn = inVer.filter((row) => row.flag_skip_after_patch === 'yes');
  const skipsOut = outVer.filter((row) => row.flag_skip_after_patch === 'yes');

  const sampleIn = sampleThreshold(inRows);
  const sampleOut = sampleThreshold(outRows);

  function shrinkBlock(s) {
    return [
      `### ${s.label}`,
      '',
      `样本数: ${s.n}`,
      `推荐 k (点估计): ${s.k}`,
      `Bootstrap 95% CI: [${s.k_p5}, ${s.k_p95}], median=${s.k_median}, CI 包含 1.0: ${s.ci_contains_1}`,
      `原始 Brier: ${s.brier_raw}`,
      `收缩后 Brier: ${s.brier_adj}`,
      `Brier 改进: ${s.brier_improvement}`,
      `公式: ${s.formula}`,
      s.advice,
      '',
    ].join('\n');
  }

  function byMarketResiduals(rs, label) {
    const items = [...groupBy(rs.filter((row) => row.model_p >= 0.55), (row) => row.market).entries()]
      .map(([market, group]) => ({
        market,
        n: group.length,
        hit: hitRate(group),
        brier: brier(group),
      }))
      .sort((a, b) => b.brier - a.brier);
    return [
      `### ${label}`,
      '',
      '| market | n | hit_rate | brier |',
      '|---|---:|---:|---:|',
      ...items.map((row) => `| ${row.market} | ${row.n} | ${formatPct(row.hit)} | ${decimal(row.brier)} |`),
      '',
    ].join('\n');
  }

  const md = [
    '# 模型修正建议 (分段)',
    '',
    '## 1. match_win 过度自信修正 (Bootstrap CI)',
    '',
    shrinkBlock(shrinkIn),
    shrinkBlock(shrinkOut),
    '## 2. 应该砍掉或降权的盘口',
    '',
    '### in_sample_2024',
    markdownList(cutsIn.map((r) => `${r.item}: ${r.reason}`)),
    '',
    '### out_of_sample_2025',
    markdownList(cutsOut.map((r) => `${r.item}: ${r.reason}`)),
    '',
    '执行规则: Brier skill < 0 的 market 默认降权;total_kills 某条 line ROI < -10% 时从候选池移除,直到新样本修复。落地前优先看 out_of_sample 信号(in_sample 受 Phase 2 调参偏置)。',
    '',
    '## 3. 版本切换跳过建议',
    '',
    '### in_sample_2024',
    markdownList(skipsIn.map((r) => `${r.market}: 切换期 Brier ${r.switch_brier} vs 稳定期 ${r.stable_brier}, p=${r.welch_p_value}`)),
    '',
    '### out_of_sample_2025',
    markdownList(skipsOut.map((r) => `${r.market}: 切换期 Brier ${r.switch_brier} vs 稳定期 ${r.stable_brier}, p=${r.welch_p_value}`)),
    '',
    (skipsIn.length + skipsOut.length) ? '建议这些 market 在版本切换后 14 天内跳过或单注减半。' : '当前回测没有触发 p < 0.05 的严格版本切换跳过规则。',
    '',
    '## 4. 样本阈值建议',
    '',
    `### in_sample_2024`,
    `sample < 20: n=${sampleIn.low_n}, hit=${formatPct(sampleIn.low_hit_rate)}, Brier=${sampleIn.low_brier}`,
    `sample >= 20: n=${sampleIn.high_n}, hit=${formatPct(sampleIn.high_hit_rate)}, Brier=${sampleIn.high_brier}`,
    sampleIn.recommendation,
    '',
    `### out_of_sample_2025`,
    `sample < 20: n=${sampleOut.low_n}, hit=${formatPct(sampleOut.low_hit_rate)}, Brier=${sampleOut.low_brier}`,
    `sample >= 20: n=${sampleOut.high_n}, hit=${formatPct(sampleOut.high_hit_rate)}, Brier=${sampleOut.high_brier}`,
    sampleOut.recommendation,
    '',
    '## 5. 有立场样本按 market 残差排序',
    '',
    byMarketResiduals(inRows, 'in_sample_2024'),
    byMarketResiduals(outRows, 'out_of_sample_2025'),
  ].join('\n');

  await writeFile(path.join(BACKTEST_DIR, '模型修正建议.md'), md, 'utf8');
  console.log('wrote 模型修正建议.md');
}

main().catch((error) => {
  console.error(`backtest-recommend failed: ${error.message}`);
  process.exitCode = 1;
});
