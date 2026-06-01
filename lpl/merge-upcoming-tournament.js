// 把另一个赛事的待赛(未开始)对阵 append 到当前 lpl/data/lpl_matches.csv。
// Phase 3 测试场景: LPL 2026 Split 2 (已完成,提供历史) + LPL 2026 Split 2 Playoffs (待赛,触发预测)。
import path from 'node:path';
import {
  DATA_DIR,
  absoluteGolUrl,
  argValue,
  cleanText,
  fetchText,
  golUrl,
  htmlCells,
  parseHtmlTables,
  readCsv,
  teamKey,
  writeCsv,
} from './shared.js';

const TOURNAMENT = argValue('tournament', '');
if (!TOURNAMENT) {
  console.error('错误: 必须传入 --tournament="赛事完整名称"');
  process.exit(2);
}

function tableByCaption(html, captionPart) {
  return parseHtmlTables(html).find((table) => table.caption.includes(captionPart));
}

function parseMatchList(html) {
  const table = tableByCaption(html, 'results');
  if (!table) throw new Error('无法解析 GOL 赛程表');
  const rows = [];
  for (const rowMatch of table.html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/<th\b/i.test(rowMatch[1])) continue;
    const cells = htmlCells(rowMatch[1]);
    if (cells.length < 7) continue;
    const href = (cells[0].html.match(/href=['"]([^'"]+)['"]/i) || [])[1] || '';
    const gameId = (href.match(/stats\/(\d+)\//) || [])[1] || '';
    const scoreText = cells[2].text.replace(/\s+/g, ' ').trim();
    const score = scoreText.match(/(\d+)\s*-\s*(\d+)/);
    const teamA = cells[1].text;
    const teamB = cells[3].text;
    const scoreA = score ? Number(score[1]) : '';
    const scoreB = score ? Number(score[2]) : '';
    const winner = score ? (scoreA > scoreB ? teamA : teamB) : '';
    const matchName = cells[0].text || `${teamA} vs ${teamB}`;
    rows.push({
      match_id: gameId,
      game_id: gameId,
      tournament: TOURNAMENT,
      match_name: matchName,
      match_date: cells[6].text,
      status: score ? '已结束' : '未开始',
      stage: cells[4].text,
      patch: cells[5].text,
      team_a_id: teamKey(teamA),
      team_a: teamA,
      score_a: scoreA,
      team_b_id: teamKey(teamB),
      team_b: teamB,
      score_b: scoreB,
      winner_id: winner ? teamKey(winner) : '',
      winner,
      source_url: href ? absoluteGolUrl(href) : '',
    });
  }
  return rows;
}

async function main() {
  console.log(`合并待赛: ${TOURNAMENT}`);
  const url = golUrl('matchlist', TOURNAMENT);
  const html = await fetchText(url);
  const upcoming = parseMatchList(html).filter((row) => row.status !== '已结束');
  console.log(`  待赛 ${upcoming.length} 场`);

  const matchesPath = path.join(DATA_DIR, 'lpl_matches.csv');
  const existing = await readCsv(matchesPath);
  const existingIds = new Set(existing.map((row) => row.match_id));
  const fresh = upcoming.filter((row) => !existingIds.has(row.match_id));
  console.log(`  其中新增 ${fresh.length} 场(去重后)`);

  const merged = [...existing, ...fresh];
  await writeCsv(matchesPath, merged, [
    'match_id', 'game_id', 'tournament', 'match_name', 'match_date', 'status',
    'stage', 'patch', 'team_a_id', 'team_a', 'score_a', 'team_b_id', 'team_b',
    'score_b', 'winner_id', 'winner', 'source_url',
  ]);
  console.log(`  合并后总场数: ${merged.length} -> ${matchesPath}`);
  for (const row of fresh) console.log(`    新增: ${row.match_date} ${row.match_name}`);
}

main().catch((error) => {
  console.error(`合并失败: ${error.message}`);
  process.exitCode = 1;
});
