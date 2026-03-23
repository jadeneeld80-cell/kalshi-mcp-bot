import { MCPTestClient, sleep } from './tests/helpers/mcp-client.js';
import 'dotenv/config';

const client = new MCPTestClient();
await client.start();

const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  const res = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
  if (res.assets.BTC.ticker) break;
  await sleep(1000);
}

const arm = await client.callTool('arm_farm_bot', { asset: 'BTC', armed: true });
console.log(client.parseResult(arm));

while (true) {
  const status = client.parseResult(await client.callTool('get_status', { asset: 'BTC' }));
  const btc = status.assets.BTC;

  if (btc.activeTrade) {
    const t = btc.activeTrade;
    console.log(`[${new Date().toISOString().slice(11,19)}] TRADE ACTIVE | ${t.bet} ${t.mode} $${t.amount} pnl=${t.pnl} capture=${t.pctCapture} secsLeft=${btc.secsLeft}`);
  } else {
    const reason = !btc.yesAsk           ? 'NO_PRICE'
                 : btc.liquidity==='LOW'  ? 'LOW_LIQ'
                 : btc.secsLeft < 240 && !(btc.secsLeft>=60 && btc.secsLeft<=180) ? 'TOO_LATE'
                 : 'SCANNING';
    console.log(`[${new Date().toISOString().slice(11,19)}] ${reason} | YES=${btc.yesAsk} secs=${btc.secsLeft} liq=${btc.liquidity} regime=${btc.regime} farmArmed=${btc.farmArmed}`);
  }

  await sleep(10000);
}
