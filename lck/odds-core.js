import path from 'node:path';
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
import { MODEL_MODE, USE_NEW_MODEL } from './model-mode.js';

export const BANKROLL = 100;

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

// 模型模式: 默认 legacy(改动前被实战验证的评级), MODEL_MODE=new 启用扣水硬护栏。
// 扣水列(overround/no_vig_p/market_edge)两种模式都算+显示, 但只有 new 用它们改档。

// total_kills 是否已被历史验证有真实选边能力(回测显示 selection_edge≈0, 暂定 false)。
// 一旦 odds-history 真实样本证明 total_kills 有 edge, 改成 true 即可放开 >0.18 大分歧的豁免。
const TOTAL_KILLS_GAP_VALIDATED = false;

// de-vig 分组键: over/under 盘按 (比赛,market,line) 配对; 其余双边盘按 (比赛,market) 配对
const OVER_UNDER_MARKETS = new Set(['map_total', 'total_kills', 'game_time']);
function devigKey(row) {
  if (OVER_UNDER_MARKETS.has(row.market)) {
    return [row.match_id || row.match_name || '', row.market, row.line ?? ''].join('|');
  }
  return [row.match_id || row.match_name || '', row.market].join('|');
}

// 给一批已 join 赔率的行计算 overround / no_vig_p
function computeDevig(rows) {
  const groups = new Map();
  for (const row of rows) {
    const odds = Number(row.odds);
    if (!(odds > 0)) continue;
    const key = devigKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const devigByRow = new Map();
  for (const group of groups.values()) {
    // 去重同一 selection(避免重复填写), 只保留有效两面/多面
    const sides = [...new Map(group.map((r) => [`${r.selection}|${r.line}`, r])).values()];
    const overround = sides.reduce((sum, r) => sum + 1 / Number(r.odds), 0);
    const enoughSides = sides.length >= 2 && overround > 0;
    for (const r of group) {
      devigByRow.set(r, enoughSides
        ? { overround, no_vig_p: (1 / Number(r.odds)) / overround }
        : { overround: '', no_vig_p: '' });
    }
  }
  return devigByRow;
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

  // 先把 rate 和赔率 join 好, 供 de-vig 分组用
  const joined = templateRows.map((row) => {
    const rate = rateMap.get(rowKey(row))
      || fallbackRateMap.get([row.match_name || '', row.market || '', row.selection || '', row.line || '', row.side || ''].join('|'))
      || {};
    const probability = rate.probability !== '' && rate.probability != null ? Number(rate.probability) : '';
    return { row, rate, probability };
  });
  // computeDevig 按行引用返回, 取回时用同一引用
  const devigLookup = computeDevig(joined.map((j) => j.row));

  const rows = joined.map(({ row, rate, probability }) => {
    const odds = Number(row.odds);
    const breakEven = impliedProbability(row.odds);
    const evValue = ev(probability, odds);
    const edge = probability !== '' && breakEven !== '' ? probability - breakEven : '';
    const devig = devigLookup.get(row) || { overround: '', no_vig_p: '' };
    const noVigP = devig.no_vig_p;
    const marketEdge = probability !== '' && noVigP !== '' ? probability - noVigP : '';
    const gap = marketEdge; // model_market_gap == model_p - no_vig_p (有符号, 正=模型比市场更看好)
    const sample = Number(rate.sample || row.sample || 0);
    const preliminary = preliminaryGrade({
      ...row, ...rate, probability, edge, ev: evValue, sample,
      no_vig_p: noVigP, market_edge: marketEdge, model_market_gap: gap,
    });

    return {
      ...rate,
      ...row,
      model_mode: rate.model_mode || row.model_mode || MODEL_MODE,
      market_label: MARKET_META[row.market]?.label || row.market,
      probability: probability === '' ? '' : decimal(probability),
      probability_text: probability === '' ? '' : pctText(probability),
      break_even: breakEven === '' ? '' : decimal(breakEven),
      break_even_text: breakEven === '' ? '' : pctText(breakEven),
      overround: devig.overround === '' ? '' : decimal(devig.overround),
      no_vig_p: noVigP === '' ? '' : decimal(noVigP),
      no_vig_p_text: noVigP === '' ? '' : pctText(noVigP),
      market_edge: marketEdge === '' ? '' : decimal(marketEdge),
      market_edge_text: marketEdge === '' ? '' : pctText(marketEdge),
      model_market_gap: gap === '' ? '' : decimal(gap),
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

function downgrade(grade) {
  return { A: 'B', B: 'C', C: 'C', D: 'D' }[grade] || 'C';
}

// 旧管线评级(改动前): 用 raw edge(模型p - 1/赔率), 无扣水硬护栏。
function preliminaryGradeLegacy(row) {
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

// 分发: 默认 legacy(旧评级), MODEL_MODE=new 走扣水护栏评级
function preliminaryGrade(row) {
  return USE_NEW_MODEL ? preliminaryGradeNew(row) : preliminaryGradeLegacy(row);
}

// 新管线评级(扣水 + 市场分歧护栏, 仅 MODEL_MODE=new):
//  EV<=0(真实赔率) -> D
//  无对手盘赔率(扣不了水) -> 最多 C
//  |gap|>0.18 -> C(除非 total_kills 且历史验证过), 不做主单
//  gap>0.12 -> 在基础档上降一档, 标注"模型与市场大分歧"
function preliminaryGradeNew(row) {
  const odds = Number(row.odds);
  const probability = row.probability === '' ? null : Number(row.probability);
  const evValue = row.ev === '' ? null : Number(row.ev);
  const sample = Number(row.sample || 0);
  const noVigP = row.no_vig_p === '' || row.no_vig_p == null ? null : Number(row.no_vig_p);
  const marketEdge = row.market_edge === '' || row.market_edge == null ? null : Number(row.market_edge);
  const gap = row.model_market_gap === '' || row.model_market_gap == null ? null : Number(row.model_market_gap);
  const meta = MARKET_META[row.market] || { volatility: 'medium' };

  if (!odds) return { grade: 'C', reason: '未填写赔率，先观察' };
  if (probability == null || Number.isNaN(probability)) return { grade: 'D', reason: '缺少模型概率' };
  if (evValue == null || evValue <= 0) return { grade: 'D', reason: 'EV不为正(按真实赔率)' };

  // 扣不了水(只填了单边赔率): 无法判断市场分歧, 最多观察
  if (noVigP == null) return { grade: 'C', reason: '缺对手盘赔率，无法扣水，只观察' };

  // 注: 单一平台 overround 恒 >1, 故公允概率 < 1/赔率, EV>0 必然 market_edge>0。
  // "market_edge<=0" 在已过 EV 闸后不可能触发(除非搬砖盘 overround<1, 本流程不存在), 故不单设规则。

  if (sample > 0 && sample < 8) return { grade: 'C', reason: '样本太小，只观察' };
  if (meta.volatility === 'high' && evValue < 0.18) return { grade: 'C', reason: '高波动盘口，EV不够厚' };

  // 极端分歧: >18pp, 模型大概率漏信息(KT+1.5 教训), 不做主单
  if (gap != null && gap > 0.18) {
    const exempt = row.market === 'total_kills' && TOTAL_KILLS_GAP_VALIDATED;
    if (!exempt) return { grade: 'C', reason: `模型与市场极端分歧(+${(gap * 100).toFixed(1)}pp>18)，不做主单` };
  }

  // 基础档(用扣水后的 market_edge, 不再用虚高的 raw edge)
  let grade;
  let reason;
  if (marketEdge >= 0.08 && evValue >= 0.12 && sample >= 16 && row.scenario_alignment !== '冲突') {
    grade = 'A';
    reason = '扣水后 edge 厚，样本和剧本支持';
  } else if (marketEdge >= 0.03 && row.scenario_alignment !== '冲突') {
    grade = 'B';
    reason = '扣水后有正 edge，但优势不厚或样本一般';
  } else {
    grade = 'C';
    reason = '扣水后 edge 不足';
  }

  // 大分歧降档护栏: 12-18pp
  if (gap != null && gap > 0.12 && grade !== 'C' && grade !== 'D') {
    return { grade: downgrade(grade), reason: `${reason}；但模型与市场大分歧(+${(gap * 100).toFixed(1)}pp)，降一档` };
  }
  return { grade, reason };
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
    const hardGate = hardGateReason(row);
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

    row.risk_grade = row.preliminary_grade;
    row.reason = row.preliminary_reason;
    row.suggested_stake = stakeFor(row);
  }
}

function hardGateReason(row) {
  if (row.market === 'game_time') {
    return '硬闸门: game_time 在回测中 Brier skill < 0，暂时只观察不下注';
  }
  if (row.market === 'first_blood') {
    return '硬闸门: 第一滴血高波动且回测 skill < 0，固定跳过';
  }
  if (row.market === 'total_kills' && row.selection === 'under' && Number(row.line) === 33.5) {
    return '硬闸门: total_kills 33.5 under 历史触发率过高，容易变成 vig 损失，不自动进 A/B';
  }
  if (row.market === 'map_handicap' && Number(row.line) === -1.5 && String(row.scenario || '').includes('强队慢热') && Number(row.ev || 0) < 0.18) {
    return '降权: 慢热强队的 -1.5 地图需要更厚 EV，避免无脑追 2-0';
  }
  return '';
}

function stakeFor(row) {
  const odds = Number(row.odds);
  const evValue = Number(row.ev);
  if (!odds || !Number.isFinite(evValue) || evValue <= 0) return 0;
  const meta = MARKET_META[row.market] || { weight: 0.75 };
  if (row.risk_grade === 'A') {
    // legacy: 用 raw edge 门槛 0.14(旧行为); new: 用扣水 market_edge 门槛 0.10
    const edgeVal = USE_NEW_MODEL
      ? (row.market_edge === '' || row.market_edge == null ? Number(row.edge) : Number(row.market_edge))
      : Number(row.edge);
    const thr = USE_NEW_MODEL ? 0.10 : 0.14;
    const base = edgeVal >= thr || evValue >= 0.22 ? 7 : 5;
    return Math.max(1, Math.round(base * meta.weight));
  }
  if (row.risk_grade === 'B') return Math.max(1, Math.round(3 * meta.weight));
  return 0;
}

function applyStakeCaps(rows) {
  const dailyCap = 30;
  const perMatchCap = 15;
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
      const allowed = Math.max(0, Math.min(stake, perMatchCap - matchTotal));
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
    const allowed = Math.max(0, Math.min(stake, dailyCap - dailyTotal));
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
    'model_mode', 'match_id', 'match_date', 'match_name', 'scenario', 'market', 'market_label',
    'selection', 'line', 'side', 'odds', 'break_even', 'break_even_text',
    'overround', 'no_vig_p', 'no_vig_p_text',
    'probability', 'probability_text', 'raw_probability', 'raw_probability_text',
    'market_edge', 'market_edge_text', 'model_market_gap',
    'edge', 'ev', 'sample', 'basis',
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

  await writeFile(path.join(ANALYSIS_DIR, 'LCK盘口报告.md'), buildMarkdownReport(evaluationRows, reportRows), 'utf8');
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
    '# LCK盘口预测报告',
    '',
    `模型模式：${MODEL_MODE}（默认 legacy；MODEL_MODE=new 才启用实验管线）。`,
    '',
    '核心公式：EV = 模型命中率 × 十进制赔率 - 1。只有 EV > 0 且剧本、盘口之间没有明显冲突时，才进入 A/B 档。',
    '',
  ];

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
    lines.push('扣水说明：隐含胜率=1/赔率(含水)；公允胜率=扣水后市场真实概率；市场edge=模型−公允(真正的优势);EV 按真实赔率算赔付。');
    lines.push('| 盘口 | 赔率 | 隐含胜率 | 公允胜率 | 模型胜率 | 市场edge | EV | 风险等级 | 建议金额 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|---:|');
    for (const row of rows.filter((item) => item.odds).slice(0, 30)) {
      lines.push(`| ${marketName(row)} | ${row.odds || ''} | ${row.break_even_text || ''} | ${row.no_vig_p_text || ''} | ${row.probability_text || ''} | ${row.market_edge_text || ''} | ${row.ev || ''} | ${row.risk_grade || ''} | ${row.suggested_stake || 0} |`);
    }
    if (!rows.some((item) => item.odds)) {
      lines.push('| 暂无已填赔率 |  |  |  |  |  | C | 0 |');
    }
    lines.push('');
    lines.push('### 6. 推荐下注');
    lines.push(recommended.length
      ? recommended.map((row) => `- ${marketName(row)}，${row.risk_grade}档，建议 ${row.suggested_stake} / ${BANKROLL}。${row.reason}`).join('\n')
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
  lines.push('- 单日总投入默认按本金30%封顶。');
  lines.push('- A档单注约为5-7单位，B档约为1-3单位，高波动盘口自动降权。');
  lines.push('- 没有A/B档时不硬下注。');
  return `${lines.join('\n')}\n`;
}
