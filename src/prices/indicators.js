// Pure indicator functions — all take a prices array (oldest → newest)

export function computeEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function computeRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = prices.length - period;
  for (let i = start; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function computeBollinger(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + 2 * std, lower: mean - 2 * std, middle: mean, range: 4 * std };
}

// Build pseudo-candles from raw price samples (groups of `size`)
export function buildCandles(prices, size = 5) {
  const candles = [];
  for (let i = 0; i + size <= prices.length; i += size) {
    const slice = prices.slice(i, i + size);
    candles.push({
      open: slice[0],
      close: slice[slice.length - 1],
      high: Math.max(...slice),
      low: Math.min(...slice),
    });
  }
  return candles;
}

// f[6]: candle pattern score (−1 to +1)
// Looks at last 5 candles for bullish/bearish patterns
export function patternScore(candles) {
  if (candles.length < 2) return 0;
  const last = candles.slice(-5);
  let score = 0;
  for (const c of last) {
    const body = c.close - c.open;
    const range = c.high - c.low || 1;
    score += body / range; // positive = bullish candle
  }
  return Math.max(-1, Math.min(1, score / last.length));
}

// f[7]: wick pressure — buying pressure at the bottom of wicks (−1 to +1)
export function wickPressure(candles) {
  if (candles.length < 1) return 0;
  const last = candles.slice(-5);
  let total = 0;
  for (const c of last) {
    const range = c.high - c.low || 1;
    const buyPressure = (c.close - c.low) / range; // 0 to 1
    total += buyPressure * 2 - 1; // normalize to −1 to +1
  }
  return Math.max(-1, Math.min(1, total / last.length));
}

// f[8]: candle momentum — weighted sum of last 5 candle returns (recent = higher weight)
export function candleMomentum(candles) {
  if (candles.length < 2) return 0;
  const last = candles.slice(-5);
  const weights = [0.1, 0.15, 0.2, 0.25, 0.3];
  let momentum = 0;
  let wTotal = 0;
  for (let i = 0; i < last.length; i++) {
    const ret = (last[i].close - last[i].open) / last[i].open;
    const w = weights[weights.length - last.length + i] ?? 0.2;
    momentum += ret * w;
    wTotal += w;
  }
  return wTotal > 0 ? Math.max(-1, Math.min(1, momentum / wTotal * 100)) : 0;
}

// Market regime from recent price volatility
export function computeRegime(prices, window = 30) {
  if (prices.length < window) return 'NORMAL';
  const slice = prices.slice(-window);
  const mean = slice.reduce((a, b) => a + b) / window;
  const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / window;
  const cv = Math.sqrt(variance) / mean; // coefficient of variation

  if (cv < 0.0003) return 'CALM';
  if (cv > 0.001) return 'CHOPPY';
  return 'NORMAL';
}
