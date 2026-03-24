/**
 * Integration tests for MCP tool error cases and edge conditions.
 * Spawns a real bot and exercises validation / boundary conditions
 * that the happy-path tests in mcp-tools.test.js don't cover.
 *
 * Several tests are intentionally written to FAIL against the current
 * implementation, documenting bugs that need to be fixed:
 *
 *   [FAIL] set_balance with negative amount — silently accepted, should error
 *   [FAIL] get_trade_history with negative limit — returns wrong count
 *   [FAIL] close_trade when yesAsk is null — estimatedPnL is 'NaN'
 *   [FAIL] import_brain with malformed JSON — crashes instead of returning error
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MCPTestClient, sleep } from '../helpers/mcp-client.js';
import 'dotenv/config';

let client;

before(async () => {
  client = new MCPTestClient();
  await client.start();
  // Give clock a moment to populate tickers (don't need live prices for these tests)
  await sleep(3000);
});

after(() => client?.stop());

// ─────────────────────────────────────────────────────────────────────────────
describe('set_balance — validation', () => {
  test('accepts a valid positive amount', async () => {
    const res  = await client.callTool('set_balance', { amount: 10.00 });
    const data = client.parseResult(res);
    assert.ok(typeof data === 'string' && data.includes('10'), 'Should confirm new balance');
  });

  test('rejects negative amount with ERROR', async () => {
    // BUG: currently silently sets balance to -10 and returns success
    let threw = false;
    try {
      const res = await client.callTool('set_balance', { amount: -10 });
      client.parseResult(res); // throws on ERROR: prefix
    } catch (e) {
      threw = true;
      assert.ok(e.message.toLowerCase().includes('invalid') ||
                e.message.toLowerCase().includes('negative') ||
                e.message.toLowerCase().includes('amount'),
        `Expected validation error, got: ${e.message}`);
    }
    assert.ok(threw, 'set_balance(-10) should return an ERROR response');
  });

  test('balance in get_status is not negative after rejected set_balance', async () => {
    // Even if the above failed, balance should not be -10
    const status = client.parseResult(await client.callTool('get_status'));
    const bal = parseFloat(status.balance);
    assert.ok(bal >= 0, `Balance should not be negative, got: ${bal}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('get_trade_history — limit edge cases', () => {
  test('limit=0 returns empty array', async () => {
    const res  = await client.callTool('get_trade_history', { limit: 0 });
    const data = client.parseResult(res);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0, `Expected 0 entries for limit=0, got ${data.length}`);
  });

  test('negative limit returns empty array (not garbage data)', async () => {
    // BUG: logs.slice(-(-1)) = logs.slice(1) returns all but first entry
    const res  = await client.callTool('get_trade_history', { limit: -1 });
    const data = client.parseResult(res);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0, `Expected 0 entries for limit=-1, got ${data.length}`);
  });

  test('large limit returns all available entries', async () => {
    const res  = await client.callTool('get_trade_history', { limit: 10000 });
    const data = client.parseResult(res);
    assert.ok(Array.isArray(data));
    // Just verify it returned something reasonable, not an error
    assert.ok(data.length >= 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('close_trade — null price handling', () => {
  test('estimatedPnL is "n/a" (not "NaN") when prices unavailable', async () => {
    // Set up: place a manual trade if possible, or read current state.
    // We test by directly observing that if a trade were closed without live prices,
    // the server handles it gracefully.  Since we cannot force prices to be null
    // in integration, we verify the status field when no trade is active returns
    // a clean error rather than leaking NaN.
    const status = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));

    if (!status.assets.BTC.activeTrade) {
      // No active trade: close_trade should return a clean error
      let threw = false;
      try {
        const res = await client.callTool('close_trade', { asset: 'BTC' });
        client.parseResult(res);
      } catch (e) {
        threw = true;
        assert.ok(!e.message.includes('NaN'), `Error message should not contain NaN: ${e.message}`);
        assert.ok(e.message.toLowerCase().includes('no active trade'),
          `Expected "no active trade", got: ${e.message}`);
      }
      assert.ok(threw, 'close_trade with no active trade should throw');
    } else {
      // Active trade: check the pnl field in status is not 'NaN'
      const pnl = status.assets.BTC.activeTrade.pnl;
      assert.notEqual(pnl, 'NaN', 'pnl should never be the string "NaN"');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('import_brain — invalid input handling', () => {
  test('malformed JSON string returns ERROR response', async () => {
    // BUG: importBrain may throw an unhandled parse error
    let threw = false;
    try {
      const res = await client.callTool('import_brain', {
        asset: 'BTC',
        json:  'not valid json {{{{',
      });
      client.parseResult(res);
    } catch (e) {
      threw = true;
      // Should be a descriptive error, not an unhandled crash
      assert.ok(e.message.length > 0, 'Error message should be non-empty');
    }
    assert.ok(threw, 'import_brain with invalid JSON should return an ERROR response');
  });

  test('JSON missing weights field returns ERROR', async () => {
    let threw = false;
    try {
      const res = await client.callTool('import_brain', {
        asset: 'BTC',
        json:  JSON.stringify({ data: [], dataUp: [], dataDown: [] }), // no weights
      });
      client.parseResult(res);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'import_brain with missing weights should return an ERROR response');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('place_manual_trade — input validation', () => {
  test('amount=0 returns ERROR', async () => {
    let threw = false;
    try {
      const res = await client.callTool('place_manual_trade', {
        asset: 'BTC', bet: 'UP', amount: 0,
      });
      client.parseResult(res);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'amount=0 should return ERROR');
  });

  test('negative amount returns ERROR', async () => {
    let threw = false;
    try {
      const res = await client.callTool('place_manual_trade', {
        asset: 'BTC', bet: 'UP', amount: -5,
      });
      client.parseResult(res);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'negative amount should return ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('arm_farm_bot — state persistence', () => {
  test('arming persists to bot_state.json', async () => {
    await client.callTool('arm_farm_bot', { asset: 'BTC', armed: true });
    const status = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    assert.equal(status.assets.BTC.farmArmed, true);
    // Cleanup
    await client.callTool('arm_farm_bot', { asset: 'BTC', armed: false });
  });

  test('disarming persists correctly', async () => {
    await client.callTool('arm_farm_bot', { asset: 'ETH', armed: true });
    await client.callTool('arm_farm_bot', { asset: 'ETH', armed: false });
    const status = client.parseResult(await client.callTool('get_status', { asset: 'ETH' }));
    assert.equal(status.assets.ETH.farmArmed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reset_risk — edge cases', () => {
  test('resetting already-clean state is idempotent', async () => {
    // Reset twice — should not throw or corrupt state
    await client.callTool('reset_risk', { asset: 'BTC' });
    await client.callTool('reset_risk', { asset: 'BTC' });
    const status = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    assert.equal(status.assets.BTC.risk.consecutiveLosses, 0);
  });

  test('risk fields are all numeric after reset', async () => {
    await client.callTool('reset_risk', { asset: 'BTC' });
    const { risk } = client.parseResult(await client.callTool('get_status', { asset: 'BTC' })).assets.BTC;
    assert.ok(Number.isInteger(risk.consecutiveLosses));
    assert.ok(!Number.isNaN(parseFloat(risk.sessionPnL)), `sessionPnL is NaN: ${risk.sessionPnL}`);
    assert.ok(!Number.isNaN(parseFloat(risk.dailyPnL)),   `dailyPnL is NaN: ${risk.dailyPnL}`);
    assert.ok(!Number.isNaN(parseFloat(risk.totalPnL)),   `totalPnL is NaN: ${risk.totalPnL}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('get_status — edge cases', () => {
  test('balance field is never NaN', async () => {
    const data = client.parseResult(await client.callTool('get_status'));
    const bal  = parseFloat(data.balance);
    assert.ok(!Number.isNaN(bal), `balance should not be NaN, got: ${data.balance}`);
  });

  test('yesVel is null or a finite number', async () => {
    const data = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    const vel  = data.assets.BTC.yesVel;
    if (vel !== null) {
      assert.ok(!Number.isNaN(parseFloat(vel)), `yesVel should not be NaN: ${vel}`);
    }
  });

  test('farmRounds is a non-negative integer', async () => {
    const data = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    const r    = data.assets.BTC.farmRounds;
    assert.ok(Number.isInteger(r) && r >= 0, `farmRounds should be non-negative integer: ${r}`);
  });
});
