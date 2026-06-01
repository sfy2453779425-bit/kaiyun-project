import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_DIR,
  DATA_DIR,
  clamp,
  num,
  pctText,
  readCsv,
  readCsvIfExists,
  unionColumns,
  writeCsv,
} from '../shared.js';

const PROFILE_CSV = path.join(ANALYSIS_DIR, '队伍盘口命中率.csv');
const MAP_CSV = path.join(DATA_DIR, 'lpl_map_details.csv');
const PLAYER_CSV = path.join(DATA_DIR, 'lpl_player_map_details.csv');
const MATCH_CSV = path.join(DATA_DIR, 'lpl_matches.csv');
const DIVISION_CONFIG_PATH = path.join(DATA_DIR, '..', 'config', 'division-rating.json');
const OUT_JSON = path.join(ANALYSIS_DIR, '队伍模型洞察.json');
const OUT_CSV = path.join(ANALYSIS_DIR, '队伍模型洞察.csv');
const GROUP_JSON = path.join(ANALYSIS_DIR, '队伍分组识别.json');

const DEFAULT_DIVISION_CONFIG = {
  version: 'default',
  baseline_adjustment: {
    '登峰组': 2.0,
    '涅槃组': -5.0,
    '未分组': -2.0,
  },
  manual_groups: null,
};

function finite(value) {
  const parsed = num(value, NaN);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 1) {
  return Number(finite(value).toFixed(digits));
}

function pctRank(rows, field, value, invert = false) {
  const vals = rows.map((row) => finite(row[field])).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return 50;
  const v = finite(value);
  const below = vals.filter((x) => x < v).length;
  const equal = vals.filter((x) => x === v).length;
  const rank = ((below + equal * 0.5) / vals.length) * 100;
  return round(invert ? 100 - rank : rank, 1);
}

function avg(values) {
  const usable = values.filter((v) => Number.isFinite(v));
  return usable.length ? usable.reduce((sum, v) => sum + v, 0) / usable.length : 50;
}

function composite(parts) {
  const weighted = parts.filter((part) => Number.isFinite(part.value) && Number.isFinite(part.weight));
  const weight = weighted.reduce((sum, part) => sum + part.weight, 0);
  if (!weight) return 50;
  return round(weighted.reduce((sum, part) => sum + part.value * part.weight, 0) / weight, 1);
}

