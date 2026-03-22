// Shared mutable state for both assets — read by MCP tools and terminal

function createAssetState() {
  return {
    // Market data (updated by Kalshi WS)
    yesAsk: null,
    yesBid: null,
    ticker: null,
    secsLeft: 900,
    windowId: null,
    windowOpenPrice: null,
    liquidity: 'MEDIUM',

    // YES price velocity tracking
    yesPriceHistory: [],  // [{price, ts}] last 30 readings
    yesVel: 0,            // ¢/s (current)
    yesVelHistory: [],    // last 10 yesVel readings (for reversal + velocity reversal exit)

    // pctAbove: fraction of window ticks where YES mid >= 50¢ (for DECAY mode)
    ticksAbove: 0,
    ticksTotal: 0,

    // Bot control
    farmArmed: false,
    autoBuyArmed: false,

    // Active trade (null when flat)
    activeTrade: null,
    /* activeTrade shape:
      { ticker, bet, side, amount, count, entryYes, maxProfit,
        lockedTP, lockedSL, peakYes,
        featuresRaw, featuresNorm, startedAt, mode } */

    // NN brain (loaded at startup via loadBrain)
    brain: null, // { weights, data, dataUp, dataDown }

    // Farm bot state
    farmRounds: 0,
    lastExitTime: 0,

    // Auto-buy state
    crowdVelHistory: [], // last 4 yesVel readings (crowd block gate)
    autobuyCooldownUntil: 0,
    countdown: null,     // { bet, remaining, features, featuresNorm } — 3s pre-fire

    // Risk state
    consecutiveLosses: 0,
    lastLossTime: 0,

    // P&L
    sessionStartBalance: null,
    sessionPnL: 0,
    dailyStartBalance: null,
    dailyPnL: 0,
    totalPnL: 0,
    tradeCount: 0,
  };
}

export const state = {
  BTC: createAssetState(),
  ETH: createAssetState(),
  balance: null, // dollars (updated every 30s)
};
