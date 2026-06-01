import path from 'node:path';
import {
  ANALYSIS_DIR,
  CALIBRATION_DIR,
  addPredictions,
  calibrationBuckets,
  fitLogistic,
  fmt,
  labels,
  loadCalibrationRows,
  logit,
  markdownTable,
  metricRow,
  pct,
  plattFeatures,
  writeJson,
  writeMarkdown,
} from './common.js';

const COEF_PATH = path.join(CALIBRATION_DIR, 'platt_coef.json');
const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-step1-platt.md');

function metrics(rows) {
  return [
    metricRow('2024 fit', rows.filter((row) => row.year === '2024'), {
      model_raw: (row) => row.model_p_home,
      model_cal: (row) => row.p_model_cal,
      market: (row) => row.market_p_home,
    }),
    metricRow('2025 OOS', rows.filter((row) => row.year === '2025'), {
      model_raw: (row) => row.model_p_home,
      model_cal: (row) => row.p_model_cal,
      market: (row) => row.market_p_home,
    }),
  ];
}

function bucketRows(rows, label) {
  const specs = [
    ['model_raw', (row) => row.model_p_home],
    ['model_cal', (row) => row.p_model_cal],
    ['market', (row) => row.market_p_home],
  ];
  return specs.flatMap(([model, fn]) => calibrationBuckets(rows, fn)
    .filter((bucket) => bucket.n > 0)
    .map((bucket) => ({
      segment: label,
      model,
      bucket: bucket.bucket,
      n: bucket.n,
      mean_p: bucket.mean_p,
      hit_rate: bucket.hit_rate,
      bias: bucket.bias,
    })));
}

async function main() {
  const { rows, stats } = await loadCalibrationRows();
  const fitRows = rows.filter((row) => row.year === '2024');
  const fit = fitLogistic(plattFeatures(fitRows), labels(fitRows), { maxIter: 100 });
  const [a, b] = fit.beta;
  const predicted = addPredictions(rows, { plattCoef: fit.beta });
  const metricRows = metrics(predicted);
  const buckets = [
    ...bucketRows(predicted.filter((row) => row.year === '2024'), '2024 fit'),
    ...bucketRows(predicted.filter((row) => row.year === '2025'), '2025 OOS'),
  ];

  await writeJson(COEF_PATH, {
    model: 'p_cal = sigmoid(a + b * logit(model_p))',
    fit_year: 2024,
    n_fit: fitRows.length,
    n_total: rows.length,
    a,
    b,
    converged: fit.converged,
    iterations: fit.iterations,
    loss: fit.loss,
    generated_at: new Date().toISOString(),
  });

  const metricTable = markdownTable([
    { key: 'label', label: 'segment / 分段', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'brier_model_raw', label: 'Brier raw', format: fmt },
    { key: 'brier_model_cal', label: 'Brier cal', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'logloss_model_raw', label: 'LogLoss raw', format: fmt },
    { key: 'logloss_model_cal', label: 'LogLoss cal', format: fmt },
    { key: 'logloss_market', label: 'LogLoss market', format: fmt },
  ], metricRows);

  const bucketTable = markdownTable([
    { key: 'segment', label: 'segment / 分段', align: 'left' },
    { key: 'model', label: 'curve / 曲线', align: 'left' },
    { key: 'bucket', label: 'bucket', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'mean_p', label: 'mean p', format: pct },
    { key: 'hit_rate', label: 'hit rate', format: pct },
    { key: 'bias', label: 'bias p-hit', format: (value) => pct(value) },
  ], buckets);

  await writeMarkdown(REPORT_PATH, [
    '# Step 1 Platt Scaling / 第一步 Platt 概率缩放',
    '',
    `- Dataset / 数据集: ${stats.final_rows} matched rows; 2024 fit rows = ${fitRows.length}.`,
    `- Fit / 拟合公式: \`p_cal = sigmoid(a + b * logit(model_p))\`.`,
    `- Coefficients / 系数: \`a=${fmt(a)}\`, \`b=${fmt(b)}\`.`,
    `- Convergence / 收敛: ${fit.converged ? 'yes' : 'no'}, iterations=${fit.iterations}, loss=${fmt(fit.loss)}.`,
    `- Output JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    '## Metrics / 指标',
    '',
    metricTable,
    '',
    '## Calibration Buckets / 校准分桶',
    '',
    bucketTable,
    '',
    '## Notes / 备注',
    '',
    `- Matching stats / 匹配统计: OP=${stats.oddsportal_rows}, matched=${stats.matched}, unmatched=${stats.unmatched}, low_sample=${stats.low_sample}, final=${stats.final_rows}.`,
    '- Buckets use home-side probabilities only / 分桶仅使用主队胜率口径。',
    '',
  ]);

  console.log(`wrote ${COEF_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
