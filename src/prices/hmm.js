/**
 * 3-state Hidden Markov Model for market regime detection.
 *
 * States:  0=CALM, 1=NORMAL, 2=CHOPPY
 * Observations: discretized (atrRatio, 5-tick momentum) → 9 symbols (3 vol × 3 mom bins)
 *
 * Viterbi decoding over the last WINDOW observations gives the most likely
 * current regime. Confidence = softmax-normalised probability of the winning state.
 *
 * Why HMM over CV-based regime:
 * - CV is memoryless — flips CALM↔CHOPPY on a single noisy tick
 * - HMM incorporates inertia (transition matrix) so regime only changes when
 *   sustained evidence accumulates across multiple ticks
 * - TRANSITIONING state catches break-out/breakdown moments that CV can't label
 */

const STATES  = ['CALM', 'NORMAL', 'CHOPPY'];
const N_STATES = 3;
const WINDOW  = 20;   // ticks of history fed into Viterbi

// Initial state probabilities (flat prior for new windows)
const PI = [0.40, 0.40, 0.20];

// Transition matrix A[from][to] — row-stochastic
// Markets are sticky: once in a regime they tend to stay there.
// CHOPPY is most persistent; CALM can break out quickly to NORMAL.
const A = [
  [0.88, 0.11, 0.01], // CALM   → CALM=88%, NORMAL=11%, CHOPPY=1%
  [0.10, 0.80, 0.10], // NORMAL → CALM=10%, NORMAL=80%, CHOPPY=10%
  [0.05, 0.30, 0.65], // CHOPPY → CALM=5%,  NORMAL=30%, CHOPPY=65%
];

// Emission matrix B[state][obs]
// obs = volBin * 3 + momBin  (0..8)
// volBin: atrRatio < 0.85 → 0, 0.85–1.15 → 1, > 1.15 → 2
// momBin: |5-tick % * 1000| < 0.15 → 0, 0.15–0.40 → 1, > 0.40 → 2
//
// Rows must sum to 1.0. Calibrated to expected per-regime behaviour:
//   CALM:   most likely low vol + low/medium momentum
//   NORMAL: most likely medium vol + medium momentum
//   CHOPPY: most likely high vol + high momentum
const B = [
  // CALM
  [0.30, 0.25, 0.05,   // vol=LOW:  mom=low, mom=med, mom=high
   0.18, 0.10, 0.03,   // vol=MED
   0.05, 0.03, 0.01],  // vol=HIGH
  // NORMAL
  [0.10, 0.15, 0.05,
   0.15, 0.25, 0.10,
   0.05, 0.10, 0.05],
  // CHOPPY
  [0.03, 0.05, 0.07,
   0.05, 0.10, 0.15,
   0.08, 0.17, 0.30],
];

// Discretize continuous signals → observation index (0..8)
function observe(atrRatio, momentum5) {
  const volBin = atrRatio < 0.85 ? 0 : atrRatio < 1.15 ? 1 : 2;
  const momBin = Math.abs(momentum5) < 0.15 ? 0 : Math.abs(momentum5) < 0.40 ? 1 : 2;
  return volBin * 3 + momBin;
}

// Forward-only Viterbi decoder — O(T × S²)
function viterbi(obs) {
  const T = obs.length;
  // delta[s] = max log-prob path ending at state s at current time
  let delta = new Float64Array(N_STATES);
  for (let s = 0; s < N_STATES; s++) {
    delta[s] = Math.log(PI[s] + 1e-10) + Math.log(B[s][obs[0]] + 1e-10);
  }

  const next = new Float64Array(N_STATES);
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < N_STATES; s++) {
      let best = -Infinity;
      for (let prev = 0; prev < N_STATES; prev++) {
        const v = delta[prev] + Math.log(A[prev][s] + 1e-10);
        if (v > best) best = v;
      }
      next[s] = best + Math.log(B[s][obs[t]] + 1e-10);
    }
    delta.set(next);
  }

  // Best final state
  let bestState = 0;
  for (let s = 1; s < N_STATES; s++) {
    if (delta[s] > delta[bestState]) bestState = s;
  }

  // Confidence via softmax over final delta scores
  const maxD  = Math.max(...delta);
  const expD  = Array.from(delta).map(d => Math.exp(d - maxD));
  const sumD  = expD.reduce((a, b) => a + b, 0);
  const confidence = expD[bestState] / sumD;

  return { stateIdx: bestState, confidence };
}

/**
 * Update observation window and return current HMM regime.
 *
 * @param {number[]} obsHistory  Rolling observation window (mutated in place)
 * @param {number}   atrRatio    Short/long ATR ratio from indicators
 * @param {number}   momentum5   5-tick price momentum × 1000 (normalised)
 * @returns {{ state: 'CALM'|'NORMAL'|'CHOPPY', confidence: number }}
 */
export function hmmUpdate(obsHistory, atrRatio, momentum5) {
  const obs = observe(atrRatio ?? 1.0, momentum5 ?? 0);
  obsHistory.push(obs);
  if (obsHistory.length > WINDOW) obsHistory.shift();
  if (obsHistory.length < 3) return { state: 'NORMAL', confidence: 0.5 };

  const { stateIdx, confidence } = viterbi(obsHistory);
  return { state: STATES[stateIdx], confidence };
}
