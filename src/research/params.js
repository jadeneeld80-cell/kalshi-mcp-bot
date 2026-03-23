/**
 * Parameter registry for autoresearch tuning.
 * All parameters are read from data/params.json at startup.
 * Simulator and evaluator import P from here — no source files are modified.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARAMS_PATH = path.join(__dirname, '../../data/params.json');

// Default parameter values (used on first run or if params.json is absent)
export const DEFAULTS = {
  // Farm bot entry thresholds
  SPREAD_EXTREME_FLOOR:        0.05,   // below this or above 1-this → SPREAD_EXTREME
  DEAD_ZONE_LOW:               0.44,   // dead zone lower bound
  DEAD_ZONE_HIGH:              0.56,   // dead zone upper bound
  REVERSAL_PRIOR_THRESHOLD:    0.12,   // avg velocity magnitude for reversal prior window
  REVERSAL_RECENT_THRESHOLD:   0.12,   // avg velocity magnitude for reversal recent window
  ALIGNED_CYCLE_DELTA_MIN:     0.10,   // min cycleDelta for ALIGNED mode
  MOMENTUM_SECS_MIN:           400,    // min secsLeft for MOMENTUM mode
  MODEL_PROB_DEFAULT:          0.52,   // default modelProb when brain has < min samples
  MODEL_PROB_MIN_SAMPLES:      10,     // min samples per direction before using model

  // Risk parameters
  RISK_COOLDOWN_MS:            45_000, // normal cooldown after loss
  RISK_COOLDOWN_FAST_MS:       20_000, // fast cooldown for DECAY/STRONG_CONVICTION
  RISK_SESSION_KILL:           0.05,   // session kill threshold
  RISK_DAILY_CAP:              0.08,   // daily cap threshold
  RISK_CONSEC_BRAKE:           3,      // consecutive losses before streak brake

  // Exit thresholds
  VEL_REVERSAL_PCT_CAPTURED:   0.02,   // min profit captured before velocity reversal exit
  TAKE_PROFIT_PCT:             0.60,   // pct of maxProfit to lock in as TP
  KELLY_MAX_FRACTION:          0.20,   // max bet as fraction of balance
  STOP_LOSS_CALM:              0.06,   // regime-based stop loss
  STOP_LOSS_NORMAL:            0.09,
  STOP_LOSS_CHOPPY:            0.12,

  // Liquidity spread thresholds
  LIQUIDITY_HIGH_SPREAD:       0.03,   // spread < this → HIGH
  LIQUIDITY_MED_SPREAD:        0.06,   // spread < this → MEDIUM (else LOW)

  // Farm mode targets/stops
  TARGET_CALM:                 0.12,
  TARGET_NORMAL:               0.18,
  TARGET_CHOPPY:               0.25,
  STOP_CALM:                   0.06,
  STOP_NORMAL:                 0.09,
  STOP_CHOPPY:                 0.12,
};

// Parameter bounds for the optimizer — [min, max] inclusive
export const BOUNDS = {
  SPREAD_EXTREME_FLOOR:        [0.02, 0.10],
  DEAD_ZONE_LOW:               [0.38, 0.48],
  DEAD_ZONE_HIGH:              [0.52, 0.62],
  REVERSAL_PRIOR_THRESHOLD:    [0.05, 0.30],
  REVERSAL_RECENT_THRESHOLD:   [0.05, 0.30],
  ALIGNED_CYCLE_DELTA_MIN:     [0.03, 0.25],
  MOMENTUM_SECS_MIN:           [200,  700],
  MODEL_PROB_DEFAULT:          [0.50, 0.58],
  MODEL_PROB_MIN_SAMPLES:      [4,    25],
  RISK_COOLDOWN_MS:            [15_000, 90_000],
  RISK_COOLDOWN_FAST_MS:       [5_000,  45_000],
  RISK_SESSION_KILL:           [0.02, 0.10],
  RISK_DAILY_CAP:              [0.04, 0.15],
  RISK_CONSEC_BRAKE:           [2,    6],
  VEL_REVERSAL_PCT_CAPTURED:   [0.01, 0.10],
  TAKE_PROFIT_PCT:             [0.40, 0.80],
  KELLY_MAX_FRACTION:          [0.05, 0.35],
  STOP_LOSS_CALM:              [0.03, 0.12],
  STOP_LOSS_NORMAL:            [0.05, 0.18],
  STOP_LOSS_CHOPPY:            [0.07, 0.20],
  LIQUIDITY_HIGH_SPREAD:       [0.01, 0.06],
  LIQUIDITY_MED_SPREAD:        [0.03, 0.12],
  TARGET_CALM:                 [0.06, 0.20],
  TARGET_NORMAL:               [0.10, 0.28],
  TARGET_CHOPPY:               [0.15, 0.35],
  STOP_CALM:                   [0.02, 0.10],
  STOP_NORMAL:                 [0.04, 0.15],
  STOP_CHOPPY:                 [0.06, 0.18],
};

let _cached = null;

export function loadParams() {
  try {
    const raw = fs.readFileSync(PARAMS_PATH, 'utf8');
    _cached = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    _cached = { ...DEFAULTS };
  }
  return _cached;
}

export function saveParams(params) {
  fs.mkdirSync(path.dirname(PARAMS_PATH), { recursive: true });
  fs.writeFileSync(PARAMS_PATH, JSON.stringify(params, null, 2));
  _cached = { ...params };
}

export function getParams() {
  if (!_cached) return loadParams();
  return _cached;
}
