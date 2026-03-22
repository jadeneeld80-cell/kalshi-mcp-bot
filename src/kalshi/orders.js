import { placeOrder, cancelOrder, getOrders } from './client.js';

// UP bet  → buy YES side  → count = floor(amount / ask_yes_price)
// DOWN bet → buy NO side  → count = floor(amount / (1 - bid_yes_price))
// Getting this wrong makes DOWN P&L show ~$0.00 (was 16x too small before fix)
export function buildBuyBody(ticker, bet, amount, yesAsk, yesBid) {
  const isUp = bet === 'UP';
  const sidePrice = isUp ? yesAsk : (1 - yesBid);
  const count = Math.floor(amount / sidePrice);

  if (count < 1) throw new Error(`Budget too low: $${amount.toFixed(2)} only buys ${count} contracts at ${sidePrice.toFixed(4)}`);

  const body = {
    ticker,
    client_order_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    side: isUp ? 'yes' : 'no',
    action: 'buy',
    type: 'limit',                          // REQUIRED — Kalshi rejects without this
    count,
    time_in_force: 'fill_or_kill',          // gtc not supported on 15M crypto markets
    buy_max_cost: Math.round(amount * 100), // cents, integer
  };

  // Price fields must be strings with 4 decimals
  if (isUp) {
    body.yes_price_dollars = '0.9900';      // generous limit — gets best available fill
  } else {
    body.no_price_dollars = '0.9900';
  }

  return body;
}

export function buildSellBody(ticker, side, contractsHeld) {
  const count = Math.floor(contractsHeld);
  if (count < 1) throw new Error(`Invalid contractsToSell: ${contractsHeld}`);

  const body = {
    ticker,
    client_order_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    side,
    action: 'sell',
    type: 'limit',
    count,
    time_in_force: 'fill_or_kill',
  };

  // Minimum acceptable sell price — take whatever the market gives
  if (side === 'yes') {
    body.yes_price_dollars = '0.0100';
  } else {
    body.no_price_dollars = '0.0100';
  }

  return body;
}

export async function executeBuy(ticker, bet, amount, yesAsk, yesBid) {
  const body = buildBuyBody(ticker, bet, amount, yesAsk, yesBid);
  const result = await placeOrder(body);
  return { body, result };
}

// Cancel any open orders for a ticker before selling to avoid double-buying
export async function cancelOpenOrders(ticker) {
  const orders = await getOrders({ ticker, status: 'resting' });
  for (const order of orders) {
    try {
      await cancelOrder(order.order_id);
    } catch {
      // Best-effort
    }
  }
}

export async function executeSell(ticker, side, contractsHeld) {
  await cancelOpenOrders(ticker);
  const body = buildSellBody(ticker, side, contractsHeld);
  const result = await placeOrder(body);
  return { body, result };
}
