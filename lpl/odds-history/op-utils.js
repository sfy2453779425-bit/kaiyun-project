import { webcrypto } from 'node:crypto';
import zlib from 'node:zlib';

const ODDS_KEY = 'J*8sQ!p$7aD_fR2yW@gHn*3bVp#sAdLd_k';
const ODDS_SALT = '5b9a8f2c3e6d1a4b7c8e9d0f1a2b3c4d';

export function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function decryptOddsPortalPayload(payload) {
  const decoded = Buffer.from(payload, 'base64').toString('binary');
  const [cipherTextBase64, ivHex] = decoded.split(':');
  if (!cipherTextBase64 || !ivHex) throw new Error('Unexpected OddsPortal encrypted payload');
  const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map((hex) => parseInt(hex, 16)));
  const encoder = new TextEncoder();
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(ODDS_KEY),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(ODDS_SALT),
      iterations: 1000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  );
  const cipherBytes = new Uint8Array(Buffer.from(cipherTextBase64, 'base64'));
  const plainBytes = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipherBytes));
  const body = plainBytes[0] === 31 && plainBytes[1] === 139
    ? zlib.gunzipSync(plainBytes)
    : Buffer.from(plainBytes);
  return body.toString('utf8');
}

export async function fetchEncryptedJson(url, referer) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 LPL OP odds scraper',
      accept: 'application/json,text/plain,*/*',
      referer,
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`OddsPortal request failed: ${res.status} ${res.statusText}: ${url}`);
  const text = await res.text();
  return JSON.parse(await decryptOddsPortalPayload(text));
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 LPL OP odds scraper',
      accept: 'text/html,*/*',
      referer: 'https://www.oddsportal.com/',
    },
  });
  if (!res.ok) throw new Error(`OddsPortal page failed: ${res.status} ${res.statusText}: ${url}`);
  return res.text();
}

export function parseEventHeader(html) {
  const raw = String(html || '').match(/id=["']react-event-header["'][^>]+data='([^']+)'/)?.[1];
  if (!raw) throw new Error('react-event-header data not found');
  const json = JSON.parse(raw);
  const event = json.eventData || {};
  return {
    event_id: event.id,
    xhashf: decodeURIComponent(event.xhashf || ''),
    home: event.home,
    away: event.away,
    match_name: `${event.home} vs ${event.away}`,
    match_start_ts: event.startDate ? new Date(Number(event.startDate) * 1000).toISOString() : null,
    tournament: event.tournamentName || '',
    raw: json,
  };
}

export function average(values) {
  const nums = values.map(Number).filter((value) => Number.isFinite(value) && value > 1);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function oddsArrays(entry) {
  return Object.values(entry?.odds || {}).filter(Array.isArray);
}

export function summarizeOutcomeOdds(entry) {
  const arrays = oddsArrays(entry);
  const width = Math.max(0, ...arrays.map((arr) => arr.length));
  const rows = [];
  for (let i = 0; i < width; i += 1) {
    const current = arrays.map((arr) => arr[i]).filter((value) => Number(value) > 1);
    rows.push({
      avg_odds: average(current),
      max_odds: current.length ? Math.max(...current.map(Number)) : null,
      bookmaker_count: current.length,
    });
  }
  return rows;
}

export function marketFromBt(entry) {
  const bt = Number(entry.bettingTypeId);
  const line = Number(entry.handicapValue);
  if (bt === 3) return { market: 'match_win', selections: ['home', 'away'], lines: [null, null] };
  if (bt === 5) {
    const homeLine = Number.isFinite(line) ? line : null;
    const awayLine = Number.isFinite(line) ? -line : null;
    return { market: 'map_handicap', selections: ['home', 'away'], lines: [homeLine, awayLine] };
  }
  if (bt === 2) {
    const market = Number.isFinite(line) && line <= 5 ? 'map_total' : 'total_kills';
    return { market, selections: ['over', 'under'], lines: [line, line] };
  }
  return null;
}

export async function fetchEventOdds(event, referer, bettingTypes = [3, 5, 2, 8]) {
  const rows = [];
  const raw = {};
  for (const bt of bettingTypes) {
    const url = `https://www.oddsportal.com/match-event/1-36-${event.event_id}-${bt}-2-${event.xhashf}.dat?_=${Date.now()}`;
    try {
      const json = await fetchEncryptedJson(url, referer);
      raw[`bt_${bt}`] = json;
      const entries = Object.values(json.d?.oddsdata?.back || {});
      for (const entry of entries) {
        const mapped = marketFromBt(entry);
        if (!mapped) continue;
        const oddsRows = summarizeOutcomeOdds(entry);
        for (let i = 0; i < oddsRows.length && i < mapped.selections.length; i += 1) {
          const odd = oddsRows[i];
          if (!odd.avg_odds) continue;
          rows.push({
            market: mapped.market,
            selection: mapped.selections[i],
            line: mapped.lines[i] == null ? null : String(mapped.lines[i]),
            odds: Number(odd.avg_odds.toFixed(3)),
            max_odds: odd.max_odds == null ? null : Number(odd.max_odds.toFixed(3)),
            bookmaker_count: odd.bookmaker_count,
            betting_type_id: entry.bettingTypeId,
            scope_id: entry.scopeId,
            raw_key: `${entry.bettingTypeId}-${entry.scopeId}-${entry.handicapValue ?? ''}`,
          });
        }
      }
    } catch (error) {
      raw[`bt_${bt}_error`] = error.message;
    }
  }
  return { rows, raw };
}
