// 13 → 8 → 1 neural network with sigmoid activation
// Three NNs per asset: combined (normalised), UP-only, DOWN-only
// Feature vector: 9 price indicators + secsLeft, ADX, pctAbove, spread

const INPUT = 13;
const HIDDEN = 8;
const OUTPUT = 1;
const LEARNING_RATE = 0.05;
const MAX_SAMPLES_PER_CLASS = 150;
const TRAIN_BATCH = 60;
const EPOCHS = 12;
const DOWN_LOSS_WEIGHT = 2.0; // penalise DOWN misclassifications 2x to counter UP bias

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function sigmoidDeriv(s) { return s * (1 - s); }

function randomWeights(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (Math.random() * 2 - 1) * 0.5)
  );
}

function randomBias(size) {
  return Array.from({ length: size }, () => (Math.random() * 2 - 1) * 0.1);
}

export function initWeights() {
  return {
    // Combined NN (direction-normalised features)
    w1: randomWeights(HIDDEN, INPUT), b1: randomBias(HIDDEN),
    w2: randomWeights(OUTPUT, HIDDEN), b2: randomBias(OUTPUT),
    // UP-only NN
    w1Up: randomWeights(HIDDEN, INPUT), b1Up: randomBias(HIDDEN),
    w2Up: randomWeights(OUTPUT, HIDDEN), b2Up: randomBias(OUTPUT),
    // DOWN-only NN
    w1Down: randomWeights(HIDDEN, INPUT), b1Down: randomBias(HIDDEN),
    w2Down: randomWeights(OUTPUT, HIDDEN), b2Down: randomBias(OUTPUT),
    // MOMENTUM mode NN — trained only on MOMENTUM-mode trades (raw features)
    w1Momentum: randomWeights(HIDDEN, INPUT), b1Momentum: randomBias(HIDDEN),
    w2Momentum: randomWeights(OUTPUT, HIDDEN), b2Momentum: randomBias(OUTPUT),
    // ALIGNED mode NN — trained only on ALIGNED-mode trades (raw features)
    w1Aligned: randomWeights(HIDDEN, INPUT), b1Aligned: randomBias(HIDDEN),
    w2Aligned: randomWeights(OUTPUT, HIDDEN), b2Aligned: randomBias(OUTPUT),
  };
}

// Recency weight: exponential decay with 30-day half-life.
// New samples (ts ≈ now) → weight ≈ 1.0.
// Samples from 30 days ago → weight ≈ 0.5.
// Samples from 90 days ago → weight ≈ 0.125.
// Without ts (old brain files) → weight = 1.0 (no penalty).
function recencyWeight(ts) {
  if (!ts) return 1.0;
  const daysSince = (Date.now() - ts) / (24 * 3600 * 1000);
  return Math.exp(-daysSince * Math.LN2 / 30);
}

// Forward pass — returns { hidden, output } (both as arrays)
export function forward(w1, b1, w2, b2, features) {
  const hidden = b1.map((bias, j) => {
    const sum = features.reduce((acc, x, i) => acc + x * w1[j][i], bias);
    return sigmoid(sum);
  });
  const output = b2.map((bias, j) => {
    const sum = hidden.reduce((acc, h, i) => acc + h * w2[j][i], bias);
    return sigmoid(sum);
  });
  return { hidden, output };
}

// Single backprop step — mutates weights/biases in place
function backprop(w1, b1, w2, b2, features, label, lossWeight = 1) {
  const { hidden, output } = forward(w1, b1, w2, b2, features);
  const pred = output[0];

  // Output layer error with optional loss weighting
  const error = label - pred;
  const weightedError = error * lossWeight;
  const dOutput = weightedError * sigmoidDeriv(pred);

  // Hidden layer error
  const dHidden = hidden.map((h, j) => dOutput * w2[0][j] * sigmoidDeriv(h));

  // Update w2, b2
  hidden.forEach((h, j) => { w2[0][j] += LEARNING_RATE * dOutput * h; });
  b2[0] += LEARNING_RATE * dOutput;

  // Update w1, b1
  dHidden.forEach((dh, j) => {
    features.forEach((x, i) => { w1[j][i] += LEARNING_RATE * dh * x; });
    b1[j] += LEARNING_RATE * dh;
  });
}

// Build a balanced training batch with oversampling for the minority class
function buildBatch(data, batchSize) {
  const wins  = data.filter(d => d.l === 1);
  const losses = data.filter(d => d.l === 0);
  if (!wins.length || !losses.length) return data.slice(-batchSize);

  const half = Math.floor(batchSize / 2);
  const sample = (arr, n) =>
    Array.from({ length: n }, () => arr[Math.floor(Math.random() * arr.length)]);

  return [...sample(wins, half), ...sample(losses, half)].sort(() => Math.random() - 0.5);
}

