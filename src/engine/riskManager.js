// Pure guard functions — return { blocked, reason } or mutate P&L counters.
// All dollar values in USD.

const RISK_DAILY_CAP    = 0.08;    // stop after 8% daily loss
const RISK_SESSION_KILL = 0.05;    // stop after 5% session loss
const RISK_CONSEC_BRAKE = 3;       // stop after 3 consecutive losses
const RISK_COOLDOWN_MS  = 45_000;  // 45s cooldown after each loss
const BALANCE_GUARD     = 5;       // don't apply loss guards below $5

export function checkRiskGuards(s, balance) {
  const now = Date.now();

  if (now - s.lastLossTime < RISK_COOLDOWN_MS) {
    return { blocked: true, reason: 'COOLDOWN' };
  }

  if (s.consecutiveLosses >= RISK_CONSEC_BRAKE) {
    return { blocked: true, reason: 'STREAK' };
  }

  if (balance > BALANCE_GUARD) {
    if (s.sessionStartBalance !== null &&
        s.sessionPnL <= -(s.sessionStartBalance * RISK_SESSION_KILL)) {
      return { blocked: true, reason: 'SESSIONKILL' };
    }
    if (s.dailyStartBalance !== null &&
        s.dailyPnL <= -(s.dailyStartBalance * RISK_DAILY_CAP)) {
      return { blocked: true, reason: 'DAILYCAP' };
    }
  }

  return { blocked: false };
}

// Called after every trade closes
export function recordTradePnL(s, pnl) {
  s.sessionPnL += pnl;
  s.dailyPnL   += pnl;
  s.totalPnL   += pnl;
  s.tradeCount++;

  if (pnl < 0) {
    s.consecutiveLosses++;
    s.lastLossTime = Date.now();
  } else {
    s.consecutiveLosses = 0;
  }
}

// Reset session counters (call at bot start or on demand)
export function startSession(s, balance) {
  s.sessionStartBalance = balance;
  s.sessionPnL = 0;
  s.consecutiveLosses = 0;
  s.lastLossTime = 0;
}

// Reset daily counters (call at midnight ET)
export function startDay(s, balance) {
  s.dailyStartBalance = balance;
  s.dailyPnL = 0;
}
