/**
 * Bayesian Calibration — Kennedy & O'Hagan (2001) discrepancy model.
 *
 * Core idea: y_real(x) = y_sim(x) + δ(x)
 *   where δ is the systematic bias between simulator and live trading.
 *
 * We track per-mode bias ratios:
 *   biasRatio = livePnL / simPnL  (exponential moving average, 30-obs half-life)
 *
 * When biasRatio < 1.0 the sim is over-optimistic — calibrated score is penalised.
 * When biasRatio > 1.0 the sim is conservative — calibrated score gets a boost.
 * No live history → biasRatio = 1.0 (no correction applied).
 *
 * Usage:
 *   updateDiscrepancy(simSummary, liveTrades)  — called after each live cycle
 *   getCalibratedScore(rawScore, simTrades)    — called inside optimizer scoring
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISC_FILE  = path.join(__dirname, '../../data/discrepancy.json');

// Exponential moving average alpha — ~30-observation half-life
const EMA_ALPHA = 1 - Math.pow(0.5, 1 / 30);

// Modes we track discrepancy for individually
const TRACKED_MODES = ['ALIGNED', 'DECAY', 'MOMENTUM'];

// ── Persistence ───────────────────────────────────────────────────────────────

function loadDiscrepancy() {
  try {
    return JSON.parse(fs.readFileSync(DISC_FILE, 'utf8'));
  } catch {
    return {
      overall: { biasRatio: 1.0, observations: 0 },
      modes: {
        ALIGNED:  { biasRatio: 1.0, observations: 0 },
        DECAY:    { biasRatio: 1.0, observations: 0 },
        MOMENTUM: { biasRatio: 1.0, observations: 0 },
      },
      history: [],   // last 50 (sim_pnl, live_pnl, at) pairs for diagnostics
      updatedAt: null,
    };
  }
}

function saveDiscrepancy(disc) {
  fs.writeFileSync(DISC_FILE, JSON.stringify(disc, null, 2), 'utf8');
}

// ── EMA update ────────────────────────────────────────────────────────────────

function emaUpdate(current, newValue, alpha) {
  return alpha * newValue + (1 - alpha) * current;
}

// ── Summarise trades by mode ──────────────────────────────────────────────────

function summariseByMode(trades) {
  const result = { overall: 0 };
  for (const mode of TRACKED_MODES) result[mode] = 0;
  for (const t of trades) {
    result.overall += t.pnl ?? 0;
    if (t.mode && result[t.mode] !== undefined) result[t.mode] += t.pnl ?? 0;
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Update discrepancy state by comparing simulator prediction to live results.
 *
 * simTrades  — trades produced by simulate() for the same time window
 * liveTrades — actual trades from logs/trades.json for that window
 *
 * Both arrays may be empty; we skip the update if either has no trades.
 */
export function updateDiscrepancy(simTrades, liveTrades) {
  if (!simTrades.length || !liveTrades.length) return;

  const disc = loadDiscrepancy();
  const simSummary  = summariseByMode(simTrades);
  const liveSummary = summariseByMode(liveTrades);

  // Overall bias ratio
  if (Math.abs(simSummary.overall) > 0.001) {
    const ratio = liveSummary.overall / simSummary.overall;
    // Clamp to [0.1, 5.0] to prevent wild swings from tiny sim samples
    const clampedRatio = Math.max(0.1, Math.min(5.0, ratio));
    disc.overall.biasRatio = emaUpdate(disc.overall.biasRatio, clampedRatio, EMA_ALPHA);
    disc.overall.observations++;
  }

  // Per-mode bias ratios
  for (const mode of TRACKED_MODES) {
    const simPnL  = simSummary[mode];
    const livePnL = liveSummary[mode];
    if (Math.abs(simPnL) > 0.001) {
      const ratio = livePnL / simPnL;
      const clampedRatio = Math.max(0.1, Math.min(5.0, ratio));
      disc.modes[mode].biasRatio = emaUpdate(disc.modes[mode].biasRatio, clampedRatio, EMA_ALPHA);
      disc.modes[mode].observations++;
    }
  }

  // History log (capped at 50 entries)
  disc.history.push({
    at: new Date().toISOString(),
    simPnL:  simSummary.overall,
    livePnL: liveSummary.overall,
    biasRatio: disc.overall.biasRatio,
    simTrades: simTrades.length,
    liveTrades: liveTrades.length,
  });
  if (disc.history.length > 50) disc.history.shift();

  disc.updatedAt = new Date().toISOString();
  saveDiscrepancy(disc);

  console.log(`[Discrepancy] Updated — overall bias ${disc.overall.biasRatio.toFixed(3)} (${disc.overall.observations} obs) | sim $${simSummary.overall.toFixed(2)} → live $${liveSummary.overall.toFixed(2)}`);
}

/**
 * Apply Kennedy-style calibration correction to a raw simulator score.
 *
 * rawScore   — overallScore from evaluate() [0..1]
 * simTrades  — the trades that produced rawScore (used for mode weighting)
 *
 * Returns calibratedScore in [0..1].
 * If < 10 observations accumulated, returns rawScore unchanged.
 */
export function getCalibratedScore(rawScore, simTrades) {
  const disc = loadDiscrepancy();

  // Not enough data — no correction
  if (disc.overall.observations < 5) return rawScore;

  // Compute mode-weighted bias ratio based on PnL contribution of each mode
  const summary = summariseByMode(simTrades);
  const totalSimPnL = Math.abs(summary.overall) || 1;

  let weightedBias = disc.overall.biasRatio;

  // If we have per-mode history, blend mode-specific bias in proportion to PnL contribution
  let modeWeight = 0;
  let modeBiasSum = 0;
  for (const mode of TRACKED_MODES) {
    if (disc.modes[mode].observations >= 3) {
      const contribution = Math.abs(summary[mode]) / totalSimPnL;
      modeBiasSum += disc.modes[mode].biasRatio * contribution;
      modeWeight  += contribution;
    }
  }

  if (modeWeight > 0.1) {
    // Blend: 60% overall + 40% mode-weighted
    weightedBias = 0.60 * disc.overall.biasRatio + 0.40 * (modeBiasSum / modeWeight);
  }

  // Apply correction — bias > 1 means live beats sim, bias < 1 means sim over-predicts
  // Clamp correction to ±40% to avoid wild score distortions
  const correction = Math.max(0.60, Math.min(1.40, weightedBias));
  const calibrated = Math.max(0, Math.min(1, rawScore * correction));

  return calibrated;
}

/**
 * Return current discrepancy stats (for logging / MCP status).
 */
export function getDiscrepancyStats() {
  return loadDiscrepancy();
}
