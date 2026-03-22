// 9 → 8 → 1 neural network with sigmoid activation
// Three NNs per asset: combined (normalised), UP-only, DOWN-only

const INPUT = 9;
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
  };
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

// Train all three NNs on new data
export function train(weights, data, dataUp, dataDown) {
  // Cap buffer sizes
  const trimmed = (arr) => {
    const wins  = arr.filter(d => d.l === 1).slice(-MAX_SAMPLES_PER_CLASS);
    const losses = arr.filter(d => d.l === 0).slice(-MAX_SAMPLES_PER_CLASS);
    return [...wins, ...losses];
  };
  const allData  = trimmed(data);
  const allUp    = trimmed(dataUp);
  const allDown  = trimmed(dataDown);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    // Combined NN
    const batch = buildBatch(allData, TRAIN_BATCH);
    for (const { f, l } of batch) {
      // DOWN bets in combined NN get weighted loss
      const isDown = f[0] < 0; // proxy: normalised features are flipped for DOWN
      const lw = (isDown && l === 0) ? DOWN_LOSS_WEIGHT : 1;
      backprop(weights.w1, weights.b1, weights.w2, weights.b2, f, l, lw);
    }

    // UP-only NN
    if (allUp.length >= 4) {
      const batchUp = buildBatch(allUp, Math.min(TRAIN_BATCH, allUp.length));
      for (const { f, l } of batchUp) {
        backprop(weights.w1Up, weights.b1Up, weights.w2Up, weights.b2Up, f, l);
      }
    }

    // DOWN-only NN (penalise misses more)
    if (allDown.length >= 4) {
      const batchDown = buildBatch(allDown, Math.min(TRAIN_BATCH, allDown.length));
      for (const { f, l } of batchDown) {
        const lw = l === 0 ? DOWN_LOSS_WEIGHT : 1;
        backprop(weights.w1Down, weights.b1Down, weights.w2Down, weights.b2Down, f, l, lw);
      }
    }
  }
}

// Ensemble prediction — weighted average by sample count
export function predict(weights, features, featuresNorm, dataUp, dataDown) {
  const combined = forward(weights.w1, weights.b1, weights.w2, weights.b2, featuresNorm).output[0];
  const upPred   = forward(weights.w1Up, weights.b1Up, weights.w2Up, weights.b2Up, features).output[0];
  const downPred = 1 - forward(weights.w1Down, weights.b1Down, weights.w2Down, weights.b2Down, features).output[0];

  const nCombined = 1; // always include combined
  const nUp   = Math.max(1, dataUp.length);
  const nDown = Math.max(1, dataDown.length);
  const total = nCombined + nUp + nDown;

  return (combined * nCombined + upPred * nUp + downPred * nDown) / total;
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
