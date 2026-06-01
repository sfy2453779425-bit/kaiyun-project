import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  ANALYSIS_DIR,
  clamp,
  decimal,
  num,
  pctText,
  readCsv,
  safeFileName,
  toCsv,
  writeCsv,
} from './shared.js';

export const BANKROLL = 100;
export const FIXED_STAKE_UNIT = 3;
export const HIGH_CONFIDENCE_STAKE = 4;
export const B_GRADE_STAKE = 2;
export const MAX_SINGLE_STAKE = 4;
export const PER_MATCH_STAKE_CAP = 8;
export const DAILY_STAKE_CAP = 12;
const MARKET_FEATURE_COEF_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'market_feature_coef.json');
const WIN_MARKETS = new Set(['match_win', 'game1_win']);
const GAME_TIME_BAN_UNTIL = '2026-06-22';
const OOS_NEGATIVE_SKILL_MARKETS = new Map([
  ['map_total', '-0.1267'],
  ['team_kills_handicap', '-0.0873'],
  ['map_handicap', '-0.0290'],
]);
const TOTAL_KILLS_MIN_LINE_EDGE = 3.0;

function marketWinAlphaEnabled() {
  try {
    if (!existsSync(MARKET_FEATURE_COEF_PATH)) return false;
    const coef = JSON.parse(readFileSync(MARKET_FEATURE_COEF_PATH, 'utf8'));
    return coef?.oos_2025?.beats_market === true;
  } catch {
    return false;
  }
}

const WIN_MARKET_ALPHA_ENABLED = marketWinAlphaEnabled();

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export const MARKET_META = {
  match_win: { label: '胜负盘', volatility: 'medium', weight: 0.8 },
  map_handicap: { label: '地图让分', volatility: 'medium', weight: 0.8 },
  map_total: { label: '地图总数', volatility: 'medium', weight: 0.8 },
  game1_win: { label: '第一局胜负', volatility: 'medium', weight: 0.7 },
  team_kills_handicap: { label: '击杀让分', volatility: 'low', weight: 1 },
  total_kills: { label: '总击杀大小', volatility: 'low', weight: 1 },
  game_time: { label: '比赛时间大小', volatility: 'low', weight: 1 },
  first_blood: { label: '第一滴血', volatility: 'high', weight: 0.35 },
  first_turret: { label: '首塔', volatility: 'high', weight: 0.45 },
  hero_group: { label: '英雄使用盘口', volatility: 'high', weight: 0.4 },
};

export function impliedProbability(odds) {
  const n = Number(odds);
  return n > 0 ? 1 / n : '';
}

export function ev(probability, odds) {
  const n = Number(odds);
  return probability !== '' && n > 0 ? probability * n - 1 : '';
}

export function marketName(row) {
  const line = row.line === '' || row.line == null ? '' : ` ${row.line}`;
  const selection = row.selection ? ` ${row.selection}` : '';
  return `${MARKET_META[row.market]?.label || row.market}${selection}${line}`.trim();
}

function rowKey(row) {
  return [
    row.match_id || '',
    row.match_name || '',
    row.market || '',
    row.selection || '',
    row.line || '',
    row.side || '',
  ].join('|');
}

