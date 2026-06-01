import path from 'node:path';
import { readCsv, num } from '../shared.js';
import {
  BACKTEST_DIR,
  SPLIT_IN_SAMPLE,
  SPLIT_OUT_SAMPLE,
  brier,
  bucketOf,
  decimal,
  groupBy,
  hitRate,
  mean,
  parseOutcome,
  writeBacktestCsv,
} from './common.js';

function usableRows(rows) {
  return rows
    .map((row) => ({ ...row, model_p_num: num(row.model_p), outcome_num: parseOutcome(row.outcome) }))
    .filter((row) => Number.isFinite(row.model_p_num) && row.outcome_num != null)
    .map((row) => ({ ...row, model_p: row.model_p_num, outcome: row.outcome_num }));
}

function calibrationRows(rows, bucketCount, groupFields) {
  const grouped = groupBy(rows, (row) => [
    ...groupFields.map((field) => row[field] || ''),
    bucketOf(row.model_p, bucketCount),
  ].join('|'));

  const out = [];
  for (const [key, items] of grouped) {
    const parts = key.split('|');
    const bucket = Number(parts.at(-1));
    const row = {};
    groupFields.forEach((field, index) => { row[field] = parts[index]; });
    row.bucket_lower = decimal(bucket / bucketCount, 2);
    row.bucket_upper = decimal((bucket + 1) / bucketCount, 2);
    row.n_samples = items.length;
    row.mean_model_p = decimal(mean(items, (item) => item.model_p));
    row.actual_hit_rate = decimal(hitRate(items));
    row.brier_contrib = decimal(brier(items));
    out.push(row);
  }

  return out.sort((a, b) => groupFields.map((field) => String(a[field]).localeCompare(String(b[field]))).find((value) => value !== 0) || Number(a.bucket_lower) - Number(b.bucket_lower));
}

function brierRows(rows) {
  const grouped = groupBy(rows, (row) => row.market);
  return [...grouped.entries()].map(([market, items]) => {
    const actual = hitRate(items);
    const score = brier(items);
    const baseline = actual * (1 - actual);
    return {
      market,
      n_samples: items.length,
      brier_score: decimal(score),
      baseline_brier: decimal(baseline),
      skill: baseline ? decimal(1 - score / baseline) : '',
    };
  }).sort((a, b) => Number(b.brier_score) - Number(a.brier_score));
}

async function runForSplit(allRows, split, suffix) {
  const rows = allRows.filter((row) => row.split === split);
  console.log(`  ${split}: ${rows.length} 行`);
  if (!rows.length) {
    console.log(`  跳过 ${split} (无样本)`);
    return;
  }
  await writeBacktestCsv(`calibration_by_market_${suffix}.csv`, calibrationRows(rows, 10, ['market']), [
    'market', 'bucket_lower', 'bucket_upper', 'n_samples', 'mean_model_p', 'actual_hit_rate', 'brier_contrib',
  ]);
  await writeBacktestCsv(`calibration_by_patch_${suffix}.csv`, calibrationRows(rows, 5, ['market', 'patch']), [
    'market', 'patch', 'bucket_lower', 'bucket_upper', 'n_samples', 'mean_model_p', 'actual_hit_rate', 'brier_contrib',
  ]);
  await writeBacktestCsv(`brier_scores_${suffix}.csv`, brierRows(rows), [
    'market', 'n_samples', 'brier_score', 'baseline_brier', 'skill',
  ]);
}

async function main() {
  const rows = usableRows(await readCsv(path.join(BACKTEST_DIR, 'predictions_with_outcomes.csv')));
  console.log(`总样本: ${rows.length}`);

  // 分段
  await runForSplit(rows, SPLIT_IN_SAMPLE, 'in_sample');
  await runForSplit(rows, SPLIT_OUT_SAMPLE, 'out_of_sample');

  // 合并整体 (兼容旧脚本读取)
  await writeBacktestCsv('calibration_by_market.csv', calibrationRows(rows, 10, ['market']), [
    'market', 'bucket_lower', 'bucket_upper', 'n_samples', 'mean_model_p', 'actual_hit_rate', 'brier_contrib',
  ]);
  await writeBacktestCsv('brier_scores.csv', brierRows(rows), [
    'market', 'n_samples', 'brier_score', 'baseline_brier', 'skill',
  ]);

  console.log(`calibration_rows=${rows.length}`);
}

main().catch((error) => {
  console.error(`backtest-calibrate failed: ${error.message}`);
  process.exitCode = 1;
});
