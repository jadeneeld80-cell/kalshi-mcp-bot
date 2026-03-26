# Kalshi 15M BTC/ETH Trading Bot — MCP Server

## Project overview

A Node.js MCP (Model Context Protocol) server that autonomously trades BTC and ETH 15-minute prediction contracts on Kalshi. Runs headlessly on local machine (cloud migration planned). Exposes MCP tools so Claude can monitor and control the bot conversationally. Includes a blessed terminal dashboard for live monitoring.

This is a port of a battle-tested browser app. Every constant, formula, and bug fix listed in this file was earned through real trading. Do not change them without understanding why they exist.

---

## File structure

```
kalshi-bot/
├── CLAUDE.md
├── package.json
├── .env                        ← KALSHI_KEY_ID, KALSHI_PRIVATE_KEY
├── src/
│   ├── index.js                ← entry point, wires everything together
│   ├── mcp/
│   │   └── server.js           ← MCP tool definitions
│   ├── engine/
│   │   ├── clock.js            ← 1-second tick loop (the heartbeat)
│   │   ├── farmBot.js          ← 5-mode farm bot
│   │   ├── autoBuy.js          ← edge-detection auto-buy bot
│   │   ├── exitManager.js      ← trail stop, velocity exit, time floor
│   │   └── riskManager.js      ← daily cap, session kill, streak brake
│   ├── kalshi/
│   │   ├── client.js           ← RSA-PSS signing + REST calls
│   │   ├── websocket.js        ← live YES price streaming
│   │   └── orders.js           ← place, cancel, sell
│   ├── prices/
│   │   ├── binance.js          ← BTC/ETH aggTrade WebSocket
│   │   └── kraken.js           ← fallback price feed
│   ├── nn/
│   │   ├── network.js          ← forward pass, backprop training
│   │   ├── features.js         ← buildFeatures, buildFeaturesNorm
│   │   └── store.js            ← load/save brain JSON to data/
│   └── ui/
│       └── terminal.js         ← blessed terminal dashboard
├── data/
│   ├── btc_brain.json          ← BTC NN weights + training samples
│   └── eth_brain.json          ← ETH NN weights + training samples
└── logs/
    └── trades.json             ← append-only trade history
```

---

## Stack

- **Runtime**: Node.js 18+
- **MCP SDK**: `@anthropic-ai/mcp` (or `@modelcontextprotocol/sdk`)
- **Terminal UI**: `blessed` + `blessed-contrib`
- **WebSocket**: `ws`
- **Crypto**: Node built-in `crypto` (RSA-PSS signing)
- **Persistence**: plain JSON files in `data/` (no database needed)
- **Environment**: `.env` via `dotenv`

---

## Development commands

```bash
npm start               # start MCP server + terminal UI
npm run dev             # start with nodemon (auto-restart)
npm run test-auth       # verify Kalshi API connection
npm run export-brain btc   # dump current BTC brain to stdout
```

---

## Kalshi API — critical details

**Base URL**: `https://api.elections.kalshi.com/trade-api/v2`
**WebSocket**: `wss://api.elections.kalshi.com/trade-api/ws/v2`

### Authentication (RSA-PSS — exact algorithm)

```js
function buildHeaders(keyId, privateKeyPem, method, kalshiPath) {
  const ts = Date.now().toString();
  const pathNoQuery = '/trade-api/v2' + kalshiPath.split('?')[0];
  const message = ts + method.toUpperCase() + pathNoQuery;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  const signature = sign.sign({
    key: normalizedPEM,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
  };
}
```

PEM keys from `.env` may have literal `\n` — normalise before use:
```js
pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
```

### Order body — exact working format

```js
{
  ticker: 'KXBTC15M-26MAR161730-30',
  client_order_id: Date.now().toString(36) + Math.random().toString(36).slice(2,7),
  side: 'yes' | 'no',              // UP→'yes', DOWN→'no'
  action: 'buy',
  type: 'limit',                    // REQUIRED — Kalshi rejects without this
  count: Math.floor(amount / sidePrice),
  time_in_force: 'fill_or_kill',
  buy_max_cost: Math.round(amount * 100), // cents, integer
  yes_price_dollars: '0.9900',      // STRING with 4 decimals — generous limit
  // OR no_price_dollars: '0.9900' for DOWN bets
}
```

