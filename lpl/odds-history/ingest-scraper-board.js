// Read D:/lol_scraper odds JSON and build a normalized LPL best-odds board.
// PANDA and IMDJ are treated as separate books; the same bet always keeps the higher odds.
import { ANALYSIS_DIR, DATA_DIR, argValue, writeCsv } from '../shared.js';
import {
  BOARD_COLUMNS,
  readScraperBoard,
} from './scraper-board-core.js';
import path from 'node:path';

const BOARD_OUT = path.join(DATA_DIR, 'odds_history', 'scraper_board.csv');
const ANALYSIS_OUT = path.join(ANALYSIS_DIR, '小站盘口比价板.csv');

async function main() {
  const { file, rawRows, rows } = readScraperBoard({
    file: argValue('file', ''),
    dir: argValue('dir', 'D:/lol_scraper/data'),
  });

  await writeCsv(BOARD_OUT, rows, BOARD_COLUMNS);
  await writeCsv(ANALYSIS_OUT, rows, BOARD_COLUMNS);

  const shopRows = rows.filter((row) => row.shopping_edge);
  console.log(`读取盘口板: ${file}`);
  console.log(`解析出 ${rawRows.length} 条 LPL 原始盘口行`);
  console.log(`写入 ${BOARD_OUT}: ${rows.length} 个统一盘口`);
  console.log(`同步 ${ANALYSIS_OUT}`);
  console.log(`两平台同盘口可比价: ${shopRows.length} 个`);

  if (shopRows.length) {
    console.log('\n=== best-odds 比价机会 ===');
    for (const row of shopRows.slice(0, 20)) {
      console.log(`${row.match_name} | ${row.market} ${row.selection} ${row.line} | PANDA ${row.panda_odds || '-'} vs IMDJ ${row.imdj_odds || '-'} -> ${row.best_platform} ${row.best_odds}`);
    }
  }
}

main().catch((error) => {
  console.error(`ingest scraper board failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
