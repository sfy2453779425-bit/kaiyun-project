import path from 'node:path';
import {
  ANALYSIS_DIR,
  CALIBRATION_DIR,
  brier,
  ciFor,
  fitLogistic,
  fmt,
  labels,
  loadCalibrationRows,
  logLoss,
  logit,
  markdownTable,
  metricRow,
  pct,
  predictLogistic,
  seededRandom,
  writeJson,
  writeMarkdown,
} from './common.js';
import { num } from '../shared.js';

const COEF_PATH = path.join(CALIBRATION_DIR, 'market_feature_coef.json');
const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-step2b-market-features.md');
const SEED = 20260522;
const L2 = 0.01;

const FEATURE_DEFS = {
  market_logit: {
    label: 'market logit / 市场 logit',
    scale: false,
    value: (row) => logit(row.market_p_home),
  },
  strength_diff: {
    label: 'strength diff / 强度差',
    scale: true,
    value: (row) => num(row.strength_diff),
  },
  recent_form_diff: {
    label: 'recent form diff / 衰减近期差',
    scale: true,
    value: (row) => num(row.recent_form_diff),
  },
  avg_total_diff: {
    label: 'avg total diff / 节奏总击杀差',
    scale: true,
    value: (row) => num(row.avg_total_diff),
  },
  patch_age_days: {
    label: 'patch age days / 版本年龄',
    scale: true,
    value: (row) => num(row.patch_age_days),
  },
  is_playoff: {
    label: 'is playoff / 季后赛',
    scale: false,
    value: (row) => num(row.is_playoff),
  },
  map_sample_diff: {
    label: 'map sample diff / 样本差',
    scale: true,
    value: (row) => num(row.map_sample_diff),
  },
};

const FULL_FEATURES = [
  'market_logit',
  'strength_diff',
  'recent_form_diff',
  'avg_total_diff',
  'patch_age_days',
  'is_playoff',
  'map_sample_diff',
];

const ABLATIONS = [
  ['market_only', ['market_logit']],
  ['market_strength', ['market_logit', 'strength_diff']],
  ['market_strength_recent', ['market_logit', 'strength_diff', 'recent_form_diff']],
  ['market_all_features', FULL_FEATURES],
];

function rawValue(row, key) {
  const value = FEATURE_DEFS[key].value(row);
  return Number.isFinite(value) ? value : 0;
}

function fitScaler(rows, featureKeys) {
  const scaler = {};
  for (const key of featureKeys) {
    const def = FEATURE_DEFS[key];
    if (!def.scale) continue;
    const values = rows.map((row) => rawValue(row, key));
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
    scaler[key] = {
      mean,
      sd: Math.sqrt(variance) || 1,
    };
  }
  return scaler;
}

function featureVector(row, featureKeys, scaler) {
  return [
    1,
    ...featureKeys.map((key) => {
      const value = rawValue(row, key);
      const def = FEATURE_DEFS[key];
      if (!def.scale) return value;
      const s = scaler[key] || { mean: 0, sd: 1 };
      return (value - s.mean) / s.sd;
    }),
  ];
}

function features(rows, featureKeys, scaler) {
  return rows.map((row) => featureVector(row, featureKeys, scaler));
}

function fitFeatureModel(fitRows, featureKeys) {
  const scaler = fitScaler(fitRows, featureKeys);
  const fit = fitLogistic(features(fitRows, featureKeys, scaler), labels(fitRows), {
    maxIter: 200,
    l2: L2,
  });
  return { featureKeys, scaler, fit };
}

function predictRows(rows, model, field) {
  return rows.map((row) => ({
    ...row,
    [field]: predictLogistic(model.fit.beta, featureVector(row, model.featureKeys, model.scaler)),
  }));
}

function bootstrapFeatureModel(fitRows, featureKeys, scaler) {
  const random = seededRandom(SEED);
  const coefs = [];
  let failures = 0;
  for (let i = 0; i < 1000; i += 1) {
    const sample = Array.from({ length: fitRows.length }, () => fitRows[Math.floor(random() * fitRows.length)]);
    const fit = fitLogistic(features(sample, featureKeys, scaler), labels(sample), {
      maxIter: 120,
      l2: L2,
    });
    if (!fit.beta.every(Number.isFinite)) {
      failures += 1;
      continue;
    }
    coefs.push(fit.beta);
  }
  return { coefs, failures };
}

function segmentMetrics(rows, predKey) {
  return [
    metricRow('2024 fit', rows.filter((row) => row.year === '2024'), {
      feature_model: (row) => row[predKey],
      market: (row) => row.market_p_home,
      model_raw: (row) => row.model_p_home,
    }),
    metricRow('2025 OOS', rows.filter((row) => row.year === '2025'), {
      feature_model: (row) => row[predKey],
      market: (row) => row.market_p_home,
      model_raw: (row) => row.model_p_home,
    }),
  ];
}

function ablationRows(rows, fitRows) {
  const out = [];
  for (const [name, featureKeys] of ABLATIONS) {
    const model = fitFeatureModel(fitRows, featureKeys);
    const predicted = predictRows(rows, model, 'p_ablation');
    for (const segment of ['2024 fit', '2025 OOS']) {
      const segRows = predicted.filter((row) => segment === '2024 fit' ? row.year === '2024' : row.year === '2025');
      const brierFeature = brier(segRows, (row) => row.p_ablation);
      const brierMarket = brier(segRows, (row) => row.market_p_home);
      const llFeature = logLoss(segRows, (row) => row.p_ablation);
      const llMarket = logLoss(segRows, (row) => row.market_p_home);
      out.push({
        model: name,
        segment,
        n: segRows.length,
        brier_feature: brierFeature,
        brier_market: brierMarket,
        brier_delta_vs_market: brierFeature - brierMarket,
        logloss_feature: llFeature,
        logloss_market: llMarket,
        logloss_delta_vs_market: llFeature - llMarket,
      });
    }
  }
  return out;
}