export function evaluateTemplate(templateRows, rateRows) {
  const rateMap = new Map(rateRows.map((row) => [rowKey(row), row]));
  const fallbackRateMap = new Map(rateRows.map((row) => [
    [row.match_name || '', row.market || '', row.selection || '', row.line || '', row.side || ''].join('|'),
    row,
  ]));

  const rows = templateRows.map((row) => {
    const rate = rateMap.get(rowKey(row))
      || fallbackRateMap.get([row.match_name || '', row.market || '', row.selection || '', row.line || '', row.side || ''].join('|'))
      || {};
    const probability = rate.probability !== '' && rate.probability != null ? Number(rate.probability) : '';
    const odds = Number(row.odds);
    const breakEven = impliedProbability(row.odds);
    const evValue = ev(probability, odds);
    const edge = probability !== '' && breakEven !== '' ? probability - breakEven : '';
    const sample = Number(rate.sample || row.sample || 0);
    const preliminary = preliminaryGrade({ ...row, ...rate, probability, edge, ev: evValue, sample });

    return {
      ...rate,
      ...row,
      market_label: MARKET_META[row.market]?.label || row.market,
      probability: probability === '' ? '' : decimal(probability),
      probability_text: probability === '' ? '' : pctText(probability),
      break_even: breakEven === '' ? '' : decimal(breakEven),
      break_even_text: breakEven === '' ? '' : pctText(breakEven),
      edge: edge === '' ? '' : decimal(edge),
      ev: evValue === '' ? '' : decimal(evValue),
      sample: sample || rate.sample || '',
      preliminary_grade: preliminary.grade,
      preliminary_reason: preliminary.reason,
      conflict: '',
      risk_grade: preliminary.grade,
      reason: preliminary.reason,
      suggested_stake: 0,
      bankroll: BANKROLL,
    };
  });

  applyConflicts(rows);
  applyFinalGrades(rows);
  applyStakeCaps(rows);
  return rows;
}

function preliminaryGrade(row) {
  const odds = Number(row.odds);
  const probability = row.probability === '' ? null : Number(row.probability);
  const edge = row.edge === '' ? null : Number(row.edge);
  const evValue = row.ev === '' ? null : Number(row.ev);
  const sample = Number(row.sample || 0);
  const meta = MARKET_META[row.market] || { volatility: 'medium' };

  if (!odds) return { grade: 'C', reason: '未填写赔率，先观察' };
  if (probability == null || Number.isNaN(probability)) return { grade: 'D', reason: '缺少模型概率' };
  if (evValue == null || evValue <= 0) return { grade: 'D', reason: 'EV不为正' };
  if (sample > 0 && sample < 8) return { grade: 'C', reason: '样本太小，只观察' };
  if (meta.volatility === 'high' && evValue < 0.18) return { grade: 'C', reason: '高波动盘口，EV不够厚' };
  if (edge != null && edge >= 0.08 && evValue >= 0.12 && sample >= 16 && row.scenario_alignment !== '冲突') {
    return { grade: 'A', reason: 'EV明显为正，样本和剧本支持' };
  }
  if (edge != null && edge >= 0.03 && evValue > 0 && row.scenario_alignment !== '冲突') {
    return { grade: 'B', reason: 'EV为正，但优势不厚或样本一般' };
  }
  return { grade: 'C', reason: '有正EV但边际不足' };
}

function applyConflicts(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.match_name)) grouped.set(row.match_name, []);
    grouped.get(row.match_name).push(row);
  }

  for (const group of grouped.values()) {
    const positives = group.filter((row) => Number(row.ev) > 0);
    for (const row of positives) {
      const conflicts = [];
      for (const other of positives) {
        if (other === row) continue;
        if (isDirectConflict(row, other)) conflicts.push(marketName(other));
        if (isSoftTimeKillConflict(row, other)) conflicts.push(`需确认剧本: ${marketName(other)}`);
      }
      row.conflict = [...new Set(conflicts)].join('；');
    }
  }
}

function isDirectConflict(a, b) {
  if (a.market === 'map_handicap' && b.market === 'map_total') {
    return Number(a.line) === -1.5 && b.selection === 'over' && Number(b.line) === 2.5;
  }
  if (a.market === 'map_total' && b.market === 'map_handicap') return isDirectConflict(b, a);
  if (a.market === b.market && ['map_total', 'total_kills', 'game_time'].includes(a.market)) {
    return a.line === b.line && a.selection !== b.selection;
  }
  if (a.market === 'team_kills_handicap' && b.market === 'team_kills_handicap') {
    return a.line === b.line && a.selection !== b.selection;
  }
  return false;
}

function isSoftTimeKillConflict(a, b) {
  const pair = [a, b];
  const hasTimeOver = pair.some((row) => row.market === 'game_time' && row.selection === 'over');
  const hasKillsUnder = pair.some((row) => row.market === 'total_kills' && row.selection === 'under');
  if (!hasTimeOver || !hasKillsUnder) return false;
  const scenario = a.scenario || b.scenario || '';
  return !scenario.includes('低击杀运营');
}

