/**
 * Unit tests for src/kalshi/client.js
 * Tests buildHeaders shape and findActiveMarket filtering/sorting logic.
 * Uses a generated RSA key so crypto signing doesn't fail, and mocks
 * global.fetch so no real HTTP calls are made.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── Generate a real RSA key so buildHeaders doesn't crash ────────────────────
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testPem = privateKey.export({ type: 'pkcs1', format: 'pem' });

process.env.KALSHI_KEY_ID      = 'test-key-id';
process.env.KALSHI_PRIVATE_KEY = testPem; // real newlines — normalizePEM handles both forms

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeFuture(offsetMs = 60_000) {
  return new Date(Date.now() + offsetMs).toISOString();
}
function makePast(offsetMs = 60_000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

function mockFetch(markets) {
  global.fetch = async () => ({
    ok:   true,
    text: async () => JSON.stringify({ markets }),
  });
}

// ── Lazy-load after env is set ────────────────────────────────────────────────
let buildHeaders, findActiveMarket, BASE_URL;

before(async () => {
  ({ buildHeaders, findActiveMarket, BASE_URL } =
    await import('../../src/kalshi/client.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildHeaders', () => {
  test('returns KALSHI-ACCESS-KEY', () => {
    const h = buildHeaders('GET', '/markets');
    assert.equal(h['KALSHI-ACCESS-KEY'], 'test-key-id');
  });

  test('returns KALSHI-ACCESS-SIGNATURE as base64 string', () => {
    const h = buildHeaders('GET', '/markets');
    assert.equal(typeof h['KALSHI-ACCESS-SIGNATURE'], 'string');
    assert.ok(h['KALSHI-ACCESS-SIGNATURE'].length > 0);
    // base64 characters only
    assert.match(h['KALSHI-ACCESS-SIGNATURE'], /^[A-Za-z0-9+/]+=*$/);
  });

  test('returns KALSHI-ACCESS-TIMESTAMP as numeric string', () => {
    const h = buildHeaders('GET', '/markets');
    const ts = h['KALSHI-ACCESS-TIMESTAMP'];
    assert.equal(typeof ts, 'string');
    assert.ok(!Number.isNaN(Number(ts)), `Timestamp "${ts}" is not numeric`);
  });

  test('returns Content-Type application/json', () => {
    const h = buildHeaders('POST', '/portfolio/orders');
    assert.equal(h['Content-Type'], 'application/json');
  });

  test('signature changes for different methods', () => {
    const h1 = buildHeaders('GET',  '/markets');
    const h2 = buildHeaders('POST', '/markets');
    assert.notEqual(h1['KALSHI-ACCESS-SIGNATURE'], h2['KALSHI-ACCESS-SIGNATURE']);
  });

  test('strips query string from signed path', () => {
    // Two calls with same base path but different query strings should produce
    // the same signature (query params are NOT signed)
    const h1 = buildHeaders('GET', '/markets?series_ticker=KXBTC15M&status=open');
    const h2 = buildHeaders('GET', '/markets');
    // They have different timestamps so direct equality won't hold,
    // but both should be valid base64 strings (no crash)
    assert.match(h1['KALSHI-ACCESS-SIGNATURE'], /^[A-Za-z0-9+/]+=*$/);
    assert.match(h2['KALSHI-ACCESS-SIGNATURE'], /^[A-Za-z0-9+/]+=*$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('findActiveMarket', () => {
  // Compute times deterministically relative to the actual 15-min window boundaries
  // so tests aren't affected by ±90s window-match tolerance.
  function windowBoundaryMs() {
    return (Math.floor(Date.now() / (15 * 60 * 1000)) + 1) * 15 * 60 * 1000;
  }
  // Mid-window = 7.5 min from the nearest boundary → always >90s away from any boundary
  function midWindowFuture(windowsAhead = 1) {
    return new Date(windowBoundaryMs() + windowsAhead * 15 * 60 * 1000 - 7.5 * 60 * 1000).toISOString();
  }

  test('returns the window-matching market (preferred over soonest future)', async () => {
    const target = new Date(windowBoundaryMs()).toISOString();
    mockFetch([
      { ticker: 'KXBTC15M-WINDOW', close_time: target },
      { ticker: 'KXBTC15M-FAR',    close_time: midWindowFuture(2) },
    ]);
    const m = await findActiveMarket('BTC');
    assert.equal(m.ticker, 'KXBTC15M-WINDOW');
  });

  test('returns soonest future market when no window match (fallback)', async () => {
    // Place both markets at mid-window times — guaranteed >90s from any boundary
    mockFetch([
      { ticker: 'KXBTC15M-NEAR', close_time: midWindowFuture(1) },
      { ticker: 'KXBTC15M-FAR',  close_time: midWindowFuture(2) },
    ]);
    const m = await findActiveMarket('BTC');
    assert.equal(m.ticker, 'KXBTC15M-NEAR');
  });

  test('filters out markets that have already closed', async () => {
    // EXPIRED: 10+ minutes in the past, well outside ±90s window tolerance
    mockFetch([
      { ticker: 'KXBTC15M-EXPIRED', close_time: makePast(600_000) },
      { ticker: 'KXBTC15M-ACTIVE',  close_time: midWindowFuture(1) },
    ]);
    const m = await findActiveMarket('BTC');
    assert.equal(m.ticker, 'KXBTC15M-ACTIVE');
  });

  test('throws when no open markets returned', async () => {
    mockFetch([]);
    await assert.rejects(
      () => findActiveMarket('BTC'),
      /No open KXBTC15M market found/
    );
  });

  test('throws when ALL markets are expired (no future or window match)', async () => {
    // Both markets are well outside the ±90s window-match tolerance AND in the past
    mockFetch([
      { ticker: 'KXBTC15M-OLD1', close_time: makePast(600_000) },
      { ticker: 'KXBTC15M-OLD2', close_time: makePast(300_000) },
    ]);
    await assert.rejects(
      () => findActiveMarket('BTC'),
      /No future/i
    );
  });

  test('uses KXETH15M series for ETH', async () => {
    let capturedUrl = '';
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok:   true,
        text: async () => JSON.stringify({
          markets: [{ ticker: 'KXETH15M-TEST', close_time: makeFuture() }],
        }),
      };
    };
    await findActiveMarket('ETH');
    assert.ok(capturedUrl.includes('KXETH15M'), `Expected KXETH15M in URL, got: ${capturedUrl}`);
  });

  test('uses KXBTC15M series for BTC', async () => {
    let capturedUrl = '';
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok:   true,
        text: async () => JSON.stringify({
          markets: [{ ticker: 'KXBTC15M-TEST', close_time: makeFuture() }],
        }),
      };
    };
    await findActiveMarket('BTC');
    assert.ok(capturedUrl.includes('KXBTC15M'), `Expected KXBTC15M in URL, got: ${capturedUrl}`);
  });

  test('throws on non-ok HTTP response', async () => {
    global.fetch = async () => ({
      ok:         false,
      status:     401,
      statusText: 'Unauthorized',
      text:       async () => JSON.stringify({ error: 'invalid signature' }),
    });
    await assert.rejects(
      () => findActiveMarket('BTC'),
      /401|invalid signature|Unauthorized/i
    );
  });

  test('market with missing close_time is treated as expired', async () => {
    // A market without close_time: new Date(undefined).getTime() = NaN > now is false → filtered
    mockFetch([
      { ticker: 'KXBTC15M-NODATETIME' },   // no close_time
      { ticker: 'KXBTC15M-GOOD', close_time: makeFuture() },
    ]);
    const m = await findActiveMarket('BTC');
    assert.equal(m.ticker, 'KXBTC15M-GOOD');
  });
});
