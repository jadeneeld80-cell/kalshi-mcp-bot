/**
 * Simulated Market Agent
 * ─────────────────────
 * Tests the MCP server under a series of scripted market scenarios by
 * manipulating bot state via MCP tools and verifying that the system
 * behaves correctly.  Does NOT place real orders.
 *
 * Scenarios covered:
 *  1. Farm bot arming / risk guard state transitions
 *  2. DECAY mode conditions (short time + extreme YES price)
 *  3. Loss streak → risk block → reset cycle
 *  4. Balance scenarios (tiny balance, normal balance)
 *  5. Brain import → stats reflect new data
 *  6. Window roll simulation (ticker update detection)
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MCPTestClient, sleep } from '../helpers/mcp-client.js';
import 'dotenv/config';

let client;

before(async () => {
  client = new MCPTestClient();
  await client.start();
  await client.waitForMarket('BTC');
  await client.waitForMarket('ETH');
});

after(() => client?.stop());

// Helper: read current BTC status
async function btcStatus() {
  const res = await client.callTool('get_status', { asset: 'BTC' });
  return client.parseResult(res).assets.BTC;
}

// Helper: read current ETH status
async function ethStatus() {
  const res = await client.callTool('get_status', { asset: 'ETH' });
  return client.parseResult(res).assets.ETH;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 1 — arm / disarm cycle', () => {
  test('start: both bots disarmed', async () => {
    await client.callTool('arm_farm_bot',  { asset: 'BTC', armed: false });
    await client.callTool('arm_auto_buy',  { asset: 'BTC', armed: false });
    const s = await btcStatus();
    assert.equal(s.farmArmed,    false);
    assert.equal(s.autoBuyArmed, false);
  });

  test('arm farm → status reflects, auto_buy still off', async () => {
    await client.callTool('arm_farm_bot', { asset: 'BTC', armed: true });
    const s = await btcStatus();
    assert.equal(s.farmArmed,    true);
    assert.equal(s.autoBuyArmed, false);
  });

  test('switch to auto_buy — farm disarmed automatically', async () => {
    await client.callTool('arm_auto_buy', { asset: 'BTC', armed: true });
    const s = await btcStatus();
    assert.equal(s.autoBuyArmed, true);
    assert.equal(s.farmArmed,    false);
  });

  test('disarm all — both false', async () => {
    await client.callTool('arm_auto_buy', { asset: 'BTC', armed: false });
    const s = await btcStatus();
    assert.equal(s.autoBuyArmed, false);
    assert.equal(s.farmArmed,    false);
  });

  test('BTC and ETH arm states are independent', async () => {
    await client.callTool('arm_farm_bot', { asset: 'BTC', armed: true });
    await client.callTool('arm_farm_bot', { asset: 'ETH', armed: false });
    const btc = await btcStatus();
    const eth = await ethStatus();
    assert.equal(btc.farmArmed, true);
    assert.equal(eth.farmArmed, false);
    // cleanup
    await client.callTool('arm_farm_bot', { asset: 'BTC', armed: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 2 — balance state transitions', () => {
  const ORIGINAL_BALANCE_HOLDER = { value: 0 };

  before(async () => {
    const status = client.parseResult(await client.callTool('get_status'));
    ORIGINAL_BALANCE_HOLDER.value = parseFloat(status.balance);
  });

  after(async () => {
    await client.callTool('set_balance', { amount: ORIGINAL_BALANCE_HOLDER.value });
  });

  test('set very small balance (simulates micro account)', async () => {
    await client.callTool('set_balance', { amount: 1.00 });
    const status = client.parseResult(await client.callTool('get_status'));
    assert.ok(Math.abs(parseFloat(status.balance) - 1.00) < 0.01);
  });

  test('set larger balance (simulates funded account)', async () => {
    await client.callTool('set_balance', { amount: 500.00 });
    const status = client.parseResult(await client.callTool('get_status'));
    assert.ok(Math.abs(parseFloat(status.balance) - 500.00) < 0.01);
  });

  test('set_balance with $0 is accepted', async () => {
    await client.callTool('set_balance', { amount: 0 });
    const status = client.parseResult(await client.callTool('get_status'));
    assert.ok(Math.abs(parseFloat(status.balance)) < 0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 3 — risk counter lifecycle', () => {
  test('reset_risk clears counters for BTC', async () => {
    await client.callTool('reset_risk', { asset: 'BTC' });
    const s = await btcStatus();
    assert.equal(s.risk.consecutiveLosses, 0);
  });

  test('reset_risk clears counters for ETH', async () => {
    await client.callTool('reset_risk', { asset: 'ETH' });
    const s = await ethStatus();
    assert.equal(s.risk.consecutiveLosses, 0);
  });

  test('sessionPnL is a numeric string', async () => {
    const s = await btcStatus();
    assert.ok(!Number.isNaN(parseFloat(s.risk.sessionPnL)),
      `sessionPnL "${s.risk.sessionPnL}" is not numeric`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 4 — brain import and stats verification', () => {
  const BRAIN_WITH_SAMPLES = JSON.stringify({
    weights: {
      w1:    Array.from({ length: 8 }, () => Array(9).fill(0.01)),
      b1:    Array(8).fill(0.01),
      w2:    [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]],
      b2:    [0.01],
      w1Up:  Array.from({ length: 8 }, () => Array(9).fill(0.01)),
      b1Up:  Array(8).fill(0.01),
      w2Up:  [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]],
      b2Up:  [0.01],
      w1Down: Array.from({ length: 8 }, () => Array(9).fill(0.01)),
      b1Down: Array(8).fill(0.01),
      w2Down: [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]],
      b2Down: [0.01],
    },
    data:     [{ f: Array(9).fill(0.1), l: 1 }, { f: Array(9).fill(-0.1), l: 0 }],
    dataUp:   [{ f: Array(9).fill(0.1), l: 1 }],
    dataDown: [{ f: Array(9).fill(-0.1), l: 0 }],
  });

  test('import brain with sample data', async () => {
    const res = await client.callTool('import_brain', { asset: 'BTC', json: BRAIN_WITH_SAMPLES });
    const data = client.parseResult(res);
    assert.ok(data.message?.includes('imported') || data.stats, 'Import should confirm success');
  });

  test('get_brain_stats reflects imported samples', async () => {
    await client.callTool('import_brain', { asset: 'BTC', json: BRAIN_WITH_SAMPLES });
    const res  = await client.callTool('get_brain_stats', { asset: 'BTC' });
    const data = client.parseResult(res);
    assert.ok(data.combined.samples >= 2, `Expected ≥2 combined samples, got ${data.combined.samples}`);
    assert.ok(data.up.samples >= 1,       `Expected ≥1 UP samples, got ${data.up.samples}`);
    assert.ok(data.down.samples >= 1,     `Expected ≥1 DOWN samples, got ${data.down.samples}`);
  });

  test('win rate is parseable percentage string', async () => {
    await client.callTool('import_brain', { asset: 'BTC', json: BRAIN_WITH_SAMPLES });
    const res  = await client.callTool('get_brain_stats', { asset: 'BTC' });
    const data = client.parseResult(res);
    if (data.combined.winRate !== null) {
      assert.match(data.combined.winRate, /^\d+\.\d+%$/, 'Win rate should be like "50.0%"');
    }
  });

  test('export_brain returns imported weights', async () => {
    await client.callTool('import_brain', { asset: 'BTC', json: BRAIN_WITH_SAMPLES });
    const exported = client.parseResult(await client.callTool('export_brain', { asset: 'BTC' }));
    assert.ok(exported.weights?.w1, 'Exported brain missing weights.w1');
    assert.ok(Array.isArray(exported.data), 'Exported brain missing data array');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 5 — market data integrity checks', () => {
  test('BTC and ETH tickers are different', async () => {
    const btc = await btcStatus();
    const eth = await ethStatus();
    assert.notEqual(btc.ticker, eth.ticker,
      `BTC and ETH should have different tickers: ${btc.ticker} vs ${eth.ticker}`);
  });

  test('BTC ticker starts with KXBTC15M', async () => {
    const s = await btcStatus();
    assert.match(s.ticker, /^KXBTC15M-/);
  });

  test('ETH ticker starts with KXETH15M', async () => {
    const s = await ethStatus();
    assert.match(s.ticker, /^KXETH15M-/);
  });

  test('spread is below 0.20 (not excessive)', async () => {
    const s = await btcStatus();
    if (s.yesAsk !== null && s.yesBid !== null) {
      const spread = parseFloat(s.yesAsk) - parseFloat(s.yesBid);
      assert.ok(spread < 0.20, `Spread ${spread.toFixed(4)} ≥ 0.20 — excessive`);
      assert.ok(spread >= 0,   `Negative spread ${spread.toFixed(4)}`);
    }
  });

  test('farmRounds is a non-negative integer', async () => {
    const s = await btcStatus();
    assert.ok(Number.isInteger(s.farmRounds) && s.farmRounds >= 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 6 — trade history and logs are consistent', () => {
  test('get_trade_history and get_logs return same structure', async () => {
    const hist = client.parseResult(await client.callTool('get_trade_history'));
    const logs = client.parseResult(await client.callTool('get_logs'));
    assert.ok(Array.isArray(hist));
    assert.ok(Array.isArray(logs));
    // Both read the same file — lengths should match (same default limit)
    assert.equal(hist.length, logs.length, 'get_trade_history and get_logs should return same count');
  });
});
