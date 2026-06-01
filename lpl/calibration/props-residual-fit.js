import path from 'node:path';
import { ANALYSIS_DIR, CALIBRATION_DIR, bootstrapCoef, ciFor, fitLogistic, fmt, logit, markdownTable, metricRow, predictLogistic, writeJson, writeMarkdown } from './common.js';
import { loadPropRows } from './props-common.js';

const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-props-step2-residual.md');
const COEF_PATH = path.join(CALIBRATION_DIR, 'props_residual_coef.json');

function features(rows) { return rows.map((row) => [1, logit(row.market_p), logit(row.model_p) - logit(row.market_p)]); }
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
    const boot = bootstrapCoef(fitRows, features, labels, { iterations: 1000, seed: 20260522 });
    const ciC = ciFor(boot.coefs, 2);
    coefs[market] = {
      a: fit.beta[0], b: fit.beta[1], c: fit.beta[2], c_ci: ciC,
      n_fit: fitRows.length, converged: fit.converged, bootstrap_successful: boot.coefs.length, bootstrap_failures: boot.failures,
    };
    const predicted = scoped.map((row) => ({ ...row, p_final: predictLogistic(fit.beta, [1, logit(row.market_p), logit(row.model_p) - logit(row.market_p)]) }));
    for (const year of ['2024', '2025']) {
      const seg = predicted.filter((row) => row.year === year);
      if (!seg.length) continue;
      const m = metricRow(`${market} ${year}`, seg.map((row) => ({ model_p_home: row.model_p, market_p_home: row.market_p, outcome_home: row.outcome, p_final: row.p_final })), {
        p_final: (row) => row.p_final,
        market: (row) => row.market_p_home,
        raw: (row) => row.model_p_home,
      });
      metrics.push({ market, year, n: m.n, c: fit.beta[2], c_low: ciC.low, c_high: ciC.high, brier_final: m.brier_p_final, brier_market: m.brier_market, beats_market: m.brier_p_final < m.brier_market });
    }
  }
  await writeJson(COEF_PATH, { generated_at: new Date().toISOString(), stats, coefs });
  const table = metrics.length ? markdownTable([
    { key: 'market', label: 'market / 盘口', align: 'left' },
    { key: 'year', label: 'year' },
    { key: 'n', label: 'n' },
    { key: 'c', label: 'c', format: fmt },
    { key: 'c_low', label: 'c CI low', format: fmt },
    { key: 'c_high', label: 'c CI high', format: fmt },
    { key: 'brier_final', label: 'Brier final', format: fmt },
    { key: 'brier_market', label: 'Brier market', format: fmt },
    { key: 'beats_market', label: 'beats?', format: (value) => value ? 'YES' : 'NO' },
  ], metrics) : 'No usable prop rows / 没有可用 prop 样本。';
  await writeMarkdown(REPORT_PATH, [
    '# Props Step 2 Residual / Props 第二步 残差回归',
    '',
    `- Prop rows / prop 行: ${stats.prop_rows}; final rows / 最终样本: ${stats.final_rows}.`,
    `- Coef JSON / 系数文件: \`${COEF_PATH}\`.`,
    '',
    table,
    '',
  ]);
  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
