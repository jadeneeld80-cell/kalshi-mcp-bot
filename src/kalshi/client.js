import crypto from 'crypto';
import 'dotenv/config';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

function normalizePEM(pem) {
  return pem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
}

function buildHeaders(method, kalshiPath) {
  const keyId = process.env.KALSHI_KEY_ID;
  const privateKey = normalizePEM(process.env.KALSHI_PRIVATE_KEY);

  const ts = Date.now().toString();
  // If the caller passes a path that already starts with /trade-api/ (e.g. the
  // WebSocket endpoint /trade-api/ws/v2), use it verbatim.  Otherwise prepend
  // the REST base prefix so that short paths like /portfolio/balance work.
  const rawPath = kalshiPath.split('?')[0];
  const pathNoQuery = rawPath.startsWith('/trade-api/')
    ? rawPath
    : '/trade-api/v2' + rawPath;
  const message = ts + method.toUpperCase() + pathNoQuery;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  const signature = sign.sign({
    key: privateKey,
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

async function request(method, path, body = null) {
  const headers = buildHeaders(method, path);
  const url = BASE_URL + path;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.error || data?.raw || res.statusText;
    throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${msg}`);
  }

  return data;
}

// Portfolio
export async function getBalance() {
  const data = await request('GET', '/portfolio/balance');
  return data.balance;
}

export async function getPositions() {
  const data = await request('GET', '/portfolio/positions');
  return data.market_positions || [];
}

export async function getFills(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/portfolio/fills' + (qs ? '?' + qs : '');
  const data = await request('GET', path);
  return data.fills || [];
}

export async function getOrders(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/portfolio/orders' + (qs ? '?' + qs : '');
  const data = await request('GET', path);
  return data.orders || [];
}

// Markets
export async function getMarkets(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const path = '/markets' + (qs ? '?' + qs : '');
  const data = await request('GET', path);
  return data.markets || [];
}

export async function getMarket(ticker) {
  const data = await request('GET', `/markets/${ticker}`);
  return data.market;
}

// Find the active 15M market for an asset (BTC or ETH)
export async function findActiveMarket(asset) {
  const series = asset === 'ETH' ? 'KXETH15M' : 'KXBTC15M';
  const markets = await getMarkets({ series_ticker: series, status: 'open' });
  if (!markets.length) throw new Error(`No open ${series} market found`);
  // Filter to markets that haven't closed yet (prevents connecting to an
  // already-expired ticker at window boundaries), then sort by soonest close.
  const now = Date.now();
  const future = markets.filter(m => new Date(m.close_time).getTime() > now);
  if (!future.length) throw new Error(`No future-expiring ${series} market found`);
  future.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  return future[0];
}

// Orders
export async function placeOrder(body) {
  return request('POST', '/portfolio/orders', body);
}

export async function cancelOrder(orderId) {
  return request('DELETE', `/portfolio/orders/${orderId}`);
}

export { buildHeaders, BASE_URL };
