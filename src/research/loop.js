/**
 * Research loop — orchestrates the autoresearch cycle:
 *   Every 5 minutes: run simulation + optimize params
 *   Every 10 minutes: execute live trade via MCP + score result
 *   Continuously: record market ticks via MCP polling
 */
import { loadParams, saveParams, DEFAULTS } from './params.js';
import { simulate } from './simulator.js';
import { evaluate } from './evaluator.js';
import { optimize } from './optimizer.js';
import { Recorder } from './recorder.js';
import { saveReport } from './reporter.js';
import { updateDiscrepancy, getCalibratedScore, getDiscrepancyStats } from './discrepancy.js';
import { runLossClassifier } from './lossClassifier.js';
import { notify } from '../notify.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function loadBrain(asset) {
  const p = path.join(__dirname, `../../data/${asset.toLowerCase()}_brain.json`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_STATE_FILE  = path.join(__dirname, '../../data/live_state.json');
const TRADES_LOG_FILE  = path.join(__dirname, '../../logs/trades.json');

const SIM_INTERVAL_MS  = 5  * 60 * 1000;   // 5 minutes
const LIVE_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const TICK_INTERVAL_MS = 3_000;            // poll status every 3s

export class ResearchLoop {
  constructor(mcpClient = null) {
    this._mcp        = mcpClient;
    this._recorder   = new Recorder();
    this._params     = loadParams();
    this._cycles     = [];
    this._allTrades  = [];
    this._lastScore  = 0;
    this._startedAt  = new Date().toISOString();
    this._runId      = `run_${Date.now()}`;
    this._running    = false;
    this._timers     = [];
  }

  async start() {
    this._running = true;
    console.log('[ResearchLoop] Starting — loading historical snapshots...');
    this._recorder.loadFromDisk();

    // Initial simulation immediately
    await this._runSimCycle();

    // Tick recorder (polls MCP get_status every 3s)
    const tickTimer = setInterval(() => this._tick().catch(e =>
      console.error('[ResearchLoop] tick error:', e.message)
    ), TICK_INTERVAL_MS);
    this._timers.push(tickTimer);

    // Simulation + optimization cycle every 5 minutes
    const simTimer = setInterval(() => this._runSimCycle().catch(e =>
      console.error('[ResearchLoop] sim error:', e.message)
    ), SIM_INTERVAL_MS);
    this._timers.push(simTimer);

    // Live trade cycle every 10 minutes
    const liveTimer = setInterval(() => this._runLiveCycle().catch(e =>
      console.error('[ResearchLoop] live error:', e.message)
    ), LIVE_INTERVAL_MS);
    this._timers.push(liveTimer);

    console.log('[ResearchLoop] Running. Sim every 5m, live every 10m.');
    console.log('[ResearchLoop] Check reports/latest.html for progress.');
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    console.log('[ResearchLoop] Stopped.');
  }

  // ── Tick: read live state snapshot written by main bot ─────────────────────
  async _tick() {
    if (!this._running) return;
    try {
      const raw  = fs.readFileSync(LIVE_STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data) this._recorder.ingest(data);
    } catch {}
  }

  // ── Simulation cycle ────────────────────────────────────────────────────────
  async _runSimCycle() {
    const snapshots = this._recorder.getSimulationData();
    if (snapshots.length < 10) {
      console.log(`[ResearchLoop] Sim: only ${snapshots.length} snapshots, waiting for more data...`);
      return;
    }

    console.log(`[ResearchLoop] Running simulation on ${snapshots.length} snapshots...`);

    // Load latest brains from disk so simulation reflects current NN state
    const btcBrain = loadBrain('BTC');
    const ethBrain = loadBrain('ETH');

    // Baseline with current params
    const baselineTrades = simulate(snapshots, this._params, 10,
      snapshots[0]?.asset === 'ETH' ? ethBrain : btcBrain);
    const baseline = baselineTrades.length >= 3
      ? evaluate(baselineTrades, this._params)
      : { overallScore: 0, questions: [] };

    console.log(`[ResearchLoop] Baseline: ${(baseline.overallScore * 100).toFixed(1)}% (${baselineTrades.length} trades, ${snapshots.length} ticks)`);

    // Run optimizer
    const { params: newParams, finalScore, history } = await optimize({
      snapshots,
      initialParams: this._params,
      rounds: 5,
    });

    this._params = newParams;

    // Re-evaluate with tuned params (use mixed brain by majority asset)
    const majorityAsset = snapshots.filter(s => s.asset === 'ETH').length > snapshots.length / 2 ? 'ETH' : 'BTC';
    const tunedTrades = simulate(snapshots, this._params, 10,
      majorityAsset === 'ETH' ? ethBrain : btcBrain);
    const tunedEval   = tunedTrades.length >= 3
      ? evaluate(tunedTrades, this._params)
      : { overallScore: 0, questions: [] };

    const cycleResult = {
      type:       'simulation',
      at:         new Date().toISOString(),
      snapshots:  snapshots.length,
      tradeCount: tunedTrades.length,
      score:      tunedEval.overallScore,
      pnl:        tunedTrades.reduce((s, t) => s + t.pnl, 0),
      paramChanges: history.flatMap(r => r.changes).length,
    };
    this._cycles.push(cycleResult);
    this._allTrades.push(...tunedTrades);
    this._lastScore = tunedEval.overallScore;

    const calibratedScore = getCalibratedScore(tunedEval.overallScore, tunedTrades);
    const discStats = getDiscrepancyStats();
    const biasLabel = discStats.overall.observations >= 5
      ? ` | bias=${discStats.overall.biasRatio.toFixed(3)} calibrated=${(calibratedScore*100).toFixed(1)}%`
      : ' | bias=uncalibrated (< 5 obs)';
    console.log(`[ResearchLoop] Sim cycle done. Score: ${(tunedEval.overallScore * 100).toFixed(1)}%${biasLabel} (${tunedTrades.length} trades)`);

    // Save report
    this._saveCurrentReport(tunedEval.questions);
  }

  // ── Live trade cycle ────────────────────────────────────────────────────────
  async _runLiveCycle() {
    if (!this._running) return;

    console.log('[ResearchLoop] Live cycle — reading trade log...');

    try {
      // MCP status check is optional — skip if client not connected
      if (this._mcp) {
        try {
          const statusResult = await this._mcp.callTool('get_status', {});
          const status = parseToolContent(statusResult);
          if (!status) console.log('[ResearchLoop] Live: MCP status unavailable, continuing with trade log');
        } catch {}
      }

      // Read trade log directly from disk
      let history = { trades: [] };
      try { history = { trades: JSON.parse(fs.readFileSync(TRADES_LOG_FILE, 'utf8')) }; } catch {}

      if (!history.trades.length) return;

      const newTrades = history.trades
        .filter(t => {
          const age = Date.now() - new Date(t.at).getTime();
          return age < LIVE_INTERVAL_MS + 60_000; // within last 11 minutes
        })
        .map(t => ({
          ...t,
          source: 'live',
          yesPrice: t.entryYes ?? 0.5,
          regime: 'NORMAL',
        }));

      if (!newTrades.length) {
        console.log('[ResearchLoop] Live: no new trades this interval');
        return;
      }

      // Bayesian calibration update — compare last sim prediction to actual live outcomes.
      // Uses the same snapshot window the last sim ran on so the comparison is apples-to-apples.
      const lastSimTrades = this._allTrades.filter(t => t.source !== 'live').slice(-200);
      updateDiscrepancy(lastSimTrades, newTrades);

      // Loss classifier — auto-adjust params based on failure patterns in recent live trades
      const allLiveTrades = [...this._allTrades.filter(t => t.source === 'live'), ...newTrades];
      const classifierAction = runLossClassifier(allLiveTrades);
      if (classifierAction) {
        // Reload params so the updated value is picked up by the next sim cycle
        this._params = loadParams();
        console.log(`[ResearchLoop] Params reloaded after classifier adjustment: ${classifierAction.param}`);
      }

      const cycleResult = {
        type:       'live',
        at:         new Date().toISOString(),
        tradeCount: newTrades.length,
        score:      evaluate(newTrades, this._params).overallScore,
        pnl:        newTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
        paramChanges: 0,
      };
      this._cycles.push(cycleResult);
      this._allTrades.push(...newTrades);

      const liveEval = evaluate(this._allTrades.slice(-50), this._params);
      this._lastScore = liveEval.overallScore;

      console.log(`[ResearchLoop] Live cycle: ${newTrades.length} trades, score ${(cycleResult.score * 100).toFixed(1)}%`);

      // Sim training progress report
      const allSimTrades = [
        ...this._allTrades.filter(t => t.sim),
        ...newTrades.filter(t => t.sim),
      ];
      if (allSimTrades.length > 0) {
        const simWins  = allSimTrades.filter(t => t.win).length;
        const simWR    = simWins / allSimTrades.length;
        const target   = 200;
        const wrTarget = 0.55;
        const ready    = allSimTrades.length >= target && simWR >= wrTarget;
        console.log(`[SimTraining] ${allSimTrades.length}/${target} trades | WR=${(simWR*100).toFixed(0)}% (need ${(wrTarget*100).toFixed(0)}%) | ${ready ? '✅ READY FOR LIVE' : '📚 training...'}`);

        // Fire push notification when target is hit (only once)
        if (ready && !this._simReadyNotified) {
          this._simReadyNotified = true;
          await notify(
            '🚀 Bot Ready for Live Trading',
            `Sim training complete: ${allSimTrades.length} trades, ${(simWR*100).toFixed(0)}% win rate. Time to go live!`,
            'default'
          );
          console.log('[SimTraining] 🔔 Push notification sent — training target reached!');
        }

        // Progress ping every 50 trades
        if (allSimTrades.length % 50 === 0 && !ready) {
          await notify(
            `📚 Sim Training: ${allSimTrades.length}/200`,
            `WR=${(simWR*100).toFixed(0)}% | Need 55% to go live`,
            'default'
          );
        }
      }

      this._saveCurrentReport(liveEval.questions);

    } catch (err) {
      console.error('[ResearchLoop] Live cycle error:', err.message);
    }
  }

  _saveCurrentReport(questionScores) {
    try {
      saveReport({
        runId:         this._runId,
        startedAt:     this._startedAt,
        cycles:        this._cycles,
        finalScore:    this._lastScore,
        trades:        this._allTrades.slice(-200),
        paramHistory:  [], // populated by optimizer
        questionScores: questionScores ?? [],
        params:        this._params,
      });
    } catch (err) {
      console.error('[ResearchLoop] Report save error:', err.message);
    }
  }

  getStatus() {
    const recStats = this._recorder.stats();
    return {
      running:       this._running,
      cycles:        this._cycles.length,
      lastScore:     this._lastScore,
      totalTrades:   this._allTrades.length,
      recorderStats: recStats,
      params:        this._params,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseToolContent(result) {
  try {
    if (!result || !result.content) return null;
    const text = result.content.find(c => c.type === 'text')?.text;
    if (!text) return null;
    // Try JSON parse first
    try { return JSON.parse(text); } catch {}
    // Try extracting JSON from text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return null;
  } catch { return null; }
}
