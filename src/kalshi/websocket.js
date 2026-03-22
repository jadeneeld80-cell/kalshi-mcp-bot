import WebSocket from 'ws';
import { buildHeaders } from './client.js';

const WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const RECONNECT_DELAY_MS = 3000;

export class KalshiWebSocket {
  constructor(onPrice) {
    this.onPrice = onPrice;  // callback(yesAsk, yesBid, ticker)
    this.ticker = null;
    this.ws = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.cmdSeq = 1;
  }

  connect(ticker) {
    this.ticker = ticker;
    this.intentionalClose = false;
    this._open();
  }

  _open() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const headers = buildHeaders('GET', '/trade-api/ws/v2');
    this.ws = new WebSocket(WS_URL, { headers });

    this.ws.on('open', () => {
      this._subscribe(this.ticker);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', () => {
      if (!this.intentionalClose) this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      if (!this.intentionalClose) this._scheduleReconnect();
    });
  }

  _subscribe(ticker) {
    const msg = {
      id: this.cmdSeq++,
      cmd: 'subscribe',
      params: { channels: ['orderbook_delta'], market_tickers: [ticker] },
    };
    this.ws.send(JSON.stringify(msg));
  }

  _handleMessage(msg) {
    // Orderbook snapshot or delta — extract best ask (yes) and best bid (yes)
    const market = msg?.msg?.market_ticker || msg?.params?.market_ticker;
    const orderbook = msg?.msg?.orderbook || msg?.msg;

    if (!orderbook) return;

    const yesAsks = orderbook.yes?.filter(([p]) => p > 0);
    const yesBids = orderbook.yes?.filter(([p]) => p > 0);

    // Orderbook format: [[price_cents, quantity], ...]
    // Best ask = lowest ask, best bid = highest bid
    const asks = orderbook.yes_ask || (yesAsks?.length ? [...yesAsks].sort((a, b) => a[0] - b[0]) : null);
    const bids = orderbook.yes_bid || (yesBids?.length ? [...yesBids].sort((a, b) => b[0] - a[0]) : null);

    // Kalshi orderbook_delta uses 'yes' array for bids and asks separately
    // The snapshot format: { yes: [[price_cents, qty]...], no: [...] }
    // Price in cents → divide by 100
    let yesAsk = null;
    let yesBid = null;

    if (orderbook.yes_ask !== undefined) {
      yesAsk = orderbook.yes_ask / 100;
      yesBid = orderbook.yes_bid / 100;
    } else if (Array.isArray(orderbook.yes)) {
      // Legacy format
      const sorted = [...orderbook.yes].sort((a, b) => a[0] - b[0]);
      if (sorted.length >= 2) {
        yesBid = sorted[0][0] / 100;
        yesAsk = sorted[sorted.length - 1][0] / 100;
      }
    }

    if (yesAsk !== null && yesBid !== null) {
      this.onPrice(yesAsk, yesBid, market || this.ticker);
    }
  }

  // Call this when the 15-minute window rolls and a new ticker is active
  switchTicker(newTicker) {
    this.ticker = newTicker;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._subscribe(newTicker);
    } else {
      this._open();
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS);
  }

  close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
