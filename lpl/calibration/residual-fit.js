import path from 'node:path';
import {
  ANALYSIS_DIR,
  CALIBRATION_DIR,
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
  residualFeatures,
  writeJson,
  writeMarkdown,
} from './common.js';

const COEF_PATH = path.join(CALIBRATION_DIR, 'residual_coef.json');
const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-step2-residual.md');

function alphaDecision(c, ci) {
  if (c > 0 && ci.low > 0) return '模型有盘口外增量信息 / Model has positive market-residual information';
  if (c < 0 && ci.high < 0) return '模型是反向信号,必须停用 / Model residual is negative signal; stop';
  return 'CI 含 0,不能证明有增量信息 / CI includes 0; no proven alpha';
}

async function main() {
  const { rows, stats } = await loadCalibrationRows();
  const fitRows = rows.filter((row) => row.year === '2024');
  const fit = fitLogistic(residualFeatures(fitRows), labels(fitRows), { maxIter: 100 });
  const [a, b, c] = fit.beta;
  const boot = bootstrapCoef(fitRows, residualFeatures, labels, { iterations: 1000, seed: 20260522 });
  const ciA = ciFor(boot.coefs, 0);
  const ciB = ciFor(boot.coefs, 1);
  const ciC = ciFor(boot.coefs, 2);
  const predicted = addPredictions(rows, { residualCoef: fit.beta });

  const metricRows = [
    metricRow('2024 fit', predicted.filter((row) => row.year === '2024'), {
      p_final: (row) => row.p_final,
      market: (row) => row.market_p_home,
      model_raw: (row) => row.model_p_home,
    }),
    metricRow('2025 OOS', predicted.filter((row) => row.year === '2025'), {
      p_final: (row) => row.p_final,
      market: (row) => row.market_p_home,
      model_raw: (row) => row.model_p_home,
    }),
  ];
  const oos = metricRows.find((row) => row.label === '2025 OOS');
  const strictMarketBeat = oos.brier_p_final < oos.brier_market;

  await writeJson(COEF_PATH, {
    model: 'logit(p_final) = a + b * logit(market_p) + c * (logit(model_p) - logit(market_p))',
    fit_year: 2024,
    n_fit: fitRows.length,
    n_total: rows.length,
    a,
    b,
    c,
    ci95: {
      a: ciA,
      b: ciB,
      c: ciC,
    },
    bootstrap: {
      iterations: 1000,
      seed: 20260522,
      successful: boot.coefs.length,
      failures: boot.failures,
    },
    converged: fit.converged,
    iterations: fit.iterations,
    loss: fit.loss,
    oos_2025: {
      brier_p_final: oos.brier_p_final,
      brier_market: oos.brier_market,
      p_final_beats_market: strictMarketBeat,
    },
    decision: {
      c_signal: alphaDecision(c, ciC),
      alpha: c > 0 && ciC.low > 0 && strictMarketBeat,
    },
    generated_at: new Date().toISOString(),
  });

  const metricTable = markdownTable([
    { key: 'label', label: 'segment / 分段', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'brier_p_final', label: 'Brier p_final', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'brier_model_raw', label: 'Brier raw model', format: fmt },
    { key: 'logloss_p_final', label: 'LogLoss p_final', format: fmt },
    { key: 'logloss_market', label: 'LogLoss market', format: fmt },
    { key: 'logloss_model_raw', label: 'LogLoss raw model', format: fmt },
  ], metricRows);

  const coefRows = [
    { name: 'a / intercept', value: a, low: ciA.low, high: ciA.high },
    { name: 'b / market logit', value: b, low: ciB.low, high: ciB.high },
    { name: 'c / model residual', value: c, low: ciC.low, high: ciC.high },
  ];
  const coefTable = markdownTable([
    { key: 'name', label: 'coef / 系数', align: 'left' },
    { key: 'value', label: 'value', format: fmt },
    { key: 'low', label: 'CI low', format: fmt },
    { key: 'high', label: 'CI high', format: fmt },
  ], coefRows);

  await writeMarkdown(REPORT_PATH, [
    '# Step 2 Market-Anchored Residual Regression / 第二步 市场锚定残差回归',
    '',
    `- Dataset / 数据集: ${stats.final_rows} matched rows; 2024 fit rows = ${fitRows.length}.`,
    '- Fit / 拟合公式: `logit(p_final) = a + b * logit(market_p) + c * (logit(model_p) - logit(market_p))`.',
    `- Bootstrap / 自助法: 1000 resamples, seed=20260522, successful=${boot.coefs.length}, failures=${boot.failures}.`,
    `- Convergence / 收敛: ${fit.converged ? 'yes' : 'no'}, iterations=${fit.iterations}, loss=${fmt(fit.loss)}.`,
    `- Output JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    '## Coefficients / 系数',
    '',
    coefTable,
    '',
    '## Alpha Check / Alpha 检查',
    '',
    `- c decision / c 判断: **${alphaDecision(c, ciC)}**.`,
    `- 2025 Brier(p_final) vs Brier(market): **${fmt(oos.brier_p_final)} vs ${fmt(oos.brier_market)}** (${strictMarketBeat ? 'p_final strictly better / 严格优于市场' : 'not better / 不优于市场'}).`,
    `- Final alpha decision / 最终 alpha 判断: **${c > 0 && ciC.low > 0 && strictMarketBeat ? 'YES / 有 alpha' : 'NO / 没有可证明 alpha'}**.`,
    '',
    '## Metrics / 指标',
    '',
    metricTable,
    '',
    '## Notes / 备注',
    '',
    `- Matching stats / 匹配统计: OP=${stats.oddsportal_rows}, matched=${stats.matched}, unmatched=${stats.unmatched}, low_sample=${stats.low_sample}, final=${stats.final_rows}.`,
    '- All metrics use home-side probabilities / 所有指标使用主队胜率口径。',
    '',
  ]);

  console.log(`wrote ${COEF_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
