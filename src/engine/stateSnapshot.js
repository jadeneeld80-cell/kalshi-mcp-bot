// Write a lightweight JSON snapshot of live prices every tick.
// Research loop reads this instead of spawning a separate bot process.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { state } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(__dirname, '../../data/live_state.json');

export function writeStateSnapshot() {
  try {
    const snap = {
      ts: new Date().toISOString(),
      balance: state.balance,
      assets: {},
    };
    for (const asset of ['BTC', 'ETH']) {
      const s = state[asset];
      snap.assets[asset] = {
        asset,
        yesAsk:    s.yesAsk,
        yesBid:    s.yesBid,
        price:     s.yesAsk !== null && s.yesBid !== null ? ((s.yesAsk + s.yesBid) / 2).toFixed(4) : null,
        yesVel:    s.yesVel,
        secsLeft:  s.secsLeft,
        windowId:  s.windowId,
        liquidity: s.liquidity,
        regime:    s.regime,
        ticker:    s.ticker,
        farmArmed: s.farmArmed,
        autoBuyArmed: s.autoBuyArmed,
        farmRounds: s.farmRounds,
        activeTrade: s.activeTrade,
        btcPrice:  s.windowOpenPrice,
      };
    }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
  } catch {}
}