function applyFinalGrades(rows) {
  for (const row of rows) {
    const hardGate = hardMarketGate(row);
    if (hardGate && ['A', 'B'].includes(row.preliminary_grade)) {
      row.risk_grade = 'C';
      row.reason = hardGate;
      row.suggested_stake = 0;
      continue;
    }

    const hasConflict = Boolean(row.conflict);
    if (hasConflict) {
      row.risk_grade = row.conflict.includes('需确认剧本') ? 'C' : 'D';
      row.reason = row.conflict.includes('需确认剧本') ? `${row.reason}；${row.conflict}` : `逻辑冲突：${row.conflict}`;
      row.suggested_stake = 0;
      continue;
    }

    if (WIN_MARKETS.has(row.market) && !WIN_MARKET_ALPHA_ENABLED && ['A', 'B'].includes(row.preliminary_grade)) {
      row.risk_grade = 'C';
      row.reason = '校准闸门: 胜负类模型未在 2025 OOS 证明打赢市场, 只观察不下注';
      row.suggested_stake = 0;
      continue;
    }

    row.risk_grade = row.preliminary_grade;
    row.reason = row.preliminary_reason;
    row.suggested_stake = stakeFor(row);
  }
}

function hardMarketGate(row) {
  if (row.market === 'total_kills') {
    const lineEdge = Number(row.line_edge_kills);
    if (!Number.isFinite(lineEdge)) {
      return '硬闸门: total_kills 缺少模型均值/线差, 只观察不下注';
    }
    if (lineEdge < TOTAL_KILLS_MIN_LINE_EDGE) {
      return `硬闸门: total_kills 线差 ${lineEdge.toFixed(2)} < ${TOTAL_KILLS_MIN_LINE_EDGE.toFixed(1)} kills, 只看明显挂歪的盘口`;
    }
  }
  if (row.market === 'game_time' && todayIso() <= GAME_TIME_BAN_UNTIL) {
    return `硬闸门: G1 比赛时间盘封禁到 ${GAME_TIME_BAN_UNTIL}, 只观察不下注`;
  }
  if (row.market === 'first_blood') {
    return '硬闸门: 第一滴血高波动且未证明 +EV, 固定 C 档跳过';
  }
  if (OOS_NEGATIVE_SKILL_MARKETS.has(row.market)) {
    return `硬闸门: ${row.market} 在 2025 OOS Brier skill 为 ${OOS_NEGATIVE_SKILL_MARKETS.get(row.market)}, 等新校准证明后再放行`;
  }
  return '';
}

function stakeFor(row) {
  const odds = Number(row.odds);
  const evValue = Number(row.ev);
  const edge = Number(row.edge);
  if (!odds || !Number.isFinite(evValue) || evValue <= 0) return 0;

  const meta = MARKET_META[row.market] || { volatility: 'medium' };
  const volatilityCap = meta.volatility === 'high' ? 2 : MAX_SINGLE_STAKE;
  const cap = Math.min(MAX_SINGLE_STAKE, volatilityCap);

  if (row.risk_grade === 'A') {
    const base = edge >= 0.14 || evValue >= 0.22 ? HIGH_CONFIDENCE_STAKE : FIXED_STAKE_UNIT;
    return Math.max(1, Math.min(base, cap));
  }
  if (row.risk_grade === 'B') return Math.max(1, Math.min(B_GRADE_STAKE, cap));
  return 0;
}

function applyStakeCaps(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.match_name)) grouped.set(row.match_name, []);
    grouped.get(row.match_name).push(row);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => Number(b.ev || 0) - Number(a.ev || 0));
    let matchTotal = 0;
    for (const row of group) {
      const stake = Number(row.suggested_stake || 0);
      if (stake <= 0) continue;
      const allowed = Math.max(0, Math.min(stake, PER_MATCH_STAKE_CAP - matchTotal));
      if (allowed <= 0) {
        row.suggested_stake = 0;
        row.risk_grade = 'C';
        row.reason = `${row.reason}；同场相关风险已达上限`;
      } else {
        row.suggested_stake = allowed;
        matchTotal += allowed;
      }
    }
  }

  const ordered = rows
    .filter((row) => Number(row.suggested_stake) > 0)
    .sort((a, b) => Number(b.ev || 0) - Number(a.ev || 0));
  let dailyTotal = 0;
  for (const row of ordered) {
    const stake = Number(row.suggested_stake || 0);
    const allowed = Math.max(0, Math.min(stake, DAILY_STAKE_CAP - dailyTotal));
    if (allowed <= 0) {
      row.suggested_stake = 0;
      row.risk_grade = 'C';
      row.reason = `${row.reason}；单日总投入已达上限`;
    } else {
      row.suggested_stake = allowed;
      dailyTotal += allowed;
    }
  }
}

