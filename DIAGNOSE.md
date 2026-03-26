# Diagnostic task — MCP server not making profitable trades

## Symptoms
Bot is running but not making trades, or making trades that exit immediately at a loss.

## Step 1 — Add a decision log to every tick

In `engine/clock.js` (or wherever the 1-second tick runs), add a structured log
every tick that dumps the full decision state to `logs/decisions.jsonl`:

```js
// Log every second — run for 5 minutes then stop
fs.appendFileSync('logs/decisions.jsonl', JSON.stringify({
  ts: Date.now(),
  asset: 'BTC',
  yesPrice: state.kalshiYESPrice,
  yesVel: state.yesVel,
  yesVelHistory: state.yesVelHistory,
  cycleDelta: state.cycleDelta,
  priceCount: state.prices.length,
  secsLeft: getClock().secsLeft,
  farmArmed: state.farmArmed,
  active: !!state.active,
  farmDecision: computeFarmDecision(),   // full object including reason
  regimeResult: computeRegimeFilter(),   // full object including which gate blocked
  liquidity: getLiquidityRating(),
  volatility: getVolatilityRating(),
  nnOut: nnEnsemblePredict(),            // raw NN output 0-1
}) + '\n');
```

## Step 2 — Analyse the decision log

After 5 minutes of logging, run this analysis:

```js
const lines = fs.readFileSync('logs/decisions.jsonl','utf8')
  .split('\n').filter(Boolean).map(JSON.parse);

// Farm bot: why is it not firing?
const farmReasons = {};
lines.forEach(l => {
  const reason = l.farmDecision?.reason || 'unknown';
  farmReasons[reason] = (farmReasons[reason] || 0) + 1;
});
console.log('Farm bot block reasons:');
Object.entries(farmReasons).sort((a,b)=>b[1]-a[1])
  .forEach(([r,n]) => console.log(`  ${n}x ${r}`));

// Regime filter: which gate fires most?
const regimeBlocks = {};
lines.filter(l => l.regimeResult?.blocked).forEach(l => {
  const gate = l.regimeResult?.code || 'unknown';
  regimeBlocks[gate] = (regimeBlocks[gate] || 0) + 1;
});
console.log('\nRegime filter blocks:');
Object.entries(regimeBlocks).sort((a,b)=>b[1]-a[1])
  .forEach(([g,n]) => console.log(`  ${n}x ${g}`));

// YES price availability
const noYES = lines.filter(l => l.yesPrice === null).length;
console.log(`\nTicks with null YES price: ${noYES}/${lines.length} (${(noYES/lines.length*100).toFixed(0)}%)`);

// Velocity history depth
const velDepths = lines.map(l => l.yesVelHistory?.length || 0);
const avgDepth = velDepths.reduce((a,b)=>a+b,0)/velDepths.length;
console.log(`Avg yesVelHistory depth: ${avgDepth.toFixed(1)} (need ≥4 for REVERSAL, ≥3 for vel exit)`);

// Price buffer depth
const priceCounts = lines.map(l => l.priceCount || 0);
const avgPrices = priceCounts.reduce((a,b)=>a+b,0)/priceCounts.length;
console.log(`Avg price buffer depth: ${avgPrices.toFixed(0)} (need ≥26 for EMA26, ≥15 for features)`);

// NN output distribution
const nnOuts = lines.map(l => l.nnOut).filter(v => v !== null);
const allHalf = nnOuts.filter(v => Math.abs(v-0.5) < 0.02).length;
console.log(`NN outputs near 0.5: ${allHalf}/${nnOuts.length} — if >80% the brain didn't load`);

