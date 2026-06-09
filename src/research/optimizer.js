/**
 * Optimizer — coordinate descent over the parameter space.
 * Each iteration tweaks one parameter by ±DELTA%, runs simulation,
 * keeps the change if it improves the overall evaluation score.
 *
 * Pattern inspired by karpathy/autoresearch:
 * - One modifiable "file" = data/params.json
 * - Fixed budget = simulation window
 * - Score vs baseline → commit or revert
 * - Loop until 100% or budget exhausted
 */

import { DEFAULTS, BOUNDS, saveParams } from './params.js';
import { simulate } from './simulator.js';
import { evaluate } from './evaluator.js';
import { getCalibratedScore } from './discrepancy.js';

const DELTA = 0.10;       // 10% perturbation per step
const MIN_TRADES = 3;     // min trades in sim before scoring

/**
 * Run one optimization pass over all parameters.
 * @param {Array<Object>} snapshots - market snapshots for simulation
 * @param {Object} currentParams    - current parameter set
 * @param {number} baselineScore    - score to beat
 * @param {Function} onProgress     - callback({ paramName, delta, newScore, accepted })
 * @returns {{ params, score, history }}
 */
export async function optimizeStep(snapshots, currentParams, baselineScore, onProgress = null) {
  let bestParams = { ...currentParams };
  let bestScore  = baselineScore;
  const history  = [];

  const paramNames = Object.keys(DEFAULTS);

  for (const param of paramNames) {
    const bounds = BOUNDS[param];
    if (!bounds) continue;
    const [lo, hi] = bounds;
    const current  = bestParams[param];

    // Try +DELTA and -DELTA
    for (const sign of [+1, -1]) {
      const candidate = clamp(current * (1 + sign * DELTA), lo, hi);
      if (Math.abs(candidate - current) < 1e-9) continue;

      const candidateParams = { ...bestParams, [param]: candidate };
      const trades = simulate(snapshots, candidateParams);

      if (trades.length < MIN_TRADES) continue;

      const result  = evaluate(trades, candidateParams);
      const newScore = getCalibratedScore(result.overallScore, trades);
      const accepted = newScore > bestScore;

      if (accepted) {
        bestScore  = newScore;
        bestParams = candidateParams;
      }

      const entry = {
        param, sign: sign > 0 ? '+' : '-', delta: DELTA,
        from: current, to: candidate,
        newScore, accepted,
      };
      history.push(entry);
      if (onProgress) onProgress(entry);

      // Early exit if perfect score
      if (bestScore >= 1.0) break;
    }
    if (bestScore >= 1.0) break;
  }

  return { params: bestParams, score: bestScore, history };
}

/**
 * Multi-round optimizer. Runs `rounds` full parameter sweeps.
 * Persists best params to disk after each improvement.
 */
export async function optimize({
  snapshots,
  initialParams,
  rounds = 10,
  onRoundComplete = null,
}) {
  let params = { ...DEFAULTS, ...initialParams };
  const trades0 = simulate(snapshots, params);
  const baseline = trades0.length >= MIN_TRADES
    ? getCalibratedScore(evaluate(trades0, params).overallScore, trades0)
    : 0;
  let bestScore = baseline;

  console.log(`[Optimizer] Baseline score: ${(baseline * 100).toFixed(1)}% over ${trades0.length} trades`);

  const allHistory = [];

  for (let round = 0; round < rounds; round++) {
    console.log(`[Optimizer] Round ${round + 1}/${rounds}, current score: ${(bestScore * 100).toFixed(1)}%`);

    const { params: newParams, score, history } = await optimizeStep(
      snapshots, params, bestScore,
      (entry) => {
        if (entry.accepted) {
          console.log(`  ✓ ${entry.param} ${entry.sign}${(entry.delta*100).toFixed(0)}% → score ${(entry.newScore*100).toFixed(1)}%`);
        }
      }
    );

    allHistory.push({ round: round + 1, score, changes: history.filter(h => h.accepted) });

    if (score > bestScore) {
      bestScore = score;
      params = newParams;
      saveParams(params);
      console.log(`[Optimizer] Saved improved params (score: ${(bestScore*100).toFixed(1)}%)`);
    }

    if (onRoundComplete) {
      await onRoundComplete({ round: round + 1, score: bestScore, params });
    }

    if (bestScore >= 1.0) {
      console.log('[Optimizer] Reached 100% score — stopping');
      break;
    }
  }

  return { params, finalScore: bestScore, history: allHistory };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
