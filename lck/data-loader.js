import path from 'node:path';
import { DATA_DIR, readCsv, readCsvIfExists, teamKey } from './shared.js';

export const MANUAL_MATCHES_PATH = path.join(DATA_DIR, 'manual_recent_matches.csv');
export const MANUAL_MAPS_PATH = path.join(DATA_DIR, 'manual_recent_maps.csv');

function matchDedupeKey(row) {
  const date = String(row.match_date || row.match_time || '').slice(0, 10);
  const teams = [teamKey(row.team_a_id || row.team_a), teamKey(row.team_b_id || row.team_b)]
    .filter(Boolean)
    .sort()
    .join('|');
  return date && teams ? `${date}|${teams}` : '';
}

function preferManualRows(baseRows, manualRows, idField, keyFn) {
  const byId = new Map();
  const byKey = new Map();

  for (const row of baseRows) {
    const id = String(row[idField] || '');
    const key = keyFn(row);
    if (id) byId.set(id, row);
    if (key) byKey.set(key, id || key);
  }

  for (const row of manualRows) {
    const id = String(row[idField] || '');
    const key = keyFn(row);
    const existingId = key ? byKey.get(key) : '';
    if (existingId && byId.has(existingId)) byId.delete(existingId);
    if (id) {
      byId.set(id, row);
      if (key) byKey.set(key, id);
    }
  }

  return [...byId.values()];
}

export async function readLckData({ includeManual = true } = {}) {
  const [matches, maps, summary] = await Promise.all([
    readCsv(path.join(DATA_DIR, 'lck_matches.csv')),
    readCsv(path.join(DATA_DIR, 'lck_map_details.csv')),
    readCsv(path.join(DATA_DIR, 'lck_team_detail_summary.csv')),
  ]);
  if (!includeManual) return { matches, maps, summary };

  const [manualMatches, manualMaps] = await Promise.all([
    readCsvIfExists(MANUAL_MATCHES_PATH),
    readCsvIfExists(MANUAL_MAPS_PATH),
  ]);

  return {
    matches: preferManualRows(matches, manualMatches, 'match_id', matchDedupeKey),
    maps: preferManualRows(maps, manualMaps, 'game_id', (row) => String(row.game_id || '')),
    summary,
    manualMatches,
    manualMaps,
  };
}
