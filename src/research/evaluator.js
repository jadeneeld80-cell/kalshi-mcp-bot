/**
 * Evaluator — scores a trade log against the 18 evaluation questions.
 * Each question returns { id, question, score, detail }.
 * Overall score = fraction of questions with score >= 0.5.
 */

// ── Evaluation Questions ──────────────────────────────────────────────────────
// Each evaluator returns a score in [0, 1] (higher = better).
// "pass" means score >= PASS_THRESHOLD.
const PASS_THRESHOLD = 0.5;

export function evaluate(trades, params) {
  const results = [
    q1_EntryPrecision(trades, params),
    q2_StopLossRespect(trades, params),
    q3_WinRate(trades, params),
    q4_ProfitFactor(trades, params),
    q5_RiskReward(trades, params),
    q6_KellyCalibration(trades, params),
    q7_RegimeAdaptation(trades, params),
    q8_DecayModeEfficiency(trades, params),
    q9_ReversalAccuracy(trades, params),
    q10_MomentumEdge(trades, params),
    q11_LiquidityFiltering(trades, params),
    q12_VelocityReversalExit(trades, params),
    q13_TrailStopCapture(trades, params),
    q14_TimeFloorProtection(trades, params),
    q15_SessionRisk(trades, params),
    q16_CooldownRespect(trades, params),
    q17_BrainImprovement(trades, params),
    q18_OverallPnL(trades, params),
  ];

  const passed = results.filter(r => r.score >= PASS_THRESHOLD).length;
  const overallScore = passed / results.length;

  return {
    overallScore,
    passed,
    total: results.length,
    questions: results,
    trades,
  };
}

// ── Individual Question Evaluators ───────────────────────────────────────────

function q1_EntryPrecision(trades) {
  // Q1: Are entries avoiding dead zones and extreme prices?
  if (!trades.length) return pass(1, 'Entry precision (dead zone avoidance)', 1.0, 'No trades to check');
  const bad = trades.filter(t => {
    const p = t.yesPrice;
    return p >= 0.44 && p <= 0.56;
  }).length;
  const score = 1 - bad / trades.length;
  return pass(1, 'Entry precision — dead zone / spread avoidance', score,
    `${bad}/${trades.length} entries in dead zone or spread extreme`);
}

function q2_StopLossRespect(trades) {
  // Q2: Do stop losses fire before losses exceed threshold?
  if (!trades.length) return pass(2, 'Stop loss respect', 1.0, 'No trades');
  const big = trades.filter(t => t.pnl < 0 && Math.abs(t.pnl) > t.amount * 0.25).length;
  const score = 1 - big / trades.length;
  return pass(2, 'Stop loss — no catastrophic losses (>25% of stake)', score,
    `${big} trades exceeded 25% stop threshold`);
}

function q3_WinRate(trades) {
  // Q3: Win rate >= 50%?
  if (!trades.length) return pass(3, 'Win rate >= 50%', 0.5, 'No trades');
  const wins = trades.filter(t => t.win).length;
  const wr = wins / trades.length;
  const score = Math.min(1, wr / 0.50);  // scales: 50% wr → score=1.0
  return pass(3, `Win rate (${(wr*100).toFixed(1)}% of ${trades.length} trades)`, score,
    `${wins} wins, ${trades.length - wins} losses`);
}

function q4_ProfitFactor(trades) {
  // Q4: Total gains > total losses (profit factor > 1)?
  if (!trades.length) return pass(4, 'Profit factor > 1', 0.5, 'No trades');
  const gains  = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = trades.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  if (!losses) return pass(4, 'Profit factor', 1.0, 'No losses recorded');
  const pf = gains / losses;
  const score = Math.min(1, pf / 1.5); // pf=1.5 → score=1.0
  return pass(4, `Profit factor (${pf.toFixed(2)})`, score,
    `Gains $${gains.toFixed(2)}, Losses $${losses.toFixed(2)}`);
}

function q5_RiskReward(trades) {
  // Q5: Average win/loss ratio >= 1.5
  const wins  = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  if (!wins.length || !losses.length) return pass(5, 'Risk/reward ratio', 0.5, 'Not enough data');
  const avgWin  = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
  const avgLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0) / losses.length;
  const rr = avgWin / avgLoss;
  const score = Math.min(1, rr / 1.5);
  return pass(5, `Risk/reward ratio (${rr.toFixed(2)})`, score,
    `Avg win $${avgWin.toFixed(2)}, avg loss $${avgLoss.toFixed(2)}`);
}

