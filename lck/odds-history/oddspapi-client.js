// OddsPapi 免费 API 复用客户端: 节流 + 限流重试。
// key 从 --key= 或 env ODDSPAPI_KEY 读。
import { argValue } from '../shared.js';

export const BASE = 'https://api.oddspapi.io';
export const LOL_SPORT_ID = 18;
export const LCK_TOURNAMENT_ID = 2454;

export function getKey() {
  return argValue('key', process.env.ODDSPAPI_KEY || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function papiGet(path, params = {}, { key = getKey(), tries = 6 } = {}) {
  const qs = new URLSearchParams({ ...params, apiKey: key }).toString();
  const url = `${BASE}${path}?${qs}`;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      if (json?.error?.code === 'RATE_LIMITED') {
        await sleep(Math.ceil(Number(json.error.retryMs) || 1000) + 300);
        continue;
      }
      return { ok: res.ok, status: res.status, json, raw: text };
    } catch {
      await sleep(800 * (i + 1));
    }
  }
  return { ok: false, status: 0, json: null, raw: 'failed-after-retries' };
}

export async function listLckFixtures(opts = {}) {
  const r = await papiGet('/v4/fixtures', { tournamentId: LCK_TOURNAMENT_ID }, opts);
  const list = Array.isArray(r.json) ? r.json : (r.json?.data || []);
  return list;
}

// LoL 市场定义: marketId -> { name, type, handicap, outcomes:[{outcomeId,outcomeName}] }
export async function loadLolMarketDefs(opts = {}) {
  const r = await papiGet('/v4/markets', {}, opts);
  const arr = Array.isArray(r.json) ? r.json : (r.json?.data || []);
  const defs = new Map();
  for (const m of arr) {
    if (Number(m.sportId) !== LOL_SPORT_ID) continue;
    defs.set(String(m.marketId), {
      name: m.marketName,
      type: m.marketType,
      handicap: m.handicap,
      length: m.marketLength,
      outcomes: m.outcomes || [],
    });
  }
  return defs;
}

export async function getHistoricalOdds(fixtureId, bookmaker, opts = {}) {
  return papiGet('/v4/historical-odds', { fixtureId, bookmaker }, opts);
}

// 取一个价格序列的"收盘价"(最后一个 active 的 price)
export function closingPrice(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const active = series.filter((p) => p && p.price > 0);
  const last = active.at(-1) || series.at(-1);
  return last && last.price > 0 ? Number(last.price) : null;
}
