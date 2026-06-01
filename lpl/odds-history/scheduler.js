import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { argValue } from './op-utils.js';

const DEFAULT_WATCHLIST = path.join('lpl', 'odds-history', 'watchlist.json');

async function runScrape(eventUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join('lpl', 'odds-history', 'scrape-op-snapshot.js'),
      `--event-url=${eventUrl}`,
    ], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code || 0));
  });
}

async function tick(watchlistPath) {
  const watchlist = JSON.parse(await readFile(watchlistPath, 'utf8'));
  const events = Array.isArray(watchlist) ? watchlist : watchlist.events || [];
  for (const item of events) {
    const url = typeof item === 'string' ? item : item.event_url;
    if (!url) continue;
    await runScrape(url);
  }
}

async function main() {
  const watchlistPath = argValue('watchlist', DEFAULT_WATCHLIST);
  const intervalMinutes = Number(argValue('interval-minutes', '30'));
  const once = process.argv.includes('--once');
  await tick(watchlistPath);
  if (once) return;
  setInterval(() => {
    tick(watchlistPath).catch((error) => console.error(`scheduler tick failed: ${error.message}`));
  }, Math.max(1, intervalMinutes) * 60 * 1000);
}

main().catch((error) => {
  console.error(`scheduler failed: ${error.message}`);
  process.exitCode = 1;
});
