import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initWeights, train } from './network.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

function brainPath(asset) {
  return path.join(DATA_DIR, `${asset.toLowerCase()}_brain.json`);
}

export function loadBrain(asset) {
  const p = brainPath(asset);
  if (!fs.existsSync(p)) {
    console.log(`[Brain] No ${asset} brain found — starting fresh`);
    return {
      weights: initWeights(),
      data: [], dataUp: [], dataDown: [],
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const weights = raw.weights ?? initWeights();

    // Backwards-compat: older brain files may not have directional NNs
    if (!weights.w1Up) {
      const fresh = initWeights();
      weights.w1Up = fresh.w1Up; weights.b1Up = fresh.b1Up;
      weights.w2Up = fresh.w2Up; weights.b2Up = fresh.b2Up;
      weights.w1Down = fresh.w1Down; weights.b1Down = fresh.b1Down;
      weights.w2Down = fresh.w2Down; weights.b2Down = fresh.b2Down;
    }

    const data     = raw.data     ?? [];
    const dataUp   = raw.dataUp   ?? [];
    const dataDown = raw.dataDown ?? [];
    console.log(`[Brain] Loaded ${asset}: ${data.length} combined, ${dataUp.length} UP, ${dataDown.length} DOWN samples (${raw.at ?? 'unknown date'})`);
    return { weights, data, dataUp, dataDown };
  } catch (err) {
    console.error(`[Brain] Failed to load ${asset} brain:`, err.message);
    return { weights: initWeights(), data: [], dataUp: [], dataDown: [] };
  }
}

export async function saveBrain(asset, weights, data, dataUp, dataDown) {
  const p = brainPath(asset);
  const payload = JSON.stringify({ weights, data, dataUp, dataDown, at: new Date().toISOString() });
  await fs.promises.writeFile(p, payload, 'utf8');
}

// Record a completed trade, retrain, and persist
export async function recordTrade(asset, brain, featuresNorm, featuresRaw, bet, win) {
  const { weights, data, dataUp, dataDown } = brain;

  // Combined NN: direction-normalised features
  data.push({ f: featuresNorm, l: win ? 1 : 0 });

  // Directional NNs: raw features
  if (bet === 'UP')   dataUp.push({ f: featuresRaw, l: win ? 1 : 0 });
  else                dataDown.push({ f: featuresRaw, l: win ? 1 : 0 });

  // Retrain
  train(weights, data, dataUp, dataDown);

  // Persist immediately — data only lives in JSON files
  await saveBrain(asset, weights, data, dataUp, dataDown);

  return brain;
}

// Import a brain from exported JSON (e.g. from the browser app)
export function importBrain(asset, json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json; // throws SyntaxError on bad JSON
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid brain JSON: expected an object');
  }
  if (!raw.weights || !raw.weights.w1 || !raw.weights.b1 || !raw.weights.w2 || !raw.weights.b2) {
    throw new Error('Invalid brain JSON: missing required weights fields (w1, b1, w2, b2)');
  }
  const p = brainPath(asset);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...raw, at: new Date().toISOString() }), 'utf8');
  console.log(`[Brain] Imported ${asset} brain: ${raw.data?.length ?? 0} samples`);
}

export function exportBrain(asset) {
  const p = brainPath(asset);
  if (!fs.existsSync(p)) throw new Error(`No ${asset} brain file found`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Stats for MCP get_brain_stats tool
export function brainStats(brain, asset) {
  const { data, dataUp, dataDown } = brain;
  const winRate = (arr) => {
    if (!arr.length) return null;
    return (arr.filter(d => d.l === 1).length / arr.length * 100).toFixed(1) + '%';
  };
  return {
    asset,
    combined: { samples: data.length, winRate: winRate(data) },
    up:       { samples: dataUp.length, winRate: winRate(dataUp) },
    down:     { samples: dataDown.length, winRate: winRate(dataDown) },
  };
}