export async function writeEvaluationOutputs(evaluationRows, reportRows = []) {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const columns = [
    'match_id', 'match_date', 'match_name', 'scenario', 'market', 'market_label',
    'selection', 'line', 'side', 'odds', 'break_even', 'break_even_text',
    'probability', 'probability_text', 'edge', 'ev', 'sample', 'basis',
    'scenario_alignment', 'risk_grade', 'suggested_stake', 'bankroll',
    'reason', 'conflict',
    'total_kills_model_mean', 'total_kills_model_sigma', 'line_edge_kills',
    'note',
  ];
  await writeCsv(path.join(ANALYSIS_DIR, '赔率评估结果.csv'), evaluationRows, columns);

  const candidates = evaluationRows
    .filter((row) => ['A', 'B'].includes(row.risk_grade) && Number(row.suggested_stake) > 0)
    .sort((a, b) => Number(b.ev || 0) - Number(a.ev || 0));
  await writeCsv(path.join(ANALYSIS_DIR, '可下注候选.csv'), candidates, columns);

  const noBets = evaluationRows
    .filter((row) => row.odds && !['A', 'B'].includes(row.risk_grade));
  await writeCsv(path.join(ANALYSIS_DIR, '不下注盘口说明.csv'), noBets, columns);

  const conflicts = evaluationRows.filter((row) => row.conflict);
  await writeCsv(path.join(ANALYSIS_DIR, '冲突检查.csv'), conflicts, columns);

  await writeFile(path.join(ANALYSIS_DIR, 'LPL盘口报告.md'), buildMarkdownReport(evaluationRows, reportRows), 'utf8');
}

export async function evaluateOddsFiles() {
  const templateRows = await readCsv(path.join(ANALYSIS_DIR, '赔率填写模板.csv'));
  const rateRows = await readCsv(path.join(ANALYSIS_DIR, '待赛对阵盘口概率.csv'));
  const reportRows = await readCsv(path.join(ANALYSIS_DIR, '比赛剧本摘要.csv')).catch(() => []);
  const evaluationRows = evaluateTemplate(templateRows, rateRows);
  await writeEvaluationOutputs(evaluationRows, reportRows);
  return evaluationRows;
}

