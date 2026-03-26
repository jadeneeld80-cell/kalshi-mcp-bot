import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { executeBuy } from '../kalshi/orders.js';
import { checkRiskGuards, RISK_COOLDOWN_FAST_MS } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';
import { notify } from '../notify.js';

const FARM_REENTRY_WAIT_MS = 8_000;
const FARM_MIN_TIME_LEFT   = 200; // closes the 181-240s dead band
const FARM_MAX_ROUNDS      = 99;
const KALSHI_MIN_BET       = 0.05;
const MAX_BET_FRACTION     = 0.20;

const TARGET = { CALM: 0.12, NORMAL: 0.18, CHOPPY: 0.25 };

// Mode-specific stop losses calibrated to actual per-mode volatility risk:
// REVERSAL/MOMENTUM need wider stops — single large orders cause 3-5¢ adverse moves
// STRONG_CONVICTION/CONVICTION/DECAY stay tight — extreme prices mean-revert slowly
const STOP_BY_MODE = {
  REVERSAL:          0.15,  // 15% — needs room to breathe through noise reversals
  MOMENTUM:          0.12,  // 12% — gappy thin markets blow through 9% instantly
  ALIGNED:           0.15,  // 15% — weakest signal, widest stop
  CONVICTION:        0.03,  // 3%  — strong directional setup, stays tight
  STRONG_CONVICTION: 0.015, // 1.5% — market near certainty, very small target
  DECAY:             0.02,  // 2%  — final minutes, small target
};

// Kelly bet sizing for binary options
function kellyBet(bet, yesAsk, yesBid, modelProb, balance) {
  const p = modelProb;
  const q = 1 - p;
  const b = bet === 'UP'
    ? (1 - yesAsk) / yesAsk
    : yesBid / (1 - yesBid);
  const kelly = (b * p - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
  const minBet = Math.max(KALSHI_MIN_BET, sidePrice);
  return Math.max(Math.min(halfKelly * balance, MAX_BET_FRACTION * balance), minBet);
}

// Evaluate all 6 farm modes + gates.
// Returns { shouldFarm, bet, target, stop, mode } or { shouldFarm: false, reason }
function evaluateModes(s, regime, cycleDelta, pctAbove) {
  const { yesAsk, yesBid, secsLeft, yesVel, yesVelHistory, yesPriceHistory, liquidity } = s;
  const yesPrice = (yesAsk + yesBid) / 2;

  // ── Gate A: Momentum divergence (95% confidence, data-backed) ─────────────
  if (Math.abs(cycleDelta) > 0.6 && Math.abs(yesVel) > 0.8) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_A' };
    }
  }

  // ── Gate B: EMA/momentum conflict (raised to 0.4%/0.5¢ — fewer false blocks)
  if (Math.abs(cycleDelta) > 0.4 && Math.abs(yesVel) > 0.5) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_B' };
    }
  }

  // ── Gate C: Volatility gate — block entry when market is whipsawing ────────
  // If the YES mid-price spanned > 5¢ in the last 30 WS readings, the book is
  // too choppy for scalping. Single large orders create fake velocity signals.
  if (yesPriceHistory && yesPriceHistory.length >= 10) {
    const last30 = yesPriceHistory.slice(-30);
    const prices = last30.map(x => x.price);
    const range = (Math.max(...prices) - Math.min(...prices)) * 100; // cents
    if (range > 5) return { shouldFarm: false, reason: 'HIGH_VOLATILITY' };
  }

  // ── Gate D: Large order guard — 5s cooldown after a 3¢+ price jump ─────────
  // Large individual orders cause synthetic velocity spikes. Wait for liquidity
  // to reset before trading.
  if (s.lastLargeJumpTs && Date.now() - s.lastLargeJumpTs < 5_000) {
    return { shouldFarm: false, reason: 'POST_LARGE_ORDER' };
  }

  // ── Gate C (stop tightener): strong signal → tighter stop ─────────────────
  const signalStrength = Math.abs(cycleDelta) * 10 + Math.abs(yesVel);
  const stopMult = signalStrength > 5 ? 0.70 : 1.0;

  // ── Common entry blocks ───────────────────────────────────────────────────
  if (secsLeft < FARM_MIN_TIME_LEFT && !(secsLeft >= 60 && secsLeft <= 180)) {
    return { shouldFarm: false, reason: 'TOO_LATE' };
  }
  if (yesPrice <= 0.05 || yesPrice >= 0.95) return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  if (yesPrice >= 0.49 && yesPrice <= 0.51) return { shouldFarm: false, reason: 'DEAD_ZONE' };
  if (liquidity === 'LOW')                   return { shouldFarm: false, reason: 'LOW_LIQ' };

  // ── Mode 1: TIME DECAY (60–180s left) ────────────────────────────────────
  if (secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65) {
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: STOP_BY_MODE.DECAY * stopMult, mode: 'DECAY' };
    }
    if (yesPrice <= 0.20 && pctAbove <= 0.35) {
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: STOP_BY_MODE.DECAY * stopMult, mode: 'DECAY' };
    }
    // No pctAbove confirmation — fall through to STRONG_CONVICTION / CONVICTION
  }

  // ── Mode 2: REVERSAL ─────────────────────────────────────────────────────
  // Requires 3-tick confirmation: prior avg, mid tick, AND latest tick all aligned.
  // Prevents single-order whipsaws from triggering false reversals.
  if (yesPrice >= 0.15 && yesPrice <= 0.85 && yesVelHistory.length >= 5 && liquidity === 'HIGH') {
    const prior  = yesVelHistory.slice(-5, -3);
    const mid    = yesVelHistory.slice(-3, -1);
    const latest = yesVelHistory[yesVelHistory.length - 1];
    const priorAvg = prior.reduce((a, b) => a + b) / prior.length;
    const midAvg   = mid.reduce((a, b) => a + b) / mid.length;

    // UP reversal: prior was falling, mid has turned, latest confirms
    if (priorAvg <= -0.12 && midAvg >= 0.06 && latest >= 0.08) {
      return { shouldFarm: true, bet: 'UP',   target: TARGET[regime], stop: STOP_BY_MODE.REVERSAL * stopMult, mode: 'REVERSAL' };
    }
    // DOWN reversal: prior was rising, mid has turned, latest confirms
    if (priorAvg >= 0.12 && midAvg <= -0.06 && latest <= -0.08) {
      return { shouldFarm: true, bet: 'DOWN', target: TARGET[regime], stop: STOP_BY_MODE.REVERSAL * stopMult, mode: 'REVERSAL' };
    }
  }

  // ── Mode 3: STRONG CONVICTION (YES 80–95¢ or 5–20¢) ─────────────────────
  if ((yesPrice >= 0.80 && yesPrice <= 0.95) || (yesPrice >= 0.05 && yesPrice <= 0.20)) {
    const bet = yesPrice >= 0.80 ? 'UP' : 'DOWN';
    return { shouldFarm: true, bet, target: 0.03, stop: STOP_BY_MODE.STRONG_CONVICTION * stopMult, mode: 'STRONG_CONVICTION' };
  }

  // ── Mode 4: CONVICTION (YES 70–80¢ or 20–30¢) ───────────────────────────
  if ((yesPrice >= 0.70 && yesPrice < 0.80) || (yesPrice > 0.20 && yesPrice <= 0.30)) {
    const bet    = yesPrice >= 0.70 ? 'UP' : 'DOWN';
    const target = secsLeft < 8 * 60 ? 0.04 : 0.05;
    return { shouldFarm: true, bet, target, stop: STOP_BY_MODE.CONVICTION * stopMult, mode: 'CONVICTION' };
  }

  // ── Mode 5: ALIGNED ───────────────────────────────────────────────────────
  if (Math.abs(cycleDelta) >= 0.04 && Math.abs(yesVel) >= 0.03) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP_BY_MODE.ALIGNED * stopMult, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  // ── Mode 6: MOMENTUM ──────────────────────────────────────────────────────
  // Raised threshold 0.04→0.08 + require 2 consecutive ticks sustaining signal.
  // Filters single-order whipsaws: real momentum persists across multiple ticks.
  if (yesPrice >= 0.30 && yesPrice <= 0.70 && secsLeft > 240 && yesVelHistory.length >= 2 && liquidity === 'HIGH') {
    const last2 = yesVelHistory.slice(-2);
    const last2Avg = last2.reduce((a, b) => a + b) / last2.length;
    if (Math.abs(yesVel) >= 0.08 && Math.abs(last2Avg) >= 0.06 && Math.sign(yesVel) === Math.sign(last2Avg)) {
      const bet = yesVel > 0 ? 'UP' : 'DOWN';
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP_BY_MODE.MOMENTUM * stopMult, mode: 'MOMENTUM' };
    }
  }

  return { shouldFarm: false, reason: 'NO_MODE' };
}

