// 用 OddsPortal 597 场历史赔率 + 结果,跟我的 matchWinProbability 模型正面对比。
//
// 关键指标:
//   - Brier(model) vs Brier(market) vs Brier(uniform 0.5)
//   - calibration bucket: model_p 各桶的实际命中率
//   - 模型 vs 市场偏离哪边赢?(模型 > 市场 + 实际赢 vs 模型 < 市场 + 实际赢)
//   - 按 split (2024 in_sample / 2025 out_of_sample) 分段
//
// 数据匹配:
//   - 用 match_date + home_key + away_key 找我的 all_matches.csv 对应场次
//   - 仅评估两队都有 >= 8 maps 历史的场次 (与 backtest 一致)
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readCsv, num, teamKey } from './shared.js';
import { buildProfiles } from './build-market-analysis.js';
import {
  buildSnapshotSummary,
  beforeDate,
  rowDate,
} from './backtest/common.js';

const HISTORY_DIR = path.join('lpl', 'data', 'history');
const OP_PATH = path.join(HISTORY_DIR, 'oddsportal_lpl_match_odds.csv');

// 复制 build-market-analysis.js 私有函数
function matchWinProbability(team, opponent) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const logistic = (x) => 1 / (1 + Math.exp(-x));
  const sample = Math.min(num(team.maps) + num(opponent.maps), 60);
  const confidence = clamp(sample / 40, 0.45, 1);
  const raw = logistic((team.strength_score - opponent.strength_score) / 13);
  return clamp(0.5 + (raw - 0.5) * confidence, 0.05, 0.95);
}

function fmt(value, digits = 4) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}
function fmtPct(value, digits = 1) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

