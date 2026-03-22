import { priceFeed } from '../prices/binance.js';

// Build raw feature vector from current price indicators
// Returns null if not enough data yet
export function buildFeatures(asset) {
  const ind = priceFeed.getIndicators(asset);
  if (!ind) return null;

  const { price, rsi, ema9, ema12, ema21, ema26, bb, patternScore, wickPressure, candleMomentum } = ind;
  if (!ema26 || !ema21 || !bb || bb.range === 0) return null;

  const buf = priceFeed.buffer[asset];
  if (buf.length < 11) return null;

  const price10ago = buf[buf.length - 11];
  const price5ago  = buf[buf.length - 6];

  return [
    (rsi - 50) / 50,                                    // f[0] normalised RSI
    (ema12 - ema26) / price * 1000,                     // f[1] EMA 12v26 cross
    (ema9  - ema21) / price * 1000,                     // f[2] EMA 9v21 cross
    (price - bb.lower) / bb.range * 2 - 1,              // f[3] Bollinger position
    (price - price10ago) / price * 1000,                // f[4] 10-bar momentum
    (price - price5ago)  / price * 1000,                // f[5] 5-bar trend
    patternScore,                                       // f[6] candle pattern
    wickPressure,                                       // f[7] wick buying pressure
    candleMomentum,                                     // f[8] weighted 5-candle run
  ];
}

// Direction-normalised features for the combined NN.
// For DOWN bets: flip all 9 features by multiplying by -1.
// This ensures positive features always mean "conditions favour my bet direction."
// Without this flip: DOWN-bet wins with negative features contradict
// UP-bet wins with positive features → NN accuracy stalls at ~50%.
export function buildFeaturesNorm(features, bet) {
  if (!features) return null;
  if (bet === 'DOWN') return features.map(v => -v);
  return [...features];
}
