import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { state } from '../engine/state.js';
import { computeUnrealizedPnL } from '../engine/exitManager.js';

export function startTerminal() {
  const screen = blessed.screen({ smartCSR: true, title: 'Kalshi MCP Bot' });

  // ── Layout ─────────────────────────────────────────────────────────────────
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // Header bar
  const header = grid.set(0, 0, 1, 12, blessed.box, {
    tags: true,
    style: { fg: 'white', bg: 'blue' },
  });

  // BTC panel
  const btcBox = grid.set(1, 0, 5, 6, blessed.box, {
    label: ' BTC ',
    border: { type: 'line' },
    tags: true,
    style: { border: { fg: 'yellow' } },
  });

  // ETH panel
  const ethBox = grid.set(1, 6, 5, 6, blessed.box, {
    label: ' ETH ',
    border: { type: 'line' },
    tags: true,
    style: { border: { fg: 'cyan' } },
  });

  // Active trade panel
  const tradeBox = grid.set(6, 0, 3, 12, blessed.box, {
    label: ' Active Trade ',
    border: { type: 'line' },
    tags: true,
    style: { border: { fg: 'green' } },
  });

  // Log panel
  const logBox = grid.set(9, 0, 3, 12, blessed.box, {
    label: ' Recent Trades ',
    border: { type: 'line' },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: 'magenta' } },
  });

  // ── Quit ───────────────────────────────────────────────────────────────────
  screen.key(['q', 'C-c'], () => process.exit(0));

  // ── Render helpers ─────────────────────────────────────────────────────────
  function c(color, text) { return `{${color}-fg}${text}{/}`; }
  function pnlColor(n) { return n >= 0 ? 'green' : 'red'; }

  function renderAsset(box, asset) {
    const s = state[asset];
    const yes = s.yesAsk !== null ? (s.yesAsk + s.yesBid) / 2 : null;
    const velSign = (s.yesVel ?? 0) >= 0 ? '+' : '';
    const armed = s.farmArmed ? c('green', 'FARM') : s.autoBuyArmed ? c('yellow', 'AUTO') : c('gray', 'IDLE');

    let lines = [
      `Price: ${c('white', yes !== null ? (yes * 100).toFixed(1) + '¢' : '--')}  ` +
      `Ask: ${s.yesAsk !== null ? (s.yesAsk * 100).toFixed(1) + '¢' : '--'}  ` +
      `Bid: ${s.yesBid !== null ? (s.yesBid * 100).toFixed(1) + '¢' : '--'}`,
      `Vel:  ${c(s.yesVel >= 0.05 ? 'green' : s.yesVel <= -0.05 ? 'red' : 'white', `${velSign}${(s.yesVel ?? 0).toFixed(3)}¢/s`)}  ` +
      `Regime: ${c('white', s.regime ?? 'NORMAL')}  Liq: ${c('white', s.liquidity)}`,
      `Ticker: ${c('white', s.ticker ?? '--')}  SecsLeft: ${c('white', s.secsLeft)}  Rounds: ${c('white', s.farmRounds)}`,
      `Bot: ${armed}  Consecutive L: ${c(s.consecutiveLosses > 0 ? 'red' : 'green', String(s.consecutiveLosses))}`,
      `Session PnL: ${c(pnlColor(s.sessionPnL), '$' + (s.sessionPnL ?? 0).toFixed(2))}  ` +
      `Daily: ${c(pnlColor(s.dailyPnL), '$' + (s.dailyPnL ?? 0).toFixed(2))}  ` +
      `Total: ${c(pnlColor(s.totalPnL), '$' + (s.totalPnL ?? 0).toFixed(2))}`,
    ];

    box.setContent(lines.join('\n'));
  }

  function renderTrade() {
    const lines = [];
    for (const asset of ['BTC', 'ETH']) {
      const s = state[asset];
      const trade = s.activeTrade;
      if (!trade) { lines.push(`${asset}: ${c('gray', 'flat')}`); continue; }

      const pnl = s.yesAsk !== null ? computeUnrealizedPnL(trade, s.yesAsk, s.yesBid) : 0;
      const pct = trade.maxProfit > 0 ? (pnl / trade.maxProfit * 100).toFixed(1) : '0.0';
      const secs = Math.round((Date.now() - trade.startedAt) / 1000);

      lines.push(
        `${c('white', asset)} ${c('yellow', trade.mode)} ${c('cyan', trade.bet)} ` +
        `$${trade.amount.toFixed(2)} × ${trade.count}ct  ` +
        `PnL: ${c(pnlColor(pnl), '$' + pnl.toFixed(3))} (${pct}%)  ` +
        `${secs}s open`
      );
    }
    tradeBox.setContent(lines.join('\n'));
  }

  let logLines = [];

  function renderLogs() {
    logBox.setContent(logLines.slice(-12).join('\n'));
    logBox.scrollTo(logLines.length);
  }

  // Expose log push for external use
  startTerminal.pushLog = (entry) => {
    const pnl = entry.pnl ?? 0;
    logLines.push(
      `${new Date(entry.at).toLocaleTimeString()} ` +
      `${entry.asset} ${entry.mode ?? ''} ${entry.bet} ` +
      c(pnlColor(pnl), `$${pnl.toFixed(2)}`) +
      ` (${entry.reason})`
    );
  };

  // ── Update loop ────────────────────────────────────────────────────────────
  function render() {
    const bal = state.balance?.toFixed(2) ?? '--';
    header.setContent(
      ` {bold}Kalshi MCP Bot{/}  Balance: ${c('green', '$' + bal)}  ` +
      `${new Date().toLocaleTimeString()}`
    );

    renderAsset(btcBox, 'BTC');
    renderAsset(ethBox, 'ETH');
    renderTrade();
    renderLogs();
    screen.render();
  }

  setInterval(render, 500);
  render();

  return screen;
}
