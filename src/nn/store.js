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
      data: [], dataUp: [], dataDown: [], dataMomentum: [], dataAligned: [],
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

    // Backwards-compat: older brain files may not have mode-specific NNs
    if (!weights.w1Momentum) {
      const fresh = initWeights();
      weights.w1Momentum = fresh.w1Momentum; weights.b1Momentum = fresh.b1Momentum;
      weights.w2Momentum = fresh.w2Momentum; weights.b2Momentum = fresh.b2Momentum;
      weights.w1Aligned  = fresh.w1Aligned;  weights.b1Aligned  = fresh.b1Aligned;
      weights.w2Aligned  = fresh.w2Aligned;  weights.b2Aligned  = fresh.b2Aligned;
    }

    // Migrate 9-input weights to 13-input by padding new weight columns with small random values.
    // w1 shape: [HIDDEN][INPUT] = [8][9] → [8][13]. Pad each row with 4 new small weights.
    const padWeights = (w1) => {
      if (!w1 || w1[0]?.length >= 13) return w1;
      return w1.map(row => [...row, ...[0,0,0,0].map(() => (Math.random() * 2 - 1) * 0.05)]);
    };
    weights.w1         = padWeights(weights.w1);
    weights.w1Up       = padWeights(weights.w1Up);
    weights.w1Down     = padWeights(weights.w1Down);
    weights.w1Momentum = padWeights(weights.w1Momentum);
    weights.w1Aligned  = padWeights(weights.w1Aligned);

    // Migrate 9-feature samples to 13 by padding with neutral context defaults.
    // Neutral values: secsLeft=0.5 (mid-window), adx=0.5 (moderate), pctAbove=0 (neutral), spread=0.5 (mid)
    const padFeatures = (sample) => {
      if (!sample.f || sample.f.length >= 13) return sample;
      return { ...sample, f: [...sample.f, 0.5, 0.5, 0.0, 0.5] };
    };
    const data         = (raw.data         ?? []).map(padFeatures);
    const dataUp       = (raw.dataUp       ?? []).map(padFeatures);
    const dataDown     = (raw.dataDown     ?? []).map(padFeatures);
    const dataMomentum = (raw.dataMomentum ?? []).map(padFeatures);
    const dataAligned  = (raw.dataAligned  ?? []).map(padFeatures);
    const wasMigrated  = (raw.data?.[0]?.f?.length ?? 13) < 13;
    console.log(`[Brain] Loaded ${asset}: ${data.length} combined, ${dataUp.length} UP, ${dataDown.length} DOWN, ${dataMomentum.length} MOMENTUM, ${dataAligned.length} ALIGNED samples (${raw.at ?? 'unknown date'})${wasMigrated ? ' [migrated 9→13 features]' : ''}`);
    return { weights, data, dataUp, dataDown, dataMomentum, dataAligned };
  } catch (err) {
    console.error(`[Brain] Failed to load ${asset} brain:`, err.message);
    return { weights: initWeights(), data: [], dataUp: [], dataDown: [], dataMomentum: [], dataAligned: [] };
  }
}

export async function saveBrain(asset, weights, data, dataUp, dataDown, dataMomentum = [], dataAligned = []) {
  const p = brainPath(asset);
  const payload = JSON.stringify({ weights, data, dataUp, dataDown, dataMomentum, dataAligned, at: new Date().toISOString() });
  await fs.promises.writeFile(p, payload, 'utf8');
}

// Record a completed trade, retrain, and persist.
//
// pctCaptured: fraction of maxProfit realised (positive for wins).
//   Win  → q = 0.5 + 0.5 × clamp(pctCaptured, 0, 1)
//              60% capture → q=0.80 (strong reinforce); 10% capture → q=0.55 (mild)
//   Loss → q = 0 (hard negative target regardless of size)
//
// w (gradient weight) amplifies the update signal proportionally to outcome quality:
//   Win  → w = 1 + clamp(pctCaptured, 0, 1)   — up to 2× for excellent exits
//   Loss → w = 1 + clamp(|pnl/amount|, 0, 1) × 3
//              fast 5% reversal → w≈1.15 (gentle); full -15% stop → w≈1.45 (firm)
//
// The binary class l (0/1) is kept for balanced batch sampling — NOT used as target.
// mode: 'MOMENTUM' | 'ALIGNED' | null — routes sample to mode-specific NN dataset
export async function recordTrade(asset, brain, featuresNorm, featuresRaw, bet, win,
                                   pctCaptured = 0, pnl = 0, amount = 1, mode = null) {
  const { weights, data, dataUp, dataDown } = brain;
  if (!brain.dataMomentum) brain.dataMomentum = [];
  if (!brain.dataAligned)  brain.dataAligned  = [];
  const { dataMomentum, dataAligned } = brain;

  // Outcome quality label and gradient weight
  let q, w;
  if (win) {
    const cap = Math.min(Math.max(pctCaptured, 0), 1);
    q = 0.5 + 0.5 * cap;              // [0.50, 1.00] — scaled by how much profit was kept
    w = 1 + cap;                       // [1.0,  2.0]  — bigger capture = stronger reinforce
  } else {
    const lossPct = Math.min(Math.abs(amount > 0 ? pnl / amount : 0), 1);
    q = 0;                             // hard negative target — avoid these entry conditions
    w = 1 + lossPct * 3;               // [1.0,  4.0]  — bigger loss = stronger penalty
  }

  const l  = win ? 1 : 0; // binary class for batch sampling only
  const ts = Date.now();   // timestamp for recency weighting (30-day half-life)

  // Combined NN: direction-normalised features
  data.push({ f: featuresNorm, l, q, w, ts });

  // Directional NNs: raw features
  if (bet === 'UP')   dataUp.push({ f: featuresRaw, l, q, w, ts });
  else                dataDown.push({ f: featuresRaw, l, q, w, ts });

  // Mode-specific NNs: raw features routed by trade mode
  if (mode === 'MOMENTUM') dataMomentum.push({ f: featuresRaw, l, q, w, ts });
  if (mode === 'ALIGNED')  dataAligned.push({  f: featuresRaw, l, q, w, ts });

  // Retrain all NNs
  train(weights, data, dataUp, dataDown, dataMomentum, dataAligned);

  // Persist immediately — data only lives in JSON files
  await saveBrain(asset, weights, data, dataUp, dataDown, dataMomentum, dataAligned);

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
  const { data, dataUp, dataDown, dataMomentum = [], dataAligned = [] } = brain;
  const winRate = (arr) => {
    if (!arr.length) return null;
    return (arr.filter(d => d.l === 1).length / arr.length * 100).toFixed(1) + '%';
  };
  return {
    asset,
    combined: { samples: data.length, winRate: winRate(data) },
    up:       { samples: dataUp.length, winRate: winRate(dataUp) },
    down:     { samples: dataDown.length, winRate: winRate(dataDown) },
    momentum: { samples: dataMomentum.length, winRate: winRate(dataMomentum) },
    aligned:  { samples: dataAligned.length,  winRate: winRate(dataAligned) },
  };
}