**Critical contract count formula:**
- UP bet → `count = Math.floor(amount / ask_yes_price)`
- DOWN bet → `count = Math.floor(amount / (1 - bid_yes_price))` — NO price = 1 − YES bid

Getting this wrong makes DOWN bet P&L show ~$0.00 (was 16× too small before the fix).

### Sell order body

```js
{
  ticker, client_order_id,
  side: kalshiOrderSide,
  action: 'sell',
  type: 'limit',                    // REQUIRED — same as buy
  count: Math.floor(contractsHeld),
  time_in_force: 'fill_or_kill',
  yes_price_dollars: '0.0100',      // OR no_price_dollars — minimum acceptable sell price
}
```

Always cancel any open resting orders before selling (DELETE `/portfolio/orders/:order_id`).

### Market series tickers

| Asset | Series | WS subscription |
|---|---|---|
| BTC | `KXBTC15M` | `btcusdt@aggTrade` (Binance) / `XBT/USD` (Kraken) |
| ETH | `KXETH15M` | `ethusdt@aggTrade` (Binance) / `ETH/USD` (Kraken) |

---

## Bet sizing — three-tier system

All bet sizing goes through `getTieredBetSize(balance, prob, yesPrice)`. Never hardcode a bet amount.

| Tier | Balance | Bet size | Why |
|---|---|---|---|
| 1 | < $5 | $0.50 fixed | Ruin protection — $1 at $3 balance is 33%, genuinely dangerous |
| 2 | $5 – $50 | $1.00 fixed | Consistent signal for NN training; Kelly at $10 produces $0.05–$0.80 (too noisy) |
| 3 | > $50 | Kelly formula (half-Kelly, capped 20%) | Math optimum kicks in at meaningful balance |

```js
function getTieredBetSize(balance, prob, yesPrice, scaleFactor=1.0) {
  let base;
  if (balance < 5)        base = 0.50;
  else if (balance <= 50) base = 1.00;
  else                    base = computeKellyBet(prob, yesPrice, balance);
  return Math.round(Math.max(0.05, base * scaleFactor) * 100) / 100;
}
```

The Kelly formula: `f* = (b·p − q) / b` where `b = (1 − yesPrice) / yesPrice`, using half-Kelly for safety.

---

## Farm bot — 6 modes (priority order)

Runs every second. Evaluates modes in this order, fires on first match.

### Signal quality gates (run before all modes)

```
Gate A — Momentum divergence (95% confidence, data-backed):
  BTC drift from window open > 0.6% AND YES velocity > 0.8¢/s
  BUT they point opposite directions → BLOCK
  Rationale: 25/26 high-momentum trades won; the 1 loss had this exact pattern.

Gate B — EMA/momentum conflict (68% confidence):
  cycleDelta strong one direction, YES velocity strong opposite → BLOCK
  Lower confidence — only blocks when both signals are meaningfully sized.

Gate C — Strong signal stop tightener (72% confidence):
  signalStrength = |cycleDelta|×10 + |yesVel| > 5
  → multiply stopBase by 0.70 (30% tighter stop)
  → does NOT block trades, only reduces loss size on failures
```

### Mode 1: TIME DECAY (60–180s left)
- YES ≥ 80¢ + pctAbove ≥ 0.65 → buy UP
- YES ≤ 20¢ + pctAbove ≤ 0.35 → buy DOWN
- Target: 4%, Stop: 2%

### Mode 2: REVERSAL
- yesVelHistory last 4: prior avg ≤ −0.12¢/s, recent avg ≥ +0.06¢/s → UP reversal
- Or prior avg ≥ +0.12¢/s, recent avg ≤ −0.06¢/s → DOWN reversal
- YES must be 15–85¢
- Target: vol-scaled, Stop: vol-scaled

### Mode 3: STRONG CONVICTION (YES 80–95¢ or 5–20¢)
- Fast scalp — market nearly certain
- Target: 3%, Stop: 1.5%

