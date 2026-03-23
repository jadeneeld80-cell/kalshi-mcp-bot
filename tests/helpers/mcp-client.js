/**
 * MCP test client — spawns the bot in --mcp mode, does the JSON-RPC
 * handshake, and exposes callTool() / listTools() for test files.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_PATH  = resolve(__dirname, '../../src/index.js');
const ROOT      = resolve(__dirname, '../..');

export class MCPTestClient {
  constructor() {
    this.proc    = null;
    this.rl      = null;
    this.pending = new Map();   // id → { resolve, reject }
    this.nextId  = 1;
    this._stderrBuf = '';
  }

  /** Spawn bot, run MCP init handshake. Resolves when server is ready. */
  async start(timeoutMs = 25_000) {
    this.proc = spawn('node', [BOT_PATH, '--mcp'], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Drain stderr (logs go here in MCP mode) to avoid pipe blocking
    this.proc.stderr.on('data', (d) => { this._stderrBuf += d.toString(); });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else           resolve(msg.result);
      }
    });

    this.proc.on('exit', (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`Bot process exited with code ${code}`));
      }
      this.pending.clear();
    });

    await Promise.race([
      this._initialize(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`MCP init timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  async _initialize() {
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:   {},
      clientInfo:     { name: 'kalshi-test', version: '1.0.0' },
    });
    // notifications/initialized has no id — no response expected
    this._write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  /** Call an MCP tool and return the raw result object. */
  async callTool(name, args = {}, timeoutMs = 20_000) {
    return Promise.race([
      this._request('tools/call', { name, arguments: args }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`callTool(${name}) timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /** List all tools the server exposes. */
  async listTools(timeoutMs = 10_000) {
    return Promise.race([
      this._request('tools/list', {}),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('listTools timed out')), timeoutMs)
      ),
    ]);
  }

  /**
   * Parse the first content item as JSON (or return the raw string).
   * Throws if the tool returned an error response.
   */
  parseResult(res) {
    const text = res.content[0].text;
    if (text.startsWith('ERROR:')) throw new Error(text.slice(7).trim());
    try { return JSON.parse(text); } catch { return text; }
  }

  /**
   * Poll get_status until the given asset has a live ticker.
   * Required because the bot needs a few seconds to connect on boot.
   */
  async waitForMarket(asset = 'BTC', timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res  = await this.callTool('get_status', { asset });
        const data = this.parseResult(res);
        const a = data?.assets?.[asset];
        if (a?.ticker && a?.yesAsk !== null && a?.yesBid !== null) return data;
      } catch {}
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for ${asset} market (${timeoutMs}ms)\nStderr:\n${this._stderrBuf.slice(-2000)}`);
  }

  /** Gracefully terminate the bot process. */
  stop() {
    this.rl?.close();
    this.proc?.kill('SIGTERM');
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  _write(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
