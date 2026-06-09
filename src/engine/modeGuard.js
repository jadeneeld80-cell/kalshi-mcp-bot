/**
 * Mode Performance Circuit Breaker
 *
 * Tracks rolling stats per (mode, direction) combo and automatically
 * disables combos that are bleeding. Re-enables after a cooldown period.
 *
 * Combos tracked: ALIGNED_UP, ALIGNED_DOWN, MOMENTUM_UP, MOMENTUM_DOWN,
 *                 DECAY_UP, DECAY_DOWN, CONVICTION_UP, CONVICTION_DOWN
 *
 * Disable conditions (must have >= MIN_SAMPLES):
 *   - Soft disable: win rate < 35% AND avg PnL/trade < -$0.05
 *   - Hard disable: 3 consecutive losses AND avg loss > $0.10/trade
 *
 * Re-enable: AUTO_RESET_MS cooldown, then 5 fresh trades before re-evaluating.
 *
 * Constraints:
 *   - Max 2 combos disabled at once (prevents full shutdown)
 *   - Logs all decisions to data/mode_guard_log.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE   = path.join(__dirname, '../../data/mode_guard.json');
const LOG_FILE     = path.join(__dirname, '../../data/mode_guard_log.json');

const WINDOW        = 10;          // rolling trades per combo before evaluating
const MIN_SAMPLES   = 5;           // minimum trades before any disable decision
const WIN_RATE_MIN  = 0.35;        // below this → soft disable candidate
const AVG_PNL_MIN   = -0.05;       // avg PnL/trade below this → soft disable
const HARD_CONSEC   = 3;           // consecutive losses for hard disable
const HARD_AVG_LOSS = -0.10;       // avg loss threshold for hard disable
const AUTO_RESET_MS = 30 * 60_000; // 30 minutes before re-enabling
const GRACE_TRADES  = 5;           // trades after re-enable before re-evaluating
const MAX_DISABLED  = 2;           // never disable more than 2 combos at once

// ── State ─────────────────────────────────────────────────────────────────────

let _state = null;

function loadState() {
  try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _state = {}; }
  return _state;
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
}

function getState() {
  if (!_state) loadState();
  return _state;
}

function comboKey(mode, bet) {
  return `${mode}_${bet}`;
}

function getCombo(key) {
  const s = getState();
  if (!s[key]) {
    s[key] = {
      trades:       [],   // rolling [{win, pnl, at}]
      disabled:     false,
      disabledAt:   null,
      disableReason: null,
      graceTrades:  0,    // trades since last re-enable
      consecutiveLosses: 0,
    };
  }
  return s[key];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record trade outcome. Called from exitManager after every close.
 * Returns the action taken ('disabled' | 're-enabled' | 'watching' | null)
 */
export function recordOutcome(mode, bet, pnl, win) {
  if (!mode || !bet) return null;
  const key = comboKey(mode, bet);
  const combo = getCombo(key);
  const now = Date.now();

  // Add to rolling window
  combo.trades.push({ win, pnl, at: new Date().toISOString() });
  if (combo.trades.length > WINDOW) combo.trades.shift();

  // Update consecutive loss counter
  if (win) combo.consecutiveLosses = 0;
  else combo.consecutiveLosses = (combo.consecutiveLosses ?? 0) + 1;

  // Grace period after re-enable — don't re-disable immediately
  if (combo.graceTrades > 0) {
    combo.graceTrades--;
    saveState();
    return 'watching';
  }

  // Auto-reset check — re-enable if cooldown has passed
  if (combo.disabled && combo.disabledAt && (now - combo.disabledAt) >= AUTO_RESET_MS) {
    _enableCombo(key, combo, 'AUTO_RESET');
    saveState();
    return 're-enabled';
  }

  // Already disabled — nothing more to do
  if (combo.disabled) { saveState(); return null; }

  // Check if we should disable — need minimum samples
  const window = combo.trades;
  if (window.length < MIN_SAMPLES) { saveState(); return null; }

  // Don't disable if already at cap
  const s = getState();
  const disabledCount = Object.values(s).filter(c => c.disabled).length;
  if (disabledCount >= MAX_DISABLED) { saveState(); return null; }

  const wins    = window.filter(t => t.win).length;
  const winRate = wins / window.length;
  const avgPnl  = window.reduce((a, t) => a + t.pnl, 0) / window.length;

  // Hard disable — consecutive losses + bad avg loss
  if (combo.consecutiveLosses >= HARD_CONSEC && avgPnl <= HARD_AVG_LOSS) {
    _disableCombo(key, combo, 'HARD', { consecutiveLosses: combo.consecutiveLosses, avgPnl });
    saveState();
    return 'disabled';
  }

  // Soft disable — sustained low win rate + negative avg PnL
  if (winRate < WIN_RATE_MIN && avgPnl < AVG_PNL_MIN) {
    _disableCombo(key, combo, 'SOFT', { winRate, avgPnl, sampleSize: window.length });
    saveState();
    return 'disabled';
  }

  saveState();
  return null;
}