### Mode 4: CONVICTION (YES 70–80¢ or 20–30¢)
- Target: 5% (4% if < 8 min left), Stop: 3%

### Mode 5: ALIGNED
- cycleDelta ≥ 0.02% AND yesVel ≥ 0.05¢/s, both same direction
- Stop: stopBase × 0.8 × stopMultiplier (Gate C)
- If signals conflict → hold, return shouldFarm: false

### Mode 6: MOMENTUM
- YES 30–70¢, |yesVel| ≥ 0.08¢/s
- Target: vol-scaled (CALM=12%, NORMAL=18%, CHOPPY=25%)
- Stop: vol-scaled × stopMultiplier (Gate C)

### Common entry blocks
- secsLeft < 240 (< 4 min) → block (DECAY handles 60–180s separately)
- YES ≤ 3¢ or ≥ 97¢ → spread kills margin
- Liquidity = LOW → block
- 8s re-entry cooldown after last exit
- rounds ≥ FARM_MAX_ROUNDS (10)

---

## Auto-buy bot

Fires when model has significant edge over market-implied probability.

### Regime filter — 11 gates (ALL must pass to fire)

| Gate | Blocks when |
|---|---|
| SPREAD | bid/ask spread > 20¢ |
| DEADZONE | YES 44–56¢ |
| EARLY | < 2 min into window |
| LATE | < 3 min left |
| FLATLINE | BTC velocity < velFloor |
| DAILYCAP | daily loss ≥ 8% of balance (only if balance > $5) |
| COOLDOWN | within 45s of last loss |
| STREAK | 3+ consecutive losses |
| SESSIONKILL | session loss ≥ 5% of balance (only if balance > $5) |
| MKTCOND | LOW liquidity, or LOW+CHOPPY |
| CROWDBLOCK | YES velocity sustained against model for 4 readings at > 0.5¢/s |

### Edge calculation

```
rawEdge = modelProb - marketProb
dynThresh: spread<4¢→6%, <8¢→8%, <12¢→10%, <18¢→13%, else→17%
Momentum boost: velForBet ≥ 0.15¢/s → thresh × 0.70; ≥ 0.08¢/s → thresh × 0.85
Ceiling block: YES > 88¢ for the bet side → blocked (< 12¢ upside remaining)
approved = rawEdge ≥ effectiveThresh AND ev ≥ minEV
```

3-second countdown before firing. Cancels if direction flips during countdown.
60s cooldown after each fire.

---

## Exit manager — 5 triggers (priority order)

1. **Take profit**: unrealizedPnL ≥ maxProfit × 0.60
2. **Stop loss**: unrealizedPnL ≤ −amount × dynamicSL (CALM=15%, NORMAL=12%, CHOPPY=10%)
3. **Velocity reversal**: YES velocity against bet > 0.8¢/s sustained 3 readings + pctCaptured > 5%
4. **Trail stop**: YES pulls back from peak by trailCents (≥75¢→3¢, ≥65¢→4¢, ≥55¢→6¢)
5. **Time floor**: secsLeft≤90→any profit; ≤180→10%+; ≤360→25%+; ≤600→40%+

Farm bot exits use thresholds locked at entry — never recomputed mid-trade.

---

## Neural network

### Architecture: 9 inputs → 8 hidden → 1 output

**Three NNs per asset (ensemble):**
1. **Combined NN** — direction-normalised features (UP + DOWN bets, features flipped for DOWN)
2. **UP-NN** — trained only on UP-bet samples (raw features)
3. **DOWN-NN** — trained only on DOWN-bet samples (raw features)

Ensemble prediction = weighted average by sample count. More samples = more votes.

### Feature vector (9 values)

```
f[0] = (RSI − 50) / 50                        normalised RSI
f[1] = (EMA12 − EMA26) / price × 1000         EMA 12v26 cross
f[2] = (EMA9 − EMA21) / price × 1000          EMA 9v21 cross
f[3] = (price − BB_lower) / BB_range × 2 − 1  Bollinger band position
f[4] = (price − price[−10]) / price × 1000    10-bar momentum
f[5] = (price − price[−5]) / price × 1000     5-bar trend
f[6] = patternScore                            candle pattern (−1 to +1)
f[7] = wickPressure                            buying vs selling pressure
f[8] = candleMomentum                          weighted 5-candle run
```

