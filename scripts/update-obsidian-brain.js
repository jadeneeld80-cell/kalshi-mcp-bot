#!/usr/bin/env node
/**
 * update-obsidian-brain.js
 *
 * Reads logs/trades.json and creates/updates one Obsidian learning event note
 * per trading session (per asset, per date) in the Neural Network vault.
 *
 * Run manually:  node scripts/update-obsidian-brain.js
 * Or call from trade close logic to branch the graph on every learned trade.
 *
 * Output path: ~/Documents/Kalshi Bot Brain/Neural Network/{ASSET}/Learning Events/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRADES_PATH  = join(__dirname, '../logs/trades.json');
const VAULT_PATH   = join(os.homedir(), 'Documents/Kalshi Bot Brain/Neural Network');
const ASSETS       = ['BTC', 'ETH'];

// ── helpers ──────────────────────────────────────────────────────────────────

function groupByDay(trades) {
  const days = {};
  for (const t of trades) {
    const day = (t.at || '').slice(0, 10);
    if (!day) continue;
    if (!days[day]) days[day] = { wins: 0, losses: 0, pnl: 0, modes: {}, exits: {}, count: 0 };
    const d = days[day];
    d.count++;
    d[t.win ? 'wins' : 'losses']++;
    d.pnl += (t.pnl || 0);
    const m = t.mode || 'FARM'; d.modes[m] = (d.modes[m] || 0) + 1;
    const e = t.reason || '?'; d.exits[e] = (d.exits[e] || 0) + 1;
  }
  return days;
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function renderTable(rows) {
  return rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n');
}

function buildNote(asset, date, stats) {
  const wr       = stats.count > 0 ? (stats.wins / stats.count * 100).toFixed(1) : '0.0';
  const pnl      = stats.pnl.toFixed(2);
  const pnlSign  = stats.pnl >= 0 ? '+' : '';
  const status   = parseFloat(wr) >= 55 ? 'ABOVE_TARGET'
                 : parseFloat(wr) >= 45 ? 'NEAR_TARGET'
                 :                        'BELOW_TARGET';
  const prev     = offsetDate(date, -1);
  const next     = offsetDate(date, +1);

  const modeRows = Object.entries(stats.modes).map(([m, c]) => [m, String(c)]);
  const exitRows = Object.entries(stats.exits).map(([e, c]) => [e, String(c)]);

  return `---
type: learning-event
asset: ${asset}
date: ${date}
trades: ${stats.count}
wins: ${stats.wins}
losses: ${stats.losses}
win_rate: ${wr}%
pnl: ${pnlSign}${pnl}
status: ${status}
---

# ${asset} Learning Event — ${date}

> Synaptic branch created when the ${asset} network processed ${stats.count} trades on this date. Each WIN/LOSS fired a backpropagation pass, adjusting ${asset} weight matrices.

## Session Summary

| Metric | Value |
|--------|-------|
| Trades | ${stats.count} |
| Wins | ${stats.wins} |
| Losses | ${stats.losses} |
| Win Rate | ${wr}% |
| Session P&L | ${pnlSign}$${pnl} |
| Status | ${status} |

## Mode Breakdown

| Mode | Trades |
|------|--------|
${renderTable(modeRows)}

## Exit Breakdown

| Exit Reason | Count |
|-------------|-------|
${renderTable(exitRows)}

## Network State After Session

After processing these ${stats.count} trades:
- Backpropagation updated all weight matrices
- WIN samples reinforced successful feature patterns
- LOSS samples weakened patterns that led to failure
- Brain persisted to \`data/${asset.toLowerCase()}_brain.json\`

## Synaptic Chain

← [[${asset} Learning — ${prev}]]
→ [[${asset} Learning — ${next}]]

## Connected to

- [[🧠 ${asset} Brain]] ← hub
- [[${asset} MOMENTUM Pathway]] — primary mode
- [[${asset} UP Pathway]] — UP bets this session
- [[${asset} DOWN Pathway]] — DOWN bets this session
`;
}

// ── main ─────────────────────────────────────────────────────────────────────

let trades;
try {
  trades = JSON.parse(readFileSync(TRADES_PATH, 'utf8'));
} catch (err) {
  console.error('[ObsidianBrain] Could not read trades.json:', err.message);
  process.exit(1);
}

let created = 0;
let updated = 0;

for (const asset of ASSETS) {
  const assetTrades = trades.filter(t => t.asset === asset);
  const days        = groupByDay(assetTrades);
  const outDir      = join(VAULT_PATH, asset, 'Learning Events');

  mkdirSync(outDir, { recursive: true });

  for (const [date, stats] of Object.entries(days)) {
    const filePath = join(outDir, `${asset} Learning — ${date}.md`);
    const content  = buildNote(asset, date, stats);
    const existed  = existsSync(filePath);
    writeFileSync(filePath, content, 'utf8');
    existed ? updated++ : created++;
  }
}

console.log(`[ObsidianBrain] Done — ${created} created, ${updated} updated`);
