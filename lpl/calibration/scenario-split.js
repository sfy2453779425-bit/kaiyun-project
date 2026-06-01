import path from 'node:path';
import {
  ANALYSIS_DIR,
  addPredictions,
  bootstrapCoef,
  ciFor,
  fitLogistic,
  fmt,
  labels,
  loadCalibrationRows,
  markdownTable,
  metricRow,
  pct,
  plattFeatures,
  residualFeatures,
  wilson,
  writeMarkdown,
} from './common.js';

const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-step4-scenario.md');

const BUCKETS = [
  { label: '[-15, -10)', low: -0.15, high: -0.10 },
  { label: '[-10, -7)', low: -0.10, high: -0.07 },
  { label: '[-7, -5)', low: -0.07, high: -0.05 },
  { label: '[-5, -3)', low: -0.05, high: -0.03 },
  { label: '[-3, 0)', low: -0.03, high: 0 },
  { label: '[0, 3)', low: 0, high: 0.03 },
  { label: '[3, 5)', low: 0.03, high: 0.05 },
  { label: '[5, 7)', low: 0.05, high: 0.07 },
  { label: '[7, 10)', low: 0.07, high: 0.10 },
  { label: '[10, 15)', low: 0.10, high: 0.15 },
  { label: '[15, +∞)', low: 0.15, high: Infinity },
];

function bucketFor(edge) {
  return BUCKETS.find((bucket) => edge >= bucket.low && edge < bucket.high) || null;
}

function edgeBuckets(rows) {
  const out = [];
  for (const year of ['2024', '2025']) {
    const scoped = rows.filter((row) => row.year === year);
    for (const bucket of BUCKETS) {
      const members = scoped.filter((row) => bucketFor(row.edge_home) === bucket);
      let wins = 0;
      let profit = 0;
      let oddsSum = 0;
      for (const row of members) {
        const betHome = row.edge_home >= 0;
        const win = betHome ? row.outcome_home : 1 - row.outcome_home;
        const odds = betHome ? row.home_avg_odds : row.away_avg_odds;
        wins += win;
        oddsSum += odds;
        profit += win ? odds - 1 : -1;
      }
      const avgOdds = members.length ? oddsSum / members.length : NaN;
      const ci = wilson(wins, members.length);
      const roi = members.length ? profit / members.length : NaN;
      const breakeven = Number.isFinite(avgOdds) && avgOdds > 1 ? 1 / avgOdds : NaN;
      out.push({
        year,
        bucket: bucket.label,
        n_samples: members.length,
        roi,
        wilson_low: ci.low,
        breakeven,
        actionable: members.length > 0 && roi > 0.03 && ci.low > breakeven,
      });
    }
  }
  return out;
}

function runPartition(name, rows) {
  const fitRows = rows.filter((row) => row.year === '2024');
  const oosRows = rows.filter((row) => row.year === '2025');
  const insufficient = rows.length < 100;
  if (fitRows.length < 20 || oosRows.length < 20) {
    return {
      name,
      n: rows.length,
      n_2024: fitRows.length,
      n_2025: oosRows.length,
      insufficient: true,
      skipped: true,
      warning: '样本不足,仅供观察 / insufficient sample, observation only',
    };
  }

  const platt = fitLogistic(plattFeatures(fitRows), labels(fitRows), { maxIter: 100 });
  const residual = fitLogistic(residualFeatures(fitRows), labels(fitRows), { maxIter: 100 });
  const boot = bootstrapCoef(fitRows, residualFeatures, labels, { iterations: 1000, seed: 20260522 + rows.length });
  const ciC = ciFor(boot.coefs, 2);
  const predicted = addPredictions(rows, { plattCoef: platt.beta, residualCoef: residual.beta }).map((row) => ({
    ...row,
    edge_home: row.p_final - row.market_p_home,
  }));
  const metrics2025 = metricRow('2025 OOS', predicted.filter((row) => row.year === '2025'), {
    p_final: (row) => row.p_final,
    market: (row) => row.market_p_home,
    model_cal: (row) => row.p_model_cal,
    model_raw: (row) => row.model_p_home,
  });
  const buckets = edgeBuckets(predicted);
  const actionable = buckets.filter((row) => row.year === '2025' && row.actionable);
  const c = residual.beta[2];

  return {
    name,
    n: rows.length,
    n_2024: fitRows.length,
    n_2025: oosRows.length,
    insufficient,
    skipped: false,
    platt_a: platt.beta[0],
    platt_b: platt.beta[1],
    residual_a: residual.beta[0],
    residual_b: residual.beta[1],
    residual_c: c,
    c_low: ciC.low,
    c_high: ciC.high,
    c_positive_ci: c > 0 && ciC.low > 0,
    brier_final_2025: metrics2025.brier_p_final,
    brier_market_2025: metrics2025.brier_market,
    final_beats_market_2025: metrics2025.brier_p_final < metrics2025.brier_market,
    actionable_buckets: actionable.map((row) => `${row.bucket} ROI=${pct(row.roi)} WilsonLow=${pct(row.wilson_low)} BE=${pct(row.breakeven)}`).join('; ') || 'None',
    bootstrap_failures: boot.failures,
  };
}

async function main() {
  const { rows, stats } = await loadCalibrationRows();
  const partitions = [
    { name: 'BO3', rows: rows.filter((row) => row.series_type === 'BO3') },
    { name: 'BO5', rows: rows.filter((row) => row.series_type === 'BO5') },
    { name: 'strong_favorite', rows: rows.filter((row) => row.market_shape === 'strong_favorite') },
    { name: 'even', rows: rows.filter((row) => row.market_shape === 'even') },
  ];
  const results = partitions.map((partition) => runPartition(partition.name, partition.rows));

  const table = markdownTable([
    { key: 'name', label: 'partition / 切分', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'n_2024', label: '2024 n' },
    { key: 'n_2025', label: '2025 n' },
    { key: 'insufficient', label: 'sample warning', format: (value) => value ? '样本不足,仅供观察' : 'OK' },
    { key: 'residual_c', label: 'c', format: fmt },
    { key: 'c_low', label: 'c CI low', format: fmt },
    { key: 'c_high', label: 'c CI high', format: fmt },
    { key: 'brier_final_2025', label: '2025 Brier final', format: fmt },
    { key: 'brier_market_2025', label: '2025 Brier market', format: fmt },
    { key: 'final_beats_market_2025', label: 'beats market?', format: (value) => value ? 'YES' : 'NO' },
    { key: 'actionable_buckets', label: '2025 actionable buckets', align: 'left' },
  ], results);

  await writeMarkdown(REPORT_PATH, [
    '# Step 4 Scenario Split / 第四步 场景切分',
    '',
    '- Partitions / 切分: BO3 vs BO5, strong favorite vs even.',
    '- Strong favorite / 强热门: `max(market_p_home, market_p_away) > 0.65`; otherwise even / 否则接近五五开。',
    '- BO5 / BO5: inferred by `max(home_score, away_score) >= 3`; otherwise BO3.',
    '- If partition n < 100, label as sample insufficient / 如果分区样本 n < 100, 标记样本不足,仅供观察。',
    '',
    '## Summary / 汇总',
    '',
    table,
    '',
    '## Notes / 备注',
    '',
    `- Matching stats / 匹配统计: OP=${stats.oddsportal_rows}, matched=${stats.matched}, unmatched=${stats.unmatched}, low_sample=${stats.low_sample}, final=${stats.final_rows}.`,
    '- Scenario coefficients are observation tools, not production coefficients / 场景系数仅用于观察,不是生产系数。',
    '',
  ]);

  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
