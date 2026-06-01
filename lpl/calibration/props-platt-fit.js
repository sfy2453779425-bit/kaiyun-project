import path from 'node:path';
import { ANALYSIS_DIR, CALIBRATION_DIR, fitLogistic, fmt, logit, markdownTable, metricRow, pct, predictLogistic, writeJson, writeMarkdown } from './common.js';
import { loadPropRows } from './props-common.js';

const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-props-step1-platt.md');
const COEF_PATH = path.join(CALIBRATION_DIR, 'props_platt_coef.json');

function features(rows) { return rows.map((row) => [1, logit(row.model_p)]); }
function labels(rows) { return rows.map((row) => row.outcome); }

async function main() {
  const { rows, stats } = await loadPropRows();
  const markets = [...new Set(rows.map((row) => row.market))].sort();
  const coefs = {};
  const metrics = [];
  for (const market of markets) {
    const scoped = rows.filter((row) => row.market === market);
    const fitRows = scoped.filter((row) => row.year === '2024');
    if (fitRows.length < 20) continue;
    const fit = fitLogistic(features(fitRows), labels(fitRows), { maxIter: 100 });
    coefs[market] = { a: fit.beta[0], b: fit.beta[1], n_fit: fitRows.length, converged: fit.converged };
    const predicted = scoped.map((row) => ({ ...row, p_cal: predictLogistic(fit.beta, [1, logit(row.model_p)]) }));
    for (const year of ['2024', '2025']) {
      const seg = predicted.filter((row) => row.year === year);
      if (!seg.length) continue;
      const m = metricRow(`${market} ${year}`, seg.map((row) => ({ model_p_home: row.model_p, market_p_home: row.market_p, outcome_home: row.outcome, p_cal: row.p_cal })), {
        raw: (row) => row.model_p_home,
        cal: (row) => row.p_cal,
        market: (row) => row.market_p_home,
      });
      metrics.push({ market, year, n: m.n, b: fit.beta[1], brier_raw: m.brier_raw, brier_cal: m.brier_cal, brier_market: m.brier_market, logloss_raw: m.logloss_raw, logloss_cal: m.logloss_cal, logloss_market: m.logloss_market });
    }
  }
  await writeJson(COEF_PATH, { generated_at: new Date().toISOString(), stats, coefs });
  const table = metrics.length ? markdownTable([
    { key: 'market', label: 'market / 盘口', align: 'left' },
    { key: 'year', label: 'year' },
    { key: 'n', label: 'n' },
    { key: 'b', label: 'Platt b', format: fmt },
    { key: 'brier_raw', label: 'Brier raw', format: fmt },
    { key: 'brier_cal', label: 'Brier cal', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'logloss_cal', label: 'LogLoss cal', format: fmt },
    { key: 'logloss_market', label: 'LogLoss market', format: fmt },
  ], metrics) : 'No usable prop rows / 没有可用 prop 样本。';
  await writeMarkdown(REPORT_PATH, [
    '# Props Step 1 Platt / Props 第一步 Platt',
    '',
    `- Prop rows / prop 行: ${stats.prop_rows}; final rows / 最终样本: ${stats.final_rows}.`,
    `- Coef JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    table,
    '',
    '- b < 1 means raw model is over-confident / b < 1 表示原模型过度自信。',
    '',
  ]);
  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