async function main() {
  console.log('加载数据...');
  const [op, allMatches, allMaps] = await Promise.all([
    readCsv(OP_PATH),
    readCsv(path.join(HISTORY_DIR, 'all_matches.csv')),
    readCsv(path.join(HISTORY_DIR, 'all_map_details.csv')),
  ]);
  console.log(`  OddsPortal: ${op.length} 场`);
  console.log(`  history all_matches: ${allMatches.length} 场`);
  console.log(`  history all_map_details: ${allMaps.length} maps`);

  // 用 date|teamA|teamB key 建索引
  const matchIndex = new Map();
  for (const m of allMatches) {
    const d = String(m.match_date || '').slice(0, 10);
    const aKey = teamKey(m.team_a_id || m.team_a);
    const bKey = teamKey(m.team_b_id || m.team_b);
    if (!d || !aKey || !bKey) continue;
    matchIndex.set([d, aKey, bKey].join('|'), m);
    matchIndex.set([d, bKey, aKey].join('|'), m); // 双向
  }

  const snapshotCache = new Map();
  const rows = [];
  let matched = 0, unmatched = 0, lowSample = 0;

  for (const op_row of op) {
    const d = String(op_row.match_date || '').slice(0, 10);
    const homeKey = teamKey(op_row.home_key);
    const awayKey = teamKey(op_row.away_key);
    if (!d || !homeKey || !awayKey) { unmatched++; continue; }
    const myMatch = matchIndex.get([d, homeKey, awayKey].join('|'));
    if (!myMatch) { unmatched++; continue; }
    matched++;

    // 取该 cutoff 的 snapshot
    if (!snapshotCache.has(d)) {
      snapshotCache.set(d, buildSnapshotSummary(allMaps, d));
    }
    const snapshotSummary = snapshotCache.get(d);
    const profiles = buildProfiles(allMatches, allMaps, snapshotSummary, d);
    const home = profiles.get(homeKey);
    const away = profiles.get(awayKey);
    if (!home || !away || Math.min(num(home.maps), num(away.maps)) < 8) {
      lowSample++;
      continue;
    }
    const model_p_home = matchWinProbability(home, away);
    const market_p_home = num(op_row.home_market_p);
    const market_p_away = num(op_row.away_market_p);
    const outcome_home = teamKey(op_row.winner_key) === homeKey ? 1 : 0;

    rows.push({
      match_date: d,
      year: op_row.year,
      home: op_row.home_team,
      away: op_row.away_team,
      home_key: homeKey,
      away_key: awayKey,
      winner_key: teamKey(op_row.winner_key),
      home_avg_odds: num(op_row.home_avg_odds),
      away_avg_odds: num(op_row.away_avg_odds),
      market_p_home,
      market_p_away,
      model_p_home,
      model_p_away: 1 - model_p_home,
      outcome_home,
      model_minus_market_pp: (model_p_home - market_p_home) * 100,
    });
  }

  console.log(`  matched: ${matched}, unmatched: ${unmatched}, low_sample: ${lowSample}`);
  console.log(`  评估样本: ${rows.length}`);

  function brier(rs, p_field) {
    if (!rs.length) return null;
    let sum = 0;
    for (const r of rs) sum += (r[p_field] - r.outcome_home) ** 2;
    return sum / rs.length;
  }
  function hitRate(rs) { return rs.reduce((s, r) => s + r.outcome_home, 0) / rs.length; }

  const r2024 = rows.filter((r) => String(r.year) === '2024');
  const r2025 = rows.filter((r) => String(r.year) === '2025');

  function segMetrics(label, rs) {
    const brier_model = brier(rs, 'model_p_home');
    const brier_market = brier(rs, 'market_p_home');
    const brier_uniform = rs.reduce((s, r) => s + (0.5 - r.outcome_home) ** 2, 0) / Math.max(1, rs.length);
    const hit = hitRate(rs);

    // log loss
    function logloss(rs, p_field) {
      let sum = 0;
      for (const r of rs) {
        const p = Math.max(0.001, Math.min(0.999, r[p_field]));
        sum += -(r.outcome_home * Math.log(p) + (1 - r.outcome_home) * Math.log(1 - p));
      }
      return sum / rs.length;
    }
    const ll_model = logloss(rs, 'model_p_home');
    const ll_market = logloss(rs, 'market_p_home');

    // skill score
    const skill_model = brier_uniform ? 1 - brier_model / brier_uniform : null;
    const skill_market = brier_uniform ? 1 - brier_market / brier_uniform : null;

    return {
      label,
      n: rs.length,
      hit_home: hit,
      brier_model,
      brier_market,
      brier_uniform,
      skill_model,
      skill_market,
      logloss_model: ll_model,
      logloss_market: ll_market,
      brier_model_vs_market: brier_model - brier_market, // <0 表示模型更好
    };
  }

  const metricsAll = segMetrics('全样本', rows);
  const metrics2024 = segMetrics('2024 in-sample', r2024);
  const metrics2025 = segMetrics('2025 out-of-sample', r2025);

  // calibration buckets (10 桶)
  function calibBuckets(rs, p_field) {
    const buckets = Array.from({ length: 10 }, () => ({ n: 0, p_sum: 0, win: 0 }));
    for (const r of rs) {
      const p = r[p_field];
      const idx = Math.min(9, Math.max(0, Math.floor(p * 10)));
      buckets[idx].n += 1;
      buckets[idx].p_sum += p;
      buckets[idx].win += r.outcome_home;
    }
    return buckets.map((b, i) => ({
      bucket: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
      n: b.n,
      mean_p: b.n ? b.p_sum / b.n : NaN,
      hit_rate: b.n ? b.win / b.n : NaN,
      bias_pp: b.n ? (b.p_sum / b.n - b.win / b.n) * 100 : NaN,
    }));
  }

  // ROI test: 模型 vs 市场,假如按 model_p > market_p 下家队,看 ROI
  function modelEdgeROI(rs) {
    // 模型相对市场偏多的一边 → 下注
    const bets_home = rs.filter((r) => r.model_p_home > r.market_p_home);
    const bets_away = rs.filter((r) => r.model_p_home < r.market_p_home);
    let profit_home = 0, profit_away = 0;
    for (const r of bets_home) {
      profit_home += r.outcome_home ? r.home_avg_odds - 1 : -1;
    }
    for (const r of bets_away) {
      profit_away += !r.outcome_home ? r.away_avg_odds - 1 : -1;
    }
    return {
      bets_total: bets_home.length + bets_away.length,
      bets_home_n: bets_home.length,
      bets_away_n: bets_away.length,
      bet_home_roi: bets_home.length ? profit_home / bets_home.length : 0,
      bet_away_roi: bets_away.length ? profit_away / bets_away.length : 0,
      total_profit: profit_home + profit_away,
      overall_roi: (bets_home.length + bets_away.length) ? (profit_home + profit_away) / (bets_home.length + bets_away.length) : 0,
    };
  }

  // 边际 thresholds: 模型偏离市场 > X pp 才下
  function edgeThresholdROI(rs, threshold_pp) {
    const bets = [];
    for (const r of rs) {
      const diff = (r.model_p_home - r.market_p_home) * 100;
      if (Math.abs(diff) < threshold_pp) continue;
      if (diff > 0) bets.push({ side: 'home', win: r.outcome_home, odds: r.home_avg_odds });
      else bets.push({ side: 'away', win: 1 - r.outcome_home, odds: r.away_avg_odds });
    }
    let profit = 0;
    for (const b of bets) profit += b.win ? b.odds - 1 : -1;
    return {
      n_bets: bets.length,
      bet_rate: bets.length / rs.length,
      win_rate: bets.length ? bets.reduce((s, b) => s + b.win, 0) / bets.length : 0,
      profit,
      roi: bets.length ? profit / bets.length : 0,
    };
  }

  const roi2024 = modelEdgeROI(r2024);
  const roi2025 = modelEdgeROI(r2025);
  const thresholds = [0, 3, 5, 7, 10, 15];

  // 输出 markdown
  function tbl(title, segs) {
    const lines = [`## ${title}`, ''];
    lines.push('| metric | ' + segs.map(s => s.label).join(' | ') + ' |');
    lines.push('|---' + segs.map(() => '|---:').join('') + ' |');
    const fields = [
      ['n', s => s.n],
      ['hit_home', s => fmtPct(s.hit_home)],
      ['**Brier(model)**', s => fmt(s.brier_model)],
      ['**Brier(market)**', s => fmt(s.brier_market)],
      ['Brier(uniform=0.5)', s => fmt(s.brier_uniform)],
      ['Brier skill(model)', s => fmtPct(s.skill_model)],
      ['Brier skill(market)', s => fmtPct(s.skill_market)],
      ['LogLoss(model)', s => fmt(s.logloss_model)],
      ['LogLoss(market)', s => fmt(s.logloss_market)],
      ['Δ Brier(model - market)', s => fmt(s.brier_model_vs_market) + (s.brier_model_vs_market < 0 ? ' ✓' : ' ✗')],
    ];
    for (const [name, fn] of fields) {
      lines.push('| ' + name + ' | ' + segs.map(s => fn(s)).join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  const md = [
    '# 模型 vs 市场校准 — OddsPortal 597 场 LPL 2024-2025',
    '',
    '数据源: `lpl/data/history/oddsportal_lpl_match_odds.csv` (Codex 爬的 597 场)',
    `匹配到我 history 的: ${matched} 场,排除样本不足(<8 maps): ${lowSample},最终评估: ${rows.length} 场`,
    '',
    tbl('1. 核心指标对比', [metricsAll, metrics2024, metrics2025]),
    '',
    '## 2. 校准曲线 (10 桶) — 全样本',
    '',
    '### 我的模型 model_p_home',
    '',
    '| bucket | n | mean_p | hit_rate | bias_pp |',
    '|---|---:|---:|---:|---:|',
    ...calibBuckets(rows, 'model_p_home').filter(b => b.n > 0).map(b =>
      `| ${b.bucket} | ${b.n} | ${fmtPct(b.mean_p)} | ${fmtPct(b.hit_rate)} | ${b.bias_pp >= 0 ? '+' : ''}${b.bias_pp.toFixed(1)} |`
    ),
    '',
    '### 市场 market_p_home',
    '',
    '| bucket | n | mean_p | hit_rate | bias_pp |',
    '|---|---:|---:|---:|---:|',
    ...calibBuckets(rows, 'market_p_home').filter(b => b.n > 0).map(b =>
      `| ${b.bucket} | ${b.n} | ${fmtPct(b.mean_p)} | ${fmtPct(b.hit_rate)} | ${b.bias_pp >= 0 ? '+' : ''}${b.bias_pp.toFixed(1)} |`
    ),
    '',
    '## 3. 真实赔率 ROI (假设按市场 avg_odds 下注)',
    '',
    '> 策略: 模型 p > 市场 p → 下家队;模型 p < 市场 p → 下客队。',
    '> 这是真实赔率,扣过 vig,**比 backtest 的合成赔率结果更可信**(教训 8)。',
    '',
    '### 全样本无阈值',
    '',
    `| segment | bets | bet rate | 命中率 | ROI |`,
    `|---|---:|---:|---:|---:|`,
    `| 2024 | ${roi2024.bets_total} | ${fmtPct(roi2024.bets_total / r2024.length)} | — | **${fmtPct(roi2024.overall_roi)}** |`,
    `| 2025 | ${roi2025.bets_total} | ${fmtPct(roi2025.bets_total / r2025.length)} | — | **${fmtPct(roi2025.overall_roi)}** |`,
    '',
    '### 加阈值 (模型偏离市场 >= N pp 才下) — 2025 out-of-sample',
    '',
    `| 阈值 (pp) | n_bets | 触发率 | 命中率 | ROI |`,
    `|---|---:|---:|---:|---:|`,
    ...thresholds.map(t => {
      const r = edgeThresholdROI(r2025, t);
      return `| ${t} | ${r.n_bets} | ${fmtPct(r.bet_rate)} | ${fmtPct(r.win_rate)} | **${fmtPct(r.roi)}** |`;
    }),
    '',
    '### 加阈值 (模型偏离市场 >= N pp 才下) — 2024 in-sample',
    '',
    `| 阈值 (pp) | n_bets | 触发率 | 命中率 | ROI |`,
    `|---|---:|---:|---:|---:|`,
    ...thresholds.map(t => {
      const r = edgeThresholdROI(r2024, t);
      return `| ${t} | ${r.n_bets} | ${fmtPct(r.bet_rate)} | ${fmtPct(r.win_rate)} | **${fmtPct(r.roi)}** |`;
    }),
    '',
    '## 4. 解读',
    '',
    '关键判断标准:',
    '- **Brier(model) < Brier(market)** ⇒ 模型预测比市场准 → **有 alpha**',
    '- **Brier(model) ≥ Brier(market)** ⇒ 模型不如市场 → **没 alpha**,只是抓 vig 损失',
    '- **2025 out-of-sample ROI > +5%** + Brier skill 跟 in-sample 接近 ⇒ alpha 稳定',
    '- ROI < -5% on out-of-sample ⇒ 系统性输,**应停手**',
    '',
    `**整体判定**: ${metrics2025.brier_model_vs_market < 0 ? '✅ 2025 out-of-sample 模型 Brier 优于市场,有 edge 候选信号' : '❌ 2025 out-of-sample 模型 Brier 不优于市场,**这意味着用模型选边长期跑会输给市场效率**'}`,
    '',
  ].join('\n');

  const outPath = 'lpl/data/盘口分析/市场校准-OddsPortal.md';
  await writeFile(outPath, md, 'utf8');
  console.log('wrote', outPath);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
