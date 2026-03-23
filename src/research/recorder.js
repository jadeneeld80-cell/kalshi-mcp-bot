/**
 * Recorder — captures live YES price ticks and BTC price ticks from the running bot
 * by polling the MCP server's get_status tool.
 * Snapshots are stored in memory (ring buffer) and written to disk periodically.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.join(__dirname, '../../data/snapshots');

const MAX_SNAPSHOTS_PER_WINDOW = 900; // 1 per second × 15 minutes

export class Recorder {
  constructor() {
    this._windows = {};  // asset → { windowId, snapshots[] }
    this._completedWindows = []; // last 10 complete windows (for sim)
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  /**
   * Record a tick from get_status response.
   * statusData should be the parsed content from get_status MCP call.
   */
  ingest(statusData) {
    if (!statusData) return;
    const ts = statusData.timestamp ?? new Date().toISOString();
    const assets = statusData.assets ?? {};
    if (assets.BTC) this._ingestAsset('BTC', { ...assets.BTC, btcPrice: assets.BTC.price }, ts);
    if (assets.ETH) this._ingestAsset('ETH', { ...assets.ETH, ethPrice: assets.ETH.price }, ts);
  }

  _ingestAsset(asset, status, timestamp) {
    const { yesAsk, yesBid, secsLeft, windowId, btcPrice, ethPrice,
            yesVel = 0, liquidity = 'MEDIUM', regime = 'NORMAL',
            ticker = null } = status;

    if (yesAsk === null || yesBid === null) return;

    // Derive window from secsLeft
    const wid = windowId ?? Math.floor(Date.now() / (15 * 60 * 1000));
    const price = asset === 'BTC' ? (btcPrice ?? status.spotPrice) : (ethPrice ?? status.spotPrice);

    if (!this._windows[asset] || this._windows[asset].windowId !== wid) {
      // Save previous window if complete enough
      if (this._windows[asset] && this._windows[asset].snapshots.length >= 30) {
        this._completeWindow(asset, this._windows[asset]);
      }
      this._windows[asset] = { windowId: wid, snapshots: [], asset };
    }

    const w = this._windows[asset];
    if (w.snapshots.length >= MAX_SNAPSHOTS_PER_WINDOW) return;

    w.snapshots.push({
      asset,
      ts: timestamp ?? new Date().toISOString(),
      yesAsk, yesBid, secsLeft,
      yesVel, liquidity, regime,
      windowId: wid,
      btcPrice: price,
      ticker,
      elapsed: (900 - secsLeft) * 1000, // ms into window
    });
  }

  _completeWindow(asset, windowData) {
    this._completedWindows.push(windowData);
    if (this._completedWindows.length > 10) this._completedWindows.shift();

    // Persist to disk
    const filename = path.join(SNAPSHOTS_DIR, `${asset}_${windowData.windowId}.json`);
    try {
      fs.writeFileSync(filename, JSON.stringify(windowData, null, 2));
    } catch (err) {
      console.error('[Recorder] Failed to write snapshot:', err.message);
    }
  }

  /** Returns all snapshots from recent completed windows for simulation. */
  getSimulationData(asset = null) {
    const windows = asset
      ? this._completedWindows.filter(w => w.asset === asset)
      : this._completedWindows;
    return windows.flatMap(w => w.snapshots);
  }

  /** Load previously saved windows from disk (for warm-start). */
  loadFromDisk() {
    try {
      const files = fs.readdirSync(SNAPSHOTS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-20); // last 20 windows

      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8'));
          if (data.snapshots && data.snapshots.length >= 30) {
            this._completedWindows.push(data);
          }
        } catch {}
      }
      if (this._completedWindows.length > 10) {
        this._completedWindows = this._completedWindows.slice(-10);
      }
      console.log(`[Recorder] Loaded ${this._completedWindows.length} windows from disk`);
    } catch {}
  }

  stats() {
    return {
      completedWindows: this._completedWindows.length,
      currentTicks: Object.fromEntries(
        Object.entries(this._windows).map(([k, v]) => [k, v.snapshots.length])
      ),
    };
  }
}