### buildFeaturesNorm — direction normalisation (critical)

For DOWN bets, multiply ALL 9 features by −1 before storing in the combined NN.
This ensures positive features always mean "conditions favour my bet direction."
Without this, DOWN-bet wins contradict UP-bet wins in the training data → NN accuracy stalls at ~74%.

### Training

- `recordTrade(trade)` called on every close
- Normalised sample → combined NN; raw sample → directional NN (UP or DOWN)
- Balanced buffer: max 150 samples per class (WIN/LOSS) per NN
- Minority class oversampled (60-sample balanced batch, 12 epochs per trade)
- Weighted loss: DOWN misclassifications penalised 2× to counter UP bias

### Persistence

Save after every trade close:
```json
{
  "weights": { "w1": [], "b1": [], "w2": [], "b2": [],
               "w1Up": [], "b1Up": [], "w2Up": [], "b2Up": [],
               "w1Down": [], "b1Down": [], "w2Down": [], "b2Down": [] },
  "data": [...],
  "dataUp": [...],
  "dataDown": [...],
  "at": "ISO_timestamp"
}
```

---

## Risk management constants

```
FARM_REENTRY_WAIT_MS  = 8000       8s cooldown between farm re-entries
FARM_MIN_TIME_LEFT    = 240        block new entries with < 4 min remaining
FARM_MAX_ROUNDS       = 10         max farm trades per 15m window per asset
                                   (signal ceiling is ~7/window — 10 gives buffer)
FARM_TARGET_CALM      = 0.12       12% target in calm markets
FARM_TARGET_NORMAL    = 0.18       18% target in normal markets
FARM_TARGET_CHOPPY    = 0.25       25% target in choppy markets
FARM_STOP_CALM        = 0.06       6% stop in calm markets
FARM_STOP_NORMAL      = 0.09       9% stop in normal markets
FARM_STOP_CHOPPY      = 0.12       12% stop in choppy markets
RISK_DAILY_CAP        = 0.08       halt after 8% daily loss
RISK_SESSION_KILL     = 0.05       halt after 5% session loss
RISK_CONSEC_BRAKE     = 3          halt after 3 consecutive losses
RISK_COOLDOWN_MS      = 45000      45s cooldown after each loss
RISK_TP_ROI           = 0.60       take profit at 60% of max payout
RISK_SL_ROI           = -0.15      stop loss at −15% of stake
KALSHI_MIN_BET        = 0.05       absolute minimum ($0.05)
                                   effective minimum = $0.50 (Tier 1 tiered sizing)
TRAIN_BET_FIXED       = 0.25       fixed bet during NN training mode
```

---

## Bet sizing in practice — what the toast shows

Every trade toast includes the tier that fired:
- `T1 $0.50` — balance below $5
- `T2 $1.00` — balance $5–$50 (most common during development)
- `T3 $X.XX` — balance above $50, Kelly-sized

---

## Liquidity schedule

**BTC HIGH liquidity**: 3–9am ET, 9am–1pm ET, 8pm–midnight ET
**BTC MEDIUM**: 1–3am ET, 1–5pm ET
**BTC LOW (auto-buy blocked)**: 5–8pm ET, midnight–1am ET

ETH is one tier lower than BTC outside US open hours.

---

## 15-minute window mechanics

- Clock: `(UTC_minutes % 15) × 60 + UTC_seconds` → secsLeft = 900 − elapsed
- Window ID: `Math.floor(Date.now() / (15 × 60 × 1000))`
- Farm round counter resets when window ID changes (checked every second)
- Kalshi issues a new contract ticker at each window boundary
- Re-fetch market and reconnect WS to new ticker on window roll
- Poll for new market every 15s (or immediately on WS disconnect)

---

## MCP tools

