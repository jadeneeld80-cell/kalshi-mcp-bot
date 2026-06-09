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
  DEAD_ZONE_LOW:               0.49,   // dead zone lower bound (matches live farmBot)
  DEAD_ZONE_HIGH:              0.51,   // dead zone upper bound
  ALIGNED_CYCLE_DELTA_MIN:     0.04,   // min cycleDelta for ALIGNED mode (matches live)
  ALIGNED_VEL_MIN:             0.03,   // min |yesVel| for ALIGNED entry (matches live)
  ALIGNED_STOP:                0.15,   // ALIGNED mode stop loss (live: 15%, likely too wide)
  MOMENTUM_VEL_MIN:            0.08,   // min |yesVel| for MOMENTUM entry
  MOMENTUM_SECS_MIN:           240,    // min secsLeft for MOMENTUM mode
  MOMENTUM_STOP:               0.12,   // MOMENTUM mode stop loss
  // Research-backed MOMENTUM filters (Polymarket v2→v3 study)
  MOMENTUM_VEL_CONFIRM_TICKS:  40,     // require avg vel over last N ticks to confirm direction
  MOMENTUM_EMA_FILTER:         1,      // 1=enabled: block entries opposing EMA12>EMA26 trend
  MOMENTUM_POST_LOSS_PROB:     0.60,   // min modelProb after 3 consecutive losses (vs 0.52 default)
  DECAY_STOP:                  0.02,   // DECAY mode stop loss
  KELLY_FRACTION:              0.25,   // Kelly fraction (quarter-Kelly = 0.25)
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
  DEAD_ZONE_LOW:               [0.44, 0.49],
  DEAD_ZONE_HIGH:              [0.51, 0.56],
  ALIGNED_CYCLE_DELTA_MIN:     [0.02, 0.15],
  ALIGNED_VEL_MIN:             [0.01, 0.10],
  ALIGNED_STOP:                [0.04, 0.20],   // optimizer finds where ALIGNED stops bleeding
  MOMENTUM_VEL_MIN:            [0.04, 0.15],
  MOMENTUM_SECS_MIN:           [200,  500],
  MOMENTUM_STOP:               [0.05, 0.20],
  MOMENTUM_VEL_CONFIRM_TICKS:  [10,   80],
  MOMENTUM_EMA_FILTER:         [0,    1],
  MOMENTUM_POST_LOSS_PROB:     [0.52, 0.70],
  DECAY_STOP:                  [0.01, 0.06],
  KELLY_FRACTION:              [0.15, 0.40],
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
