import { getBalance, findActiveMarket } from './client.js';

console.log('Testing Kalshi auth...');

try {
  const balance = await getBalance();
  console.log(`✓ Balance: $${(balance / 100).toFixed(2)}`);

  const btcMarket = await findActiveMarket('BTC');
  console.log(`✓ BTC market: ${btcMarket.ticker} (closes ${btcMarket.close_time})`);

  const ethMarket = await findActiveMarket('ETH');
  console.log(`✓ ETH market: ${ethMarket.ticker} (closes ${ethMarket.close_time})`);

  console.log('\nAuth OK — ready to trade.');
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
