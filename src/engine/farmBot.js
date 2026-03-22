import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { executeBuy } from '../kalshi/orders.js';
import { checkRiskGuards } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';

const FARM_REENTRY_WAIT_MS = 8_000;
const FARM_MIN_TIME_LEFT   = 240;
const FARM_MAX_ROUNDS      = 99;
const KALSHI_MIN_BET       = 0.05;
const MAX_BET_FRACTION     = 0.20;  // never more than 20% of balance

const TARGET = { CALM: 0.12, NORMAL: 0.18, CHOPPY: 0.25 };
const STOP   = { CALM: 0.06, NORMAL: 0.09, CHOPPY: 0.12 };

// Kelly bet sizing for binary options
// b = decimal odds for our side, p = P(we win), balance in dollars
function kellyBet(bet, yesAsk, yesBid, modelProb, balance) {
  const p = modelProb;
  const q = 1 - p;
  const b = bet === 'UP'
    ? (1 - yesAsk) / yesAsk          // YES decimal odds
    : yesBid / (1 - yesBid);         // NO decimal odds
  const kelly = (b * p - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  return Math.max(Math.min(halfKelly * balance, MAX_BET_FRACTION * balance), KALSHI_MIN_BET);
}

// Evaluate all 6 farm modes + 3 gates.
// Returns { shouldFarm, bet, target, stop, mode } or { shouldFarm: false, reason }
function evaluateModes(s, regime, cycleDelta, pctAbove) {
  const { yesAsk, yesBid, secsLeft, yesVel, yesVelHistory, liquidity } = s;
  const yesPrice = (yesAsk + yesBid) / 2;

  // ── Gate A: Momentum divergence (95% confidence, data-backed) ─────────────
  // BTC drift > 0.6% AND YES velocity > 0.8¢/s but pointing opposite → BLOCK
  if (Math.abs(cycleDelta) > 0.6 && Math.abs(yesVel) > 0.8) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_A' };
    }
  }

  // ── Gate B: EMA/momentum conflict (68% confidence) ───────────────────────
  if (Math.abs(cycleDelta) > 0.2 && Math.abs(yesVel) > 0.3) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_B' };
    }
  }

  // ── Gate C: Strong signal stop tightener (72% confidence) ────────────────
  const signalStrength = Math.abs(cycleDelta) * 10 + Math.abs(yesVel);
  const stopMult = signalStrength > 5 ? 0.70 : 1.0; // 30% tighter stop on strong signals

  // ── Common entry blocks ───────────────────────────────────────────────────
  if (secsLeft < FARM_MIN_TIME_LEFT && !(secsLeft >= 60 && secsLeft <= 180)) {
    return { shouldFarm: false, reason: 'TOO_LATE' };
  }
  if (yesPrice <= 0.03 || yesPrice >= 0.97) return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  if (liquidity === 'LOW')                   return { shouldFarm: false, reason: 'LOW_LIQ' };

  // ── Mode 1: TIME DECAY (60–180s left) ────────────────────────────────────
  if (secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65) {
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    }
    if (yesPrice <= 0.20 && pctAbove <= 0.35) {
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    }
    return { shouldFarm: false, reason: 'DECAY_NO_SIGNAL' };
  }

  // ── Mode 2: REVERSAL ─────────────────────────────────────────────────────
  if (yesPrice >= 0.15 && yesPrice <= 0.85 && yesVelHistory.length >= 4) {
    const prior  = yesVelHistory.slice(-4, -2);
    const recent = yesVelHistory.slice(-2);
    const priorAvg  = prior.reduce((a, b) => a + b) / prior.length;
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    if (priorAvg <= -0.12 && recentAvg >= 0.06) {
      return { shouldFarm: true, bet: 'UP',   target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'REVERSAL' };
    }
    if (priorAvg >= 0.12 && recentAvg <= -0.06) {
      return { shouldFarm: true, bet: 'DOWN', target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'REVERSAL' };
    }
  }

  // ── Mode 3: STRONG CONVICTION (YES 80–95¢ or 5–20¢) ─────────────────────
  if ((yesPrice >= 0.80 && yesPrice <= 0.95) || (yesPrice >= 0.05 && yesPrice <= 0.20)) {
    const bet = yesPrice >= 0.80 ? 'UP' : 'DOWN';
    return { shouldFarm: true, bet, target: 0.03, stop: 0.015 * stopMult, mode: 'STRONG_CONVICTION' };
  }

  // ── Mode 4: CONVICTION (YES 70–80¢ or 20–30¢) ───────────────────────────
  if ((yesPrice >= 0.70 && yesPrice < 0.80) || (yesPrice > 0.20 && yesPrice <= 0.30)) {
    const bet    = yesPrice >= 0.70 ? 'UP' : 'DOWN';
    const target = secsLeft < 8 * 60 ? 0.04 : 0.05;
    return { shouldFarm: true, bet, target, stop: 0.03 * stopMult, mode: 'CONVICTION' };
  }

  // ── Mode 5: ALIGNED ───────────────────────────────────────────────────────
  if (Math.abs(cycleDelta) >= 0.02 && Math.abs(yesVel) >= 0.05) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP[regime] * 0.8 * stopMult, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  // ── Mode 6: MOMENTUM ──────────────────────────────────────────────────────
  if (yesPrice >= 0.30 && yesPrice <= 0.70 && Math.abs(yesVel) >= 0.08) {
    const bet = yesVel > 0 ? 'UP' : 'DOWN';
    return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'MOMENTUM' };
  }

  return { shouldFarm: false, reason: 'NO_MODE' };
}

