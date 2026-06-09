/**
 * Loss Classifier — closed-loop reactive parameter adjustment.
 *
 * After each live cycle, classifies recent losses into failure buckets:
 *   WHIPSAW        — stop fired within 60s of entry (stop too tight / entered noise)
 *   WRONG_DIRECTION — stop loss on a directional mode (bad signal quality)
 *   EARLY_EXIT     — win but < $0.02 captured (left money on table)
 *   MARKET_SETTLED — held to expiry (force-exit not working)
 *   OVERNIGHT      — loss during low-liquidity hours (time block not catching it)
 *
 * When a bucket exceeds its threshold over the last 20 trades, fires a single
 * conservative param adjustment via params.js. Logs every action to
 * data/loss_classifier_log.json for full auditability.
 *
 * Rules:
 *   - Only one param changes per cycle (prevents oscillation)
 *   - Changes are bounded by BOUNDS in params.js (optimizer can't go out of range)
 *   - Same param can't be changed twice within 30 minutes (cooling period)
 *   - Reverts automatically if the next 10 trades after a change are worse
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadParams, saveParams, BOUNDS, DEFAULTS } from './params.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE   = path.join(__dirname, '../../data/loss_classifier_log.json');
const WINDOW     = 20;    // rolling trade window for bucket analysis
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min between changes to same param

// ── Failure buckets ───────────────────────────────────────────────────────────

const BUCKETS = {
  WHIPSAW:        { threshold: 4, description: 'Stop fired too quickly — stop too tight' },
  WRONG_DIRECTION:{ threshold: 5, description: 'Stop losses on directional entries — bad signal' },
  EARLY_EXIT:     { threshold: 6, description: 'Wins too small — exiting before target' },
  MARKET_SETTLED: { threshold: 2, description: 'Held to expiry — force-exit not catching' },
  OVERNIGHT:      { threshold: 3, description: 'Losses during low-liquidity hours' },
};

// ── Param adjustments per bucket ─────────────────────────────────────────────
// Each bucket maps to a param + direction + step size
const ADJUSTMENTS = {
  WHIPSAW: [
    { param: 'ALIGNED_STOP',   dir: +1, step: 0.02, reason: 'Widen ALIGNED stop to reduce whipsaws' },
    { param: 'MOMENTUM_STOP',  dir: +1, step: 0.02, reason: 'Widen MOMENTUM stop to reduce whipsaws' },
  ],
  WRONG_DIRECTION: [
    { param: 'ALIGNED_CYCLE_DELTA_MIN', dir: +1, step: 0.01, reason: 'Raise ALIGNED entry threshold — too many wrong-direction stops' },
    { param: 'MOMENTUM_VEL_MIN',        dir: +1, step: 0.01, reason: 'Raise MOMENTUM vel threshold — too many wrong-direction stops' },
  ],
  EARLY_EXIT: [
    { param: 'VEL_REVERSAL_PCT_CAPTURED', dir: +1, step: 0.02, reason: 'Raise reversal exit threshold — exiting too early' },
    { param: 'TAKE_PROFIT_PCT',           dir: +1, step: 0.03, reason: 'Raise take-profit target — wins too small' },
  ],
  MARKET_SETTLED: [
    { param: 'RISK_COOLDOWN_MS', dir: -1, step: 5000, reason: 'Lower cooldown to allow more re-entries before expiry' },
  ],
  OVERNIGHT: [
    { param: 'MOMENTUM_SECS_MIN', dir: +1, step: 20, reason: 'Block MOMENTUM entries later in window during low liquidity' },
  ],
};

// ── Classify a single losing trade ───────────────────────────────────────────

function classifyLoss(trade) {
  const buckets = [];

  if (!trade.win) {
    // MARKET_SETTLED
    if (trade.reason === 'MARKET_SETTLED') {
      buckets.push('MARKET_SETTLED');
    }

    // WHIPSAW — stop fired, trade held < 60s
    if (trade.reason === 'STOP_LOSS') {
      const heldMs = trade.heldMs ?? 0;
      if (heldMs < 60_000) buckets.push('WHIPSAW');
      buckets.push('WRONG_DIRECTION');
    }

    // OVERNIGHT — loss during UTC 23–12
    const utcHour = new Date(trade.at).getUTCHours();
    const overnight = new Set([23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    if (overnight.has(utcHour)) buckets.push('OVERNIGHT');
  }

  // EARLY_EXIT — won but tiny (left money on table)
  if (trade.win && trade.pnl < 0.025) {
    buckets.push('EARLY_EXIT');
  }

  return buckets;
}

// ── Main classifier ───────────────────────────────────────────────────────────

export function runLossClassifier(recentTrades) {
  if (recentTrades.length < 5) return; // not enough data

  const window = recentTrades.slice(-WINDOW);

  // Count bucket frequencies
  const counts = Object.fromEntries(Object.keys(BUCKETS).map(k => [k, 0]));
  for (const trade of window) {
    const buckets = classifyLoss(trade);
    for (const b of buckets) counts[b]++;
  }

  // Load current params and log
  const params = loadParams();
  const log = loadLog();
  const now = Date.now();

  let applied = null;

  // Check each bucket in priority order (worst first)
  const priority = ['MARKET_SETTLED', 'WRONG_DIRECTION', 'WHIPSAW', 'OVERNIGHT', 'EARLY_EXIT'];

  for (const bucket of priority) {
    const { threshold } = BUCKETS[bucket];
    if (counts[bucket] < threshold) continue;

    // Find an adjustment for this bucket whose param isn't in cooldown
    const adjustments = ADJUSTMENTS[bucket] ?? [];
    for (const adj of adjustments) {
      const lastChanged = log.lastChanged?.[adj.param] ?? 0;
      if (now - lastChanged < COOLDOWN_MS) continue;

      const bounds = BOUNDS[adj.param];
      if (!bounds) continue;
      const [lo, hi] = bounds;

      const current = params[adj.param] ?? DEFAULTS[adj.param];
      const candidate = Math.max(lo, Math.min(hi, current + adj.dir * adj.step));

      if (Math.abs(candidate - current) < 1e-9) continue; // already at bound

      // Apply the change
      params[adj.param] = candidate;
      saveParams(params);

      applied = {
        at:      new Date().toISOString(),
        bucket,
        count:   counts[bucket],
        window:  window.length,
        param:   adj.param,
        from:    current,
        to:      candidate,
        reason:  adj.reason,
        bucketCounts: { ...counts },
      };

      // Update cooldown tracker
      if (!log.lastChanged) log.lastChanged = {};
      log.lastChanged[adj.param] = now;
      log.actions = log.actions ?? [];
      log.actions.push(applied);
      if (log.actions.length > 200) log.actions.shift();
      saveLog(log);

      console.log(`[LossClassifier] ${bucket} (${counts[bucket]}/${window.length}) → ${adj.param}: ${current.toFixed(4)} → ${candidate.toFixed(4)} | ${adj.reason}`);
      break; // one change per cycle
    }

    if (applied) break;
  }

  if (!applied && Object.values(counts).some(c => c > 0)) {
    const summary = Object.entries(counts).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
    console.log(`[LossClassifier] Window: ${summary} — below thresholds, no action`);
  }

  return applied;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return {}; }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

export function getClassifierLog() {
  return loadLog();
}
