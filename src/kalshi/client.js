import crypto from 'crypto';
import 'dotenv/config';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

/**
 * Normalize a PEM private key.
 */
function normalizePEM(pem) {
  if (!pem) {
    throw new Error(
      'KALSHI_PRIVATE_KEY is missing. Private Kalshi endpoints require authentication.'
    );
  }

  return pem
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');
}

/**
 * Build authenticated Kalshi request headers.
 *
 * Only used for PRIVATE endpoints such as:
 * - portfolio
 * - orders
 * - fills
 */
function buildHeaders(method, kalshiPath) {
  const keyId = process.env.KALSHI_KEY_ID;
  const privateKeyRaw = process.env.KALSHI_PRIVATE_KEY;

  if (!keyId) {
    throw new Error(
      'KALSHI_KEY_ID is missing. Private Kalshi endpoints require authentication.'
    );
  }

  const privateKey = normalizePEM(privateKeyRaw);

  const ts = Date.now().toString();

  const rawPath = kalshiPath.split('?')[0];

  const pathNoQuery = rawPath.startsWith('/trade-api/')
    ? rawPath
    : '/trade-api/v2' + rawPath;

  const message =
    ts +
    method.toUpperCase() +
    pathNoQuery;

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

/**
 * Kalshi request helper.
 *
 * auth = false:
 *   Public endpoint.
 *   No Kalshi key/private key required.
 *
 * auth = true:
 *   Private endpoint.
 *   Signed authentication required.
 */
async function request(
  method,
  path,
  body = null,
  auth = true
) {
  const headers = auth
    ? buildHeaders(method, path)
    : {
        'Content-Type': 'application/json',
      };

  const url = BASE_URL + path;

  const opts = {
    method,
    headers,
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(
    url,
    opts
  );

  const text =
    await res.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!res.ok) {
    const raw =
      typeof data?.error === 'object'
        ? JSON.stringify(
            data.error
          )
        : (
            data?.error ||
            data?.raw ||
            res.statusText
          );

    throw new Error(
      `Kalshi ${method} ${path} → ${res.status}: ${raw}`
    );
  }

  return data;
}


// ============================================================
// PRIVATE PORTFOLIO ENDPOINTS
// ============================================================

export async function getBalance() {
  const data =
    await request(
      'GET',
      '/portfolio/balance',
      null,
      true
    );

  return data.balance;
}

export async function getPositions() {
  const data =
    await request(
      'GET',
      '/portfolio/positions',
      null,
      true
    );

  return (
    data.market_positions ||
    []
  );
}

export async function getFills(
  params = {}
) {
  const qs =
    new URLSearchParams(
      params
    ).toString();

  const path =
    '/portfolio/fills' +
    (
      qs
        ? '?' + qs
        : ''
    );

  const data =
    await request(
      'GET',
      path,
      null,
      true
    );

  return data.fills || [];
}

export async function getOrders(
  params = {}
) {
  const qs =
    new URLSearchParams(
      params
    ).toString();

  const path =
    '/portfolio/orders' +
    (
      qs
        ? '?' + qs
        : ''
    );

  const data =
    await request(
      'GET',
      path,
      null,
      true
    );

  return data.orders || [];
}


// ============================================================
// PUBLIC MARKET ENDPOINTS
// ============================================================
//
// These do NOT require:
// KALSHI_KEY_ID
// KALSHI_PRIVATE_KEY
//
// This allows SIM / paper mode to use REAL Kalshi market prices
// without providing live account credentials.
// ============================================================

export async function getMarkets(
  params = {}
) {
  const qs =
    new URLSearchParams(
      params
    ).toString();

  const path =
    '/markets' +
    (
      qs
        ? '?' + qs
        : ''
    );

  const data =
    await request(
      'GET',
      path,
      null,
      false
    );

  return data.markets || [];
}

export async function getMarket(
  ticker
) {
  const data =
    await request(
      'GET',
      `/markets/${ticker}`,
      null,
      false
    );

  return data.market;
}


// ============================================================
// FIND ACTIVE BTC / ETH 15-MINUTE MARKET
// ============================================================

export async function findActiveMarket(
  asset
) {
  const series =
    asset === 'ETH'
      ? 'KXETH15M'
      : 'KXBTC15M';

  const markets =
    await getMarkets({
      series_ticker:
        series,
      status:
        'open',
    });

  if (!markets.length) {
    throw new Error(
      `No open ${series} market found`
    );
  }

  const now =
    Date.now();

  // Current 15-minute window closes at next
  // UTC 15-minute boundary.
  const WINDOW_MS =
    15 *
    60 *
    1000;

  const targetCloseMs =
    (
      Math.floor(
        now /
        WINDOW_MS
      ) +
      1
    ) *
    WINDOW_MS;

  // Allow slight delay / clock differences.
  const TOLERANCE_MS =
    90_000;

  const matching =
    markets.filter(
      (m) => {
        const ct =
          new Date(
            m.close_time
          ).getTime();

        return (
          Math.abs(
            ct -
            targetCloseMs
          ) <=
          TOLERANCE_MS
        );
      }
    );

  if (
    matching.length >
    0
  ) {
    matching.sort(
      (a, b) =>
        new Date(
          a.close_time
        ).getTime() -
        new Date(
          b.close_time
        ).getTime()
    );

    return matching[0];
  }

  // Fallback:
  // pick closest open future market.
  const future =
    markets.filter(
      (m) =>
        new Date(
          m.close_time
        ).getTime() >
        now
    );

  if (!future.length) {
    throw new Error(
      `No future-expiring ${series} market found`
    );
  }

  future.sort(
    (a, b) =>
      new Date(
        a.close_time
      ).getTime() -
      new Date(
        b.close_time
      ).getTime()
  );

  return future[0];
}


// ============================================================
// ORDERS
// ============================================================

export async function placeOrder(
  body
) {
  /**
   * HARD PAPER-TRADING SAFETY SWITCH
   *
   * When Railway has:
   *
   * DRY_RUN=true
   *
   * no actual Kalshi POST order request is sent.
   */
  if (
    process.env.DRY_RUN ===
    'true'
  ) {
    let sidePrice =
      0;

    if (
      body.yes_price_dollars != null
    ) {
      sidePrice =
        parseFloat(
          body.yes_price_dollars
        );
    } else if (
      body.no_price_dollars != null
    ) {
      sidePrice =
        1 -
        parseFloat(
          body.no_price_dollars
        );
    }

    console.log(
      `[DryRun] ${body.action
        .toUpperCase()} ${body.side
        .toUpperCase()} ×${body.count} ${body.ticker} @ ${sidePrice.toFixed(4)}`
    );

    return {
      order: {
        order_id:
          'sim_' +
          Date.now().toString(
            36
          ),

        status:
          'executed',

        remaining_count:
          0,

        action:
          body.action,

        side:
          body.side,

        count:
          body.count,

        ticker:
          body.ticker,

        simulated:
          true,
      },
    };
  }

  /**
   * LIVE ORDER PATH
   *
   * This only executes when DRY_RUN is NOT true.
   * It requires valid Kalshi credentials.
   */
  return request(
    'POST',
    '/portfolio/orders',
    body,
    true
  );
}


export async function cancelOrder(
  orderId
) {
  if (
    process.env.DRY_RUN ===
    'true'
  ) {
    console.log(
      `[DryRun] Cancel simulated order ${orderId}`
    );

    return {
      simulated:
        true,
      cancelled:
        true,
      order_id:
        orderId,
    };
  }

  return request(
    'DELETE',
    `/portfolio/orders/${orderId}`,
    null,
    true
  );
}


// ============================================================
// EXPORTS
// ============================================================

export {
  buildHeaders,
  BASE_URL,
}; 
