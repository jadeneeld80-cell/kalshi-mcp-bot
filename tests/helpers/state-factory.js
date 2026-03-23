/**
 * Factory helpers for creating isolated state objects in unit tests.
 * Mirrors src/engine/state.js but fully in-memory — no imports from src.
 */

export function createAssetState(overrides = {}) {
  return {
    yesAsk:            null,
    yesBid:            null,
    ticker:            null,
    secsLeft:          900,
    windowId:          null,
    windowOpenPrice:   null,
    liquidity:         'MEDIUM',
    yesPriceHistory:   [],
    yesVel:            0,
    yesVelHistory:     [],
    ticksAbove:        0,
    ticksTotal:        0,
    farmArmed:         false,
    autoBuyArmed:      false,
    activeTrade:       null,
    brain:             null,
    farmRounds:        0,
    lastExitTime:      0,
    crowdVelHistory:   [],
    autobuyCooldownUntil: 0,
    countdown:         null,
    consecutiveLosses: 0,
    lastLossTime:      0,
    sessionStartBalance: null,
    sessionPnL:        0,
    dailyStartBalance: null,
    dailyPnL:          0,
    totalPnL:          0,
    tradeCount:        0,
    regime:            'NORMAL',
    ...overrides,
  };
}

/** Create a minimal active trade object with sensible defaults. */
export function createTrade(overrides = {}) {
  const amount    = overrides.amount    ?? 1.00;
  const maxProfit = overrides.maxProfit ?? 3.00;
  return {
    ticker:       'KXBTC15M-26MAR221745-45',
    bet:          'UP',
    side:         'yes',
    amount,
    count:        10,
    entryYes:     0.70,
    maxProfit,
    lockedTP:     maxProfit * 0.60,
    lockedSL:     0.12,
    featuresRaw:  Array(9).fill(0.1),
    featuresNorm: Array(9).fill(0.1),
    startedAt:    Date.now() - 30_000,
    mode:         'FARM',
    ...overrides,
  };
}

/** Build a minimal NN brain (weights + empty data buffers). */
export function createFreshBrain() {
  const w = (r, c) => Array.from({ length: r }, () => Array.from({ length: c }, () => 0));
  const b = (n)    => Array(n).fill(0);
  return {
    weights: {
      w1: w(8, 9),  b1: b(8),
      w2: w(1, 8),  b2: b(1),
      w1Up: w(8, 9), b1Up: b(8), w2Up: w(1, 8), b2Up: b(1),
      w1Down: w(8, 9), b1Down: b(8), w2Down: w(1, 8), b2Down: b(1),
    },
    data: [], dataUp: [], dataDown: [],
  };
}