| Tool | Parameters | Returns |
|---|---|---|
| `get_status` | asset?: 'BTC'\|'ETH' | prices, YES price, active trade, balance, bot states |
| `arm_farm_bot` | asset, armed: bool | confirmation |
| `arm_auto_buy` | asset, armed: bool | confirmation |
| `get_positions` | — | open Kalshi positions |
| `get_trade_history` | asset?, limit? | recent trades with P&L |
| `get_brain_stats` | asset | sample counts, win rates, NN accuracy per tier |
| `place_manual_trade` | asset, bet, amount | order confirmation |
| `close_trade` | — | closes active trade on Kalshi |
| `set_balance` | amount | confirms new balance |
| `export_brain` | asset | brain JSON content |
| `import_brain` | asset, json | loads weights + samples |
| `get_logs` | limit? | recent log entries |

---

## Rules — do not violate

1. **Never skip the RSA-PSS signing** — every Kalshi request must be signed
2. **Contract count for DOWN bets uses NO price** = `amount / (1 - yes_bid)` — not YES price
3. **Price fields must be strings with 4 decimals** — `'0.9900'` not `0.99`
4. **Order requires `type: 'limit'`** — Kalshi rejects without it (silent failure)
5. **`fill_or_kill` only** — `gtc` is not supported on 15M crypto markets
6. **Cancel open order before selling position** — prevents accidentally buying more while exiting
7. **Session kill and daily cap require balance > $5** — prevents false triggers on empty accounts
8. **Farm exit thresholds locked at trade entry** — never recompute mid-trade
9. **`buildFeaturesNorm` for combined NN** — flip all 9 features for DOWN bets, not raw features
10. **Persist brain after every trade** — data lives only in `data/` JSON files
11. **MCP server is always live** — no sim mode. Use `DRY_RUN=true` in `.env` to log orders without sending
12. **Balance > $5 check before session/daily kill** — prevents false triggers on fresh accounts
13. **Use `getTieredBetSize()` for all bet sizing** — never hardcode amounts

---

## Common failure modes (already solved — do not re-introduce)

| Symptom | Root cause | Fix |
|---|---|---|
| All trades go to sim | `authConnected=false` or `kalshiYESPrice=null` at trade time | Check both before placing |
| DOWN bets show +$0.00 P&L | `count = amount / YES price` instead of `amount / NO price` | Use `bet==='DOWN' ? 1−yesPrice : yesPrice` |
| "invalid order parameter" | Missing `type: 'limit'` field | Always include it |
| "invalid parameters TimeInForce" | Sent `gtc` instead of `fill_or_kill` | Always `fill_or_kill` |
| 0 contracts filled silently | `fill_or_kill` + price below market | Send `'0.9900'` as generous limit |
| Bot never fires | `sm.conf` or `sm.prob` used | `computeStrikeModel` returns `aboveProb`/`belowProb` only |
| Session kill fires immediately | `sessionCap = balance × 0.05 = 0` when balance=0 | Guard with `balance > 5` |
| Trades lost on process crash | No graceful shutdown handler | Add `SIGTERM`/`SIGINT` handler to flush open trades to disk |
| API "has been moved" error | Wrong domain | Use `api.elections.kalshi.com` not `trading-api.kalshi.com` |
| NN stuck at ~74% accuracy | DOWN-bet features not flipped → contradicts UP features | `buildFeaturesNorm` flips all 9 features for DOWN bets |

---

## Environment variables

```
KALSHI_KEY_ID=your_key_id_here
KALSHI_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
<load from .env only — never commit the actual key>
-----END RSA PRIVATE KEY-----
DRY_RUN=false    # set true to log orders without sending to Kalshi
```

Private key may have literal `\n` in .env — normalise on load:
```js
process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n')
```

---

## Current training data status (as of Mar 25, 2026)

- **BTC brain v12**: 141 samples (116 wins / 25 losses = 82% win rate)
- **ETH brain**: not yet exported from browser app — export via Brain tab then copy to `data/eth_brain.json`

**Important**: all uploaded brain files (v1–v12) are confirmed BTC-only. There is no mixed ETH data to split out. ETH training data lives in a separate IndexedDB key in the browser and has never been exported.
