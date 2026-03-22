import { state } from './state.js';
import { checkFarmBot } from './farmBot.js';
import { checkAutoBuy } from './autoBuy.js';
import { checkExit } from './exitManager.js';
import { startSession, startDay } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';
import { krakenFallback } from '../prices/kraken.js'; // activates fallback wiring
import { KalshiWebSocket } from '../kalshi/websocket.js';
import { getBalance, findActiveMarket } from '../kalshi/client.js';
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

function getLiquidity(asset, hour) {
  // BTC liquidity schedule
  const btcLiq =
    (hour >= 3 && hour < 13) || hour >= 20 ? 'HIGH' :
    (hour >= 1 && hour < 3)  || (hour >= 13 && hour < 17) ? 'MEDIUM' :
    'LOW';

  if (asset === 'BTC') return btcLiq;
  // ETH is one tier lower outside US open hours (9am–4pm ET)
  if (hour >= 9 && hour < 16) return btcLiq;
  return btcLiq === 'HIGH' ? 'MEDIUM' : 'LOW';
}

async function onWindowRoll(asset) {
  const s = state[asset];
  console.log(`[Clock] ${asset} window rolled — fetching new market`);
  s.farmRounds = 0;
  s.ticksAbove = 0;
  s.ticksTotal = 0;
  s.windowOpenPrice = priceFeed.getPrice(asset);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const market = await findActiveMarket(asset);
      s.ticker = market.ticker;
      kalshiWS[asset].switchTicker(market.ticker);
      console.log(`[Clock] ${asset} new ticker: ${market.ticker}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error(`[Clock] Failed to get new ${asset} market after 5 attempts`);
}

let _lastBalanceFetch = 0;
let _lastWindowId = { BTC: null, ETH: null };

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
    s.liquidity = getLiquidity(asset, hour);
    s.regime    = priceFeed.getRegime(asset);

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

    // Window roll detection
    if (s.windowId !== null && s.windowId !== wid) {
      await onWindowRoll(asset);
    }
    s.windowId = wid;

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

  // Init sessions
  const bal = state.balance ?? 0;
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

  // 1-second heartbeat
  setInterval(() => {
    tick().catch(err => console.error('[Clock] tick error:', err.message));
  }, 1000);

  console.log('[Clock] Running.');
}
