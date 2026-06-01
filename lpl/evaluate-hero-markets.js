import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  clamp,
  decimal,
  num,
  pct,
  pctText,
  readCsv,
  readCsvIfExists,
  teamKey,
  unionColumns,
  writeCsv,
} from './shared.js';

const ROLE_MAP = {
  TOP: 'top',
  JUNGLE: 'jun',
  JUN: 'jun',
  MID: 'mid',
  ADC: 'adc',
  BOT: 'adc',
  SUPPORT: 'sup',
  SUP: 'sup',
};

function roleKey(role) {
  return ROLE_MAP[String(role || '').toUpperCase()] || String(role || '').toLowerCase();
}

function heroName(name) {
  return String(name || '').trim() === 'K' ? "K'Sante" : String(name || '').trim();
}

function splitHeroes(value) {
  return String(value || '')
    .split(/[\/,，|]/)
    .map((item) => heroName(item))
    .filter(Boolean);
}

function rate(rows, predicate) {
  return rows.length ? rows.filter(predicate).length / rows.length : 0;
}

function topHeroes(rows, limit = 4) {
  const counts = new Map();
  for (const row of rows) counts.set(heroName(row.hero), (counts.get(heroName(row.hero)) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([hero]) => hero)
    .join('/');
}

function teamRoleRows(players, teamId, role) {
  return players
    .filter((row) => teamKey(row.team || row.team_id) === teamId && roleKey(row.role) === role)
    .map((row) => ({ ...row, hero: heroName(row.hero) }));
}

function opponentBanRate(mapRows, targetTeamId, opponentTeamId, heroes) {
  let maps = 0;
  let hits = 0;
  const heroSet = new Set(heroes);
  for (const row of mapRows) {
    const hasTarget = [row.team_a_id, row.team_b_id].includes(targetTeamId);
    const hasOpponent = [row.team_a_id, row.team_b_id].includes(opponentTeamId);
    if (!hasTarget || !hasOpponent) continue;
    const opponentSide = row.blue_team_id === opponentTeamId ? 'blue' : row.red_team_id === opponentTeamId ? 'red' : '';
    if (!opponentSide) continue;
    maps += 1;
    const bans = splitHeroes(row[`${opponentSide}_bans`]);
    if (bans.some((hero) => heroSet.has(hero))) hits += 1;
  }
  return maps ? hits / maps : 0;
}

function sideFiltered(rows, side) {
  return side ? rows.filter((row) => row.side === side) : rows;
}

function estimateHeroProbability({ allRate, game1Rate, recentRate, sideRate, banRate, stealRate }) {
  let p = allRate * 0.30 + game1Rate * 0.22 + recentRate * 0.30 + sideRate * 0.13 + 0.05 * 0.5;
  p -= Math.min(0.10, banRate * 0.10);
  p -= Math.min(0.06, stealRate * 0.06);
  return clamp(p, 0.04, 0.9);
}

function evaluateSide(probability, odds) {
  const n = Number(odds);
  if (!n) return { break_even: '', ev: '', grade: 'C', stake: 0 };
  const breakEven = 1 / n;
  const ev = probability * n - 1;
  let grade = 'D';
  let stake = 0;
  if (ev > 0.20 && probability - breakEven > 0.08) {
    grade = 'B';
    stake = 1;
  } else if (ev > 0) {
    grade = 'C';
  }
  return { break_even: breakEven, ev, grade, stake };
}

function buildUsageRows(players) {
  const groups = new Map();
  for (const row of players) {
    const key = [teamKey(row.team || row.team_id), row.team, roleKey(row.role), heroName(row.hero)].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        team_id: teamKey(row.team || row.team_id),
        team: row.team,
        role: roleKey(row.role),
        hero: heroName(row.hero),
        games: 0,
        game1_games: 0,
        blue_games: 0,
        red_games: 0,
      });
    }
    const group = groups.get(key);
    group.games += 1;
    group.game1_games += num(row.bo) === 1 ? 1 : 0;
    group.blue_games += row.side === 'blue' ? 1 : 0;
    group.red_games += row.side === 'red' ? 1 : 0;
  }

  const totals = new Map();
  for (const row of players) {
    const key = [teamKey(row.team || row.team_id), roleKey(row.role)].join('|');
    if (!totals.has(key)) totals.set(key, { all: 0, game1: 0, blue: 0, red: 0 });
    const total = totals.get(key);
    total.all += 1;
    total.game1 += num(row.bo) === 1 ? 1 : 0;
    total.blue += row.side === 'blue' ? 1 : 0;
    total.red += row.side === 'red' ? 1 : 0;
  }

  return [...groups.values()].map((row) => {
    const total = totals.get([row.team_id, row.role].join('|')) || {};
    return {
      ...row,
      all_rate: decimal(pct(row.games, total.all)),
      all_rate_text: pctText(pct(row.games, total.all)),
      game1_rate: decimal(pct(row.game1_games, total.game1)),
      game1_rate_text: pctText(pct(row.game1_games, total.game1)),
      blue_rate: decimal(pct(row.blue_games, total.blue)),
      red_rate: decimal(pct(row.red_games, total.red)),
    };
  }).sort((a, b) => a.team_id.localeCompare(b.team_id) || a.role.localeCompare(b.role) || b.games - a.games);
}

