import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_DIR, DATA_DIR, readCsvIfExists } from '../shared.js';
import { EXPECTED_LPL_MODEL_MODE, LPL_MODEL_MODE, modelRunMeta } from '../model-config.js';

const ROOT = process.cwd();
const LPL_DIR = path.join(ROOT, 'lpl');
const REPORT_PATH = path.join(ANALYSIS_DIR, 'project-health.md');
const DRIFT_BIAS_WARN_KILLS = 1.0;
const DRIFT_ECE_WARN = 0.10;

const REQUIRED_FILES = [
  ['current matches', path.join(DATA_DIR, 'lpl_matches.csv')],
  ['current maps', path.join(DATA_DIR, 'lpl_map_details.csv')],
  ['current team summary', path.join(DATA_DIR, 'lpl_team_detail_summary.csv')],
  ['history matches', path.join(DATA_DIR, 'history', 'all_matches.csv')],
  ['history maps', path.join(DATA_DIR, 'history', 'all_map_details.csv')],
  ['odds core', path.join(LPL_DIR, 'odds-core.js')],
  ['market builder', path.join(LPL_DIR, 'build-market-analysis.js')],
  ['division config', path.join(LPL_DIR, 'config', 'division-rating.json')],
];

const GENERATED_FILES = [
  ['team profiles', path.join(ANALYSIS_DIR, '队伍盘口命中率.csv')],
  ['team insights', path.join(ANALYSIS_DIR, '队伍模型洞察.json')],
  ['division detection', path.join(ANALYSIS_DIR, '队伍分组识别.json')],
  ['rates', path.join(ANALYSIS_DIR, '待赛对阵盘口概率.csv')],
  ['odds evaluation', path.join(ANALYSIS_DIR, '赔率评估结果.csv')],
  ['strict candidates', path.join(ANALYSIS_DIR, '严格筛选结果.csv')],
  ['total kills 2026 drift report', path.join(ANALYSIS_DIR, '总杀模型-2026漂移体检.md')],
  ['total kills model coef', path.join(LPL_DIR, 'calibration', 'total_kills_model_coef.json')],
  ['team kills NB coef', path.join(LPL_DIR, 'calibration', 'team_kills_nb_coef.json')],
];

function rel(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, '/');
}

function statusLine(ok, label, detail = '') {
  return {
    ok,
    label,
    detail,
  };
}

