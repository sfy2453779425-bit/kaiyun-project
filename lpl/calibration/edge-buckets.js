import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  ANALYSIS_DIR,
  CALIBRATION_DIR,
  addPredictions,
  fmt,
  loadCalibrationRows,
  markdownTable,
  pct,
  wilson,
  writeMarkdown,
} from './common.js';

const COEF_PATH = path.join(CALIBRATION_DIR, 'residual_coef.json');
const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-step3-buckets.md');

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

async function residualCoef() {
  const json = JSON.parse(await readFile(COEF_PATH, 'utf8'));
  return [json.a, json.b, json.c];
}

function bucketFor(edge) {
  return BUCKETS.find((bucket) => edge >= bucket.low && edge < bucket.high) || null;
}

export function edgeBucketRows(rows) {
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
      const hitRate = members.length ? wins / members.length : NaN;
      const roi = members.length ? profit / members.length : NaN;
      const ci = wilson(wins, members.length);
      const breakeven = Number.isFinite(avgOdds) && avgOdds > 1 ? 1 / avgOdds : NaN;
      out.push({
        year,
        bucket: bucket.label,
        n_samples: members.length,
        hit_rate: hitRate,
        avg_odds: avgOdds,
        roi,
        profit,
        wilson_low: ci.low,
        wilson_high: ci.high,
        breakeven,
        clears_breakeven: Number.isFinite(ci.low) && Number.isFinite(breakeven) && ci.low > breakeven,
        actionable_3pct: Number.isFinite(roi) && roi > 0.03 && Number.isFinite(ci.low) && Number.isFinite(breakeven) && ci.low > breakeven,
      });
    }
  }
  return out;
}

async function main() {
  const coef = await residualCoef();
  const { rows, stats } = await loadCalibrationRows();
  const predicted = addPredictions(rows, { residualCoef: coef }).map((row) => ({
    ...row,
    edge_home: row.p_final - row.market_p_home,
  }));
  const bucketRows = edgeBucketRows(predicted);
  const outOfRange = predicted.filter((row) => row.edge_home < -0.15).length;
  const positive2025 = bucketRows.filter((row) => row.year === '2025' && row.n_samples > 0 && row.roi > 0 && row.clears_breakeven);
  const actionable2025 = bucketRows.filter((row) => row.year === '2025' && row.n_samples > 0 && row.actionable_3pct);

  const table = markdownTable([
    { key: 'year', label: 'year / 年份', align: 'left' },
    { key: 'bucket', label: 'edge bucket / edge桶', align: 'left' },
    { key: 'n_samples', label: 'n' },
    { key: 'hit_rate', label: 'hit rate', format: pct },
    { key: 'avg_odds', label: 'avg odds', format: fmt },
    { key: 'roi', label: 'ROI', format: pct },
    { key: 'wilson_low', label: 'Wilson low', format: pct },
    { key: 'wilson_high', label: 'Wilson high', format: pct },
    { key: 'breakeven', label: 'breakeven', format: pct },
    { key: 'actionable_3pct', label: 'actionable?', format: (value) => value ? 'YES' : 'NO' },
  ], bucketRows);

  const positiveTable = positive2025.length ? markdownTable([
    { key: 'bucket', label: 'bucket / 桶', align: 'left' },
    { key: 'n_samples', label: 'n' },
    { key: 'roi', label: 'ROI', format: pct },
    { key: 'wilson_low', label: 'Wilson low', format: pct },
    { key: 'breakeven', label: 'breakeven', format: pct },
  ], positive2025) : 'None / 无';

  const actionableTable = actionable2025.length ? markdownTable([
    { key: 'bucket', label: 'bucket / 桶', align: 'left' },
    { key: 'n_samples', label: 'n' },
    { key: 'roi', label: 'ROI', format: pct },
    { key: 'wilson_low', label: 'Wilson low', format: pct },
    { key: 'breakeven', label: 'breakeven', format: pct },
  ], actionable2025) : 'None / 无';

  await writeMarkdown(REPORT_PATH, [
    '# Step 3 Edge Bucketing / 第三步 Edge 分桶',
    '',
    `- Dataset / 数据集: ${stats.final_rows} matched rows.`,
    '- Edge definition / Edge 定义: `edge = p_final - market_p_home`.',
    '- Betting rule / 下注规则: positive edge bets home; negative edge bets away.',
    '- Actionable rule / 可下注规则: 2025 ROI > +3% and Wilson low > breakeven.',
    `- Out of requested negative bucket range (< -15pp) / 低于 -15pp 未入指定桶: ${outOfRange}.`,
    '',
    '## 2025 Buckets With ROI > 0 And Wilson Low > Breakeven / 2025 正 ROI 且 Wilson 下限高于盈亏平衡',
    '',
    positiveTable,
    '',
    '## 2025 Actionable Buckets / 2025 可小流量验证桶',
    '',
    actionableTable,
    '',
    '## All Buckets / 全部分桶',
    '',
    table,
    '',
    '## Notes / 备注',
    '',
    '- If a bucket is not listed as actionable, it must be ignored for match-win betting / 未列为可下注的桶必须忽略。',
    `- Matching stats / 匹配统计: OP=${stats.oddsportal_rows}, matched=${stats.matched}, unmatched=${stats.unmatched}, low_sample=${stats.low_sample}, final=${stats.final_rows}.`,
    '',
  ]);

  console.log(`wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
