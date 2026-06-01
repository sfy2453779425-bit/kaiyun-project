export function normalizeModelMode(value = process.env.MODEL_MODE) {
  return String(value || 'legacy').toLowerCase() === 'new' ? 'new' : 'legacy';
}

export const MODEL_MODE = normalizeModelMode();
export const USE_NEW_MODEL = MODEL_MODE === 'new';