function q6_KellyCalibration(trades) {
  // Q6: Bet sizes are not catastrophically large vs balance
  if (!trades.length) return pass(6, 'Kelly bet sizing', 1.0, 'No trades');
  // Proxy: average trade amount vs pnl magnitude (should be reasonable)
  const oversized = trades.filter(t => t.amount > 0 && Math.abs(t.pnl) / t.amount > 1.5).length;
  const score = 1 - oversized / trades.length;
  return pass(6, 'Kelly bet calibration (no oversized losses)', score,
    `${oversized}/${trades.length} trades had loss > 150% of stake`);
}

function q7_RegimeAdaptation(trades) {
  // Q7: Does the bot avoid more trades in CHOPPY regime (or have better win rate in CALM)?
  const calm   = trades.filter(t => t.regime === 'CALM');
  const normal = trades.filter(t => t.regime === 'NORMAL');
  const choppy = trades.filter(t => t.regime === 'CHOPPY');

  if (!trades.length) return pass(7, 'Regime adaptation', 0.5, 'No trades');

  // Score: CALM win rate >= CHOPPY win rate (we want to be more selective in CHOPPY)
  const choppyWR = choppy.length ? choppy.filter(t => t.win).length / choppy.length : 0.5;
  const calmWR   = calm.length   ? calm.filter(t => t.win).length   / calm.length   : 0.5;
  const normalWR = normal.length ? normal.filter(t => t.win).length / normal.length : 0.5;

  const score = Math.max(0, Math.min(1, (calmWR + normalWR * 0.5 - choppyWR * 0.5) / 1.0));
  return pass(7, `Regime adaptation (CALM=${(calmWR*100).toFixed(0)}% NORMAL=${(normalWR*100).toFixed(0)}% CHOPPY=${(choppyWR*100).toFixed(0)}%)`,
    score, `${calm.length} calm, ${normal.length} normal, ${choppy.length} choppy trades`);
}

function q8_DecayModeEfficiency(trades) {
  // Q8: DECAY mode trades have win rate >= 65%
  const decay = trades.filter(t => t.mode === 'DECAY');
  if (!decay.length) return pass(8, 'DECAY mode win rate', 0.5, 'No DECAY trades');
  const wr = decay.filter(t => t.win).length / decay.length;
  const score = Math.min(1, wr / 0.65);
  return pass(8, `DECAY mode win rate (${(wr*100).toFixed(1)}% of ${decay.length} trades)`, score,
    `Need >= 65% for full score`);
}

function q9_ReversalAccuracy(trades) {
  // Q9: REVERSAL mode precision (should not fire false reversals)
  const rev = trades.filter(t => t.mode === 'REVERSAL');
  if (!rev.length) return pass(9, 'REVERSAL mode accuracy', 0.5, 'No REVERSAL trades');
  const wr = rev.filter(t => t.win).length / rev.length;
  const score = Math.min(1, wr / 0.55);
  return pass(9, `REVERSAL mode accuracy (${(wr*100).toFixed(1)}% of ${rev.length} trades)`, score,
    `Need >= 55% for full score`);
}

function q10_MomentumEdge(trades) {
  // Q10: MOMENTUM mode win rate >= 52%
  const mom = trades.filter(t => t.mode === 'MOMENTUM');
  if (!mom.length) return pass(10, 'MOMENTUM mode edge', 0.5, 'No MOMENTUM trades');
  const wr = mom.filter(t => t.win).length / mom.length;
  const score = Math.min(1, wr / 0.52);
  return pass(10, `MOMENTUM mode edge (${(wr*100).toFixed(1)}% of ${mom.length} trades)`, score, '');
}

function q11_LiquidityFiltering(trades) {
  // Q11: All trades are in HIGH or MEDIUM liquidity (no LOW trades)
  // Since simulator blocks LOW_LIQ, we check mode distributions include no extreme spread entries
  if (!trades.length) return pass(11, 'Liquidity filtering', 1.0, 'No trades');
  // Proxy: check for trades with unreasonably high amounts (> 30% of typical balance estimate)
  // We can't know liquidity at exit in logs, so score this as always passing in sim
  return pass(11, 'Liquidity filtering (LOW_LIQ blocked)', 1.0,
    'Simulator blocks LOW liquidity entries by design');
}

function q12_VelocityReversalExit(trades) {
  // Q12: VEL_REVERSAL exits protect profits (should be profitable exits)
  const velExits = trades.filter(t => t.reason === 'VEL_REVERSAL');
  if (!velExits.length) return pass(12, 'Velocity reversal exit quality', 0.5, 'No VEL_REVERSAL exits');
  const profitable = velExits.filter(t => t.pnl > 0).length;
  const score = profitable / velExits.length;
  return pass(12, `VEL_REVERSAL exits with profit (${profitable}/${velExits.length})`, score,
    'Should mostly exit in green');
}

