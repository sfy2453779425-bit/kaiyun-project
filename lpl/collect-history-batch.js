import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { argValue } from './shared.js';

function slugify(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function runCollect(tournament, outDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      'lpl/collect-lpl.js',
      `--tournament=${tournament}`,
      `--output-dir=${outDir}`,
    ], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code));
  });
}

async function main() {
  const yearArg = argValue('year', '');
  const candidatesPath = path.join('lpl', 'data', 'history', 'tournament_candidates.json');
  const data = JSON.parse(await readFile(candidatesPath, 'utf8'));
  const targets = data.candidates.filter((c) => {
    if (!yearArg) return true;
    return String(c.year) === yearArg;
  });

  console.log(`将采集 ${targets.length} 个赛事 (year=${yearArg || 'all'})`);
  const skipped = [];
  const completed = [];
  const failed = [];

  for (let i = 0; i < targets.length; i += 1) {
    const c = targets[i];
    const slug = slugify(c.tournament);
    const outDir = path.join('lpl', 'data', 'history', slug);
    console.log(`\n[${i + 1}/${targets.length}] ${c.tournament} -> ${outDir}`);
    await mkdir(outDir, { recursive: true });
    const code = await runCollect(c.tournament, outDir);
    if (code === 0) completed.push({ tournament: c.tournament, slug });
    else failed.push({ tournament: c.tournament, slug, exitCode: code });
  }

  console.log('\n==== 批量采集汇总 ====');
  console.log(`成功: ${completed.length}, 失败: ${failed.length}`);
  for (const c of completed) console.log('  ✓', c.slug);
  for (const f of failed) console.log('  ✗', f.slug, 'exit', f.exitCode);
  if (skipped.length) console.log('跳过:', skipped.join(', '));
}

main().catch((error) => {
  console.error(`批量采集失败: ${error.message}`);
  process.exitCode = 1;
});