async function fileSize(filePath) {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return -1;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function listJsFiles(dir) {
  const out = [];
  async function walk(cur) {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      const relative = rel(full);
      if (entry.isDirectory()) {
        if (relative.startsWith('lpl/data/')) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => rel(a).localeCompare(rel(b)));
}

async function countNullBytes(filePath) {
  const buf = await readFile(filePath);
  let count = 0;
  for (const byte of buf) if (byte === 0) count += 1;
  return count;
}

function runNodeCheck(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function runTotalKillsDriftCheck() {
  const scriptPath = path.join(LPL_DIR, 'calibration', 'total-kills-2026-drift.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const match = output.match(/qual2026=(\d+)\s+meanActual=([-+0-9.]+)\s+meanPred=([-+0-9.]+)\s+resid=([-+0-9.]+)\s+ECE=([-+0-9.]+)%/);
  const parsed = match ? {
    qual2026: Number(match[1]),
    meanActual: Number(match[2]),
    meanPred: Number(match[3]),
    resid: Number(match[4]),
    ece: Number(match[5]) / 100,
  } : null;
  return {
    ok: result.status === 0,
    output,
    parsed,
  };
}

async function main() {
  await mkdir(ANALYSIS_DIR, { recursive: true });

  const checks = [];
  const warnings = [];

  for (const [label, filePath] of REQUIRED_FILES) {
    const size = await fileSize(filePath);
    checks.push(statusLine(size > 0, label, size > 0 ? `${rel(filePath)} (${size} bytes)` : `${rel(filePath)} missing/empty`));
  }

  for (const [label, filePath] of GENERATED_FILES) {
    const size = await fileSize(filePath);
    warnings.push(statusLine(size > 0, label, size > 0 ? `${rel(filePath)} (${size} bytes)` : `${rel(filePath)} missing/empty`));
  }

  const sharedPath = path.join(LPL_DIR, 'shared.js');
  const nullCount = await countNullBytes(sharedPath);
  checks.push(statusLine(nullCount === 0, 'shared.js text-safe', `NUL bytes: ${nullCount}`));

  const jsFiles = await listJsFiles(LPL_DIR);
  const syntaxFailures = [];
  for (const filePath of jsFiles) {
    const result = runNodeCheck(filePath);
    if (!result.ok) syntaxFailures.push({ filePath, output: result.output });
  }
  checks.push(statusLine(syntaxFailures.length === 0, 'JS syntax', `${jsFiles.length} files checked, ${syntaxFailures.length} failures`));

  const [matches, maps, players, historyMatches, historyMaps] = await Promise.all([
    readCsvIfExists(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'lpl_player_map_details.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'history', 'all_matches.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'history', 'all_map_details.csv')),
  ]);

  const upcoming = matches.filter((row) => row.status !== '已结束');
  const latestMatchDate = matches
    .map((row) => row.match_date)
    .filter(Boolean)
    .sort((a, b) => String(b).localeCompare(String(a)))[0] || '';

  const divisionConfig = await readJsonIfExists(path.join(LPL_DIR, 'config', 'division-rating.json'));
  const divisionOutput = await readJsonIfExists(path.join(ANALYSIS_DIR, '队伍分组识别.json'));
  const totalKillsCoef = await readJsonIfExists(path.join(LPL_DIR, 'calibration', 'total_kills_model_coef.json'));
  const oddsDb = path.join(DATA_DIR, 'odds_history', 'odds.db');
  const driftCheck = runTotalKillsDriftCheck();
  const modelMeta = modelRunMeta();

  warnings.push(statusLine(
    LPL_MODEL_MODE === EXPECTED_LPL_MODEL_MODE,
    'LPL_MODEL_MODE default',
    `current=${LPL_MODEL_MODE}; expected default=${EXPECTED_LPL_MODEL_MODE}`,
  ));
  if (!divisionConfig?.manual_groups) warnings.push(statusLine(false, 'division manual groups', 'manual_groups missing'));
  if (!divisionOutput?.groups?.length) warnings.push(statusLine(false, 'division output', '队伍分组识别.json missing groups'));
  if (!totalKillsCoef?.deploy) warnings.push(statusLine(false, 'total kills model deploy', 'deploy flag is not true'));
  warnings.push(statusLine(existsSync(oddsDb), 'odds.db', existsSync(oddsDb) ? rel(oddsDb) : 'missing'));
  warnings.push(statusLine(
    driftCheck.ok,
    'total kills 2026 drift script',
    driftCheck.ok ? (driftCheck.output || 'ok') : (driftCheck.output || 'script failed'),
  ));
  if (driftCheck.ok && driftCheck.parsed) {
    warnings.push(statusLine(
      Math.abs(driftCheck.parsed.resid) <= DRIFT_BIAS_WARN_KILLS,
      'total kills 2026 bias',
      `resid=${driftCheck.parsed.resid.toFixed(2)} kills; warn if |resid| > ${DRIFT_BIAS_WARN_KILLS.toFixed(2)}`,
    ));
    warnings.push(statusLine(
      driftCheck.parsed.ece <= DRIFT_ECE_WARN,
      'total kills 2026 ECE',
      `ECE=${(driftCheck.parsed.ece * 100).toFixed(1)}%; warn if > ${(DRIFT_ECE_WARN * 100).toFixed(1)}%`,
    ));
  } else if (driftCheck.ok) {
    warnings.push(statusLine(false, 'total kills 2026 drift parse', driftCheck.output || 'no parseable stdout'));
  }

  const failed = checks.filter((item) => !item.ok);
  const warn = warnings.filter((item) => !item.ok);

  const lines = [];
  lines.push('# LPL Project Health / 项目健康检查');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary / 摘要');
  lines.push('');
  lines.push(`- Required checks: ${checks.length - failed.length}/${checks.length} passed`);
  lines.push(`- Warnings: ${warn.length}`);
  lines.push(`- Current matches: ${matches.length}`);
  lines.push(`- Current maps: ${maps.length}`);
  lines.push(`- Player map rows: ${players.length}`);
  lines.push(`- History matches: ${historyMatches.length}`);
  lines.push(`- History maps: ${historyMaps.length}`);
  lines.push(`- Upcoming matches: ${upcoming.length}`);
  lines.push(`- Latest current match date: ${latestMatchDate || '-'}`);
  lines.push(`- Model mode: ${modelMeta.model_mode}`);
  lines.push(`- Model signature: ${modelMeta.model_signature}`);
  if (driftCheck.parsed) {
    lines.push(`- Total kills 2026 drift: resid=${driftCheck.parsed.resid.toFixed(2)} kills, ECE=${(driftCheck.parsed.ece * 100).toFixed(1)}%, n=${driftCheck.parsed.qual2026}`);
  }
  lines.push('');
  lines.push('## Required Checks / 必须通过');
  lines.push('');
  lines.push('| Status | Check | Detail |');
  lines.push('|---|---|---|');
  for (const check of checks) lines.push(`| ${check.ok ? 'PASS' : 'FAIL'} | ${check.label} | ${check.detail.replaceAll('|', '/')} |`);
  lines.push('');
  lines.push('## Warnings / 警告');
  lines.push('');
  lines.push('| Status | Check | Detail |');
  lines.push('|---|---|---|');
  for (const item of warnings) lines.push(`| ${item.ok ? 'OK' : 'WARN'} | ${item.label} | ${item.detail.replaceAll('|', '/')} |`);

  if (syntaxFailures.length) {
    lines.push('');
    lines.push('## JS Syntax Failures / JS 语法失败');
    lines.push('');
    for (const failure of syntaxFailures) {
      lines.push(`### ${rel(failure.filePath)}`);
      lines.push('');
      lines.push('```text');
      lines.push(failure.output || '(no output)');
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('');
  lines.push('## Notes / 备注');
  lines.push('');
  lines.push('- This health check does not change model behavior.');
  lines.push('- LPL model mode is a stamp only: default production behavior is unchanged unless future code explicitly adds a branch.');
  lines.push('- It refreshes the 2026 total-kills drift report and warns if absolute bias exceeds 1 kill or ECE exceeds 10%.');
  lines.push('- Dashboard division scores are display-layer only; betting permission still comes from `lpl/odds-core.js`.');
  lines.push('- If this report fails, fix required checks before trusting newly generated picks.');
  lines.push('');

  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`health report: ${REPORT_PATH}`);
  console.log(`required: ${checks.length - failed.length}/${checks.length} passed; warnings: ${warn.length}`);

  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`health check failed: ${error.message}`);
  process.exitCode = 1;
});
