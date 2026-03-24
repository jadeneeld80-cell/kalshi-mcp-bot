import { state } from './state.js';
import { checkFarmBot } from './farmBot.js';
import { checkAutoBuy } from './autoBuy.js';
import { checkExit } from './exitManager.js';
import { startSession, startDay } from './riskManager.js';
import { loadBotState } from './botStateStore.js';
import { writeStateSnapshot } from './stateSnapshot.js';
import { priceFeed } from '../prices/binance.js';
import { krakenFallback } from '../prices/kraken.js'; // activates fallback wiring
import { KalshiWebSocket } from '../kalshi/websocket.js';
import { getBalance, findActiveMarket, getPositions } from '../kalshi/client.js';
import { executeSell } from '../kalshi/orders.js';
import { loadBrain } from '../nn/store.js';

// One Kalshi WS per asset — updates YES price in state
const kalshiWS = {
  BTC: new KalshiWebSocket((ask, bid) => updateYes('BTC', ask, bid)),
  ETH: new KalshiWebSocket((ask, bid) => updateYes('ETH', ask, bid)),
};

function updateYes(asset, yesAsk, yesBid) {
  const s = state[asset];
  const now = Date.now();
  const mid = (yesAsk + yesBid) / 2;

  s.yesPriceHistory.push({ price: mid, ts: now });
  if (s.yesPriceHistory.length > 30) s.yesPriceHistory.shift();

  // YES velocity in ¢/s over last 3 WS readings
  if (s.yesPriceHistory.length >= 3) {
    const prev = s.yesPriceHistory[s.yesPriceHistory.length - 3];
    const dt = (now - prev.ts) / 1000;
    s.yesVel = dt > 0 ? (mid - prev.price) * 100 / dt : 0;
  }

  s.yesAsk = yesAsk;
  s.yesBid = yesBid;
}

function secsLeft() {
  const now = new Date();
  return 900 - ((now.getUTCMinutes() % 15) * 60 + now.getUTCSeconds());
}

function windowId() {
  return Math.floor(Date.now() / (15 * 60 * 1000));
}

// ET hour (EDT = UTC-4). Adjust to -5 after DST ends in November.
function etHour() {
  return (new Date().getUTCHours() - 4 + 24) % 24;
}

// Fix 1: Dynamic spread-based liquidity — replaces fixed clock schedule.
// Spread < 3¢ → HIGH, < 6¢ → MEDIUM, otherwise → LOW.
// Falls back to clock-based estimate when YES prices aren't available yet.
function getLiquidity(asset, hour, yesAsk, yesBid) {
  if (yesAsk !== null && yesBid !== null) {
    const spread = yesAsk - yesBid;
    if (spread < 0.03) return 'HIGH';
    if (spread < 0.06) return 'MEDIUM';
    return 'LOW';
  }
  // Fallback: clock-based estimate while orderbook warms up
  const btcLiq =
    (hour >= 3 && hour < 13) || hour >= 20 ? 'HIGH' :
    (hour >= 1 && hour < 3)  || (hour >= 13 && hour < 17) ? 'MEDIUM' :
    'LOW';
  if (asset === 'BTC') return btcLiq;
  if (hour >= 9 && hour < 16) return btcLiq;
  return btcLiq === 'HIGH' ? 'MEDIUM' : 'LOW';
}

// Per-asset lock — prevents concurrent onWindowRoll calls while one is in-flight
const _rolling = { BTC: false, ETH: false };

// Returns true on success, false on failure (so caller can decide whether to
// advance windowId — we only advance on success to allow retry on failure).
async function onWindowRoll(asset) {
  if (_rolling[asset]) return false; // already in progress
  _rolling[asset] = true;

  const s = state[asset];
  console.log(`[Clock] ${asset} window rolled — fetching new market`);
  s.farmRounds = 0;
  s.ticksAbove = 0;
  s.ticksTotal = 0;
  s.windowOpenPrice = priceFeed.getPrice(asset);
  // Clear stale prices so tick() skips this asset until fresh WS data arrives
  s.yesAsk = null;
  s.yesBid = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const market = await findActiveMarket(asset);
      s.ticker = market.ticker;
      kalshiWS[asset].switchTicker(market.ticker);
      console.log(`[Clock] ${asset} new ticker: ${market.ticker}`);
      _rolling[asset] = false;
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 5000)); // 10 × 5s = 50s max wait
    }
  }
  console.error(`[Clock] Failed to get new ${asset} market after 10 attempts`);
  _rolling[asset] = false;
  return false;
}

let _lastBalanceFetch = 0;

