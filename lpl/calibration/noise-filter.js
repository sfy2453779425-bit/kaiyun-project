import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clamp, num } from '../shared.js';

const DEFAULT_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'noise_filter_candidate.json');

let cachedPath = '';
let cachedFilter = null;

export function loadNoiseFilter(filePath = DEFAULT_PATH) {
  const resolved = path.resolve(filePath);
  if (cachedPath === resolved) return cachedFilter;
  cachedPath = resolved;
  cachedFilter = null;
  if (!existsSync(resolved)) return null;
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
    cachedFilter = parsed?.deploy === true ? parsed : null;
  } catch {
    cachedFilter = null;
  }
  return cachedFilter;
}

export function noiseFilterDecision(row, filePath = DEFAULT_PATH) {
  const filter = loadNoiseFilter(filePath);
  if (!filter) return null;
  const rules = filter.rules || {};
  const market = row.market || '';
  const blockedMarkets = new Set(rules.block_markets || []);
  if (blockedMarkets.has(market)) {
    return {
      action: 'block',
      reason: `noise_filter: market ${market} is blocked by deployed noise filter`,
    };
  }

  const minSample = num(rules.min_sample, 0);
  if (minSample > 0 && num(row.sample, 0) < minSample) {
    return {
      action: 'block',
      reason: `noise_filter: sample ${num(row.sample, 0)} < ${minSample}`,
    };
  }

  const marketMinSamples = rules.market_min_sample || {};
  const marketMin = num(marketMinSamples[market], 0);
  if (marketMin > 0 && num(row.sample, 0) < marketMin) {
    return {
      action: 'block',
      reason: `noise_filter: ${market} sample ${num(row.sample, 0)} < ${marketMin}`,
    };
  }

  return null;
}

function adjustedProbability(method, probability, row) {
  const p = num(probability, NaN);
  if (!Number.isFinite(p)) return probability;
  if (method === 'shrink_10') return clamp(0.5 + 0.90 * (p - 0.5), 0.02, 0.98);
  if (method === 'shrink_20') return clamp(0.5 + 0.80 * (p - 0.5), 0.02, 0.98);
  if (method === 'shrink_30') return clamp(0.5 + 0.70 * (p - 0.5), 0.02, 0.98);
  if (method === 'market_gap_adjust_50') {
    const gap = num(row.prior_market_gap, NaN);
    return Number.isFinite(gap) ? clamp(p - 0.5 * gap, 0.02, 0.98) : p;
  }
  if (method === 'market_gap_adjust_100') {
    const gap = num(row.prior_market_gap, NaN);
    return Number.isFinite(gap) ? clamp(p - gap, 0.02, 0.98) : p;
  }
  if (method === 'line_gap_adjust_50') {
    const gap = num(row.prior_line_gap, NaN);
    return Number.isFinite(gap) ? clamp(p - 0.5 * gap, 0.02, 0.98) : p;
  }
  return p;
}

export function applyNoiseAdjustment(row, probability, filePath = DEFAULT_PATH) {
  const filter = loadNoiseFilter(filePath);
  if (!filter) {
    return {
      probability,
      action: '',
      reason: '',
      method: '',
    };
  }

  const gate = noiseFilterDecision(row, filePath);
  if (gate?.action === 'block') {
    return {
      probability: 0.5,
      action: 'block',
      reason: gate.reason,
      method: 'block',
    };
  }

  const market = row.market || '';
  const marketRule = (filter.market_rules || {})[market] || {};
  const method = marketRule.method || filter.selected_method || '';
  const adjusted = adjustedProbability(method, probability, row);
  if (!method || adjusted === probability) {
    return {
      probability,
      action: '',
      reason: '',
      method: '',
    };
  }

  return {
    probability: adjusted,
    action: 'adjust',
    reason: `noise_filter: ${method} adjusted p ${num(probability).toFixed(4)} -> ${num(adjusted).toFixed(4)}`,
    method,
  };
}
