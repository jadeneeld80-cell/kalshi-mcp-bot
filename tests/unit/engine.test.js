/**
 * Unit tests for engine modules.
 * Uses mock.module() + dynamic imports so mocks intercept before load.
 */
import { test, describe, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetState, createTrade } from '../helpers/state-factory.js';

// ── Mock external dependencies BEFORE any dynamic imports ────────────────────

// Prevent real order placement
mock.module('../../src/kalshi/orders.js', {
  namedExports: {
    executeSell:       async () => {},
    executeBuy:        async () => ({ result: { order: { id: 'mock', remaining_count: 0 } } }),
    cancelOpenOrders:  async () => {},
  },
});

// Prevent disk writes from nn/store
mock.module('../../src/nn/store.js', {
  namedExports: {
    recordTrade:  async () => {},
    brainStats:   () => ({ samples: 0 }),
    loadBrain:    async () => null,
    exportBrain:  () => ({}),
    importBrain:  () => {},
    saveBrain:    async () => {},
  },
});

// Prevent Binance WebSocket connection
mock.module('../../src/prices/binance.js', {
  namedExports: {
    priceFeed: {
      connect:       () => {},
      getPrice:      () => 65000,
      getVelocity:   () => 0.05,
      getRegime:     () => 'NORMAL',
      getIndicators: () => null,   // null = features not ready
      buffer:        { BTC: [], ETH: [] },
    },
  },
});

// Prevent Kalshi API calls in client
mock.module('../../src/kalshi/client.js', {
  namedExports: {
    getBalance:        async () => 509,
    getPositions:      async () => [],
    getFills:          async () => [],
    getOrders:         async () => [],
    placeOrder:        async () => ({}),
    cancelOrder:       async () => ({}),
    findActiveMarket:  async () => ({ ticker: 'KXBTC15M-TEST-45' }),
    buildHeaders:      () => ({}),
    BASE_URL:          'https://mock.kalshi.com',
  },
});

// Lazy-loaded after mocks are set up
let computeUnrealizedPnL, checkExit;
let checkRiskGuards, recordTradePnL, startSession, startDay;

