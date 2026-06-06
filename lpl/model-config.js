import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const EXPECTED_LPL_MODEL_MODE = 'production';
export const LPL_MODEL_MODE = process.env.LPL_MODEL_MODE || EXPECTED_LPL_MODEL_MODE;

const TOTAL_KILLS_COEF_PATH = path.join(process.cwd(), 'lpl', 'calibration', 'total_kills_model_coef.json');

function readJsonIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function totalKillsModelMeta() {
  const model = readJsonIfExists(TOTAL_KILLS_COEF_PATH);
  return {
    total_kills_model: model?.model || '',
    total_kills_deploy: model?.deploy === true ? 'true' : 'false',
    total_kills_model_generated_at: model?.generated_at || '',
  };
}

export function modelRunMeta() {
  const totalKills = totalKillsModelMeta();
  const signatureParts = [
    'lpl',
    LPL_MODEL_MODE,
    totalKills.total_kills_model || 'no-total-kills-model',
    totalKills.total_kills_deploy === 'true' ? 'deployed' : 'not-deployed',
  ];
  return {
    model_mode: LPL_MODEL_MODE,
    model_signature: signatureParts.join(':'),
    ...totalKills,
  };
}

export function modelModeLine() {
  const meta = modelRunMeta();
  return `Model mode: ${meta.model_mode}; signature: ${meta.model_signature}; total_kills=${meta.total_kills_model || '-'} deploy=${meta.total_kills_deploy}`;
}
