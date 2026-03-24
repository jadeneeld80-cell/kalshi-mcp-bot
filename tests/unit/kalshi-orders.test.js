/**
 * Unit tests for src/kalshi/orders.js
 * Tests buildBuyBody, buildSellBody, executeBuy, executeSell, cancelOpenOrders.
 */
import { test, describe, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock client before dynamic import ────────────────────────────────────────
let mockPlaceOrder   = async () => ({ order: { id: 'mock-order', remaining_count: 0 } });
let mockCancelOrder  = async () => ({});
let mockGetOrders    = async () => [];

mock.module('../../src/kalshi/client.js', {
  namedExports: {
    placeOrder:   (...a) => mockPlaceOrder(...a),
    cancelOrder:  (...a) => mockCancelOrder(...a),
    getOrders:    (...a) => mockGetOrders(...a),
    buildHeaders: () => ({}),
    BASE_URL: 'https://mock.kalshi.com',
  },
});

let buildBuyBody, buildSellBody, executeBuy, executeSell, cancelOpenOrders;

before(async () => {
  ({ buildBuyBody, buildSellBody, executeBuy, executeSell, cancelOpenOrders } =
    await import('../../src/kalshi/orders.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildBuyBody — UP bet', () => {
  const ticker = 'KXBTC15M-TEST-45';
  const yesAsk = 0.60, yesBid = 0.58;

  test('side is "yes" for UP bet', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(body.side, 'yes');
  });

  test('action is "buy"', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(body.action, 'buy');
  });

  test('type is "limit" (required by Kalshi)', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(body.type, 'limit');
  });

  test('time_in_force is "fill_or_kill"', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(body.time_in_force, 'fill_or_kill');
  });

  test('count = floor(amount / yesAsk)', () => {
    // $1.00 at yesAsk=0.60 → floor(1.00/0.60) = 1
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(body.count, 1);
    // $5.00 at yesAsk=0.60 → floor(5.00/0.60) = 8
    const body2 = buildBuyBody(ticker, 'UP', 5.00, yesAsk, yesBid);
    assert.equal(body2.count, 8);
  });

  test('yes_price_dollars is a 4-decimal string', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(typeof body.yes_price_dollars, 'string');
    assert.match(body.yes_price_dollars, /^\d+\.\d{4}$/);
  });

  test('buy_max_cost is an integer in cents', () => {
    const body = buildBuyBody(ticker, 'UP', 1.25, yesAsk, yesBid);
    assert.equal(body.buy_max_cost, 125);
    assert.ok(Number.isInteger(body.buy_max_cost));
  });

  test('client_order_id is a non-empty string', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.equal(typeof body.client_order_id, 'string');
    assert.ok(body.client_order_id.length > 0);
  });

  test('no no_price_dollars field on UP bet', () => {
    const body = buildBuyBody(ticker, 'UP', 1.00, yesAsk, yesBid);
    assert.ok(!('no_price_dollars' in body), 'no_price_dollars should not be set for UP');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildBuyBody — DOWN bet', () => {
  const ticker = 'KXBTC15M-TEST-45';
  const yesAsk = 0.60, yesBid = 0.58;

  test('side is "no" for DOWN bet', () => {
    const body = buildBuyBody(ticker, 'DOWN', 1.00, yesAsk, yesBid);
    assert.equal(body.side, 'no');
  });

  test('count = floor(amount / (1 - yesBid))', () => {
    // NO price = 1 - 0.58 = 0.42 → floor(1.00 / 0.42) = 2
    const body = buildBuyBody(ticker, 'DOWN', 1.00, yesAsk, yesBid);
    assert.equal(body.count, 2);
  });

  test('DOWN count is NOT floor(amount / yesAsk) — the old bug', () => {
    // Old bug: count = floor(1.00/0.60) = 1, correct: floor(1.00/0.42) = 2
    const body = buildBuyBody(ticker, 'DOWN', 1.00, yesAsk, yesBid);
    assert.notEqual(body.count, Math.floor(1.00 / yesAsk), 'Should NOT use yesAsk for DOWN count');
    assert.equal(body.count, Math.floor(1.00 / (1 - yesBid)));
  });

  test('no_price_dollars is a 4-decimal string', () => {
    const body = buildBuyBody(ticker, 'DOWN', 1.00, yesAsk, yesBid);
    assert.equal(typeof body.no_price_dollars, 'string');
    assert.match(body.no_price_dollars, /^\d+\.\d{4}$/);
  });

  test('no yes_price_dollars field on DOWN bet', () => {
    const body = buildBuyBody(ticker, 'DOWN', 1.00, yesAsk, yesBid);
    assert.ok(!('yes_price_dollars' in body), 'yes_price_dollars should not be set for DOWN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildBuyBody — error cases', () => {
  const ticker = 'KXBTC15M-TEST-45';

  test('throws when budget too low for UP (count < 1)', () => {
    // $0.01 at yesAsk=0.99 → floor(0.01/0.99) = 0 < 1
    assert.throws(
      () => buildBuyBody(ticker, 'UP', 0.01, 0.99, 0.98),
      /Budget too low/
    );
  });

  test('throws when budget too low for DOWN (count < 1)', () => {
    // NO price = 1 - 0.99 = 0.01 → floor(0.001/0.01) = 0 < 1
    assert.throws(
      () => buildBuyBody(ticker, 'DOWN', 0.001, 0.02, 0.01),
      /Budget too low/
    );
  });

  test('throws on NaN amount', () => {
    // NaN / 0.60 = NaN, NaN < 1 is FALSE, so currently does NOT throw — this is the bug
    assert.throws(
      () => buildBuyBody(ticker, 'UP', NaN, 0.60, 0.58),
      /invalid|NaN|amount/i,
      'buildBuyBody should throw on NaN amount'
    );
  });

  test('throws on zero amount', () => {
    assert.throws(
      () => buildBuyBody(ticker, 'UP', 0, 0.60, 0.58),
      /Budget too low|invalid|amount/i
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildSellBody', () => {
  const ticker = 'KXBTC15M-TEST-45';

  test('yes side uses yes_price_dollars', () => {
    const body = buildSellBody(ticker, 'yes', 5);
    assert.equal(body.yes_price_dollars, '0.0100');
    assert.ok(!('no_price_dollars' in body));
  });

  test('no side uses no_price_dollars', () => {
    const body = buildSellBody(ticker, 'no', 5);
    assert.equal(body.no_price_dollars, '0.0100');
    assert.ok(!('yes_price_dollars' in body));
  });

  test('action is "sell"', () => {
    const body = buildSellBody(ticker, 'yes', 5);
    assert.equal(body.action, 'sell');
  });

  test('type is "limit"', () => {
    const body = buildSellBody(ticker, 'yes', 5);
    assert.equal(body.type, 'limit');
  });

  test('time_in_force is "fill_or_kill"', () => {
    const body = buildSellBody(ticker, 'yes', 5);
    assert.equal(body.time_in_force, 'fill_or_kill');
  });

  test('floors fractional contract count', () => {
    const body = buildSellBody(ticker, 'yes', 5.9);
    assert.equal(body.count, 5);
  });

  test('throws when contractsHeld < 1', () => {
    assert.throws(() => buildSellBody(ticker, 'yes', 0.5), /Invalid/);
    assert.throws(() => buildSellBody(ticker, 'yes', 0),   /Invalid/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('executeBuy', () => {
  test('calls placeOrder with the built body', async () => {
    let captured = null;
    mockPlaceOrder = async (body) => { captured = body; return { order: { id: 'o1' } }; };

    const { body } = await executeBuy('KXBTC15M-TEST', 'UP', 1.00, 0.60, 0.58);
    assert.ok(captured !== null, 'placeOrder should have been called');
    assert.equal(captured.side,   'yes');
    assert.equal(captured.action, 'buy');
    assert.equal(body.ticker, 'KXBTC15M-TEST');
  });

  test('propagates placeOrder errors', async () => {
    mockPlaceOrder = async () => { throw new Error('API error 429'); };
    await assert.rejects(
      () => executeBuy('KXBTC15M-TEST', 'UP', 1.00, 0.60, 0.58),
      /API error 429/
    );
    mockPlaceOrder = async () => ({ order: { id: 'mock', remaining_count: 0 } }); // reset
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('executeSell', () => {
  test('cancels open orders before selling', async () => {
    const calls = [];
    mockGetOrders    = async () => [{ order_id: 'open-1' }, { order_id: 'open-2' }];
    mockCancelOrder  = async (id) => { calls.push(`cancel:${id}`); return {}; };
    mockPlaceOrder   = async () => { calls.push('sell'); return { order: { id: 'sold' } }; };

    await executeSell('KXBTC15M-TEST', 'yes', 5);

    assert.ok(calls.includes('cancel:open-1'), 'Should cancel open-1');
    assert.ok(calls.includes('cancel:open-2'), 'Should cancel open-2');
    assert.ok(calls.indexOf('cancel:open-1') < calls.indexOf('sell'), 'Cancel must precede sell');
    assert.ok(calls.indexOf('cancel:open-2') < calls.indexOf('sell'), 'Cancel must precede sell');
  });

  test('still sells even if cancel fails (best-effort)', async () => {
    let sellCalled = false;
    mockGetOrders   = async () => [{ order_id: 'open-1' }];
    mockCancelOrder = async () => { throw new Error('cancel failed'); };
    mockPlaceOrder  = async () => { sellCalled = true; return { order: {} }; };

    await executeSell('KXBTC15M-TEST', 'yes', 5);
    assert.ok(sellCalled, 'Sell should proceed even when cancel throws');
  });

  test('propagates sell (placeOrder) errors', async () => {
    mockGetOrders   = async () => [];
    mockCancelOrder = async () => ({});
    mockPlaceOrder  = async () => { throw new Error('sell rejected'); };

    await assert.rejects(
      () => executeSell('KXBTC15M-TEST', 'yes', 5),
      /sell rejected/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('cancelOpenOrders', () => {
  test('does nothing when no resting orders', async () => {
    let cancelCalled = false;
    mockGetOrders   = async () => [];
    mockCancelOrder = async () => { cancelCalled = true; };

    await cancelOpenOrders('KXBTC15M-TEST');
    assert.ok(!cancelCalled, 'cancelOrder should not be called when no orders');
  });

  test('cancels all resting orders for the ticker', async () => {
    const cancelled = [];
    mockGetOrders   = async () => [{ order_id: 'a' }, { order_id: 'b' }, { order_id: 'c' }];
    mockCancelOrder = async (id) => { cancelled.push(id); return {}; };

    await cancelOpenOrders('KXBTC15M-TEST');
    assert.deepEqual(cancelled.sort(), ['a', 'b', 'c']);
  });
});
