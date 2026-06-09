# Kalshi 15M Trading Bot

An autonomous trading bot for BTC and ETH 15-minute prediction contracts on [Kalshi](https://kalshi.com). Built in Node.js, controlled via an MCP (Model Context Protocol) server so Claude can monitor and manage it conversationally.

---

## What It Does

Kalshi lists binary contracts every 15 minutes: "Will BTC be above $X at 4:15pm?" The contract pays $1 if correct, $0 if not. The bot watches real-time price feeds, predicts which way BTC/ETH will move in the next window, and buys the corresponding YES or NO contract. It then manages the trade — taking profit, cutting losses, and exiting before the market settles.

The bot runs continuously, placing trades automatically with no human input required.

---

## Architecture

```
kalshi-mcp-bot/
├── src/
│   ├── index.js              ← Entry point — wires everything together
│   ├── engine/
│   │   ├── clock.js          ← 1-second heartbeat loop
│   │   ├── farmBot.js        ← 6-mode entry strategy
│   │   ├── autoBuy.js        ← Edge-detection entry bot
│   │   ├── exitManager.js    ← All exit logic (stop loss, take profit, etc.)
│   │   ├── riskManager.js    ← Daily loss caps, session kill switch
│   │   └── state.js          ← Shared runtime state
│   ├── kalshi/
│   │   ├── client.js         ← REST API client (RSA-PSS signed requests)
│   │   ├── websocket.js      ← Live YES price streaming
│   │   └── orders.js         ← Place, cancel, and sell orders
│   ├── prices/
│   │   └── binance.js        ← BTC/ETH real-time price feed (Binance WebSocket)
│   ├── nn/
│   │   ├── network.js        ← Neural network (forward pass + backprop)
│   │   ├── features.js       ← 9 technical indicator features
│   │   └── store.js          ← Load/save trained weights
│   ├── mcp/
│   │   └── server.js         ← MCP tool definitions (Claude integration)
│   └── ui/
│       └── terminal.js       ← Live terminal dashboard
├── scripts/
│   └── update-obsidian-brain.js  ← Writes learning event notes to Obsidian
├── data/                     ← Brain weights + sim state (gitignored)
└── logs/                     ← Trade history (gitignored)
```

---

## How the Bot Thinks

### 1. Price Feed
Every second, the bot receives real-time BTC/ETH prices from Binance WebSocket streams and YES/NO prices from the Kalshi WebSocket.

### 2. Entry — Farm Bot (6 modes)
The farm bot evaluates six strategies every second, firing on the first match:

| Mode | Condition | Signal |
|---|---|---|
| TIME DECAY | < 3 min left, YES ≥ 80¢ or ≤ 20¢ | Market nearly certain |
| REVERSAL | Velocity flipped direction (4 readings) | Momentum pivot |
| STRONG CONVICTION | YES 80–95¢ or 5–20¢ | Fast scalp |
| CONVICTION | YES 70–80¢ or 20–30¢ | High probability |
| ALIGNED | Price delta + YES velocity both same direction | Momentum confirmation |
| MOMENTUM | YES 30–70¢, strong velocity | Trend following |

### 3. Neural Network
A 9-input → 8-hidden → 1-output neural network trained on every trade the bot closes. It learns which market conditions lead to wins and which lead to losses, continuously improving over time.

Features it learns from: RSI, EMA crossovers, Bollinger Band position, price momentum, candle patterns, and buying/selling pressure.

Three networks run in ensemble: a combined network (UP + DOWN), an UP-only network, and a DOWN-only network. Their predictions are weighted by sample count.

### 4. Exit Manager (7 triggers, in priority order)
1. **Take profit** — unrealized P&L hits 45% of max payout
2. **Stop loss** — YES price moves 8–13¢ against the trade from entry (regime-dependent)
3. **Velocity spike** — single tick moves > 4¢/s against the trade (gap-through protection)
4. **Velocity reversal** — sustained momentum flip for 3 ticks with some profit locked
5. **Trail stop** — price pulls back from peak by 3–6¢ depending on price level
6. **Time floor** — exits at progressively lower thresholds as the window closes
7. **NN reversal** — neural network now disagrees with the entry signal

### 5. Risk Management
- Daily loss cap: 8% of balance → halt trading for the day
- Session loss cap: 5% of balance → halt for the session
- 3 consecutive losses → 45s cooldown
- Bet sizing: fixed $0.50 (< $5 balance), fixed $1.00 ($5–$50), Kelly formula (> $50)

---

## MCP Server (Claude Integration)

The bot exposes tools over the Model Context Protocol so Claude can interact with it conversationally:

```
get_status         — live prices, YES price, active trade, balance, bot state
arm_farm_bot       — enable/disable the farm bot
arm_auto_buy       — enable/disable the auto-buy bot
get_trade_history  — recent trades with P&L
get_brain_stats    — NN sample counts, win rates per tier
place_manual_trade — manually place a trade
close_trade        — close the active trade
set_balance        — update the tracked balance
export_brain       — dump brain weights to JSON
import_brain       — load brain weights from JSON
```

---

## Setup

### Prerequisites
- Node.js 18+
- A funded Kalshi account
- A Kalshi API key (RSA key pair) — generate at kalshi.com/settings/api

### Install
```bash
git clone https://github.com/your-username/kalshi-mcp-bot.git
cd kalshi-mcp-bot
npm install
```

### Environment
Create a `.env` file at the project root:
```
KALSHI_KEY_ID=your-key-id-here
KALSHI_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
...your private key...
-----END RSA PRIVATE KEY-----

DRY_RUN=false
```

### Run
```bash
npm start          # start bot + terminal dashboard
npm run dev        # auto-restart on file changes (development)
npm run test-auth  # verify Kalshi API connection
```

---

## Sim Mode

To run without risking real money, create `data/sim_override.json`:
```json
{
  "forceSimMode": true,
  "paperBalance": 50.00,
  "disabledAssets": ["ETH"]
}
```

The bot will paper trade using a virtual balance. All trade logic runs identically — only the order submission is skipped. Remove this file (or set `forceSimMode: false`) to go live.

---

## Performance (as of June 2026)

Sim training on BTC only, $50 paper balance:

- **1,243 sim trades** completed
- **68% win rate**
- **+$21 net P&L** on $50 paper balance
- Brain: 1,134 training samples (653 UP / 481 DOWN)

---

## Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js 18+ |
| Exchange API | Kalshi REST + WebSocket |
| Price feed | Binance WebSocket (`aggTrade`) |
| Auth | RSA-PSS signing (Node `crypto`) |
| MCP | `@modelcontextprotocol/sdk` |
| Terminal UI | `blessed` + `blessed-contrib` |
| Persistence | JSON files in `data/` |

---

## Notes

- **This is not financial advice.** Prediction markets carry real risk. Never trade more than you can afford to lose.
- **Kalshi contracts are binary.** Every trade either pays $1 or $0 per contract — there is no partial settlement.
- **The bot trades autonomously.** Once armed, it places and closes orders without confirmation. Review the risk settings before running live.
