#!/usr/bin/env node
/**
 * AutoResearch entry point — karpathy/autoresearch-inspired self-improving loop.
 *
 * This script:
 *  1. Spawns the bot via MCP
 *  2. Polls market ticks every 3s (recorder)
 *  3. Every 5 minutes: runs simulation + coordinate-descent optimizer
 *  4. Every 10 minutes: fetches live trade results and scores them
 *  5. Saves HTML + JSON reports to reports/ after each cycle
 *  6. Loops until Ctrl-C or 100% score across all 18 questions
 *
 * Usage:
 *   node run-research.mjs
 *   node run-research.mjs --quick   (no live trades, sim only, for testing)
 */
import { ResearchLoop } from './src/research/loop.js';
import { loadParams, DEFAULTS, saveParams } from './src/research/params.js';
import { simulate } from './src/research/simulator.js';
import { evaluate } from './src/research/evaluator.js';
import { saveReport } from './src/research/reporter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUICK_MODE = process.argv.includes('--quick');

// ── In quick mode: run offline simulation with synthetic snapshots ─────────
if (QUICK_MODE) {
  console.log('[Research] QUICK MODE — running offline simulation with synthetic data');
  await runQuickMode();
  process.exit(0);
}

// ── Normal mode: read live state file written by main bot ─────────────────────
// No MCP client needed — main bot writes data/live_state.json every second.
console.log('[Research] Starting in file-watch mode (reads data/live_state.json)');
console.log('[Research] Make sure the bot is running: node src/index.js --mcp &');

const loop = new ResearchLoop();

// Graceful shutdown
process.on('SIGINT',  () => { loop.stop(); process.exit(0); });
process.on('SIGTERM', () => { loop.stop(); process.exit(0); });

// Print status every 60s
setInterval(() => {
  const s = loop.getStatus();
  console.log(`[Research] Status: score=${(s.lastScore * 100).toFixed(1)}% trades=${s.totalTrades} cycles=${s.cycles} ticks=${JSON.stringify(s.recorderStats.currentTicks)}`);
}, 60_000);

await loop.start();

// ── Quick mode: synthetic scenario testing ───────────────────────────────────
async function runQuickMode() {
  console.log('[Research] Generating synthetic market scenarios...');
  const params = loadParams();
  const snapshots = generateSyntheticSnapshots(500);

  // Baseline evaluation
  const baselineTrades = simulate(snapshots, params);
  const baseline = baselineTrades.length >= 3
    ? evaluate(baselineTrades, params)
    : { overallScore: 0, questions: [], trades: [] };

  console.log(`\n[Research] Baseline: ${(baseline.overallScore * 100).toFixed(1)}% score, ${baselineTrades.length} trades`);
  printQuestionSummary(baseline.questions);

  // Run optimization
  const { optimize } = await import('./src/research/optimizer.js');
  const { params: tunedParams, finalScore, history } = await optimize({
    snapshots,
    initialParams: params,
    rounds: 5,
    onRoundComplete: async ({ round, score }) => {
      console.log(`[Research] Round ${round} complete → score: ${(score * 100).toFixed(1)}%`);
    },
  });

  // Final evaluation
  const finalTrades = simulate(snapshots, tunedParams);
  const finalEval   = finalTrades.length >= 3
    ? evaluate(finalTrades, tunedParams)
    : { overallScore: 0, questions: [] };

  console.log(`\n[Research] Final: ${(finalEval.overallScore * 100).toFixed(1)}% score, ${finalTrades.length} trades`);
  printQuestionSummary(finalEval.questions);

  const cycles = history.map((h, i) => ({
    type: 'simulation', at: new Date().toISOString(),
    snapshots: snapshots.length,
    tradeCount: finalTrades.length,
    score: h.score,
    pnl: finalTrades.reduce((s, t) => s + t.pnl, 0),
    paramChanges: h.changes.length,
  }));

  saveReport({
    runId:         `quick_${Date.now()}`,
    startedAt:     new Date().toISOString(),
    cycles,
    finalScore:    finalEval.overallScore,
    trades:        finalTrades,
    paramHistory:  history,
    questionScores: finalEval.questions ?? [],
    params:        tunedParams,
  });

  console.log('\n[Research] Reports saved to reports/latest.html');
  console.log(`[Research] Net PnL: $${finalTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
}

function printQuestionSummary(questions) {
  if (!questions || !questions.length) return;
  const passed = questions.filter(q => q.passed).length;
  console.log(`  ${passed}/${questions.length} questions passing`);
  for (const q of questions) {
    const icon = q.passed ? '✓' : '✗';
    console.log(`  ${icon} Q${q.id}: ${q.question.slice(0, 60)} → ${(q.score * 100).toFixed(0)}%`);
  }
}

// Generate synthetic market snapshots to test bot logic offline
function generateSyntheticSnapshots(count) {
  const snapshots = [];
  const scenarios = [
    // Strong uptrend
    { startYes: 0.30, drift: +0.0003, vel: +0.15, regime: 'NORMAL' },
    // Strong downtrend
    { startYes: 0.70, drift: -0.0003, vel: -0.15, regime: 'NORMAL' },
    // Reversal (down → up)
    { startYes: 0.40, drift: 0, vel: 0, regime: 'NORMAL', reversal: 'UP' },
    // Choppy / dead zone
    { startYes: 0.50, drift: 0, vel: 0.02, regime: 'CHOPPY' },
    // Conviction long (strong YES)
    { startYes: 0.75, drift: +0.0002, vel: +0.10, regime: 'CALM' },
    // Conviction short
    { startYes: 0.25, drift: -0.0002, vel: -0.10, regime: 'CALM' },
    // Late window decay (high YES, time running out)
    { startYes: 0.85, drift: 0, vel: 0, regime: 'NORMAL', lateWindow: true },
  ];

  const windowId = Math.floor(Date.now() / (15 * 60 * 1000));
  let btcPrice = 65000;
  let secsLeftBase = 890;

  for (let i = 0; i < count; i++) {
    const scenario = scenarios[i % scenarios.length];
    const tick = i % 128; // ticks per scenario block

    let yesPrice = scenario.startYes + tick * scenario.drift;
    yesPrice = Math.max(0.06, Math.min(0.94, yesPrice));

    // Reversal: first half goes down, second half goes up
    if (scenario.reversal === 'UP') {
      yesPrice = tick < 64
        ? Math.max(0.20, 0.45 - tick * 0.002)
        : Math.min(0.75, 0.30 + (tick - 64) * 0.003);
    }

    const spread = scenario.regime === 'CHOPPY' ? 0.04 : 0.02;
    const yesAsk = Math.min(0.98, yesPrice + spread / 2);
    const yesBid = Math.max(0.02, yesPrice - spread / 2);

    const secsLeft = scenario.lateWindow
      ? Math.max(60, 120 - tick)
      : Math.max(60, secsLeftBase - tick * 6);

    // Vel history — use last 4 ticks
    const yesVel = scenario.reversal === 'UP'
      ? (tick < 64 ? -0.15 : +0.15)
      : (scenario.vel + (Math.random() - 0.5) * 0.05);

    btcPrice += (Math.random() - 0.5) * 100;

    snapshots.push({
      asset:    'BTC',
      ts:       new Date(Date.now() - (count - i) * 3000).toISOString(),
      yesAsk,
      yesBid,
      secsLeft,
      yesVel,
      regime:   scenario.regime ?? 'NORMAL',
      windowId: windowId + Math.floor(i / 128),
      btcPrice,
      ticker:   'KXBTC15M-SIM',
      elapsed:  (900 - secsLeft) * 1000,
    });
  }

  return snapshots;
}
