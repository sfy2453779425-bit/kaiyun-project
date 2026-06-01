import path from 'node:path';
import { ANALYSIS_DIR } from './shared.js';
import { evaluateOddsFiles } from './odds-core.js';

evaluateOddsFiles()
  .then((rows) => {
    const candidates = rows.filter((row) => ['A', 'B'].includes(row.risk_grade) && Number(row.suggested_stake) > 0);
    console.log(`赔率评估完成。A/B候选 ${candidates.length} 条。`);
    console.log(path.join(ANALYSIS_DIR, '赔率评估结果.csv'));
  })
  .catch((error) => {
    console.error(`赔率评估失败: ${error.message}`);
    process.exitCode = 1;
  });
