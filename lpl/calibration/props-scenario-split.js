import path from 'node:path';
import { ANALYSIS_DIR, markdownTable, writeMarkdown } from './common.js';
import { loadPropRows } from './props-common.js';

const REPORT_PATH = path.join(ANALYSIS_DIR, '校准层-props-step4-scenario.md');

async function main() {
  const { rows, stats } = await loadPropRows();
  const groups = new Map();
  for (const row of rows) {
    const key = [row.market, row.line || ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const summary = [...groups.entries()].map(([key, members]) => {
    const [market, line] = key.split('|');
    return {
      market,
      line: line || '',
      n: members.length,
      n_2024: members.filter((row) => row.year === '2024').length,
      n_2025: members.filter((row) => row.year === '2025').length,
      warning: members.length < 100 ? '样本不足,仅供观察' : 'OK',
    };
  }).sort((a, b) => a.market.localeCompare(b.market) || String(a.line).localeCompare(String(b.line)));
  const table = summary.length ? markdownTable([
    { key: 'market', label: 'market / 盘口', align: 'left' },
    { key: 'line', label: 'line', align: 'left' },
    { key: 'n', label: 'n' },
    { key: 'n_2024', label: '2024 n' },
    { key: 'n_2025', label: '2025 n' },
    { key: 'warning', label: 'warning / 警告', align: 'left' },
  ], summary) : 'No usable prop rows / 没有可用 prop 样本。';
  await writeMarkdown(REPORT_PATH, [
    '# Props Step 4 Scenario / Props 第四步 Line 切分',
    '',
    `- Prop rows / prop 行: ${stats.prop_rows}; final rows / 最终样本: ${stats.final_rows}.`,
    '- Split by market + line / 按 market + line 切分。',
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