function tier(score) {
  if (score >= 63) return 'S';
  if (score >= 57) return 'A';
  if (score >= 51) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

function styleLabel(team) {
  const strength = finite(team.rating_score ?? team.strength_score);
  const tempo = finite(team.tempo_score);
  const attack = finite(team.attributes?.attack);
  const defense = finite(team.attributes?.defense);
  const objective = finite(team.attributes?.objective);
  if (strength >= 60 && attack >= 65) return '压制型强队';
  if (strength >= 58 && objective >= 65) return '资源运营强队';
  if (tempo >= 65) return '高节奏乱战队';
  if (defense >= 65 && tempo <= 50) return '低节奏防守队';
  if (strength < 48 && tempo >= 60) return '高波动弱队';
  return '均衡型';
}

function connectedComponents(edges, teamIds) {
  const graph = new Map();
  for (const id of teamIds) graph.set(id, new Set());
  for (const [a, b] of edges) {
    if (!a || !b) continue;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
  }

  const seen = new Set();
  const components = [];
  for (const id of graph.keys()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const members = [];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const next of graph.get(cur) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(members.sort((a, b) => String(a).localeCompare(String(b))));
  }
  return components;
}

async function loadDivisionConfig() {
  try {
    return JSON.parse(await readFile(DIVISION_CONFIG_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_DIVISION_CONFIG;
    throw error;
  }
}

function manualGroupsFromConfig(matchRows, profiles, divisionConfig) {
  const manual = divisionConfig?.manual_groups;
  if (!manual || typeof manual !== 'object') return null;

  const profileByTeam = new Map(profiles.map((row) => [row.team_id, row]));
  const regularRows = matchRows.filter((row) =>
    String(row.tournament || '').includes('LPL 2026 Split 2')
    && !String(row.tournament || '').includes('Playoffs')
  );
  const groupByTeam = new Map();
  const groups = Object.entries(manual).map(([name, members]) => {
    const known = (Array.isArray(members) ? members : []).filter((teamId) => profileByTeam.has(teamId));
    for (const teamId of known) groupByTeam.set(teamId, name);
    return {
      name,
      members: known,
      size: known.length,
      avg_strength_raw: round(avg(known.map((teamId) => finite(profileByTeam.get(teamId).strength_score))), 2),
      regular_match_count: regularRows.filter((row) => known.includes(row.team_a_id) || known.includes(row.team_b_id)).length,
      teams: known,
    };
  }).filter((group) => group.size > 0);

  if (!groups.length) return null;

  for (const row of profiles) {
    if (!groupByTeam.has(row.team_id)) groupByTeam.set(row.team_id, '未分组');
  }

  return {
    method: `manual_groups from ${path.relative(process.cwd(), DIVISION_CONFIG_PATH)}`,
    source_matches: regularRows.length,
    groupByTeam,
    groups,
  };
}

function inferGroups(matchRows, profiles, divisionConfig) {
  const manual = manualGroupsFromConfig(matchRows, profiles, divisionConfig);
  if (manual) return manual;

  const profileByTeam = new Map(profiles.map((row) => [row.team_id, row]));
  const profileTeamIds = profiles.map((row) => row.team_id).filter(Boolean);
  const regularRows = matchRows.filter((row) =>
    String(row.tournament || '').includes('LPL 2026 Split 2')
    && !String(row.tournament || '').includes('Playoffs')
    && row.team_a_id
    && row.team_b_id
  );
  const edges = regularRows.map((row) => [row.team_a_id, row.team_b_id]);
  const components = connectedComponents(edges, profileTeamIds)
    .filter((members) => members.some((teamId) => profileByTeam.has(teamId)))
    .map((members) => {
      const known = members.filter((teamId) => profileByTeam.has(teamId));
      const avgStrength = avg(known.map((teamId) => finite(profileByTeam.get(teamId).strength_score)));
      const matchCount = regularRows.filter((row) => known.includes(row.team_a_id) || known.includes(row.team_b_id)).length;
      return {
        members: known,
        size: known.length,
        avg_strength_raw: round(avgStrength, 2),
        regular_match_count: matchCount,
      };
    })
    .sort((a, b) => b.avg_strength_raw - a.avg_strength_raw || b.size - a.size);

  const groupByTeam = new Map();
  const groups = components.map((component, index) => {
    const name = index === 0 ? '登峰组' : index === 1 ? '涅槃组' : `未识别组${index + 1}`;
    for (const teamId of component.members) groupByTeam.set(teamId, name);
    return {
      name,
      ...component,
      teams: component.members,
    };
  });

  for (const teamId of profileTeamIds) {
    if (!groupByTeam.has(teamId)) groupByTeam.set(teamId, '未分组');
  }

  return {
    method: 'regular-season schedule connected components; stronger component labeled 登峰组',
    source_matches: regularRows.length,
    groupByTeam,
    groups,
  };
}

function findSide(row, teamId) {
  if (row.team_a_id === teamId) {
    return {
      side: row.blue_team_id === teamId ? 'blue' : 'red',
      opponent_id: row.team_b_id,
      opponent: row.team_b,
      kills: finite(row.team_a_kills),
      deaths: finite(row.team_b_kills),
    };
  }
  if (row.team_b_id === teamId) {
    return {
      side: row.blue_team_id === teamId ? 'blue' : 'red',
      opponent_id: row.team_a_id,
      opponent: row.team_a,
      kills: finite(row.team_b_kills),
      deaths: finite(row.team_a_kills),
    };
  }
  return null;
}

function mapDate(row) {
  return String(row.match_time || row.match_date || '');
}

function recentMaps(mapRows, teamId) {
  return mapRows
    .filter((row) => row.team_a_id === teamId || row.team_b_id === teamId)
    .sort((a, b) => mapDate(a).localeCompare(mapDate(b)) || finite(a.bo) - finite(b.bo))
    .slice(-8)
    .map((row) => {
      const side = findSide(row, teamId);
      return {
        date: row.match_time || row.match_date || '',
        match: row.match_name,
        bo: row.bo,
        patch: row.patch,
        side: side?.side || '',
        result: row.map_winner_id === teamId ? 'W' : 'L',
        opponent: side?.opponent || '',
        kills: side?.kills ?? '',
        deaths: side?.deaths ?? '',
        total_kills: row.total_kills,
        game_time_min: row.game_time_min,
      };
    })
    .reverse();
}

function heroPool(playerRows, teamId) {
  const counts = new Map();
  for (const row of playerRows) {
    if (row.team_id !== teamId || !row.hero) continue;
    const key = `${row.role}|${row.hero}`;
    const item = counts.get(key) || { role: row.role, hero: row.hero, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || String(a.role).localeCompare(String(b.role)))
    .slice(0, 12);
}

function modelNote(team) {
  const bits = [];
  if (team.group_name) bits.push(`${team.group_name}第 ${team.group_rank}/${team.group_size}`);
  if (team.group_adjustment > 0) bits.push(`跨组折算修正 +${team.group_adjustment}`);
  if (team.group_adjustment < 0) bits.push(`跨组折算修正 ${team.group_adjustment}`);
  if (team.group_name === '涅槃组') bits.push('涅槃组原始高分只代表组内强，不等于登峰组同分');
  if (team.tier === 'S' || team.tier === 'A') bits.push('赛程修正后综合强度靠前');
  if (team.attributes.attack >= 65) bits.push('进攻端突出');
  if (team.attributes.defense >= 65) bits.push('防守/控死能力较好');
  if (team.attributes.early >= 65) bits.push('前期优势明显');
  if (team.attributes.objective >= 65) bits.push('资源控制稳定');
  if (team.attributes.tempo >= 65) bits.push('节奏偏快，适合关注总击杀线');
  if (team.attributes.volatility >= 65) bits.push('波动较大，胜负盘要降权');
  if (team.confidence < 50) bits.push('样本置信度偏低');
  if (team.current_patch_maps < 5) bits.push('当前版本样本不足');
  return bits.length ? bits.join('；') + '。' : '整体特征接近联盟中位，更多依赖对阵和盘口价格。';
}

async function main() {
  await mkdir(ANALYSIS_DIR, { recursive: true });
  const [profiles, mapRows, playerRows, matchRows, divisionConfig] = await Promise.all([
    readCsv(PROFILE_CSV),
    readCsvIfExists(MAP_CSV),
    readCsvIfExists(PLAYER_CSV),
    readCsvIfExists(MATCH_CSV),
    loadDivisionConfig(),
  ]);

  if (!profiles.length || profiles[0].empty != null) {
    throw new Error(`missing team profile csv: ${PROFILE_CSV}`);
  }

  const groupInfo = inferGroups(matchRows, profiles, divisionConfig);
  const leagueAvgStrengthRaw = round(avg(profiles.map((profile) => finite(profile.strength_score))), 2);
  const groupStatsByName = new Map(groupInfo.groups.map((group) => [group.name, group]));
  const divisionBaselineAdjustment = {
    ...DEFAULT_DIVISION_CONFIG.baseline_adjustment,
    ...(divisionConfig.baseline_adjustment || {}),
  };

  const enriched = profiles.map((profile) => {
    const rawStrength = round(profile.strength_score, 1);
    const groupName = groupInfo.groupByTeam.get(profile.team_id) || '未分组';
    const groupStats = groupStatsByName.get(groupName);
    const groupRows = profiles.filter((row) => (groupInfo.groupByTeam.get(row.team_id) || '未分组') === groupName);
    const peerRows = groupRows.length >= 4 ? groupRows : profiles;
    const baselineAdjustment = divisionBaselineAdjustment[groupName] ?? divisionBaselineAdjustment['未分组'] ?? -2.0;
    const groupMeanAdjustment = groupStats ? round((finite(groupStats.avg_strength_raw) - leagueAvgStrengthRaw) * 0.25, 1) : 0;
    const groupAdjustment = round(baselineAdjustment + groupMeanAdjustment, 1);
    const ratingScore = round(rawStrength + groupAdjustment, 1);
    const tempo = round(profile.tempo_score, 1);
    const confidence = round(finite(profile.strength_score_confidence) * 100, 1);
    const attributes = {
      strength: round(ratingScore, 1),
      tempo: round(tempo, 1),
      momentum: pctRank(peerRows, 'recent_10_map_win_rate', profile.recent_10_map_win_rate),
      attack: composite([
        { value: pctRank(peerRows, 'avg_kills', profile.avg_kills), weight: 0.38 },
        { value: pctRank(peerRows, 'avg_kill_diff', profile.avg_kill_diff), weight: 0.32 },
        { value: pctRank(peerRows, 'dpm', profile.dpm), weight: 0.30 },
      ]),
      defense: composite([
        { value: pctRank(peerRows, 'avg_deaths', profile.avg_deaths, true), weight: 0.45 },
        { value: pctRank(peerRows, 'map_win_rate', profile.map_win_rate), weight: 0.35 },
        { value: pctRank(peerRows, 'series_0_2_loss_rate', profile.series_0_2_loss_rate, true), weight: 0.20 },
      ]),
      early: composite([
        { value: pctRank(peerRows, 'gd_at_15', profile.gd_at_15), weight: 0.45 },
        { value: pctRank(peerRows, 'first_turret_rate', profile.first_turret_rate), weight: 0.35 },
        { value: pctRank(peerRows, 'first_blood_rate', profile.first_blood_rate), weight: 0.20 },
      ]),
      objective: composite([
        { value: pctRank(peerRows, 'dragon_control_rate', profile.dragon_control_rate), weight: 0.40 },
        { value: pctRank(peerRows, 'baron_control_rate', profile.baron_control_rate), weight: 0.35 },
        { value: pctRank(peerRows, 'herald_control_rate', profile.herald_control_rate), weight: 0.25 },
      ]),
      volatility: composite([
        { value: pctRank(peerRows, 'kill_over_33_5_rate', profile.kill_over_33_5_rate), weight: 0.32 },
        { value: pctRank(peerRows, 'series_go_3_maps_rate', profile.series_go_3_maps_rate), weight: 0.28 },
        { value: pctRank(peerRows, 'avg_total_kills', profile.avg_total_kills), weight: 0.25 },
        { value: 100 - confidence, weight: 0.15 },
      ]),
      patch_fit: round(clamp(finite(profile.current_patch_maps) / Math.max(8, finite(profile.maps) * 0.35), 0, 1) * 100, 1),
      confidence,
    };

    const team = {
      ...profile,
      raw_strength_score: rawStrength,
      group_internal_score: rawStrength,
      division_baseline_adjustment: baselineAdjustment,
      group_mean_adjustment: groupMeanAdjustment,
      group_adjustment: groupAdjustment,
      rating_score: ratingScore,
      strength_score: ratingScore,
      tempo_score: tempo,
      confidence,
      group_name: groupName,
      group_size: groupStats?.size || peerRows.length,
      group_avg_strength_raw: groupStats?.avg_strength_raw || leagueAvgStrengthRaw,
      attribute_scope: groupRows.length >= 4 ? groupName : '全联盟',
      attributes,
      tier: tier(ratingScore),
      rank: 0,
      group_rank: 0,
      style_label: '',
      recent_maps: recentMaps(mapRows, profile.team_id),
      hero_pool: heroPool(playerRows, profile.team_id),
      warnings: [
        confidence < 50 ? '样本置信度偏低' : '',
        finite(profile.maps) < 20 ? '总地图样本 < 20' : '',
        finite(profile.current_patch_maps) < 5 ? '当前版本样本 < 5' : '',
        attributes.volatility >= 70 ? '高波动' : '',
      ].filter(Boolean),
    };
    team.style_label = styleLabel(team);
    team.model_note = modelNote(team);
    return team;
  }).sort((a, b) => b.rating_score - a.rating_score);

  enriched.forEach((team, index) => {
    team.rank = index + 1;
  });
  for (const group of groupInfo.groups) {
    enriched
      .filter((team) => team.group_name === group.name)
      .sort((a, b) => b.rating_score - a.rating_score)
      .forEach((team, index) => {
        team.group_rank = index + 1;
      });
  }
  for (const team of enriched) {
    team.style_label = styleLabel(team);
    team.model_note = modelNote(team);
  }

  const ranking = enriched.map((team) => ({
    rank: team.rank,
    group_name: team.group_name,
    group_rank: team.group_rank,
    team_id: team.team_id,
    team: team.team,
    tier: team.tier,
    style_label: team.style_label,
    rating_score: team.rating_score,
    group_internal_score: team.group_internal_score,
    raw_strength_score: team.raw_strength_score,
    division_baseline_adjustment: team.division_baseline_adjustment,
    group_mean_adjustment: team.group_mean_adjustment,
    group_adjustment: team.group_adjustment,
    strength_score: team.strength_score,
    tempo_score: team.tempo_score,
    confidence: team.confidence,
    maps: team.maps,
    current_patch_maps: team.current_patch_maps,
    attack: team.attributes.attack,
    defense: team.attributes.defense,
    early: team.attributes.early,
    objective: team.attributes.objective,
    volatility: team.attributes.volatility,
    recent_10_map_win_rate: pctText(team.recent_10_map_win_rate),
    model_note: team.model_note,
  }));

  const insight = {
    generated_at: new Date().toISOString(),
    source_profile_csv: PROFILE_CSV,
    team_count: enriched.length,
    grouping: {
      method: groupInfo.method,
      config_path: DIVISION_CONFIG_PATH,
      config_version: divisionConfig.version || 'unknown',
      source_matches: groupInfo.source_matches,
      league_avg_strength_raw: leagueAvgStrengthRaw,
      division_baseline_adjustment: divisionBaselineAdjustment,
      groups: groupInfo.groups,
    },
    league: {
      avg_strength: round(avg(enriched.map((team) => team.rating_score)), 1),
      avg_raw_strength: round(avg(enriched.map((team) => team.raw_strength_score)), 1),
      avg_tempo: round(avg(enriched.map((team) => team.tempo_score)), 1),
      avg_confidence: round(avg(enriched.map((team) => team.confidence)), 1),
    },
    teams: enriched,
    ranking,
  };

  await writeFile(OUT_JSON, `${JSON.stringify(insight, null, 2)}\n`, 'utf8');
  await writeFile(GROUP_JSON, `${JSON.stringify(insight.grouping, null, 2)}\n`, 'utf8');
  await writeCsv(OUT_CSV, ranking, unionColumns(ranking));
  console.log(`team insights exported: ${enriched.length} teams`);
  console.log(OUT_JSON);
}

main().catch((error) => {
  console.error(`team insights export failed: ${error.message}`);
  process.exitCode = 1;
});
