// Persist and restore bot arm state (farmArmed / autoBuyArmed) across restarts.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { state } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_STATE_FILE = path.join(__dirname, '../../data/bot_state.json');

export function persistBotState() {
  try {
    const s = {
      BTC: { farmArmed: state.BTC.farmArmed, autoBuyArmed: state.BTC.autoBuyArmed },
      ETH: { farmArmed: state.ETH.farmArmed, autoBuyArmed: state.ETH.autoBuyArmed },
    };
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

export function loadBotState() {
  try {
    const s = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
    for (const asset of ['BTC', 'ETH']) {
      if (s[asset]) {
        state[asset].farmArmed    = !!s[asset].farmArmed;
        state[asset].autoBuyArmed = !!s[asset].autoBuyArmed;
      }
    }
    const armed = Object.entries(s).filter(([, v]) => v.farmArmed || v.autoBuyArmed)
      .map(([k, v]) => `${k}:${v.farmArmed ? 'FARM' : 'AUTO'}`).join(', ');
    if (armed) console.log(`[Bot] Restored armed state: ${armed}`);
  } catch {}
}