// Train all NNs on new data.
// dataMomentum/dataAligned are mode-specific sample buffers (optional).
// Recency weighting (30-day half-life) is applied to all NNs so stale
// March-era samples lose influence as April+ data accumulates.
export function train(weights, data, dataUp, dataDown, dataMomentum = [], dataAligned = []) {
  // Cap buffer sizes
  const trimmed = (arr) => {
    const wins  = arr.filter(d => d.l === 1).slice(-MAX_SAMPLES_PER_CLASS);
    const losses = arr.filter(d => d.l === 0).slice(-MAX_SAMPLES_PER_CLASS);
    return [...wins, ...losses];
  };
  const allData     = trimmed(data);
  const allUp       = trimmed(dataUp);
  const allDown     = trimmed(dataDown);
  const allMomentum = trimmed(dataMomentum);
  const allAligned  = trimmed(dataAligned);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    // Combined NN
    // d.q = soft quality label (0.5–1.0 for wins, 0 for losses) set by recordTrade
    // d.w = gradient weight; d.ts = timestamp for recency weighting
    const batch = buildBatch(allData, TRAIN_BATCH);
    for (const { f, l, q, w, ts } of batch) {
      const target      = q ?? l;
      const isDown      = f[0] < 0;
      const downPenalty = (isDown && l === 0) ? DOWN_LOSS_WEIGHT : 1;
      const rw          = recencyWeight(ts);
      const lw          = Math.min((w ?? 1) * downPenalty * rw, 6);
      backprop(weights.w1, weights.b1, weights.w2, weights.b2, f, target, lw);
    }

    // UP-only NN — recency-weighted, cap at 4×
    if (allUp.length >= 4) {
      const batchUp = buildBatch(allUp, Math.min(TRAIN_BATCH, allUp.length));
      for (const { f, l, q, w, ts } of batchUp) {
        const target = q ?? l;
        const rw     = recencyWeight(ts);
        const lw     = Math.min((w ?? 1) * rw, 4);
        backprop(weights.w1Up, weights.b1Up, weights.w2Up, weights.b2Up, f, target, lw);
      }
    }

    // DOWN-only NN — outcome weight + DOWN bias correction, recency-weighted, cap at 6×
    if (allDown.length >= 4) {
      const batchDown = buildBatch(allDown, Math.min(TRAIN_BATCH, allDown.length));
      for (const { f, l, q, w, ts } of batchDown) {
        const target      = q ?? l;
        const downPenalty = l === 0 ? DOWN_LOSS_WEIGHT - 1 : 0;
        const rw          = recencyWeight(ts);
        const lw          = Math.min(((w ?? 1) + downPenalty) * rw, 6);
        backprop(weights.w1Down, weights.b1Down, weights.w2Down, weights.b2Down, f, target, lw);
      }
    }

    // MOMENTUM mode NN — raw features, recency-weighted
    if (allMomentum.length >= 4 && weights.w1Momentum) {
      const batchM = buildBatch(allMomentum, Math.min(TRAIN_BATCH, allMomentum.length));
      for (const { f, l, q, w, ts } of batchM) {
        const target = q ?? l;
        const rw     = recencyWeight(ts);
        const lw     = Math.min((w ?? 1) * rw, 4);
        backprop(weights.w1Momentum, weights.b1Momentum, weights.w2Momentum, weights.b2Momentum, f, target, lw);
      }
    }

    // ALIGNED mode NN — raw features, recency-weighted
    if (allAligned.length >= 4 && weights.w1Aligned) {
      const batchA = buildBatch(allAligned, Math.min(TRAIN_BATCH, allAligned.length));
      for (const { f, l, q, w, ts } of batchA) {
        const target = q ?? l;
        const rw     = recencyWeight(ts);
        const lw     = Math.min((w ?? 1) * rw, 4);
        backprop(weights.w1Aligned, weights.b1Aligned, weights.w2Aligned, weights.b2Aligned, f, target, lw);
      }
    }
  }
}

// Ensemble prediction — weighted by sample count, direction-aware + mode-aware.
// featuresNorm must already be flipped for DOWN bets (caller's responsibility).
// bet determines which directional NN joins the ensemble.
// mode + modeData optionally add a mode-specialized NN (MOMENTUM or ALIGNED).
// Minimum 8 mode samples required before mode NN enters the ensemble.
const MIN_MODE_SAMPLES = 8;

export function predict(weights, features, featuresNorm, bet, dataUp, dataDown, mode = null, modeData = []) {
  const combined = forward(weights.w1, weights.b1, weights.w2, weights.b2, featuresNorm).output[0];
  let sum = combined;
  let n = 1;

  // Direction-specific NN
  if (bet === 'UP' && dataUp.length) {
    const upPred = forward(weights.w1Up, weights.b1Up, weights.w2Up, weights.b2Up, features).output[0];
    sum += upPred * dataUp.length;
    n   += dataUp.length;
  } else if (bet === 'DOWN' && dataDown.length) {
    const downPred = forward(weights.w1Down, weights.b1Down, weights.w2Down, weights.b2Down, features).output[0];
    sum += downPred * dataDown.length;
    n   += dataDown.length;
  }

  // Mode-specific NN — joins ensemble once it has enough samples
  if (modeData.length >= MIN_MODE_SAMPLES) {
    let modePred = null;
    if (mode === 'MOMENTUM' && weights.w1Momentum) {
      modePred = forward(weights.w1Momentum, weights.b1Momentum, weights.w2Momentum, weights.b2Momentum, features).output[0];
    } else if (mode === 'ALIGNED' && weights.w1Aligned) {
      modePred = forward(weights.w1Aligned, weights.b1Aligned, weights.w2Aligned, weights.b2Aligned, features).output[0];
    }
    if (modePred !== null) {
      sum += modePred * modeData.length;
      n   += modeData.length;
    }
  }

  return sum / n;
}

// Add a sample to the training data arrays, maintaining buffer caps
export function addSample(data, features, win) {
  data.push({ f: features, l: win ? 1 : 0 });
  const wins  = data.filter(d => d.l === 1);
  const losses = data.filter(d => d.l === 0);
  if (wins.length > MAX_SAMPLES_PER_CLASS || losses.length > MAX_SAMPLES_PER_CLASS) {
    // Remove oldest from whichever class is over cap
    const overWins = wins.length > MAX_SAMPLES_PER_CLASS;
    const idx = data.findIndex(d => d.l === (overWins ? 1 : 0));
    if (idx !== -1) data.splice(idx, 1);
  }
}
