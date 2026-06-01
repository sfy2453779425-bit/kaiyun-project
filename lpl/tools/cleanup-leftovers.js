import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const LPL_ROOT = path.join(ROOT, 'lpl');
const ARCHIVE_ROOT = path.join(LPL_ROOT, 'archive', 'cleanup-20260531');
const REPORT_PATH = path.join(LPL_ROOT, 'data', '盘口分析', 'cleanup-report.md');
const EXECUTE = process.argv.includes('--execute');

const deleteTargets = [
  'lpl/data/_refresh_regular',
  'lpl/data/_refresh_playoffs',
  'lpl/data/raw',
];

const archiveTargets = [
  'lpl/paper-trade-5-23.js',
  'lpl/paper-trade-5-29.js',
  'lpl/paper-trade-5-30.js',
  'lpl/data/baseline_comparison.md',
  'lpl/data/team_alias_audit.csv',
  'lpl/data/team_alias_audit_distinct.csv',
  'lpl/data/盘口分析/5-21-复盘.md',
  'lpl/data/盘口分析/ledger-review-2026-05-21.md',
  'lpl/data/盘口分析/外部模型校准-2026-05-16.md',
  'lpl/data/盘口分析/codex-任务-连续总杀模型.md',
  'lpl/data/盘口分析/codex任务-连续总杀模型.md',
  'lpl/data/盘口分析/polymarket_odds.csv',
  'lpl/data/盘口分析/paper-trades.csv',
];

function assertInsideWorkspace(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing path outside workspace: ${absPath}`);
  }
}

function abs(relPath) {
  const resolved = path.resolve(ROOT, relPath);
  assertInsideWorkspace(resolved);
  return resolved;
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(filePath) {
  if (!(await exists(filePath))) return { bytes: 0, files: 0 };
  const s = await stat(filePath);
  if (s.isFile()) return { bytes: s.size, files: 1 };
  if (!s.isDirectory()) return { bytes: 0, files: 0 };

  let bytes = 0;
  let files = 0;
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(filePath, { withFileTypes: true }));
  for (const entry of entries) {
    const child = path.join(filePath, entry.name);
    const childSize = await sizeOf(child);
    bytes += childSize.bytes;
    files += childSize.files;
  }
  return { bytes, files };
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function archiveDestination(sourceAbs) {
  const rel = path.relative(LPL_ROOT, sourceAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`archive source outside lpl root: ${sourceAbs}`);
  }
  return path.join(ARCHIVE_ROOT, rel);
}

async function moveToArchive(sourceAbs) {
  const dest = archiveDestination(sourceAbs);
  assertInsideWorkspace(dest);
  await mkdir(path.dirname(dest), { recursive: true });
  if (await exists(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  await rename(sourceAbs, dest);
  return dest;
}

async function main() {
  const operations = [];
  let deletedBytes = 0;
  let archivedBytes = 0;

  for (const target of deleteTargets) {
    const sourceAbs = abs(target);
    const found = await exists(sourceAbs);
    const size = await sizeOf(sourceAbs);
    operations.push({
      action: 'delete',
      target,
      found,
      files: size.files,
      bytes: size.bytes,
      mb: mb(size.bytes),
      destination: '',
    });
  }

  for (const target of archiveTargets) {
    const sourceAbs = abs(target);
    const found = await exists(sourceAbs);
    const size = await sizeOf(sourceAbs);
    operations.push({
      action: 'archive',
      target,
      found,
      files: size.files,
      bytes: size.bytes,
      mb: mb(size.bytes),
      destination: found ? path.relative(ROOT, archiveDestination(sourceAbs)).replaceAll(path.sep, '/') : '',
    });
  }

  if (EXECUTE) {
    await mkdir(ARCHIVE_ROOT, { recursive: true });
    for (const op of operations) {
      if (!op.found) continue;
      const sourceAbs = abs(op.target);
      if (op.action === 'delete') {
        await rm(sourceAbs, { recursive: true, force: true });
        deletedBytes += op.bytes;
      } else if (op.action === 'archive') {
        await moveToArchive(sourceAbs);
        archivedBytes += op.bytes;
      }
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    archive_root: path.relative(ROOT, ARCHIVE_ROOT).replaceAll(path.sep, '/'),
    deleted_mb: mb(deletedBytes),
    archived_mb: mb(archivedBytes),
    operations,
  };

  const report = [
    '# LPL Cleanup Report / 清理报告',
    '',
    `Generated at: ${manifest.generated_at}`,
    `Mode: ${manifest.mode}`,
    `Archive root: ${manifest.archive_root}`,
    '',
    `Deleted: ${manifest.deleted_mb} MB`,
    `Archived: ${manifest.archived_mb} MB`,
    '',
    '| Action | Found | Files | MB | Target | Destination |',
    '|---|---:|---:|---:|---|---|',
    ...operations.map((op) => `| ${op.action} | ${op.found ? 'yes' : 'no'} | ${op.files} | ${op.mb} | ${op.target} | ${op.destination || ''} |`),
    '',
    '## Policy / 策略',
    '',
    '- Deleted only temporary fetch/cache directories.',
    '- Archived one-off scripts and old analysis notes instead of deleting them.',
    '- Kept historical CSVs, model coefficients, backtest outputs, odds database, and active scripts.',
    '',
  ].join('\n');

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${report}\n`, 'utf8');
  if (EXECUTE) {
    await writeFile(path.join(ARCHIVE_ROOT, 'cleanup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  console.log(`${EXECUTE ? 'cleanup executed' : 'cleanup dry-run'}: ${REPORT_PATH}`);
  console.log(`delete candidates: ${mb(operations.filter((op) => op.action === 'delete').reduce((sum, op) => sum + op.bytes, 0))} MB`);
  console.log(`archive candidates: ${mb(operations.filter((op) => op.action === 'archive').reduce((sum, op) => sum + op.bytes, 0))} MB`);
}

main().catch((error) => {
  console.error(`cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