async function main() {
  const { rows, stats } = await loadCalibrationRows();
  const fitRows = rows.filter((row) => row.year === '2024');
  const model = fitFeatureModel(fitRows, FULL_FEATURES);
  const predicted = predictRows(rows, model, 'p_feature');
  const boot = bootstrapFeatureModel(fitRows, FULL_FEATURES, model.scaler);
  const metricRows = segmentMetrics(predicted, 'p_feature');
  const oos = metricRows.find((row) => row.label === '2025 OOS');
  const beatsMarket = oos.brier_feature_model < oos.brier_market
    && oos.logloss_feature_model <= oos.logloss_market;

  const coefNames = ['intercept', ...FULL_FEATURES];
  const coefRows = coefNames.map((key, index) => {
    const ci = ciFor(boot.coefs, index);
    return {
      key,
      label: index === 0 ? 'intercept / 截距' : FEATURE_DEFS[key].label,
      value: model.fit.beta[index],
      ci_low: ci.low,
      ci_high: ci.high,
      significant: ci.low > 0 || ci.high < 0 ? 'yes' : 'no',
    };
  });
  const ablations = ablationRows(rows, fitRows);

  await writeJson(COEF_PATH, {
    model: 'logit(p) = intercept + market_logit + standardized profile features',
    fit_year: 2024,
    n_fit: fitRows.length,
    n_total: rows.length,
    l2: L2,
    features: FULL_FEATURES,
    scaler: model.scaler,
    beta: Object.fromEntries(coefRows.map((row) => [row.key, row.value])),
    ci95: Object.fromEntries(coefRows.map((row) => [row.key, { low: row.ci_low, high: row.ci_high }])),
    bootstrap: {
      iterations: 1000,
      seed: SEED,
      successful: boot.coefs.length,
      failures: boot.failures,
    },
    converged: model.fit.converged,
    iterations: model.fit.iterations,
    loss: model.fit.loss,
    oos_2025: {
      brier_feature_model: oos.brier_feature_model,
      brier_market: oos.brier_market,
      logloss_feature_model: oos.logloss_feature_model,
      logloss_market: oos.logloss_market,
      beats_market: beatsMarket,
    },
    generated_at: new Date().toISOString(),
  });

  const metricTable = markdownTable([
    { key: 'label', label: 'segment / 分段', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'brier_feature_model', label: 'Brier feature', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'brier_model_raw', label: 'Brier raw', format: fmt },
    { key: 'logloss_feature_model', label: 'LogLoss feature', format: fmt },
    { key: 'logloss_market', label: 'LogLoss market', format: fmt },
    { key: 'logloss_model_raw', label: 'LogLoss raw', format: fmt },
  ], metricRows);

  const coefTable = markdownTable([
    { key: 'label', label: 'feature / 特征', align: 'left' },
    { key: 'value', label: 'coef', format: fmt },
    { key: 'ci_low', label: 'CI low', format: fmt },
    { key: 'ci_high', label: 'CI high', format: fmt },
    { key: 'significant', label: 'CI excludes 0?', align: 'left' },
  ], coefRows);

  const ablationTable = markdownTable([
    { key: 'model', label: 'model / 模型', align: 'left' },
    { key: 'segment', label: 'segment / 分段', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'brier_feature', label: 'Brier feature', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'brier_delta_vs_market', label: 'Brier delta', format: fmt },
    { key: 'logloss_feature', label: 'LogLoss feature', format: fmt },
    { key: 'logloss_market', label: 'LogLoss market', format: fmt },
    { key: 'logloss_delta_vs_market', label: 'LogLoss delta', format: fmt },
  ], ablations);

  await writeMarkdown(REPORT_PATH, [
    '# Step 2B Multi-Feature Market Calibration / 多特征市场锚定校准',
    '',
    `- Dataset / 数据集: ${stats.final_rows} matched rows; 2024 fit rows = ${fitRows.length}.`,
    `- Fit / 拟合: market logit anchor + shrunk strength/recent/tempo/patch/sample features, L2=${L2}.`,
    `- Bootstrap / 自助法: 1000 resamples, seed=${SEED}, successful=${boot.coefs.length}, failures=${boot.failures}.`,
    `- Convergence / 收敛: ${model.fit.converged ? 'yes' : 'no'}, iterations=${model.fit.iterations}, loss=${fmt(model.fit.loss)}.`,
    `- Output JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    '## Decision / 裁决',
    '',
    `- 2025 Brier(feature) vs Brier(market): **${fmt(oos.brier_feature_model)} vs ${fmt(oos.brier_market)}**.`,
    `- 2025 LogLoss(feature) vs LogLoss(market): **${fmt(oos.logloss_feature_model)} vs ${fmt(oos.logloss_market)}**.`,
    `- Market-win decision / 胜负盘裁决: **${beatsMarket ? 'feature model beats market / 可进入小注验证' : 'feature model does not beat market / 胜负盘仍不放量'}**.`,
    '',
    '## Coefficients / 系数',
    '',
    coefTable,
    '',
    '## Metrics / 指标',
    '',
    metricTable,
    '',
    '## Ablation / 消融',
    '',
    ablationTable,
    '',
    '## Notes / 备注',
    '',
    `- Matching stats / 匹配统计: OP=${stats.oddsportal_rows}, matched=${stats.matched}, unmatched=${stats.unmatched}, low_sample=${stats.low_sample}, final=${stats.final_rows}.`,
    '- Positive Brier delta means worse than market / Brier delta 为正表示差于市场。',
    '',
  ]);

  console.log(`wrote ${COEF_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
