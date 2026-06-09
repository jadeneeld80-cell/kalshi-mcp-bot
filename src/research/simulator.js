/**
 * Pure-function simulator — replays bot logic against recorded market snapshots.
 * No real orders placed. Returns a trade log identical in shape to exitManager's appendLog.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function kellyBet(bet, yesAsk, yesBid, modelProb, balance, P) {
  const p = modelProb;
  const q = 1 - p;
  const b = bet === 'UP'
    ? (1 - yesAsk) / yesAsk
    : yesBid / (1 - yesBid);
  const kelly = (b * p - q) / b;
  // Quarter-Kelly (matches live farmBot after Mar 2026 update)
  const fraction = P.KELLY_FRACTION ?? 0.25;
  const sized = Math.max(0, kelly * fraction);
  return Math.max(
    Math.min(sized * balance, P.KELLY_MAX_FRACTION * balance),
    0.05  // KALSHI_MIN_BET
  );
}

function computeUnrealizedPnL(trade, yesAsk, yesBid) {
  const currentValue = trade.side === 'yes'
    ? trade.count * yesBid
    : trade.count * (1 - yesAsk);
  return currentValue - trade.amount;
}

// ── Entry evaluator (mirrors farmBot.evaluateModes — keep in sync) ───────────
// REVERSAL, STRONG_CONVICTION, CONVICTION all disabled (matches live farmBot).
// ADX/ATR gates omitted — snapshots lack these indicators; adx=null skips gate.

function evaluateModes(s, regime, cycleDelta, pctAbove, P) {
  const { yesAsk, yesBid, secsLeft, yesVel, yesVelHistory, liquidity } = s;
  const yesPrice = (yesAsk + yesBid) / 2;

  const TARGET = { CALM: P.TARGET_CALM, NORMAL: P.TARGET_NORMAL, CHOPPY: P.TARGET_CHOPPY };

  // Gate A: momentum divergence (95% confidence — same threshold as live)
  if (Math.abs(cycleDelta) > 0.6 && Math.abs(yesVel) > 0.8) {
    if ((cycleDelta > 0) !== (yesVel > 0)) return { shouldFarm: false, reason: 'GATE_A' };
  }
  // Gate B: EMA/momentum conflict (updated to match live 0.4/0.5 thresholds)
  if (Math.abs(cycleDelta) > 0.4 && Math.abs(yesVel) > 0.5) {
    if ((cycleDelta > 0) !== (yesVel > 0)) return { shouldFarm: false, reason: 'GATE_B' };
  }
  // Signal-strength stop tightener (Gate C in live)
  const signalStrength = Math.abs(cycleDelta) * 10 + Math.abs(yesVel);
  const stopMult = signalStrength > 5 ? 0.70 : 1.0;

  // Common entry blocks
  if (secsLeft < 200 && !(secsLeft >= 60 && secsLeft <= 180)) {
    return { shouldFarm: false, reason: 'TOO_LATE' };
  }
  if (yesPrice <= P.SPREAD_EXTREME_FLOOR || yesPrice >= (1 - P.SPREAD_EXTREME_FLOOR)) {
    return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  }
  if (yesPrice >= P.DEAD_ZONE_LOW && yesPrice <= P.DEAD_ZONE_HIGH) {
    return { shouldFarm: false, reason: 'DEAD_ZONE' };
  }
  if (liquidity === 'LOW') return { shouldFarm: false, reason: 'LOW_LIQ' };

  // ── Mode 1: TIME DECAY (60–180s) ───────────────────────────────────────────
  if (secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65)
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: (P.DECAY_STOP ?? 0.02) * stopMult, mode: 'DECAY' };
    if (yesPrice <= 0.20 && pctAbove <= 0.35)
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: (P.DECAY_STOP ?? 0.02) * stopMult, mode: 'DECAY' };
    // No signal → fall through to ALIGNED/MOMENTUM for mid-range entries
  }

  // ── Mode 2: REVERSAL — DISABLED ─────────────────────────────────────────
  // Live log: 0% win rate, −$8.24 total. Disabled in live farmBot.

  // ── Mode 3: STRONG_CONVICTION — DISABLED ────────────────────────────────
  // Live log: 8–9% win rate, −$2.56 total. Disabled in live farmBot.

  // ── Mode 4: CONVICTION — DISABLED ───────────────────────────────────────
  // Live log: 20% win rate, −$1.56 total. Disabled in live farmBot.

  // ── Mode 5: ALIGNED ───────────────────────────────────────────────────────
  const alignedVelMin = P.ALIGNED_VEL_MIN ?? 0.03;
  if (Math.abs(cycleDelta) >= P.ALIGNED_CYCLE_DELTA_MIN && Math.abs(yesVel) >= alignedVelMin) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      const stop = (P.ALIGNED_STOP ?? TARGET[regime]) * stopMult;
      return { shouldFarm: true, bet, target: TARGET[regime], stop, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  // ── Mode 6: MOMENTUM ──────────────────────────────────────────────────────
  // Require 2 consecutive ticks (matches live farmBot update)
  const momentumVelMin = P.MOMENTUM_VEL_MIN ?? 0.08;
  if (yesPrice >= 0.30 && yesPrice <= 0.70 && secsLeft > P.MOMENTUM_SECS_MIN
      && yesVelHistory.length >= 2) {
    const last2Avg = yesVelHistory.slice(-2).reduce((a, b) => a + b) / 2;
    if (Math.abs(yesVel) >= momentumVelMin && Math.abs(last2Avg) >= 0.06
        && Math.sign(yesVel) === Math.sign(last2Avg)) {
      const bet = yesVel > 0 ? 'UP' : 'DOWN';
      const stop = (P.MOMENTUM_STOP ?? TARGET[regime]) * stopMult;
      return { shouldFarm: true, bet, target: TARGET[regime], stop, mode: 'MOMENTUM' };
    }
  }

  return { shouldFarm: false, reason: 'NO_MODE' };
}

// ── Exit checker (mirrors exitManager.checkExit) ─────────────────────────────

function checkExitSync(trade, s, P) {
  const { yesAsk, yesBid, yesVelHistory, secsLeft } = s;
  const STOP_LOSS = { CALM: P.STOP_LOSS_CALM, NORMAL: P.STOP_LOSS_NORMAL, CHOPPY: P.STOP_LOSS_CHOPPY };
  const TRAIL_LEVELS = [
    { threshold: 0.75, pullback: 0.03 },
    { threshold: 0.65, pullback: 0.04 },
    { threshold: 0.55, pullback: 0.06 },
  ];

  const unrealizedPnL = computeUnrealizedPnL(trade, yesAsk, yesBid);
  const pctCaptured = trade.maxProfit > 0 ? unrealizedPnL / trade.maxProfit : 0;

  const currentSidePrice = trade.side === 'yes' ? yesBid : (1 - yesAsk);
  if (trade.peakYes === undefined) trade.peakYes = currentSidePrice;
  else trade.peakYes = Math.max(trade.peakYes, currentSidePrice);

  let exitReason = null;

  // 1. Take profit
  const tpTarget = trade.lockedTP ?? trade.maxProfit * P.TAKE_PROFIT_PCT;
  if (unrealizedPnL >= tpTarget) exitReason = 'TAKE_PROFIT';

  // 2. Stop loss
  if (!exitReason) {
    const regime = s.regime ?? 'NORMAL';
    const slPct = trade.lockedSL ?? STOP_LOSS[regime];
    if (unrealizedPnL <= -(trade.amount * slPct)) exitReason = 'STOP_LOSS';
  }

  // 3. Velocity reversal
  if (!exitReason && yesVelHistory.length >= 3 && pctCaptured > P.VEL_REVERSAL_PCT_CAPTURED) {
    const recent = yesVelHistory.slice(-3);
    const avgVel = recent.reduce((a, b) => a + b) / recent.length;
    const against = trade.bet === 'UP' ? avgVel < -0.08 : avgVel > 0.08;
    if (against) exitReason = 'VEL_REVERSAL';
  }

  // 4. Trail stop
  if (!exitReason) {
    for (const { threshold, pullback } of TRAIL_LEVELS) {
      if (trade.peakYes >= threshold) {
        if (trade.peakYes - currentSidePrice >= pullback) exitReason = 'TRAIL_STOP';
        break;
      }
    }
  }

  // 5. Time floor
  if (!exitReason) {
    if (
      (secsLeft <= 45  && unrealizedPnL > 0) ||
      (secsLeft <= 90  && unrealizedPnL > 0) ||
      (secsLeft <= 180 && pctCaptured >= 0.10) ||
      (secsLeft <= 360 && pctCaptured >= 0.25) ||
      (secsLeft <= 600 && pctCaptured >= 0.40)
    ) {
      exitReason = 'TIME_FLOOR';
    }
  }

  return exitReason ? { exit: true, reason: exitReason, pnl: unrealizedPnL } : { exit: false };
}

// ── Main simulation runner ────────────────────────────────────────────────────

/**
 * Run the farm bot logic against a sequence of market snapshots.
 *
 * @param {Array<Object>} snapshots  - Array of market tick snapshots
 * @param {Object} P                 - Parameter set (from params.js)
 * @param {number} balance           - Starting balance in dollars
 * @param {Object|null} brain        - Optional brain (null = use default prob)
 * @returns {Array<Object>}          - Trade log entries
 */
