import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ANALYSIS_DIR, CALIBRATION_DIR, fmt, logit, markdownTable, pct, predictLogistic, wilson, writeMarkdown } from './common.js';
import { loadPropRows } from './props-common.js';

const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-props-step3-buckets.md');
const COEF_PATH = path.join(CALIBRATION_DIR, 'props_residual_coef.json');
const BUCKETS = [
  [-0.15, -0.10, '[-15, -10)'], [-0.10, -0.07, '[-10, -7)'], [-0.07, -0.05, '[-7, -5)'],
  [-0.05, -0.03, '[-5, -3)'], [-0.03, 0, '[-3, 0)'], [0, 0.03, '[0, 3)'],
  [0.03, 0.05, '[3, 5)'], [0.05, 0.07, '[5, 7)'], [0.07, 0.10, '[7, 10)'],
  [0.10, 0.15, '[10, 15)'], [0.15, Infinity, '[15, +∞)'],
];

function bucket(edge) { return BUCKETS.find(([lo, hi]) => edge >= lo && edge < hi); }

async function main() {
  const { rows, stats } = await loadPropRows();
  const coefJson = JSON.parse(await readFile(COEF_PATH, 'utf8').catch(() => '{"coefs":{}}'));
  const out = [];
  for (const market of Object.keys(coefJson.coefs || {})) {
    const coef = coefJson.coefs[market];
    const beta = [coef.a, coef.b, coef.c];
    const scoped = rows.filter((row) => row.market === market).map((row) => ({
      ...row,
      p_final: predictLogistic(beta, [1, logit(row.market_p), logit(row.model_p) - logit(row.market_p)]),
    }));
    for (const year of ['2024', '2025']) {
      for (const b of BUCKETS) {
        const members = scoped.filter((row) => row.year === year && bucket(row.p_final - row.market_p) === b);
        const wins = members.reduce((sum, row) => sum + row.outcome, 0);
        const profit = members.reduce((sum, row) => sum + (row.outcome ? row.odds - 1 : -1), 0);
        const avgOdds = members.length ? members.reduce((sum, row) => sum + row.odds, 0) / members.length : NaN;
        const ci = wilson(wins, members.length);
        const breakeven = avgOdds > 1 ? 1 / avgOdds : NaN;
        const roi = members.length ? profit / members.length : NaN;
        out.push({ market, year, bucket: b[2], n: members.length, hit_rate: members.length ? wins / members.length : NaN, avg_odds: avgOdds, roi, wilson_low: ci.low, breakeven, actionable: members.length > 0 && year === '2025' && roi > 0.03 && ci.low > breakeven });
      }
    }
  }
  const actionable = out.filter((row) => row.actionable);
  const table = out.length ? markdownTable([
    { key: 'market', label: 'market / 盘口', align: 'left' },
    { key: 'year', label: 'year' },
    { key: 'bucket', label: 'bucket', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'hit_rate', label: 'hit', format: pct },
    { key: 'avg_odds', label: 'avg odds', format: fmt },
    { key: 'roi', label: 'ROI', format: pct },
    { key: 'wilson_low', label: 'Wilson low', format: pct },
    { key: 'breakeven', label: 'breakeven', format: pct },
    { key: 'actionable', label: 'actionable', format: (value) => value ? 'YES' : 'NO' },
  ], out) : 'No usable prop rows / 没有可用 prop 样本。';
  await writeMarkdown(REPORT_PATH, [
    '# Props Step 3 Buckets / Props 第三步 Edge 分桶',
    '',
    `- Prop rows / prop 行: ${stats.prop_rows}; final rows / 最终样本: ${stats.final_rows}.`,
    `- 2025 actionable buckets / 2025 可用桶: ${actionable.length ? actionable.map((r) => `${r.market} ${r.bucket}`).join(', ') : 'None / 无'}.`,
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
