import { priceFeed } from '../prices/binance.js';

// Which feature indices are directional (flipped for DOWN bets in buildFeaturesNorm).
// f[0–8]: all original 9 features are directional.
// f[9]  secsLeft/900: neutral — same for both sides.
// f[10] adx/40: neutral — trend strength is direction-agnostic.
// f[11] pctAbove*2-1: directional — high pctAbove = bullish context.
// f[12] spread/0.10: neutral — spread hurts both sides equally.
const DIRECTIONAL_INDICES = new Set([0,1,2,3,4,5,6,7,8,11]);

// Build raw feature vector from current price indicators.
// ctx (optional): { secsLeft, adx, pctAbove, spread }
//   — adds 4 context-aware features (f[9]–f[12]) to the base 9.
//   If ctx is null/undefined, the 4 new features default to neutral midpoints.
// Returns null if not enough data yet.
export function buildFeatures(asset, ctx = null) {
  const ind = priceFeed.getIndicators(asset);
  if (!ind) return null;

  const { price, rsi, ema9, ema12, ema21, ema26, bb, patternScore, wickPressure, candleMomentum } = ind;
  if (!ema26 || !ema21 || !bb || bb.range === 0) return null;

  const buf = priceFeed.buffer[asset];
  if (buf.length < 11) return null;

  const price10ago = buf[buf.length - 11];
  const price5ago  = buf[buf.length - 6];

  const secsLeft = ctx?.secsLeft ?? 450;
  const adx      = ctx?.adx      ?? null;
  const pctAbove = ctx?.pctAbove ?? 0.5;
  const spread   = ctx?.spread   ?? 0.05;

  return [
    (rsi - 50) / 50,                                    // f[0]  normalised RSI
    (ema12 - ema26) / price * 1000,                     // f[1]  EMA 12v26 cross
    (ema9  - ema21) / price * 1000,                     // f[2]  EMA 9v21 cross
    (price - bb.lower) / bb.range * 2 - 1,              // f[3]  Bollinger position
    (price - price10ago) / price * 1000,                // f[4]  10-bar momentum
    (price - price5ago)  / price * 1000,                // f[5]  5-bar trend
    patternScore,                                       // f[6]  candle pattern
    wickPressure,                                       // f[7]  wick buying pressure
    candleMomentum,                                     // f[8]  weighted 5-candle run
    Math.min(secsLeft, 900) / 900,                      // f[9]  time remaining in window [0,1]
    Math.min((adx ?? 20) / 40, 1.5),                    // f[10] trend strength (ADX/40, capped 1.5)
    pctAbove * 2 - 1,                                   // f[11] above/below ratio [-1,+1] directional
    Math.min(spread / 0.10, 1.5),                       // f[12] bid-ask spread (normalised, capped)
  ];
}

// Direction-normalised features for the combined NN.
// For DOWN bets: flip directional features (indices 0–8 and 11) by multiplying by -1.
// Non-directional features (9, 10, 12) are left unchanged — they're symmetric signals.
// This ensures positive features always mean "conditions favour my bet direction."
export function buildFeaturesNorm(features, bet) {
  if (!features) return null;
  if (bet === 'DOWN') {
    return features.map((v, i) => DIRECTIONAL_INDICES.has(i) ? -v : v);
  }
  return [...features];
}