// Called every tick by clock.js when farmArmed and no activeTrade
export async function checkFarmBot(ctx) {
  const { asset, s, balance, pctAbove } = ctx;
  const now = Date.now();

  if (now - s.lastExitTime < FARM_REENTRY_WAIT_MS) return;
  if (s.farmRounds >= FARM_MAX_ROUNDS) return;

  const risk = checkRiskGuards(s, balance);
  if (risk.blocked) return;

  const features = buildFeatures(asset);
  if (!features) return; // price buffer not warm yet

  const regime = priceFeed.getRegime(asset);
  const currentPrice = priceFeed.getPrice(asset);
  const cycleDelta = (s.windowOpenPrice && currentPrice)
    ? (currentPrice - s.windowOpenPrice) / s.windowOpenPrice * 100
    : 0;

  const decision = evaluateModes(s, regime, cycleDelta, pctAbove);
  if (!decision.shouldFarm) return;

  const { bet, target, stop, mode } = decision;

  // Get model probability for this specific bet direction
  const featuresNorm = buildFeaturesNorm(features, bet);
  let modelProb = 0.55; // conservative default when no brain data
  if (s.brain && (bet === 'UP' ? s.brain.dataUp : s.brain.dataDown).length >= 4) {
    modelProb = predict(s.brain.weights, features, featuresNorm, bet, s.brain.dataUp, s.brain.dataDown);
  }

  const amount = kellyBet(bet, s.yesAsk, s.yesBid, modelProb, balance);

  console.log(`[Farm] ${asset} ${mode} ${bet} $${amount.toFixed(2)} p=${(modelProb*100).toFixed(0)}%`);

  try {
    const { result } = await executeBuy(s.ticker, bet, amount, s.yesAsk, s.yesBid);
    const filled = typeof result?.order?.remaining_count === 'number'
      ? (Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid))) - result.order.remaining_count)
      : Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid)));

    if (filled < 1) { console.warn('[Farm] 0 contracts filled'); return; }

    const spentActual = filled * (bet === 'UP' ? s.yesAsk : (1 - s.yesBid));
    const maxProfit   = filled * 1.00 - spentActual;

    // Lock exit thresholds at entry — never recompute mid-trade
    s.activeTrade = {
      ticker: s.ticker, bet,
      side: bet === 'UP' ? 'yes' : 'no',
      amount: spentActual, count: filled,
      entryYes: (s.yesAsk + s.yesBid) / 2,
      maxProfit,
      lockedTP: maxProfit * 0.60,   // 60% of max payout
      lockedSL: stop,               // % of amount — locked at entry
      featuresRaw: features,
      featuresNorm,
      startedAt: Date.now(),
      mode,
    };
    s.farmRounds++;
  } catch (err) {
    console.error(`[Farm] Buy failed:`, err.message);
  }
}