// Cycledelta vs yesVel divergence gate firing rate
const divBlocks = lines.filter(l => {
  const cd = l.cycleDelta; const vel = l.yesVel;
  return Math.abs(cd) > 0.6 && Math.abs(vel) > 0.8 && Math.sign(cd) !== Math.sign(vel);
}).length;
console.log(`Gate A (divergence) would block: ${divBlocks}/${lines.length} ticks (${(divBlocks/lines.length*100).toFixed(0)}%)`);
// If this is >20% the gate is too aggressive for the new environment
```

## Step 3 — Check each suspected cause

### Check A: Is yesVelHistory building correctly?
The velocity buffer needs real YES price ticks from the Kalshi WebSocket.
If the WS is connecting but not receiving ticks, history stays empty.
```js
// Add to websocket.js onmessage handler:
console.log('[WS tick]', Date.now(), 'YES:', yesPrice, 'history depth:', yesVelHistory.length);
```

### Check B: Is cycleDelta being calculated correctly?
cycleDelta = (currentBTCPrice - windowOpenPrice) / windowOpenPrice * 100
The window open price must be set at the START of each 15m window (when secsLeft resets to ~900).
If cycleOpenPrice is never set, cycleDelta is always 0 → ALIGNED mode never fires,
Gate A never fires (which is fine), but MOMENTUM and ALIGNED are blocked.
```js
console.log('[cycle] openPrice:', cycleOpenPrice, 'current:', btcPrice, 'delta:', cycleDelta.toFixed(4)+'%');
```

### Check C: Is the brain loading?
```js
const brain = JSON.parse(fs.readFileSync('data/btc_brain.json'));
console.log('BTC brain samples:', brain.data?.length);
console.log('Weights w1 rows:', brain.weights?.w1?.length);  // should be 8
console.log('Weights w1 cols:', brain.weights?.w1?.[0]?.length);  // should be 9
```

### Check D: Is the liquidity gate correct?
The liquidity schedule uses ET (Eastern Time = UTC-4 or UTC-5).
If the server timezone is wrong, liquidity is always LOW.
```js
const utcH = new Date().getUTCHours();
const etH = (utcH - 4 + 24) % 24; // EDT offset
console.log('UTC hour:', utcH, 'ET hour:', etH, 'liquidity:', getLiquidityRating());
```

### Check E: Is the price buffer deep enough?
Features need at least 26 candles for EMA26. The app uses 1-second ticks aggregated
into synthetic candles. If buildCandles() needs 15 ticks per candle, you need
26 × 15 = 390 seconds of price data before features work.
```js
console.log('Price buffer depth:', prices.length, '— need ≥ 26 for features');
console.log('Features result:', buildFeatures(prices, 'UP', strikePrice));
// If null → buffer not deep enough yet
```

## Step 4 — Quick fixes based on findings

| Finding | Fix |
|---|---|
| Farm reason = "No YES price" >50% | WS not receiving ticks — check subscription ticker matches current market |
| Farm reason = "Low liquidity" always | Liquidity schedule timezone offset wrong — check UTC vs ET conversion |
| Farm reason = "<4 min left" always | Clock calculation wrong — secsLeft = 900 - ((utcMin%15)*60 + utcSec) |
| Regime gate = FLATLINE always | velFloor too high, or prices not updating fast enough |
| Regime gate = CROWDBLOCK always | yesVelHistory building with wrong sign convention |
| Regime gate = DEADZONE >50% | YES price stuck near 50¢ — market is genuinely flat, wait |
| Gate A blocks >20% | cycleDelta scale wrong — check it's in % not decimal |
| NN output always ~0.5 | Brain file not loading — copy btc_brain.json to data/ folder |
| Price buffer < 26 | Wait longer after startup, or seed with historical candles on init |
| Features return null | Price buffer not deep enough, or strike price is 0 |

## Step 5 — Simplification option (if all else fails)

If the diagnostic shows the signal gates are blocking too aggressively,
temporarily disable Gate A and Gate B and set stopMultiplier = 1.0:

```js
// In farmBot.js — comment these out temporarily:
// if(isMomDivergence && !training) return { shouldFarm: false, reason: '⚠ Divergence...' }
// Gate B check

// Set stopMultiplier to 1.0 always (disable Gate C tightening):
const stopMultiplier = 1.0;
```

Run for 30 minutes and check if trades fire. If they do, the gates need recalibration
for the server environment — the thresholds (0.6% drift, 0.8¢/s velocity) may need
to be raised since server-side tick rates differ from browser WebSocket timing.