async function buildTemplate(players, matches) {
  const existing = await readCsvIfExists(path.join(ANALYSIS_DIR, '英雄盘口模板.csv'));
  const oddsByKey = new Map(existing.map((row) => [[row.match_name, row.team, row.role, row.hero_group, row.side].join('|'), row]));
  const upcoming = matches.filter((row) => row.status !== '已结束').slice(0, 12);
  const rows = [];
  for (const match of upcoming) {
    for (const side of ['a', 'b']) {
      const teamId = match[`team_${side}_id`];
      const opponentId = match[`team_${side === 'a' ? 'b' : 'a'}_id`];
      const team = match[`team_${side}`];
      for (const role of ['top', 'jun', 'mid', 'adc', 'sup']) {
        const group = topHeroes(teamRoleRows(players, teamId, role).slice(-12), 4);
        const old = oddsByKey.get([match.match_name, team, role, group, ''].join('|')) || {};
        rows.push({
          match_id: match.match_id,
          match_date: match.match_date,
          match_name: match.match_name,
          team,
          team_id: teamId,
          opponent_id: opponentId,
          role,
          side: '',
          hero_group: group,
          odds_group: old.odds_group || '',
          odds_other: old.odds_other || '',
          note: 'side可填blue/red；hero_group用/分隔',
        });
      }
    }
  }
  return rows;
}

function evaluateHeroTemplates(templateRows, players, mapRows) {
  return templateRows.map((row) => {
    const heroes = splitHeroes(row.hero_group);
    const teamId = row.team_id || teamKey(row.team);
    const opponentId = row.opponent_id;
    const role = roleKey(row.role);
    const all = teamRoleRows(players, teamId, role);
    const game1 = all.filter((item) => num(item.bo) === 1);
    const recent = all.slice(-8);
    const sideRows = sideFiltered(all, row.side);
    const opponentSameRole = teamRoleRows(players, opponentId, role);
    const heroSet = new Set(heroes);

    const allRate = rate(all, (item) => heroSet.has(item.hero));
    const game1Rate = rate(game1, (item) => heroSet.has(item.hero));
    const recentRate = rate(recent, (item) => heroSet.has(item.hero));
    const sideRate = rate(sideRows, (item) => heroSet.has(item.hero));
    const banRate = opponentBanRate(mapRows, teamId, opponentId, heroes);
    const stealRate = rate(opponentSameRole, (item) => heroSet.has(item.hero));
    const pGroup = estimateHeroProbability({ allRate, game1Rate, recentRate, sideRate, banRate, stealRate });
    const pOther = 1 - pGroup;
    const groupEval = evaluateSide(pGroup, row.odds_group);
    const otherEval = evaluateSide(pOther, row.odds_other);

    return {
      ...row,
      all_rate: decimal(allRate),
      all_rate_text: pctText(allRate),
      game1_rate: decimal(game1Rate),
      game1_rate_text: pctText(game1Rate),
      recent8_rate: decimal(recentRate),
      recent8_rate_text: pctText(recentRate),
      side_rate: decimal(sideRate),
      side_rate_text: pctText(sideRate),
      opponent_ban_rate: decimal(banRate),
      opponent_ban_rate_text: pctText(banRate),
      opponent_steal_rate: decimal(stealRate),
      opponent_steal_rate_text: pctText(stealRate),
      group_probability: decimal(pGroup),
      group_probability_text: pctText(pGroup),
      group_break_even: decimal(groupEval.break_even),
      group_ev: decimal(groupEval.ev),
      group_grade: groupEval.grade,
      group_stake: groupEval.stake,
      other_probability: decimal(pOther),
      other_probability_text: pctText(pOther),
      other_break_even: decimal(otherEval.break_even),
      other_ev: decimal(otherEval.ev),
      other_grade: otherEval.grade,
      other_stake: otherEval.stake,
      top_heroes: topHeroes(all, 8),
      recent_top_heroes: topHeroes(recent, 8),
      model_note: '英雄盘单独建模；已扣除对手ban与同位置抢用风险，默认高波动不重仓。',
    };
  });
}

async function main() {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const [players, mapRows, matches] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lpl_player_map_details.csv')),
    readCsvIfExists(path.join(DATA_DIR, 'lpl_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lpl_matches.csv')),
  ]);

  const usageRows = buildUsageRows(players);
  const templateRows = await buildTemplate(players, matches);
  const evaluations = evaluateHeroTemplates(templateRows, players, mapRows);

  await writeCsv(path.join(ANALYSIS_DIR, '英雄使用率.csv'), usageRows, unionColumns(usageRows));
  await writeCsv(path.join(ANALYSIS_DIR, '英雄盘口模板.csv'), templateRows, [
    'match_id', 'match_date', 'match_name', 'team', 'team_id', 'opponent_id',
    'role', 'side', 'hero_group', 'odds_group', 'odds_other', 'note',
  ]);
  await writeCsv(path.join(ANALYSIS_DIR, '英雄盘口评估结果.csv'), evaluations, unionColumns(evaluations));

  console.log(`英雄盘口评估完成。模板 ${templateRows.length} 条。`);
  console.log(path.join(ANALYSIS_DIR, '英雄盘口模板.csv'));
}

main().catch((error) => {
  console.error(`英雄盘口评估失败: ${error.message}`);
  process.exitCode = 1;
});