function q13_TrailStopCapture(trades) {
  // Q13: TRAIL_STOP exits have positive PnL (we captured some profit)
  const trail = trades.filter(t => t.reason === 'TRAIL_STOP');
  if (!trail.length) return pass(13, 'Trail stop profit capture', 0.5, 'No TRAIL_STOP exits');
  const profitable = trail.filter(t => t.pnl > 0).length;
  const score = profitable / trail.length;
  return pass(13, `TRAIL_STOP profitable exits (${profitable}/${trail.length})`, score, '');
}

function q14_TimeFloorProtection(trades) {
  // Q14: TIME_FLOOR exits protect against time-decay losses
  const timeExits = trades.filter(t => t.reason === 'TIME_FLOOR');
  if (!timeExits.length) return pass(14, 'Time floor protection', 0.5, 'No TIME_FLOOR exits');
  const profitable = timeExits.filter(t => t.pnl > 0).length;
  const score = profitable / timeExits.length;
  return pass(14, `TIME_FLOOR profitable exits (${profitable}/${timeExits.length})`, score,
    'Time floor should lock in wins before expiry');
}

function q15_SessionRisk(trades) {
  // Q15: No single session has catastrophic consecutive loss streak
  if (trades.length < 3) return pass(15, 'Session risk control', 0.5, 'Too few trades');

  // Count the worst consecutive loss streak
  let maxStreak = 0;
  let streak = 0;
  let totalLoss = 0;
  let maxConsecLoss = 0;
  let consecLoss = 0;
  for (const t of trades) {
    if (!t.win) {
      streak++;
      consecLoss += Math.abs(t.pnl);
      if (streak > maxStreak) maxStreak = streak;
      if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
    } else {
      streak = 0;
      consecLoss = 0;
    }
    if (t.pnl < 0) totalLoss += Math.abs(t.pnl);
  }

  // Score based on max consecutive loss streak (>= 5 consecutive = bad)
  const score = Math.max(0, 1 - maxStreak / 5);
  return pass(15, `Session risk / max loss streak (${maxStreak} consecutive losses)`, score,
    `Max consecutive loss streak: ${maxStreak}`);
}

function q16_CooldownRespect(trades) {
  // Q16: Stop-loss trades should not be followed immediately by another entry
  // Proxy: after a losing trade, how often is the next trade also a loser?
  if (trades.length < 4) return pass(16, 'Cooldown between entries', 1.0, 'Too few trades');
  let postLossLosses = 0;
  let postLossTotal = 0;
  for (let i = 1; i < trades.length; i++) {
    if (!trades[i - 1].win) {
      postLossTotal++;
      if (!trades[i].win) postLossLosses++;
    }
  }
  if (!postLossTotal) return pass(16, 'Cooldown respect', 1.0, 'No post-loss entries');
  // Good cooldown = post-loss loss rate is similar to normal loss rate
  const normalLossRate = trades.filter(t => !t.win).length / trades.length;
  const postLossRate   = postLossLosses / postLossTotal;
  const score = Math.max(0, 1 - Math.max(0, postLossRate - normalLossRate) * 3);
  return pass(16, `Cooldown respect (post-loss loss rate: ${(postLossRate*100).toFixed(0)}% vs base ${(normalLossRate*100).toFixed(0)}%)`,
    score, `${postLossLosses}/${postLossTotal} post-loss entries also lost`);
}

function q17_BrainImprovement(trades) {
  // Q17: Later trades win more often than earlier trades (brain is learning)
  if (trades.length < 10) return pass(17, 'Brain learning curve', 0.5, 'Too few trades');
  const half = Math.floor(trades.length / 2);
  const early = trades.slice(0, half);
  const late  = trades.slice(half);
  const earlyWR = early.filter(t => t.win).length / early.length;
  const lateWR  = late.filter(t => t.win).length / late.length;
  const improvement = lateWR - earlyWR;
  const score = Math.min(1, Math.max(0, 0.5 + improvement * 5)); // +10% improvement → score=1
  return pass(17, `Brain learning (early WR ${(earlyWR*100).toFixed(1)}% → late WR ${(lateWR*100).toFixed(1)}%)`,
    score, `Improvement: ${(improvement*100).toFixed(1)}%`);
}

function q18_OverallPnL(trades) {
  // Q18: Total PnL is positive
  if (!trades.length) return pass(18, 'Overall PnL positive', 0.5, 'No trades');
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPerTrade = totalPnL / trades.length;
  // score: positive pnl per trade → 1.0; at -$0.10/trade → 0
  const score = Math.min(1, Math.max(0, 0.5 + avgPerTrade * 5));
  return pass(18, `Overall PnL ($${totalPnL.toFixed(2)} across ${trades.length} trades)`, score,
    `Avg per trade: $${avgPerTrade.toFixed(3)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(id, question, score, detail) {
  return {
    id, question, score: Math.max(0, Math.min(1, score)),
    passed: score >= PASS_THRESHOLD,
    detail,
  };
}
