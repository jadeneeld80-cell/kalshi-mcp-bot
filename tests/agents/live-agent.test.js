/**
 * Live Market Agent
 * ─────────────────
 * Validates the MCP server under REAL current market conditions.
 * Checks that live price data is flowing, spread/liquidity are sane,
 * and that the bot's state machine responds correctly to market reality.
 *
 * All tests are strictly READ-ONLY — no orders placed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MCPTestClient, sleep } from '../helpers/mcp-client.js';
import 'dotenv/config';

let client;
let liveStatus; // Snapshot at test start

before(async () => {
  client = new MCPTestClient();
  await client.start();
  liveStatus = await client.waitForMarket('BTC');
  await client.waitForMarket('ETH');
});

after(() => client?.stop());

// ─────────────────────────────────────────────────────────────────────────────
describe('Live market data quality', () => {
  test('BTC YES prices are flowing (non-null)', async () => {
    const res = await client.callTool('get_status', { asset: 'BTC' });
    const btc = client.parseResult(res).assets.BTC;
    assert.notEqual(btc.yesAsk, null, 'BTC yesAsk should not be null');
    assert.notEqual(btc.yesBid, null, 'BTC yesBid should not be null');
  });

  test('ETH YES prices are flowing (non-null)', async () => {
    const res = await client.callTool('get_status', { asset: 'ETH' });
    const eth = client.parseResult(res).assets.ETH;
    assert.notEqual(eth.yesAsk, null, 'ETH yesAsk should not be null');
    assert.notEqual(eth.yesBid, null, 'ETH yesBid should not be null');
  });

  test('YES prices are economically valid (0 < bid ≤ ask < 1)', async () => {
    for (const asset of ['BTC', 'ETH']) {
      const res = await client.callTool('get_status', { asset });
      const s   = client.parseResult(res).assets[asset];
      const ask = parseFloat(s.yesAsk);
      const bid = parseFloat(s.yesBid);
      assert.ok(ask > 0,   `${asset} yesAsk=${ask} ≤ 0`);
      assert.ok(ask < 1,   `${asset} yesAsk=${ask} ≥ 1`);
      assert.ok(bid > 0,   `${asset} yesBid=${bid} ≤ 0`);
      assert.ok(bid < 1,   `${asset} yesBid=${bid} ≥ 1`);
      assert.ok(ask >= bid, `${asset} inverted spread: ask(${ask}) < bid(${bid})`);
    }
  });

  test('spread is realistic (< 20¢)', async () => {
    for (const asset of ['BTC', 'ETH']) {
      const res    = await client.callTool('get_status', { asset });
      const s      = client.parseResult(res).assets[asset];
      const spread = parseFloat(s.yesAsk) - parseFloat(s.yesBid);
      assert.ok(spread < 0.20,
        `${asset} spread ${spread.toFixed(4)} ≥ 0.20 — market may be broken`);
    }
  });

  test('BTC and ETH are NOT priced identically (independent markets)', async () => {
    const res = await client.callTool('get_status');
    const d   = client.parseResult(res);
    const btcMid = (parseFloat(d.assets.BTC.yesAsk) + parseFloat(d.assets.BTC.yesBid)) / 2;
    const ethMid = (parseFloat(d.assets.ETH.yesAsk) + parseFloat(d.assets.ETH.yesBid)) / 2;
    assert.notEqual(btcMid.toFixed(2), ethMid.toFixed(2),
      'BTC and ETH should have different YES prices');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Live clock and window state', () => {
  test('secsLeft is in [0, 900]', async () => {
    const res  = await client.callTool('get_status', { asset: 'BTC' });
    const secs = client.parseResult(res).assets.BTC.secsLeft;
    assert.ok(secs >= 0 && secs <= 900,
      `secsLeft=${secs} out of [0, 900]`);
  });

  test('secsLeft decrements over 3 ticks', async () => {
    const r1 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    await sleep(3000);
    const r2 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
    const s1 = r1.assets.BTC.secsLeft;
    const s2 = r2.assets.BTC.secsLeft;
    // Allow for a window roll (s2 could be > s1 if 15m boundary crossed)
    assert.ok(s2 < s1 || s2 > s1 - 2 + 900,
      `secsLeft should decrement: ${s1} → ${s2}`);
  });

  test('ticker format matches KXBTC15M-DDMMMYYHHNN-PP', async () => {
    const res = await client.callTool('get_status', { asset: 'BTC' });
    const ticker = client.parseResult(res).assets.BTC.ticker;
    // e.g. KXBTC15M-26MAR221745-45
    assert.match(ticker, /^KXBTC15M-\d{2}[A-Z]{3}\d{2}\d{4}-\d+$/,
      `BTC ticker "${ticker}" doesn't match expected pattern`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Live balance and account state', () => {
  test('balance is a positive number', async () => {
    const res = await client.callTool('get_status');
    const bal = parseFloat(client.parseResult(res).balance);
    assert.ok(bal > 0, `Balance $${bal} should be positive`);
  });

  test('get_positions returns an array from live API', async () => {
    const res  = await client.callTool('get_positions');
    const data = client.parseResult(res);
    assert.ok(Array.isArray(data), `get_positions should return array, got ${typeof data}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Live liquidity and regime classification', () => {
  test('liquidity is one of HIGH/MEDIUM/LOW', async () => {
    for (const asset of ['BTC', 'ETH']) {
      const res = await client.callTool('get_status', { asset });
      const liq = client.parseResult(res).assets[asset].liquidity;
      assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(liq),
        `${asset} liquidity "${liq}" invalid`);
    }
  });

  test('regime is one of CALM/NORMAL/CHOPPY', async () => {
    for (const asset of ['BTC', 'ETH']) {
      const res    = await client.callTool('get_status', { asset });
      const regime = client.parseResult(res).assets[asset].regime;
      assert.ok(['CALM', 'NORMAL', 'CHOPPY'].includes(regime),
        `${asset} regime "${regime}" invalid`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Live market continuity (tick coherence)', () => {
  test('YES prices change over 5 seconds (market is live)', async () => {
    // Take two readings 5s apart and verify the bot is receiving WS updates
    const r1 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' })).assets.BTC;
    await sleep(5000);
    const r2 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' })).assets.BTC;

    const ask1 = parseFloat(r1.yesAsk);
    const ask2 = parseFloat(r2.yesAsk);
    const bid1 = parseFloat(r1.yesBid);
    const bid2 = parseFloat(r2.yesBid);

    // Either prices moved OR secsLeft decreased — either proves the clock is ticking
    const pricesMoved = (ask1 !== ask2 || bid1 !== bid2);
    const clockTicked = (r1.secsLeft !== r2.secsLeft);
    assert.ok(pricesMoved || clockTicked,
      'Neither prices nor secsLeft changed — bot may be frozen');
  });

  test('two sequential status calls are consistent', async () => {
    const r1 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' })).assets.BTC;
    const r2 = client.parseResult(await client.callTool('get_status', { asset: 'BTC' })).assets.BTC;
    // Ticker should be identical within the same window
    assert.equal(r1.ticker, r2.ticker, 'Ticker changed between two fast polls');
    // secsLeft should not increase by more than 1
    const diff = r2.secsLeft - r1.secsLeft;
    assert.ok(diff <= 1, `secsLeft jumped up by ${diff} unexpectedly`);
  });
});