async function tick() {
  const now = Date.now();
  const sl = secsLeft();
  const wid = windowId();
  const hour = etHour();

  // Refresh balance every 30s
  if (now - _lastBalanceFetch > 30_000) {
    try {
      state.balance = (await getBalance()) / 100; // cents → dollars
      _lastBalanceFetch = now;
    } catch {}
  }

  for (const asset of ['BTC', 'ETH']) {
    const s = state[asset];
    s.secsLeft  = sl;
    s.liquidity = getLiquidity(asset, hour, s.yesAsk, s.yesBid);
    s.regime    = priceFeed.getRegime(asset);

    // Recompute YES velocity at 1Hz from a 5-second price window.
    // The WS fires 60+/s but price only moves occasionally, so computing velocity
    // from the last 3 WS frames (≈50ms) always gives 0.  Using a 5-second window
    // captures real moves before they fade back to flat.
    if (s.yesPriceHistory.length >= 2) {
      const cutoff = now - 5000;
      const window = s.yesPriceHistory.filter(p => p.ts >= cutoff);
      if (window.length >= 2) {
        const oldest = window[0];
        const newest = window[window.length - 1];
        const dt = (newest.ts - oldest.ts) / 1000;
        s.yesVel = dt > 0 ? (newest.price - oldest.price) * 100 / dt : 0;
      }
    }

    // YES velocity history (rolling, for reversal detection)
    s.yesVelHistory.push(s.yesVel);
    if (s.yesVelHistory.length > 10) s.yesVelHistory.shift();

    // Crowd velocity history (for auto-buy crowd-block gate)
    s.crowdVelHistory.push(s.yesVel);
    if (s.crowdVelHistory.length > 4) s.crowdVelHistory.shift();

    // pctAbove tracking (for DECAY mode)
    if (s.yesAsk !== null) {
      s.ticksTotal++;
      if ((s.yesAsk + s.yesBid) / 2 >= 0.50) s.ticksAbove++;
    }

    // Window roll detection — only advance windowId on success so that a
    // failed lookup retries on the next tick. The _rolling lock in onWindowRoll
    // prevents concurrent in-flight calls for the same asset.
    if (s.windowId === null) {
      s.windowId = wid; // initial set on startup
    } else if (s.windowId !== wid) {
      const ok = await onWindowRoll(asset);
      if (ok) s.windowId = wid; // retry next tick if market lookup failed
    } else if (!s.ticker) {
      // Startup init failed — retry market lookup in the current window
      const ok = await onWindowRoll(asset);
      if (ok) s.windowId = wid;
    }

    // Skip if no market data
    if (!s.ticker || s.yesAsk === null) continue;

    const ctx = {
      asset,
      s,
      balance: state.balance ?? 0,
      pctAbove: s.ticksTotal > 0 ? s.ticksAbove / s.ticksTotal : 0.5,
    };

    // Exit check always runs first
    if (s.activeTrade) {
      await checkExit(ctx);
    }

    // New entry only when flat
    if (!s.activeTrade) {
      if (s.farmArmed)     await checkFarmBot(ctx);
      else if (s.autoBuyArmed) await checkAutoBuy(ctx);
    }
  }
}

export async function startClock() {
  console.log('[Clock] Starting price feeds...');
  priceFeed.connect();

  console.log('[Clock] Loading brains...');
  state.BTC.brain = await loadBrain('BTC');
  state.ETH.brain = await loadBrain('ETH');

  // Close any orphaned positions from a previous session before initialising.
  try {
    const positions = await getPositions();
    for (const p of positions) {
      const fp = parseFloat(p.position_fp);
      if (fp === 0) continue;
      const side = fp < 0 ? 'no' : 'yes';
      const count = Math.abs(fp);
      console.log(`[Clock] Closing orphaned ${side.toUpperCase()} position (${fp}) in ${p.ticker}`);
      try { await executeSell(p.ticker, side, count); } catch (err) {
        console.warn(`[Clock] Could not close orphan:`, err.message);
      }
    }
  } catch {}

  // Fetch balance before initialising session/day guards so they don't trigger
  // immediately due to sessionStartBalance=0 (state.balance is null at this point).
  try {
    state.balance = (await getBalance()) / 100;
    _lastBalanceFetch = Date.now();
  } catch {}
  const bal = state.balance ?? 5; // safe fallback; real value fetched above
  startSession(state.BTC, bal);
  startSession(state.ETH, bal);
  startDay(state.BTC, bal);
  startDay(state.ETH, bal);

  console.log('[Clock] Connecting to Kalshi markets...');
  for (const asset of ['BTC', 'ETH']) {
    try {
      const market = await findActiveMarket(asset);
      state[asset].ticker = market.ticker;
      state[asset].windowId = windowId();
      state[asset].windowOpenPrice = priceFeed.getPrice(asset);
      kalshiWS[asset].connect(market.ticker);
      console.log(`[Clock] ${asset} → ${market.ticker}`);
    } catch (err) {
      console.error(`[Clock] Init ${asset}:`, err.message);
    }
  }

  // Fetch initial balance
  try {
    state.balance = (await getBalance()) / 100;
    _lastBalanceFetch = Date.now();
    console.log(`[Clock] Balance: $${state.balance.toFixed(2)}`);
  } catch {}

  // Restore persisted arm state (farm/autobuy armed flags)
  loadBotState();

  // 1-second heartbeat
  setInterval(() => {
    tick().catch(err => console.error('[Clock] tick error:', err.message));
    writeStateSnapshot();
  }, 1000);

  console.log('[Clock] Running.');
}
