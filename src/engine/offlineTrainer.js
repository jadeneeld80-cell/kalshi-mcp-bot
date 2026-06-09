/**
 * Offline trainer — keeps the NN learning between market windows.
 *
 * Activated when Kalshi markets are unavailable (e.g. overnight, maintenance).
 * Two activities run on a schedule:
 *
 * 1. DEEP RETRAIN — runs train() on existing quality-labelled samples.
 *    20 extra cycles at start, then 5 more every 5 minutes.
 *    Uses quality labels (q, w) already attached by recordTrade so the NN
 *    internalises which entry conditions led to big wins vs hard losses.
 *
 * 2. AUGMENTED PASS — adds noise-perturbed copies of each sample before
 *    training. Prevents overfitting on small datasets (< 50 samples) and
 *    encourages the NN to learn the underlying pattern rather than memorise
 *    specific feature values.
 *
 * Accuracy is estimated on the training set before/after each cycle so you
 * can watch the NN improve in the logs.
 */

import { train as nnTrain, predict } from '../nn/network.js';
import { saveBrain } from '../nn/store.js';

// How much noise to add to feature values in the augmented copies.
// 0.03 = 3% — small enough not to flip the direction of a signal, large enough
// to prevent exact-sample memorisation.
const AUGMENT_NOISE_STD = 0.03;

// How much to downscale the weight of an augmented (noisy) copy vs the original.
const AUGMENT_WEIGHT_SCALE = 0.80;

// Seconds between periodic offline training cycles.
const CYCLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const _timers  = {};   // setInterval handles keyed by asset
const _running = {};   // bool — prevents overlapping cycles

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the offline learning loop for one asset.
 * Safe to call multiple times — idempotent if already running.
 */
export function startOfflineTraining(asset, brain) {
  if (_timers[asset]) return; // already active

  const n = brain.data.length;
  console.log(`[Offline] ${asset} — starting offline learning (${n} combined samples)`);

  // Immediate burst: 20 cycles to quickly capture quality-weighted patterns
  _runCycle(asset, brain, 20);

  // Recurring: 5 more cycles every 5 minutes, keeps improving while market is closed
  _timers[asset] = setInterval(() => {
    _runCycle(asset, brain, 5);
  }, CYCLE_INTERVAL_MS);
}

/**
 * Stop the offline learning loop. Called when the market becomes available again.
 */
export function stopOfflineTraining(asset) {
  if (_timers[asset]) {
    clearInterval(_timers[asset]);
    delete _timers[asset];
    console.log(`[Offline] ${asset} — training paused (market found, bots resuming)`);
  }
}

// ── Internal ───────────────────────────────────────────────────────────────────

async function _runCycle(asset, brain, cycles) {
  // Prevent concurrent cycles for the same asset
  if (_running[asset]) return;
  _running[asset] = true;

  try {
    const { weights, data, dataUp, dataDown } = brain;
    const combined = data.length;
    const up       = dataUp.length;
    const down     = dataDown.length;

    if (combined < 4 && up < 4 && dataDown.length < 4) {
      console.log(`[Offline] ${asset} — not enough samples yet (${combined} combined), skipping`);
      return;
    }

    const before = _estimateAccuracy(weights, data);

    // Build augmented datasets: original samples + noise-perturbed copies
    const augData  = _augment(data);
    const augUp    = up   >= 4 ? _augment(dataUp)   : dataUp;
    const augDown  = down >= 4 ? _augment(dataDown) : dataDown;

    // Run training cycles on augmented data
    for (let i = 0; i < cycles; i++) {
      nnTrain(weights, augData, augUp, augDown);
    }

    const after = _estimateAccuracy(weights, data);

    console.log(
      `[Offline] ${asset} retrain ×${cycles} — ` +
      `accuracy ${_pct(before)} → ${_pct(after)} | ` +
      `samples: ${combined} combined, ${up} UP, ${down} DOWN`
    );

    // Persist improved weights so they survive a restart
    await saveBrain(asset, brain.weights, brain.data, brain.dataUp, brain.dataDown);

  } catch (err) {
    console.error(`[Offline] ${asset} training error:`, err.message);
  } finally {
    _running[asset] = false;
  }
}

/**
 * Augment a sample array by adding a noise-perturbed copy of each entry.
 * The noisy copy shares the same class label (l) and quality label (q) but
 * receives a downscaled gradient weight (w) so originals dominate training.
 */
function _augment(samples) {
  const out = [];
  for (const { f, l, q, w } of samples) {
    out.push({ f, l, q, w }); // original
    const fNoisy = f.map(x => x + (Math.random() * 2 - 1) * AUGMENT_NOISE_STD);
    out.push({
      f: fNoisy,
      l,
      q: q ?? l,
      w: Math.min((w ?? 1) * AUGMENT_WEIGHT_SCALE, 4), // cap at 4× for safety
    });
  }
  return out;
}

/**
 * Quick accuracy estimate: fraction of combined-NN predictions that match the
 * binary class label (l). Uses the combined NN only — directional NNs are
 * checked via their own training accuracy implicitly.
 */
function _estimateAccuracy(weights, data) {
  if (data.length < 2) return 0;
  let correct = 0;
  for (const { f, l } of data) {
    // Pass empty directional arrays → combined NN prediction only
    const prob = predict(weights, f, f, 'UP', [], []);
    if ((prob >= 0.5 && l === 1) || (prob < 0.5 && l === 0)) correct++;
  }
  return correct / data.length;
}

function _pct(r) { return (r * 100).toFixed(1) + '%'; }
