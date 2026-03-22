import WebSocket from 'ws';
import { computeEMA, computeRSI, computeBollinger, buildCandles,
         patternScore, wickPressure, candleMomentum, computeRegime } from './indicators.js';

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const SAMPLE_INTERVAL_MS = 1000; // 1-second samples for indicator history
const BUFFER_SIZE = 200;          // 200 seconds of history

class BinanceFeed {
  constructor() {
    this.lastPrice = { BTC: null, ETH: null };
    this.buffer = { BTC: [], ETH: [] };
    this.ws = null;
    this.sampleTimer = null;
    this.reconnectTimer = null;
    this.connected = false;
    this.onFallback = null; // called when Binance drops, so Kraken can take over
  }

  connect() {
    this._open();
    this.sampleTimer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
  }

  _open() {
    const streams = 'btcusdt@aggTrade/ethusdt@aggTrade';
    this.ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);

    this.ws.on('open', () => { this.connected = true; });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const price = parseFloat(msg.data?.p);
        if (!price) return;
        if (msg.stream === 'btcusdt@aggTrade') this.lastPrice.BTC = price;
        else if (msg.stream === 'ethusdt@aggTrade') this.lastPrice.ETH = price;
      } catch {}
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.onFallback?.();
      this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      this.connected = false;
      this.onFallback?.();
      this._scheduleReconnect();
    });
  }

  _sample() {
    for (const asset of ['BTC', 'ETH']) {
      if (this.lastPrice[asset] !== null) {
        this.buffer[asset].push(this.lastPrice[asset]);
        if (this.buffer[asset].length > BUFFER_SIZE) this.buffer[asset].shift();
      }
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), 3000);
  }

  // Inject a price from Kraken when Binance is down
  injectPrice(asset, price) {
    this.lastPrice[asset] = price;
  }

  getPrice(asset) { return this.lastPrice[asset]; }

  getVelocity(asset, seconds = 5) {
    const buf = this.buffer[asset];
    if (buf.length < seconds + 1) return 0;
    const cur = buf[buf.length - 1];
    const past = buf[buf.length - 1 - seconds];
    return (cur - past) / past * 100; // % change
  }

  getWindowDrift(asset, windowOpenPrice) {
    const cur = this.lastPrice[asset];
    if (!cur || !windowOpenPrice) return 0;
    return (cur - windowOpenPrice) / windowOpenPrice * 100; // % since window opened
  }

  getIndicators(asset) {
    const prices = this.buffer[asset];
    if (prices.length < 27) return null; // need at least 27 for EMA26

    const price = prices[prices.length - 1];
    const rsi = computeRSI(prices);
    const ema9  = computeEMA(prices, 9);
    const ema12 = computeEMA(prices, 12);
    const ema21 = computeEMA(prices, 21);
    const ema26 = computeEMA(prices, 26);
    const bb = computeBollinger(prices);
    const candles = buildCandles(prices, 5);

    return {
      price,
      rsi,
      ema9, ema12, ema21, ema26,
      bb,
      candles,
      regime: computeRegime(prices),
      patternScore: patternScore(candles),
      wickPressure: wickPressure(candles),
      candleMomentum: candleMomentum(candles),
    };
  }

  getRegime(asset) {
    return computeRegime(this.buffer[asset]);
  }

  isReady(asset) {
    return this.buffer[asset].length >= 27;
  }

  close() {
    clearInterval(this.sampleTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const priceFeed = new BinanceFeed();
