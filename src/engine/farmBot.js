import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { executeBuy } from '../kalshi/orders.js';
import { checkRiskGuards, RISK_COOLDOWN_FAST_MS } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';

const FARM_REENTRY_WAIT_MS = 8_000;
const FARM_MIN_TIME_LEFT   = 200; // lowered from 240 — closes the 181-240s dead band
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
  // Minimum must be enough to buy at least 1 contract — otherwise buildBuyBody
  // throws "Budget too low" and the trade silently fails every tick.
  const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
  const minBet = Math.max(KALSHI_MIN_BET, sidePrice);
  return Math.max(Math.min(halfKelly * balance, MAX_BET_FRACTION * balance), minBet);
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

  // ── Gate B: EMA/momentum conflict — raised thresholds (68% confidence, too many false blocks)
  if (Math.abs(cycleDelta) > 0.4 && Math.abs(yesVel) > 0.5) {
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
  if (yesPrice <= 0.05 || yesPrice >= 0.95) return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  // Narrow dead zone to only the true coin-flip centre — 49–51¢
  if (yesPrice >= 0.49 && yesPrice <= 0.51) return { shouldFarm: false, reason: 'DEAD_ZONE' };
  if (liquidity === 'LOW')                   return { shouldFarm: false, reason: 'LOW_LIQ' };

  // ── Mode 1: TIME DECAY (60–180s left) ────────────────────────────────────
  // When pctAbove confirms the direction, fire DECAY.
  // When it doesn't, fall through to other modes (STRONG_CONVICTION fires at 80–95¢).
  if (secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65) {
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    }
    if (yesPrice <= 0.20 && pctAbove <= 0.35) {
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    }
    // No pctAbove confirmation — fall through to STRONG_CONVICTION / CONVICTION
  }

  // ── Mode 2: REVERSAL ─────────────────────────────────────────────────────
  // Fix 4: Symmetrize thresholds — prior ≥ 0.12 / recent ≤ -0.12 (was -0.06, too easy)
  if (yesPrice >= 0.15 && yesPrice <= 0.85 && yesVelHistory.length >= 4) {
    const prior  = yesVelHistory.slice(-4, -2);
    const recent = yesVelHistory.slice(-2);
    const priorAvg  = prior.reduce((a, b) => a + b) / prior.length;
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    if (priorAvg <= -0.12 && recentAvg >= 0.12) {
      return { shouldFarm: true, bet: 'UP',   target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'REVERSAL' };
    }
    if (priorAvg >= 0.12 && recentAvg <= -0.12) {
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
  // Lowered cycleDelta threshold 0.10→0.04 to allow more entries
  if (Math.abs(cycleDelta) >= 0.04 && Math.abs(yesVel) >= 0.03) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP[regime] * 0.8 * stopMult, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  // ── Mode 6: MOMENTUM ──────────────────────────────────────────────────────
  // Lowered yesVel 0.08→0.04 and secsLeft 400→240 to allow more entries
  if (yesPrice >= 0.30 && yesPrice <= 0.70 && Math.abs(yesVel) >= 0.04 && secsLeft > 240) {
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

  // Fast cooldown applies for high-confidence modes — evaluated after decision
  const decision = evaluateModes(s, priceFeed.getRegime(asset) ?? 'NORMAL',
    (s.windowOpenPrice && priceFeed.getPrice(asset))
      ? (priceFeed.getPrice(asset) - s.windowOpenPrice) / s.windowOpenPrice * 100
      : 0,
    pctAbove
  );
  const fastCooldown = decision.shouldFarm &&
    (decision.mode === 'DECAY' || decision.mode === 'STRONG_CONVICTION');
  const risk = checkRiskGuards(s, balance, fastCooldown);
  if (risk.blocked) { if (Math.random() < 0.02) console.log(`[Farm] ${asset} risk blocked: ${risk.reason}`); return; }

  const features = buildFeatures(asset);
  if (!features) { if (Math.random() < 0.02) console.log(`[Farm] ${asset} features null — buffer not warm`); return; }

  if (!decision.shouldFarm) {
    if (Math.random() < 0.01) console.log(`[Farm] ${asset} blocked: ${decision.reason}`);
    return;
  }

  const { bet, target, stop, mode } = decision;

  // Get model probability for this specific bet direction
  const featuresNorm = buildFeaturesNorm(features, bet);
  // Fix 3: Lower default prob to 0.52 and require ≥10 samples per direction
  let modelProb = 0.52;
  if (s.brain && (bet === 'UP' ? s.brain.dataUp : s.brain.dataDown).length >= 10) {
    modelProb = predict(s.brain.weights, features, featuresNorm, bet, s.brain.dataUp, s.brain.dataDown);
  }

  const amount = kellyBet(bet, s.yesAsk, s.yesBid, modelProb, balance);

  console.log(`[Farm] ${asset} ${mode} ${bet} $${amount.toFixed(2)} p=${(modelProb*100).toFixed(0)}%`);

  try {
    const { result } = await executeBuy(s.ticker, bet, amount, s.yesAsk, s.yesBid);
    const filled = typeof result?.order?.remaining_count === 'number'
      ? (Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid))) - result.order.remaining_count)
      : Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid)));

    if (filled < 1) { console.warn('[Farm] 0 contracts filled'); s.lastExitTime = Date.now(); return; }

    const spentActual = filled * (bet === 'UP' ? s.yesAsk : (1 - s.yesBid));
    const maxProfit   = filled * 1.00 - spentActual;

    // Lock exit thresholds at entry — never recompute mid-trade
    s.activeTrade = {
      ticker: s.ticker, bet,
      side: bet === 'UP' ? 'yes' : 'no',
      amount: spentActual, count: filled,
      entryYes: (s.yesAsk + s.yesBid) / 2,
      maxProfit,
      lockedTP: maxProfit * 0.50,   // 50% of max payout
      lockedSL: stop,               // % of amount — locked at entry
      featuresRaw: features,
      featuresNorm,
      startedAt: Date.now(),
      mode,
    };
    s.farmRounds++;
  } catch (err) {
    console.error(`[Farm] Buy failed:`, err.message);
    // Apply re-entry cooldown after any buy failure to avoid hammering a thin market
    s.lastExitTime = Date.now();
  }
}
