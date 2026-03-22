import { executeSell } from '../kalshi/orders.js';
import { recordTradePnL } from './riskManager.js';
import { recordTrade as recordBrainTrade } from '../nn/store.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_LOG = path.join(__dirname, '../../logs/trades.json');

const STOP_LOSS = { CALM: 0.15, NORMAL: 0.12, CHOPPY: 0.10 };

const TRAIL_LEVELS = [
  { threshold: 0.75, pullback: 0.03 },
  { threshold: 0.65, pullback: 0.04 },
  { threshold: 0.55, pullback: 0.06 },
];

export function computeUnrealizedPnL(trade, yesAsk, yesBid) {
  const currentValue = trade.side === 'yes'
    ? trade.count * yesBid
    : trade.count * (1 - yesAsk);
  return currentValue - trade.amount;
}

// Called every tick when activeTrade is set.
// Checks all 5 exit triggers in priority order and executes sell if triggered.
export async function checkExit(ctx) {
  const { asset, s } = ctx;
  const trade = s.activeTrade;
  if (!trade || s.yesAsk === null) return;

  const { yesAsk, yesBid, yesVelHistory, secsLeft } = s;
  const unrealizedPnL = computeUnrealizedPnL(trade, yesAsk, yesBid);
  const pctCaptured = trade.maxProfit > 0 ? unrealizedPnL / trade.maxProfit : 0;

  // Track peak side price for trail stop
  const currentSidePrice = trade.side === 'yes' ? yesBid : (1 - yesAsk);
  if (trade.peakYes === undefined) trade.peakYes = currentSidePrice;
  else trade.peakYes = Math.max(trade.peakYes, currentSidePrice);

  let exitReason = null;

  // 1. Take profit — locked at entry for farm trades, else 60% of max
  const tpTarget = trade.lockedTP ?? trade.maxProfit * 0.60;
  if (unrealizedPnL >= tpTarget) {
    exitReason = 'TAKE_PROFIT';
  }

  // 2. Stop loss — locked % at entry, else regime-based
  if (!exitReason) {
    const regime = s.regime ?? 'NORMAL';
    const slPct = trade.lockedSL ?? STOP_LOSS[regime];
    if (unrealizedPnL <= -(trade.amount * slPct)) {
      exitReason = 'STOP_LOSS';
    }
  }

  // 3. Velocity reversal — YES moving hard against our bet for 3 ticks + have some profit locked
  if (!exitReason && yesVelHistory.length >= 3 && pctCaptured > 0.05) {
    const recent = yesVelHistory.slice(-3);
    const avgVel = recent.reduce((a, b) => a + b) / recent.length;
    const against = trade.bet === 'UP' ? avgVel < -0.08 : avgVel > 0.08;
    if (against) exitReason = 'VEL_REVERSAL';
  }

  // 4. Trail stop — pulled back from peak by threshold cents
  if (!exitReason) {
    for (const { threshold, pullback } of TRAIL_LEVELS) {
      if (trade.peakYes >= threshold) {
        if (trade.peakYes - currentSidePrice >= pullback) {
          exitReason = 'TRAIL_STOP';
        }
        break;
      }
    }
  }

  // 5. Time floor — exit at progressively lower capture thresholds as time runs out
  if (!exitReason) {
    if (
      (secsLeft <= 90  && unrealizedPnL > 0)       ||
      (secsLeft <= 180 && pctCaptured >= 0.10)      ||
      (secsLeft <= 360 && pctCaptured >= 0.25)      ||
      (secsLeft <= 600 && pctCaptured >= 0.40)
    ) {
      exitReason = 'TIME_FLOOR';
    }
  }

  if (exitReason) {
    await executeExit(asset, s, exitReason, unrealizedPnL);
  }
}

async function executeExit(asset, s, reason, unrealizedPnL) {
  const trade = s.activeTrade;
  console.log(`[Exit] ${asset} ${trade.mode ?? ''} ${trade.bet} ${reason} PnL=$${unrealizedPnL.toFixed(2)}`);

  try {
    await executeSell(trade.ticker, trade.side, trade.count);
  } catch (err) {
    console.error(`[Exit] Sell failed (${reason}):`, err.message);
    return; // Don't clear trade — will retry next tick
  }

  // Update risk counters
  recordTradePnL(s, unrealizedPnL);

  // Train NN with outcome
  if (trade.featuresRaw && trade.featuresNorm && s.brain) {
    try {
      await recordBrainTrade(
        asset, s.brain,
        trade.featuresNorm, trade.featuresRaw,
        trade.bet, unrealizedPnL > 0
      );
    } catch (err) {
      console.error('[Exit] Brain record failed:', err.message);
    }
  }

  // Append to trade log
  await appendLog({
    asset, bet: trade.bet, mode: trade.mode,
    amount: trade.amount, pnl: unrealizedPnL,
    win: unrealizedPnL > 0, reason,
    at: new Date().toISOString(),
  });

  s.lastExitTime = Date.now();
  s.activeTrade = null;
}

async function appendLog(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(TRADES_LOG, 'utf8')); } catch {}
  logs.push(entry);
  await fs.promises.writeFile(TRADES_LOG, JSON.stringify(logs, null, 2));
}
