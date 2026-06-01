import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, 'lck', 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const ANALYSIS_DIR = path.join(DATA_DIR, '盘口分析');
export const DEFAULT_TOURNAMENT = 'LCK 2026 Rounds 1-2';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function argNumber(name, fallback = 0) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function num(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number(String(value).replace('%', '').replaceAll(',', '').replace(/[kK]$/, ''));
  if (!Number.isFinite(parsed)) return fallback;
  return /[kK]$/.test(String(value)) ? parsed * 1000 : parsed;
}

export function pct(wins, total) {
  return total ? wins / total : 0;
}

export function avg(total, count, digits = 3) {
  return count ? Number((total / count).toFixed(digits)) : 0;
}

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function pctText(value) {
  if (value === '' || value == null || Number.isNaN(Number(value))) return '';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function decimal(value, digits = 3) {
  if (value === '' || value == null || Number.isNaN(Number(value))) return '';
  return Number(value).toFixed(digits);
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((col) => csvEscape(row[col])).join(','));
  return `\uFEFF${lines.join('\n')}\n`;
}

export async function writeCsv(filePath, rows, columns = unionColumns(rows)) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, toCsv(rows, columns), 'utf8');
}

export async function readCsv(filePath) {
  return parseCsv(await readFile(filePath, 'utf8'));
}

export async function readCsvIfExists(filePath) {
  try {
    return await readCsv(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function parseCsv(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  const lines = clean.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

export function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function unionColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns.length ? columns : ['empty'];
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function cleanText(text) {
  return decodeEntities(String(text || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headerKey(text, index = 0, used = new Set()) {
  let key = cleanText(text)
    .toLowerCase()
    .replace('%', 'pct')
    .replace('@', '_at_')
    .replace(/:/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!key) key = `col_${index + 1}`;
  const base = key;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

export function htmlCells(rowHtml) {
  return [...String(rowHtml || '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => ({
    html: match[1],
    text: cleanText(match[1]),
    className: (match[0].match(/class=['"]([^'"]+)['"]/i) || [])[1] || '',
  }));
}

export function parseHtmlTables(html) {
  const tables = [];
  for (const tableMatch of String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tableHtml = tableMatch[0];
    const caption = cleanText((tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i) || [])[1] || '');
    const rawHeaders = [...tableHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => cleanText(match[1]));
    const used = new Set();
    const headers = rawHeaders.map((header, index) => headerKey(header, index, used));
    const rows = [];
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (/<th\b/i.test(rowMatch[1])) continue;
      const cells = htmlCells(rowMatch[1]);
      if (!cells.length || cells.every((cell) => !cell.text)) continue;
      const row = {};
      for (let i = 0; i < cells.length; i += 1) {
        const key = headers[i] || `col_${i + 1}`;
        row[key] = cells[i].text;
      }
      rows.push(row);
    }
    if (rows.length || headers.length) tables.push({ caption, headers, rows, html: tableHtml });
  }
  return tables;
}

export function extractAltNames(html) {
  const championFileNames = {
    BelVeth: "Bel'Veth",
    ChoGath: "Cho'Gath",
    KaiSa: "Kai'Sa",
    KhaZix: "Kha'Zix",
    KogMaw: "Kog'Maw",
    KSante: "K'Sante",
    RekSai: "Rek'Sai",
    VelKoz: "Vel'Koz",
  };
  return [...String(html || '').matchAll(/<img\b[^>]*>/gi)]
    .map((match) => {
      const tag = match[0];
      const file = (tag.match(/champions_icon\/([A-Za-z0-9]+)\.png/i) || [])[1];
      if (file && championFileNames[file]) return championFileNames[file];
      const alt = (tag.match(/alt=['"]([^'"]+)['"]/i) || [])[1] || '';
      return cleanText(alt);
    })
    .filter((name) => name && !['Kills', 'Towers', 'Dragons', 'Nashor', 'Team Gold', 'First Blood', 'First Tower'].includes(name));
}

export async function fetchText(url, options = {}, tries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'user-agent': 'Mozilla/5.0 LCK market model',
          ...(options.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(700 * attempt);
    }
  }
  throw lastError;
}

export function golUrl(kind, tournament = DEFAULT_TOURNAMENT) {
  const encoded = encodeURIComponent(tournament).replaceAll('%20', '%20');
  if (kind === 'matchlist') return `https://gol.gg/tournament/tournament-matchlist/${encoded}/`;
  if (kind === 'teams') return `https://gol.gg/teams/list/season-ALL/split-ALL/tournament-${encoded}/`;
  if (kind === 'players') return `https://gol.gg/players/list/season-ALL/split-ALL/tournament-${encoded}/`;
  if (kind === 'champions') return `https://gol.gg/champion/list/season-ALL/split-ALL/tournament-${encoded}/`;
  throw new Error(`Unknown GOL URL kind: ${kind}`);
}

export function absoluteGolUrl(href) {
  return new URL(String(href || '').replace(/&amp;/g, '&'), 'https://gol.gg/tournament/').toString();
}

export function safeFileName(name) {
  return String(name || 'file').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 120);
}

export function teamKey(name) {
  const raw = cleanText(name);
  if (!raw) return '';
  const compact = raw
    .toLowerCase()
    .replace(/\.|\s|-/g, '')
    .replace(/[^a-z0-9]/g, '');
  const aliases = {
    geng: 'GEN',
    gengaming: 'GEN',
    genglol: 'GEN',
    gengesports: 'GEN',
    hle: 'HLE',
    hanwhalife: 'HLE',
    hanwhalifeesports: 'HLE',
    t1: 'T1',
    dk: 'DK',
    dpluskia: 'DK',
    dplus: 'DK',
    dwgkia: 'DK',
    damwongaming: 'DK',
    damwon: 'DK',
    kt: 'KT',
    ktrolster: 'KT',
    drx: 'DRX',
    kiwoomdrx: 'DRX',
    krx: 'DRX',
    bnkfearx: 'FOX',
    fearx: 'FOX',
    bfx: 'FOX',
    fox: 'FOX',
    liivsandbox: 'FOX',
    sandbox: 'FOX',
    lsb: 'FOX',
    ns: 'NS',
    nongshim: 'NS',
    nongshimredforce: 'NS',
    bro: 'BRO',
    hanjinbrion: 'BRO',
    brion: 'BRO',
    okbrion: 'BRO',
    freditbrion: 'BRO',
    oksavingsbankbrion: 'BRO',
    oksavingsbank: 'BRO',
    dnsoopers: 'DNF',
    dnfreecs: 'DNF',
    dnf: 'DNF',
    dns: 'DNF',
    kwangdongfreecs: 'DNF',
    kdf: 'DNF',
    afreecafreecs: 'DNF',
  };
  return aliases[compact] || raw.toUpperCase();
}

export function displayTeam(key, fallback = '') {
  const names = {
    GEN: 'Gen.G',
    HLE: 'Hanwha Life Esports',
    T1: 'T1',
    DK: 'Dplus KIA',
    KT: 'KT Rolster',
    DRX: 'Kiwoom DRX',
    FOX: 'BNK FearX',
    NS: 'Nongshim RedForce',
    BRO: 'HANJIN BRION',
    DNF: 'DN SOOPers',
  };
  return names[key] || fallback || key;
}

export function parseDurationToMinutes(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+):(\d{2})$/);
  if (match) return Number((Number(match[1]) + Number(match[2]) / 60).toFixed(2));
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

export function parsePercent(value) {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace('%', ''));
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

export function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}