export function simulate(snapshots, P, balance = 10, brain = null) {
  const trades = [];
  let currentBalance = balance;

  // Per-window state
  let s = createSimState();

  let activeTrade = null;
  let windowId = null;
  let windowOpenPrice = null;
  let farmRounds = 0;
  let ticksAbove = 0;
  let ticksTotal = 0;
  let lastExitSnapIdx = -99;  // snapshot index of last exit (for reentry wait)
  const REENTRY_WAIT_TICKS = 3; // ~8-9 seconds at 3s tick interval

  // Risk management state (persists across windows, mirrors riskManager.js)
  let consecutiveLosses = 0;
  let lastLossSnapIdx = -999;
  const STREAK_BRAKE = 3;
  const COOLDOWN_TICKS = 15;    // ~45s at 3s tick interval
  const STREAK_RESET_TICKS = 600; // ~30 min of no trading

  for (let snapIdx = 0; snapIdx < snapshots.length; snapIdx++) {
    const snap = snapshots[snapIdx];
    const {
      yesAsk, yesBid, secsLeft, regime = 'NORMAL',
      btcPrice, windowId: wid, yesVel = 0,
    } = snap;

    // Window roll detection
    if (wid !== null && wid !== windowId) {
      farmRounds = 0;
      ticksAbove = 0;
      ticksTotal = 0;
      windowOpenPrice = btcPrice;
      windowId = wid;
      s = createSimState();
      activeTrade = null;
    }

    // Update state
    s.yesAsk = yesAsk;
    s.yesBid = yesBid;
    s.secsLeft = secsLeft;
    s.regime = regime;
    s.yesVel = yesVel;

    // Track velocity history
    s.yesVelHistory.push(yesVel);
    if (s.yesVelHistory.length > 10) s.yesVelHistory.shift();

    // Spread-based liquidity
    const spread = yesAsk - yesBid;
    s.liquidity = spread < P.LIQUIDITY_HIGH_SPREAD ? 'HIGH' :
                  spread < P.LIQUIDITY_MED_SPREAD  ? 'MEDIUM' : 'LOW';

    // pctAbove tracking
    ticksTotal++;
    if ((yesAsk + yesBid) / 2 >= 0.50) ticksAbove++;
    const pctAbove = ticksTotal > 0 ? ticksAbove / ticksTotal : 0.5;

    // ── Exit check ──────────────────────────────────────────────────────────
    if (activeTrade) {
      const exit = checkExitSync(activeTrade, s, P);
      if (exit.exit) {
        currentBalance += exit.pnl;
        const entry = {
          asset:   snap.asset ?? 'SIM',
          bet:     activeTrade.bet,
          mode:    activeTrade.mode,
          amount:  activeTrade.amount,
          pnl:     exit.pnl,
          win:     exit.pnl > 0,
          reason:  exit.reason,
          at:      snap.ts ?? new Date().toISOString(),
          secsLeft,
          regime,
          yesPrice: (yesAsk + yesBid) / 2,
          entryYes: activeTrade.entryYes,
          params:  P,
        };
        trades.push(entry);
        activeTrade = null;
        lastExitSnapIdx = snapIdx;
        // Update streak counters
        if (exit.pnl < 0) {
          consecutiveLosses++;
          lastLossSnapIdx = snapIdx;
        } else {
          consecutiveLosses = 0;
        }
      }
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (!activeTrade && farmRounds < 99) {
      // Reentry wait (cooldown after last exit)
      if (snapIdx - lastExitSnapIdx < REENTRY_WAIT_TICKS) continue;

      // Streak brake — mirrors riskManager.checkRiskGuards
      if (snapIdx - lastLossSnapIdx < COOLDOWN_TICKS) continue;
      if (consecutiveLosses >= STREAK_BRAKE) {
        if (snapIdx - lastLossSnapIdx >= STREAK_RESET_TICKS) {
          consecutiveLosses = 0; // auto-reset after 30 min idle
        } else {
          continue;
        }
      }

      // btcPrice in old snapshots is YES mid (0–1); in new snapshots it's actual spot (>100).
      // For old snapshots, use yesVel-based cycleDelta (more honest than YES-price arithmetic).
      const isSpotPrice = btcPrice > 1;
      const cycleDelta = isSpotPrice && windowOpenPrice && windowOpenPrice > 1
        ? (btcPrice - windowOpenPrice) / windowOpenPrice * 100
        : yesVel * 2; // proxy: scale yesVel (¢/s) to approximate % drift

      const decision = evaluateModes(s, regime, cycleDelta, pctAbove, P);
      if (!decision.shouldFarm) continue;

      const { bet, target, stop, mode } = decision;

      // Model probability — use brain sample count to decide if NN is reliable
      let modelProb = P.MODEL_PROB_DEFAULT;
      if (brain) {
        const dirSamples = (bet === 'UP' ? brain.dataUp : brain.dataDown) ?? [];
        if (dirSamples.length >= P.MODEL_PROB_MIN_SAMPLES) {
          modelProb = snap.modelProb ?? P.MODEL_PROB_DEFAULT;
        }
      }

      const amount = kellyBet(bet, yesAsk, yesBid, modelProb, currentBalance, P);
      const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
      const filled = Math.max(1, Math.floor(amount / sidePrice));
      const spentActual = filled * sidePrice;
      const maxProfit = filled * 1.00 - spentActual;

      activeTrade = {
        ticker: snap.ticker ?? 'SIM',
        bet,
        side: bet === 'UP' ? 'yes' : 'no',
        amount: spentActual,
        count: filled,
        entryYes: (yesAsk + yesBid) / 2,
        maxProfit,
        lockedTP: maxProfit * P.TAKE_PROFIT_PCT,
        lockedSL: stop,
        startedAt: Date.now(),
        mode,
        peakYes: undefined,
      };
      farmRounds++;
    }
  }

  return trades;
}

function createSimState() {
  return {
    yesAsk: null, yesBid: null, secsLeft: 900,
    regime: 'NORMAL', yesVel: 0,
    yesVelHistory: [], liquidity: 'MEDIUM',
  };
}