function buildMarkdownReport(evaluationRows, reportRows) {
  const byMatch = new Map();
  for (const row of reportRows) byMatch.set(row.match_name, row);
  for (const row of evaluationRows) {
    if (!byMatch.has(row.match_name)) {
      byMatch.set(row.match_name, {
        match_name: row.match_name,
        match_date: row.match_date,
        scenario: row.scenario || '',
        favorite: row.favorite || '',
        underdog: row.underdog || '',
        team_state_summary: row.team_state_summary || '',
        key_data: row.key_data || '',
        risk_tip: row.risk_tip || '',
      });
    }
  }

  const lines = [
    '# LPL盘口预测报告',
    '',
    '核心公式：EV = 模型命中率 × 十进制赔率 - 1。只有 EV > 0 且剧本、盘口之间没有明显冲突时，才进入 A/B 档。',
    '',
  ];

  if (byMatch.size === 0) {
    lines.push('## 暂无待赛比赛');
    lines.push('');
    lines.push('当前 `lpl/data/lpl_matches.csv` 中没有 `status != 已结束` 的待赛对阵。');
    lines.push('请等待新一轮赛程公布后再跑 `npm run lpl:update`，或运行 `npm run lpl:collect` 刷新数据。');
    lines.push('');
    lines.push('## 资金规则');
    lines.push('- v1.4 固定小单位: A档 3元, 高信心 A档 4元封顶, B档 2元。');
    lines.push(`- 单注硬上限 ${MAX_SINGLE_STAKE} 元; 同场最多 ${PER_MATCH_STAKE_CAP} 元; 单日最多 ${DAILY_STAKE_CAP} 元。`);
    lines.push('- 高波动盘口自动降权, 不再按运行余额/Kelly 放大。');
    lines.push('- 没有A/B档时不硬下注。');
    return `${lines.join('\n')}\n`;
  }

  for (const [matchName, report] of byMatch) {
    const rows = evaluationRows.filter((row) => row.match_name === matchName);
    const recommended = rows.filter((row) => ['A', 'B'].includes(row.risk_grade) && Number(row.suggested_stake) > 0);
    const noBet = rows.filter((row) => row.odds && !['A', 'B'].includes(row.risk_grade)).slice(0, 8);

    lines.push(`## ${matchName}`);
    if (report.match_date) lines.push(`比赛时间：${report.match_date}`);
    lines.push('');
    lines.push('### 1. 比赛剧本判断');
    lines.push(report.scenario ? `${report.scenario}。${report.scenario_reason || ''}`.trim() : '暂无剧本数据。');
    lines.push('');
    lines.push('### 2. 队伍状态摘要');
    lines.push(report.team_state_summary || '暂无。');
    lines.push('');
    lines.push('### 3. 关键数据');
    lines.push(report.key_data || '暂无。');
    lines.push('');
    lines.push('### 4. 盘口逐项评估');
    const marketNotes = [...new Set(rows.map((row) => `${marketName(row)}：${row.scenario_alignment || '待确认'}${row.basis ? `，依据 ${row.basis}` : ''}`).filter(Boolean))];
    lines.push(marketNotes.length ? marketNotes.slice(0, 12).join('\n\n') : '请先生成盘口概率。');
    lines.push('');
    lines.push('### 5. EV表格');
    lines.push('| 盘口 | 赔率 | 隐含胜率 | 模型胜率 | EV | 风险等级 | 建议金额 |');
    lines.push('|---|---:|---:|---:|---:|---|---:|');
    for (const row of rows.filter((item) => item.odds).slice(0, 30)) {
      lines.push(`| ${marketName(row)} | ${row.odds || ''} | ${row.break_even_text || ''} | ${row.probability_text || ''} | ${row.ev || ''} | ${row.risk_grade || ''} | ${row.suggested_stake || 0} |`);
    }
    if (!rows.some((item) => item.odds)) {
      lines.push('| 暂无已填赔率 |  |  |  |  | C | 0 |');
    }
    lines.push('');
    lines.push('### 6. 推荐下注');
    lines.push(recommended.length
      ? recommended.map((row) => `- ${marketName(row)}，${row.risk_grade}档，建议 ${row.suggested_stake} 元。${row.reason}`).join('\n')
      : '没有 A/B 档，放弃或等待更好的赔率。');
    lines.push('');
    lines.push('### 7. 不下注盘口说明');
    lines.push(noBet.length
      ? noBet.map((row) => `- ${marketName(row)}：${row.reason}`).join('\n')
      : '未发现已填赔率中的明确放弃项，或赔率尚未填写。');
    lines.push('');
    lines.push('### 8. 风险提示');
    lines.push(report.risk_tip || '同一场高度相关盘口不要超过总投入50%；一血和英雄盘除非优势非常厚，否则不重仓。');
    lines.push('');
  }

  lines.push('## 资金规则');
  lines.push('- v1.4 固定小单位: A档 3元, 高信心 A档 4元封顶, B档 2元。');
  lines.push(`- 单注硬上限 ${MAX_SINGLE_STAKE} 元; 同场最多 ${PER_MATCH_STAKE_CAP} 元; 单日最多 ${DAILY_STAKE_CAP} 元。`);
  lines.push('- 高波动盘口自动降权, 不再按运行余额/Kelly 放大。');
  lines.push('- 没有A/B档时不硬下注。');
  return `${lines.join('\n')}\n`;
}
