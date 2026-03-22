import WebSocket from 'ws';
import { priceFeed } from './binance.js';

const KRAKEN_WS = 'wss://ws.kraken.com/v2';

class KrakenFallback {
  constructor() {
    this.ws = null;
    this.active = false;
    this.reconnectTimer = null;
  }

  activate() {
    if (this.active) return;
    this.active = true;
    console.warn('[Kraken] Binance down — activating fallback feed');
    this._open();
  }

  deactivate() {
    this.active = false;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  _open() {
    this.ws = new WebSocket(KRAKEN_WS);

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'ticker',
          symbol: ['BTC/USD', 'ETH/USD'],
        },
      }));
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel !== 'ticker' || !msg.data?.length) return;
        for (const d of msg.data) {
          const price = d.last;
          if (!price) continue;
          if (d.symbol === 'BTC/USD') priceFeed.injectPrice('BTC', price);
          else if (d.symbol === 'ETH/USD') priceFeed.injectPrice('ETH', price);
        }
      } catch {}
    });

    this.ws.on('close', () => {
      if (this.active) this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      if (this.active) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), 3000);
  }
}

export const krakenFallback = new KrakenFallback();

// Wire the fallback into the Binance feed
priceFeed.onFallback = () => krakenFallback.activate();
