import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { state } from '../engine/state.js';
import { persistBotState } from '../engine/botStateStore.js';
import { executeBuy, executeSell, cancelOpenOrders } from '../kalshi/orders.js';
import { getPositions, getFills } from '../kalshi/client.js';
import { brainStats, importBrain, exportBrain } from '../nn/store.js';
import { computeUnrealizedPnL } from '../engine/exitManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_LOG  = path.join(__dirname, '../../logs/trades.json');

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_status',
    description: 'Current prices, YES bid/ask, active trade, balance, and bot arm states for BTC and/or ETH.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH'], description: 'Omit for both assets' },
      },
    },
  },
  {
    name: 'arm_farm_bot',
    description: 'Arm or disarm the farm bot for an asset.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'armed'],
      properties: {
        asset:  { type: 'string', enum: ['BTC', 'ETH'] },
        armed:  { type: 'boolean' },
      },
    },
  },
  {
    name: 'arm_auto_buy',
    description: 'Arm or disarm the auto-buy bot for an asset.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'armed'],
      properties: {
        asset:  { type: 'string', enum: ['BTC', 'ETH'] },
        armed:  { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_positions',
    description: 'Fetch all open Kalshi positions from the API.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trade_history',
    description: 'Recent trades with P&L from the local trade log.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH'] },
        limit: { type: 'number', description: 'Max trades to return (default 20)' },
      },
    },
  },
  {
    name: 'get_brain_stats',
    description: 'NN sample counts and win rates for an asset.',
    inputSchema: {
      type: 'object',
      required: ['asset'],
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH'] } },
    },
  },
  {
    name: 'place_manual_trade',
    description: 'Place a manual trade on Kalshi.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'bet', 'amount'],
      properties: {
        asset:  { type: 'string', enum: ['BTC', 'ETH'] },
        bet:    { type: 'string', enum: ['UP', 'DOWN'] },
        amount: { type: 'number', description: 'Dollar amount to bet' },
      },
    },
  },
  {
    name: 'close_trade',
    description: 'Close the active trade for an asset by selling all contracts.',
    inputSchema: {
      type: 'object',
      required: ['asset'],
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH'] } },
    },
  },
  {
    name: 'set_balance',
    description: 'Manually update the tracked balance (useful after deposits).',
    inputSchema: {
      type: 'object',
      required: ['amount'],
      properties: { amount: { type: 'number', description: 'New balance in dollars' } },
    },
  },
  {
    name: 'export_brain',
    description: 'Export the NN brain JSON for an asset (weights + training data).',
    inputSchema: {
      type: 'object',
      required: ['asset'],
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH'] } },
    },
  },
  {
    name: 'import_brain',
    description: 'Import a brain JSON (e.g. exported from the browser app) for an asset.',
    inputSchema: {
      type: 'object',
      required: ['asset', 'json'],
      properties: {
        asset: { type: 'string', enum: ['BTC', 'ETH'] },
        json:  { type: 'string', description: 'Brain JSON string' },
      },
    },
  },
  {
    name: 'get_logs',
    description: 'Recent entries from the trade log.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of entries to return (default 20)' },
      },
    },
  },
  {
    name: 'reset_risk',
    description: 'Reset consecutive loss counter and cooldown for an asset (use after manual review).',
    inputSchema: {
      type: 'object',
      required: ['asset'],
      properties: { asset: { type: 'string', enum: ['BTC', 'ETH'] } },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function assetStatus(asset) {
  const s = state[asset];
  const trade = s.activeTrade;
  let tradeInfo = null;

  if (trade) {
    const pnl = (s.yesAsk !== null)
      ? computeUnrealizedPnL(trade, s.yesAsk, s.yesBid)
      : null;
    tradeInfo = {
      bet:      trade.bet,
      mode:     trade.mode,
      amount:   trade.amount.toFixed(2),
      count:    trade.count,
      entryYes: trade.entryYes?.toFixed(4),
      pnl:      pnl !== null ? pnl.toFixed(3) : 'n/a',
      pctCapture: (pnl !== null && trade.maxProfit > 0)
        ? ((pnl / trade.maxProfit) * 100).toFixed(1) + '%'
        : 'n/a',
      openSecs: Math.round((Date.now() - trade.startedAt) / 1000),
    };
  }

  return {
    asset,
    price:       s.yesAsk !== null ? ((s.yesAsk + s.yesBid) / 2).toFixed(4) : null,
    yesAsk:      s.yesAsk?.toFixed(4)  ?? null,
    yesBid:      s.yesBid?.toFixed(4)  ?? null,
    yesVel:      s.yesVel?.toFixed(3)  ?? null,
    ticker:      s.ticker,
    secsLeft:    s.secsLeft,
    liquidity:   s.liquidity,
    regime:      s.regime ?? 'NORMAL',
    farmArmed:   s.farmArmed,
    autoBuyArmed: s.autoBuyArmed,
    farmRounds:  s.farmRounds,
    activeTrade: tradeInfo,
    risk: {
      consecutiveLosses: s.consecutiveLosses,
      sessionPnL: s.sessionPnL?.toFixed(2),
      dailyPnL:   s.dailyPnL?.toFixed(2),
      totalPnL:   s.totalPnL?.toFixed(2),
      tradeCount: s.tradeCount,
    },
  };
}

async function handleTool(name, args) {
  switch (name) {

    case 'get_status': {
      const assets = args.asset ? [args.asset] : ['BTC', 'ETH'];
      const result = {
        balance:  state.balance?.toFixed(2) ?? 'unknown',
        assets:   Object.fromEntries(assets.map(a => [a, assetStatus(a)])),
      };
      return ok(result);
    }

    case 'arm_farm_bot': {
      const s = state[args.asset];
      s.farmArmed = args.armed;
      if (args.armed) s.autoBuyArmed = false; // mutual exclusion
      persistBotState();
      return ok(`Farm bot ${args.armed ? 'ARMED' : 'DISARMED'} for ${args.asset}`);
    }

    case 'arm_auto_buy': {
      const s = state[args.asset];
      s.autoBuyArmed = args.armed;
      if (args.armed) s.farmArmed = false;
      persistBotState();
      return ok(`Auto-buy ${args.armed ? 'ARMED' : 'DISARMED'} for ${args.asset}`);
    }

    case 'get_positions': {
      const positions = await getPositions();
      return ok(positions);
    }

    case 'get_trade_history': {
      let logs = [];
      try { logs = JSON.parse(fs.readFileSync(TRADES_LOG, 'utf8')); } catch {}
      if (args.asset) logs = logs.filter(t => t.asset === args.asset);
      const limit = args.limit ?? 20;
      return ok(logs.slice(-limit));
    }

    case 'get_brain_stats': {
      const s = state[args.asset];
      if (!s.brain) return ok({ error: `No brain loaded for ${args.asset}` });
      return ok(brainStats(s.brain, args.asset));
    }

    case 'place_manual_trade': {
      const { asset, bet, amount } = args;
      const s = state[asset];
      if (!s.ticker)    return err('No active market ticker');
      if (!s.yesAsk)    return err('No YES price available');
      if (s.activeTrade) return err('Trade already active — close it first');
      const { result } = await executeBuy(s.ticker, bet, amount, s.yesAsk, s.yesBid);
      const sidePrice = bet === 'UP' ? s.yesAsk : (1 - s.yesBid);
      const filled = Math.floor(amount / sidePrice);
      s.activeTrade = {
        ticker: s.ticker, bet,
        side: bet === 'UP' ? 'yes' : 'no',
        amount, count: filled,
        entryYes: (s.yesAsk + s.yesBid) / 2,
        maxProfit: filled * 1.00 - amount,
        startedAt: Date.now(),
        mode: 'MANUAL',
      };
      return ok({ message: `Placed ${bet} $${amount}`, order: result?.order });
    }

    case 'close_trade': {
      const s = state[args.asset];
      if (!s.activeTrade) return err('No active trade to close');
      const trade = s.activeTrade;
      await executeSell(trade.ticker, trade.side, trade.count);
      const pnl = computeUnrealizedPnL(trade, s.yesAsk, s.yesBid);
      s.activeTrade = null;
      return ok({ message: 'Trade closed', estimatedPnL: pnl.toFixed(3) });
    }

    case 'set_balance': {
      state.balance = args.amount;
      return ok(`Balance set to $${args.amount.toFixed(2)}`);
    }

    case 'export_brain': {
      const brain = exportBrain(args.asset);
      return ok(brain);
    }

    case 'import_brain': {
      importBrain(args.asset, args.json);
      // Reload into live state
      const { loadBrain } = await import('../nn/store.js');
      state[args.asset].brain = await loadBrain(args.asset);
      const stats = brainStats(state[args.asset].brain, args.asset);
      return ok({ message: `Brain imported for ${args.asset}`, stats });
    }

    case 'get_logs': {
      let logs = [];
      try { logs = JSON.parse(fs.readFileSync(TRADES_LOG, 'utf8')); } catch {}
      return ok(logs.slice(-(args.limit ?? 20)));
    }

    case 'reset_risk': {
      const s = state[args.asset];
      s.consecutiveLosses = 0;
      s.lastLossTime = 0;
      return ok(`Risk counters reset for ${args.asset}`);
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function err(msg) {
  return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
}

// ── Server startup ────────────────────────────────────────────────────────────

export async function startMCPServer() {
  const server = new Server(
    { name: 'kalshi-mcp-bot', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await handleTool(name, args ?? {});
    } catch (e) {
      return err(e.message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[MCP] Server ready\n');
}