// Called every tick by clock.js when farmArmed and no activeTrade
export async function checkFarmBot(ctx) {
  const { asset, s, balance, pctAbove } = ctx;
  const now = Date.now();

  if (now - s.lastExitTime < FARM_REENTRY_WAIT_MS) return;
  if (s.farmRounds >= FARM_MAX_ROUNDS) return;

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

  const featuresNorm = buildFeaturesNorm(features, bet);
  let modelProb = 0.52;
  if (s.brain && (bet === 'UP' ? s.brain.dataUp : s.brain.dataDown).length >= 10) {
    modelProb = predict(s.brain.weights, features, featuresNorm, bet, s.brain.dataUp, s.brain.dataDown);
  }

  const amount = kellyBet(bet, s.yesAsk, s.yesBid, modelProb, balance);

  console.log(`[Farm] ${asset} ${mode} ${bet} $${amount.toFixed(2)} p=${(modelProb*100).toFixed(0)}%`);
  await notify(`🤖 ${asset} Farm Entry`, `${mode} ${bet} $${amount.toFixed(2)} | p=${(modelProb*100).toFixed(0)}%`, 'cha_ching');

  try {
    const { result } = await executeBuy(s.ticker, bet, amount, s.yesAsk, s.yesBid);
    const filled = typeof result?.order?.remaining_count === 'number'
      ? (Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid))) - result.order.remaining_count)
      : Math.floor(amount / (bet === 'UP' ? s.yesAsk : (1 - s.yesBid)));

    if (filled < 1) { console.warn('[Farm] 0 contracts filled'); s.lastExitTime = Date.now(); return; }

    const spentActual = filled * (bet === 'UP' ? s.yesAsk : (1 - s.yesBid));
    const maxProfit   = filled * 1.00 - spentActual;

    s.activeTrade = {
      ticker: s.ticker, bet,
      side: bet === 'UP' ? 'yes' : 'no',
      amount: spentActual, count: filled,
      entryYes: (s.yesAsk + s.yesBid) / 2,
      maxProfit,
      lockedTP: maxProfit * 0.35,   // 35% of max payout — realistic target for thin markets
      lockedSL: stop,               // mode-specific stop — locked at entry
      featuresRaw: features,
      featuresNorm,
      startedAt: Date.now(),
      canStopAfter: Date.now() + 3_000, // 3s min hold — prevents noise-triggered immediate stops
      mode,
    };
    s.farmRounds++;
  } catch (err) {
    console.error(`[Farm] Buy failed:`, err.message);
    s.lastExitTime = Date.now();
  }
}
