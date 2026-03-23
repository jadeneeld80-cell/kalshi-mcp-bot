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
  const kelly    = (b * p - q) / b;
  const halfKelly = Math.max(0, kelly * 0.5);
  return Math.max(
    Math.min(halfKelly * balance, P.KELLY_MAX_FRACTION * balance),
    0.05  // KALSHI_MIN_BET
  );
}

function computeUnrealizedPnL(trade, yesAsk, yesBid) {
  const currentValue = trade.side === 'yes'
    ? trade.count * yesBid
    : trade.count * (1 - yesAsk);
  return currentValue - trade.amount;
}

// ── Entry evaluator (mirrors farmBot.evaluateModes) ──────────────────────────

function evaluateModes(s, regime, cycleDelta, pctAbove, P) {
  const { yesAsk, yesBid, secsLeft, yesVel, yesVelHistory, liquidity } = s;
  const yesPrice = (yesAsk + yesBid) / 2;

  const FARM_MIN_TIME_LEFT = 240;
  const TARGET = { CALM: P.TARGET_CALM, NORMAL: P.TARGET_NORMAL, CHOPPY: P.TARGET_CHOPPY };
  const STOP   = { CALM: P.STOP_CALM,   NORMAL: P.STOP_NORMAL,   CHOPPY: P.STOP_CHOPPY };

  // Gate A: momentum divergence
  if (Math.abs(cycleDelta) > 0.6 && Math.abs(yesVel) > 0.8) {
    if ((cycleDelta > 0) !== (yesVel > 0)) return { shouldFarm: false, reason: 'GATE_A' };
  }
  // Gate B: EMA/momentum conflict
  if (Math.abs(cycleDelta) > 0.2 && Math.abs(yesVel) > 0.3) {
    if ((cycleDelta > 0) !== (yesVel > 0)) return { shouldFarm: false, reason: 'GATE_B' };
  }
  // Gate C: signal strength stop tightener
  const signalStrength = Math.abs(cycleDelta) * 10 + Math.abs(yesVel);
  const stopMult = signalStrength > 5 ? 0.70 : 1.0;

  // Common entry blocks
  if (secsLeft < FARM_MIN_TIME_LEFT && !(secsLeft >= 60 && secsLeft <= 180)) {
    return { shouldFarm: false, reason: 'TOO_LATE' };
  }
  if (yesPrice <= P.SPREAD_EXTREME_FLOOR || yesPrice >= (1 - P.SPREAD_EXTREME_FLOOR)) {
    return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  }
  if (yesPrice >= P.DEAD_ZONE_LOW && yesPrice <= P.DEAD_ZONE_HIGH) {
    return { shouldFarm: false, reason: 'DEAD_ZONE' };
  }
  if (liquidity === 'LOW') return { shouldFarm: false, reason: 'LOW_LIQ' };

  // Mode 1: TIME DECAY
  if (secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65)
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    if (yesPrice <= 0.20 && pctAbove <= 0.35)
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: 0.02 * stopMult, mode: 'DECAY' };
    return { shouldFarm: false, reason: 'DECAY_NO_SIGNAL' };
  }

  // Mode 2: REVERSAL
  if (yesPrice >= 0.15 && yesPrice <= 0.85 && yesVelHistory.length >= 4) {
    const prior  = yesVelHistory.slice(-4, -2);
    const recent = yesVelHistory.slice(-2);
    const priorAvg  = prior.reduce((a, b) => a + b) / prior.length;
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    if (priorAvg <= -P.REVERSAL_PRIOR_THRESHOLD && recentAvg >= P.REVERSAL_RECENT_THRESHOLD)
      return { shouldFarm: true, bet: 'UP',   target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'REVERSAL' };
    if (priorAvg >= P.REVERSAL_PRIOR_THRESHOLD && recentAvg <= -P.REVERSAL_RECENT_THRESHOLD)
      return { shouldFarm: true, bet: 'DOWN', target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'REVERSAL' };
  }

  // Mode 3: STRONG CONVICTION
  if ((yesPrice >= 0.80 && yesPrice <= 0.95) || (yesPrice >= 0.05 && yesPrice <= 0.20)) {
    const bet = yesPrice >= 0.80 ? 'UP' : 'DOWN';
    return { shouldFarm: true, bet, target: 0.03, stop: 0.015 * stopMult, mode: 'STRONG_CONVICTION' };
  }

  // Mode 4: CONVICTION
  if ((yesPrice >= 0.70 && yesPrice < 0.80) || (yesPrice > 0.20 && yesPrice <= 0.30)) {
    const bet    = yesPrice >= 0.70 ? 'UP' : 'DOWN';
    const target = secsLeft < 8 * 60 ? 0.04 : 0.05;
    return { shouldFarm: true, bet, target, stop: 0.03 * stopMult, mode: 'CONVICTION' };
  }

  // Mode 5: ALIGNED
  if (Math.abs(cycleDelta) >= P.ALIGNED_CYCLE_DELTA_MIN && Math.abs(yesVel) >= 0.05) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP[regime] * 0.8 * stopMult, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  // Mode 6: MOMENTUM
  if (yesPrice >= 0.30 && yesPrice <= 0.70 && Math.abs(yesVel) >= 0.08 && secsLeft > P.MOMENTUM_SECS_MIN) {
    const bet = yesVel > 0 ? 'UP' : 'DOWN';
    return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP[regime] * stopMult, mode: 'MOMENTUM' };
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
      }
    }

    // ── Entry check ─────────────────────────────────────────────────────────
    if (!activeTrade && farmRounds < 99) {
      // Reentry wait (cooldown after last exit)
      if (snapIdx - lastExitSnapIdx < REENTRY_WAIT_TICKS) continue;

      const cycleDelta = (windowOpenPrice && btcPrice)
        ? (btcPrice - windowOpenPrice) / windowOpenPrice * 100
        : 0;

      const decision = evaluateModes(s, regime, cycleDelta, pctAbove, P);
      if (!decision.shouldFarm) continue;

      const { bet, target, stop, mode } = decision;

      // Model probability
      let modelProb = P.MODEL_PROB_DEFAULT;
      if (brain && (bet === 'UP' ? brain.dataUp : brain.dataDown).length >= P.MODEL_PROB_MIN_SAMPLES) {
        // In simulation we use the raw stored prob if available in snap, else default
        modelProb = snap.modelProb ?? P.MODEL_PROB_DEFAULT;
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