/**
 * Check if a mode+direction combo is currently allowed.
 * Call this in farmBot before entering.
 */
export function isComboAllowed(mode, bet) {
  if (!mode || !bet) return true;
  const key = comboKey(mode, bet);
  const combo = getCombo(key);

  if (!combo.disabled) return true;

  // Auto-reset if cooldown passed (handles the case where no trade has been
  // recorded recently but time has elapsed)
  if (combo.disabledAt && (Date.now() - combo.disabledAt) >= AUTO_RESET_MS) {
    _enableCombo(key, combo, 'AUTO_RESET');
    saveState();
    return true;
  }

  return false;
}

/**
 * Get current status of all combos — for MCP get_status.
 */
export function getModeGuardStatus() {
  const s = getState();
  const disabled = [];
  const stats = {};

  for (const [key, combo] of Object.entries(s)) {
    const window = combo.trades ?? [];
    const wins = window.filter(t => t.win).length;
    stats[key] = {
      trades:    window.length,
      winRate:   window.length ? (wins / window.length * 100).toFixed(0) + '%' : 'n/a',
      avgPnl:    window.length ? '$' + (window.reduce((a,t) => a+t.pnl,0)/window.length).toFixed(3) : 'n/a',
      disabled:  combo.disabled,
      disableReason: combo.disableReason ?? null,
      resetsAt:  combo.disabled && combo.disabledAt
        ? new Date(combo.disabledAt + AUTO_RESET_MS).toISOString()
        : null,
    };
    if (combo.disabled) disabled.push({ key, reason: combo.disableReason });
  }

  return { disabled, stats };
}

/**
 * Manually re-enable a combo (for MCP override).
 */
export function forceEnable(mode, bet) {
  const key = comboKey(mode, bet);
  const combo = getCombo(key);
  _enableCombo(key, combo, 'MANUAL');
  saveState();
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _disableCombo(key, combo, type, details) {
  combo.disabled      = true;
  combo.disabledAt    = Date.now();
  combo.disableReason = type;

  const [mode, bet] = key.split('_');
  const msg = `[ModeGuard] DISABLED ${key} (${type}) — ${JSON.stringify(details)}`;
  console.warn(msg);
  _appendLog({ at: new Date().toISOString(), action: 'DISABLED', combo: key, type, details });
}

function _enableCombo(key, combo, reason) {
  combo.disabled      = false;
  combo.disabledAt    = null;
  combo.disableReason = null;
  combo.consecutiveLosses = 0;
  combo.graceTrades   = GRACE_TRADES;

  console.log(`[ModeGuard] RE-ENABLED ${key} (${reason}) — ${GRACE_TRADES} grace trades`);
  _appendLog({ at: new Date().toISOString(), action: 'RE-ENABLED', combo: key, reason });
}

function _appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