before(async () => {
  ({ computeUnrealizedPnL, checkExit } =
    await import('../../src/engine/exitManager.js'));
  ({ checkRiskGuards, recordTradePnL, startSession, startDay } =
    await import('../../src/engine/riskManager.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeUnrealizedPnL', () => {
  test('UP trade profit when YES rises', () => {
    const trade = createTrade({ bet: 'UP', side: 'yes', count: 10, amount: 7.00 });
    // yesBid = 0.80 → currentValue = 10 * 0.80 = 8.00 → pnl = 1.00
    const pnl = computeUnrealizedPnL(trade, 0.82, 0.80);
    assert.ok(pnl > 0, `Expected profit, got ${pnl}`);
    assert.ok(Math.abs(pnl - 1.00) < 0.001, `Expected ~1.00, got ${pnl}`);
  });

  test('UP trade loss when YES drops', () => {
    const trade = createTrade({ bet: 'UP', side: 'yes', count: 10, amount: 7.00 });
    // yesBid = 0.60 → currentValue = 6.00 → pnl = -1.00
    const pnl = computeUnrealizedPnL(trade, 0.62, 0.60);
    assert.ok(pnl < 0, `Expected loss, got ${pnl}`);
  });

  test('DOWN trade profit when YES drops', () => {
    // Bet DOWN = buy NO. NO value = 1 - yesAsk
    // count=10, amount=3.00, yesAsk=0.20 → value = 10*(1-0.20)=8.0 → pnl=5.0
    const trade = createTrade({ bet: 'DOWN', side: 'no', count: 10, amount: 3.00 });
    const pnl = computeUnrealizedPnL(trade, 0.20, 0.18);
    assert.ok(pnl > 0, `Expected profit, got ${pnl}`);
  });

  test('DOWN trade loss when YES rises', () => {
    const trade = createTrade({ bet: 'DOWN', side: 'no', count: 10, amount: 3.00 });
    // yesAsk=0.90 → NO value = 10*(1-0.90)=1.0 → pnl = -2.0
    const pnl = computeUnrealizedPnL(trade, 0.90, 0.88);
    assert.ok(pnl < 0, `Expected loss, got ${pnl}`);
  });

  test('zero pnl at exact entry price', () => {
    // count=10, yesAsk=0.70, yesBid=0.70, side=yes, amount=7.00
    const trade = createTrade({ bet: 'UP', side: 'yes', count: 10, amount: 7.00 });
    const pnl = computeUnrealizedPnL(trade, 0.72, 0.70);
    assert.ok(Math.abs(pnl) < 0.001, `Expected ~0, got ${pnl}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('checkRiskGuards', () => {
  test('passes when all clear', () => {
    const s = createAssetState({
      consecutiveLosses: 0,
      lastLossTime:      0,
      sessionStartBalance: 100,
      sessionPnL:        0,
      dailyStartBalance: 100,
      dailyPnL:          0,
    });
    const result = checkRiskGuards(s, 100);
    assert.equal(result.blocked, false);
  });

  test('blocks on 45s cooldown after loss', () => {
    const s = createAssetState({ lastLossTime: Date.now() - 10_000 }); // 10s ago
    const result = checkRiskGuards(s, 100);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'COOLDOWN');
  });

  test('blocks after 3 consecutive losses (streak brake)', () => {
    const s = createAssetState({ consecutiveLosses: 3, lastLossTime: 0 });
    const result = checkRiskGuards(s, 100);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'STREAK');
  });

  test('blocks on session kill (>5% loss)', () => {
    const s = createAssetState({
      consecutiveLosses: 0,
      lastLossTime:      0,
      sessionStartBalance: 100,
      sessionPnL:        -6,   // 6% > 5% threshold
      dailyStartBalance: 100,
      dailyPnL:          -6,
    });
    const result = checkRiskGuards(s, 100);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'SESSIONKILL');
  });

  test('blocks on daily cap (>8% loss)', () => {
    const s = createAssetState({
      consecutiveLosses: 0,
      lastLossTime:      0,
      sessionStartBalance: 100,
      sessionPnL:        0,
      dailyStartBalance: 100,
      dailyPnL:          -9,   // 9% > 8% threshold
    });
    const result = checkRiskGuards(s, 100);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'DAILYCAP');
  });

  test('applies session kill even on small balance (< $5)', () => {
    const s = createAssetState({
      consecutiveLosses: 0,
      lastLossTime:      0,
      sessionStartBalance: 4,
      sessionPnL:        -0.25,  // 6.25% > 5% threshold
      dailyStartBalance: 4,
      dailyPnL:          0,
    });
    const result = checkRiskGuards(s, 4);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'SESSIONKILL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recordTradePnL', () => {
  test('increments tradeCount', () => {
    const s = createAssetState({ tradeCount: 5 });
    recordTradePnL(s, 1.00);
    assert.equal(s.tradeCount, 6);
  });

  test('win resets consecutiveLosses to 0', () => {
    const s = createAssetState({ consecutiveLosses: 2 });
    recordTradePnL(s, 0.50);
    assert.equal(s.consecutiveLosses, 0);
  });

  test('loss increments consecutiveLosses', () => {
    const s = createAssetState({ consecutiveLosses: 1 });
    recordTradePnL(s, -0.50);
    assert.equal(s.consecutiveLosses, 2);
  });

  test('updates all P&L counters', () => {
    const s = createAssetState({ sessionPnL: 1.00, dailyPnL: 2.00, totalPnL: 5.00 });
    recordTradePnL(s, 0.50);
    assert.ok(Math.abs(s.sessionPnL - 1.50) < 0.001);
    assert.ok(Math.abs(s.dailyPnL   - 2.50) < 0.001);
    assert.ok(Math.abs(s.totalPnL   - 5.50) < 0.001);
  });

  test('loss sets lastLossTime to approximately now', () => {
    const before = Date.now();
    const s = createAssetState({ lastLossTime: 0 });
    recordTradePnL(s, -1.00);
    assert.ok(s.lastLossTime >= before);
    assert.ok(s.lastLossTime <= Date.now() + 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('startSession / startDay', () => {
  test('startSession sets sessionStartBalance and resets PnL', () => {
    const s = createAssetState({ sessionPnL: -5, consecutiveLosses: 3 });
    startSession(s, 100);
    assert.equal(s.sessionStartBalance, 100);
    assert.equal(s.sessionPnL, 0);
    assert.equal(s.consecutiveLosses, 0);
  });

  test('startDay sets dailyStartBalance and resets dailyPnL', () => {
    const s = createAssetState({ dailyPnL: -10 });
    startDay(s, 200);
    assert.equal(s.dailyStartBalance, 200);
    assert.equal(s.dailyPnL, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('checkExit — exit triggers', () => {
  function makeCtx(stateOverrides = {}, tradeOverrides = {}) {
    const s = createAssetState({
      yesAsk:  0.70, yesBid: 0.68,
      secsLeft: 600,
      regime:  'NORMAL',
      yesVelHistory: [],
      ...stateOverrides,
    });
    s.activeTrade = createTrade({ ...tradeOverrides });
    return { asset: 'BTC', s };
  }

  test('TAKE_PROFIT: unrealizedPnL >= lockedTP exits', async () => {
    // lockedTP = maxProfit * 0.60 = 3.00 * 0.60 = 1.80
    // We need count * yesBid - amount >= 1.80
    // count=10, yesBid=0.90 → value=9.0, amount=7.0 → pnl=2.0 ≥ 1.80 ✓
    const ctx = makeCtx(
      { yesAsk: 0.91, yesBid: 0.90 },
      { bet: 'UP', side: 'yes', count: 10, amount: 7.00, maxProfit: 3.00, lockedTP: 1.80 }
    );
    await checkExit(ctx);
    assert.equal(ctx.s.activeTrade, null, 'Trade should be closed on TAKE_PROFIT');
  });

  test('STOP_LOSS: loss exceeds regime % exits', async () => {
    // NORMAL regime stop = 12%
    // count=10, yesBid=0.50, amount=7.00 → pnl=-2.00, lockedSL=0.12
    // -2.00 <= -(7.00 * 0.12) = -0.84 ✓
    const ctx = makeCtx(
      { yesAsk: 0.52, yesBid: 0.50, regime: 'NORMAL' },
      { bet: 'UP', side: 'yes', count: 10, amount: 7.00, lockedSL: 0.12 }
    );
    await checkExit(ctx);
    assert.equal(ctx.s.activeTrade, null, 'Trade should be closed on STOP_LOSS');
  });

  test('VEL_REVERSAL: consistent velocity against bet with profit exits', async () => {
    // pctCaptured > 0.05 required — set up decent profit first
    // count=10, yesBid=0.75, amount=7.00 → pnl=0.50, maxProfit=3.0 → pct~0.17 > 0.05
    // UP bet, avgVel < -0.08 → velocity reversal
    const ctx = makeCtx(
      {
        yesAsk: 0.77, yesBid: 0.75,
        yesVelHistory: [-0.15, -0.12, -0.10],
      },
      { bet: 'UP', side: 'yes', count: 10, amount: 7.00, maxProfit: 3.00, lockedTP: 1.80, lockedSL: 0.12 }
    );
    await checkExit(ctx);
    assert.equal(ctx.s.activeTrade, null, 'Trade should be closed on VEL_REVERSAL');
  });

  test('TIME_FLOOR: exits when secsLeft <= 90 and any profit', async () => {
    // count=10, yesBid=0.71, amount=7.00 → pnl=0.10 > 0, secsLeft=89
    const ctx = makeCtx(
      { yesAsk: 0.72, yesBid: 0.71, secsLeft: 89 },
      { bet: 'UP', side: 'yes', count: 10, amount: 7.00, maxProfit: 3.00, lockedTP: 1.80, lockedSL: 0.12 }
    );
    await checkExit(ctx);
    assert.equal(ctx.s.activeTrade, null, 'Trade should be closed on TIME_FLOOR');
  });

  test('does NOT exit when no condition met', async () => {
    // Healthy mid-trade: good price, plenty of time, no reversal
    const ctx = makeCtx(
      { yesAsk: 0.72, yesBid: 0.70, secsLeft: 500 },
      { bet: 'UP', side: 'yes', count: 10, amount: 7.00, maxProfit: 3.00, lockedTP: 1.80, lockedSL: 0.12 }
    );
    await checkExit(ctx);
    assert.notEqual(ctx.s.activeTrade, null, 'Trade should remain open');
  });

  test('does nothing when no activeTrade', async () => {
    const s = createAssetState({ yesAsk: 0.70, yesBid: 0.68 });
    // activeTrade is null — should not throw
    await assert.doesNotReject(() => checkExit({ asset: 'BTC', s }));
  });
});
