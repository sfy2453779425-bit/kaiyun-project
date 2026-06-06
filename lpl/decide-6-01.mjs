// 6-01 AL vs 西安WE 完整决策: 模型 → 扣 2026 偏差 → 比开云真实赔率 → 阈值+闸门
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { readCsv, teamKey } from './shared.js';
import { buildProfiles } from './build-market-analysis.js';
import { predictTotalKills } from './calibration/total-kills-model-predict.js';

const DATA_DIR = path.join(process.cwd(), 'lpl', 'data');
const DRIFT = 0.9;          // 2026 模型高估 ~0.9 杀 → 均值下调
const EV_MIN = 0.08;        // 线差/EV 阈值: 至少 +8% 才考虑(盖过抽水+不确定)
const GAP_MIN = 1.5;        // 模型均值需离线 >= 1.5 杀, 否则是贴线 coinflip, 跳过
const fmtP = (v) => (v * 100).toFixed(1) + '%';

function latestOdds() {
  const dir = 'D:/lol_scraper/data';
  const files = readdirSync(dir).filter((f) => /deduped_.*\.json$/.test(f)).sort();
  return JSON.parse(readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
}

async function main() {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_team_detail_summary.csv')),
  ]);
  const profiles = buildProfiles(matches, maps, summary);
  const al = profiles.get('AL'); const we = profiles.get('WE');
  if (!al || !we) { console.error('missing profile', !!al, !!we); process.exit(1); }

  const tk = predictTotalKills(al, we);
  const meanRaw = tk.mean; const meanAdj = meanRaw - DRIFT; const sigma = tk.sigma;
  console.log(`AL: strength=${al.strength_score.toFixed(1)} avg_total=${al.avg_total_kills.toFixed(2)} avg_time=${al.avg_game_time_min.toFixed(2)}`);
  console.log(`WE: strength=${we.strength_score.toFixed(1)} avg_total=${we.avg_total_kills.toFixed(2)} avg_time=${we.avg_game_time_min.toFixed(2)}`);
  console.log(`总杀模型 mean=${meanRaw.toFixed(2)}  → 扣2026偏差 -${DRIFT} = ${meanAdj.toFixed(2)}  sigma=${sigma.toFixed(2)}`);

  // 正态 CDF
  const erf = (x) => { const s = x < 0 ? -1 : 1; const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a); return s * y; };
  const cdf = (x) => 0.5 * (1 + erf((x - meanAdj) / (sigma * Math.SQRT2)));

  // 抓开云 AL vs WE G1 总杀
  const j = latestOdds();
  const panda = j.platforms.PANDA.matches;
  let mkt = null;
  for (const m of Object.values(panda)) { if (/AL/.test(m.match?.teams || '')) { mkt = m; break; } }
  const lines = [];
  for (const k of Object.values(mkt.markets)) {
    if (k.name === '击杀总数大小' && k.round === 1) {
      const line = Number((Object.keys(k.odds)[0].match(/[\d.]+/) || [])[0]);
      const over = Object.entries(k.odds).find(([s]) => /大于|>/.test(s));
      const under = Object.entries(k.odds).find(([s]) => /小于|</.test(s));
      lines.push({ line, overOdd: Number(over[1].odd), underOdd: Number(under[1].odd), rr: k.return_rate });
    }
  }
  lines.sort((a, b) => a.line - b.line);

  console.log('\n开云 G1 总杀 + 模型(扣偏差后):');
  console.log('线 | 大赔 | 小赔 | 模型P(小) | 小EV | 模型P(大) | 大EV | 离线');
  const cands = [];
  for (const L of lines) {
    const pUnder = cdf(L.line); const pOver = 1 - pUnder;
    const evU = pUnder * L.underOdd - 1; const evO = pOver * L.overOdd - 1;
    const gap = Math.abs(meanAdj - L.line);
    console.log(`${L.line} | ${L.overOdd} | ${L.underOdd} | ${fmtP(pUnder)} | ${evU >= 0 ? '+' : ''}${fmtP(evU)} | ${fmtP(pOver)} | ${evO >= 0 ? '+' : ''}${fmtP(evO)} | ${gap.toFixed(1)}`);
    cands.push({ ...L, pUnder, pOver, evU, evO, gap });
  }

  console.log('\n=== 决策(阈值: EV>=+8% 且 离线>=1.5 杀; 只许总杀盘)===');
  const picks = [];
  for (const c of cands) {
    if (c.evU >= EV_MIN && c.gap >= GAP_MIN) picks.push({ side: 'under', line: c.line, odd: c.underOdd, p: c.pUnder, ev: c.evU });
    if (c.evO >= EV_MIN && c.gap >= GAP_MIN) picks.push({ side: 'over', line: c.line, odd: c.overOdd, p: c.pOver, ev: c.evO });
  }
  if (!picks.length) { console.log('PASS —— 无任何线同时满足 EV>=+8% 且离线>=1.5。'); }
  else {
    picks.sort((a, b) => b.ev - a.ev);
    for (const p of picks) console.log(`★ ${p.side} ${p.line} @${p.odd}(开云) | 模型P ${fmtP(p.p)} | EV ${p.ev >= 0 ? '+' : ''}${fmtP(p.ev)}`);
    console.log('注: over 类即便过阈值也要警惕(2026 模型在 over 侧偏乐观);优先 under。');
  }
  console.log('\nG1 胜负盘(开云): 仅参考, 不下(胜负闸门)。');
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
