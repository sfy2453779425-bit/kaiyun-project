import path from 'node:path';
import { ANALYSIS_DIR, readCsv, writeCsv } from './shared.js';

async function main() {
  const rows = await readCsv(path.join(ANALYSIS_DIR, '赔率评估结果.csv'));
  const strictRows = rows.map((row) => {
    const pass = ['A', 'B'].includes(row.risk_grade) && Number(row.suggested_stake) > 0 && !row.conflict;
    return {
      ...row,
      strict_result: pass ? '通过' : '跳过',
      strict_reason: pass ? '' : row.reason || '未达到A/B档',
    };
  });
  const candidates = strictRows.filter((row) => row.strict_result === '通过');

  await writeCsv(path.join(ANALYSIS_DIR, '严格筛选结果.csv'), strictRows, [
    'model_mode', 'model_signature', 'total_kills_model', 'total_kills_deploy',
    'match_name', 'scenario', 'market', 'selection', 'line', 'odds',
    'break_even_text', 'probability_text', 'edge', 'ev', 'risk_grade',
    'strict_result', 'strict_reason', 'suggested_stake', 'bankroll', 'basis',
    'scenario_alignment',
    'total_kills_model_mean', 'total_kills_model_sigma', 'line_edge_kills',
    'conflict', 'note',
  ]);
  await writeCsv(path.join(ANALYSIS_DIR, '可下注候选.csv'), candidates, [
    'model_mode', 'model_signature', 'total_kills_model', 'total_kills_deploy',
    'match_name', 'scenario', 'market', 'selection', 'line', 'odds',
    'break_even_text', 'probability_text', 'edge', 'ev', 'risk_grade',
    'suggested_stake', 'bankroll', 'basis', 'scenario_alignment',
    'total_kills_model_mean', 'total_kills_model_sigma', 'line_edge_kills',
    'note',
  ]);

  console.log(`严格筛选完成。候选 ${candidates.length} 条。`);
  console.log(path.join(ANALYSIS_DIR, '可下注候选.csv'));
}

main().catch((error) => {
  console.error(`严格筛选失败: ${error.message}`);
  process.exitCode = 1;
});
