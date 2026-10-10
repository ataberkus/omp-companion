// Companion host for the Tauri shell: runs the companion and talks line-delimited JSON over stdin/stdout.
// Events: {"event":"ready","port","token"} | {"event":"fatal","message"}.
// Requests: {"id","cmd":"busy"|"lan"|"links"|"quit",...} → {"id","ok":true,...} | {"id","ok":false,"error"}.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCompanion, portBusy } from '../companion/server.mjs';
import { phoneLinks } from './links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.OMP_WEB_PORT || 4545);
const alreadyRunning = `The companion is already running on port ${port}, probably node companion/server.mjs or another OMP Control Room. Close it and try again.`;
let companion, closing, lan = false;

// stdout carries only protocol lines; the shell ignores anything that is not JSON.
const send = (msg, cb) => process.stdout.write(JSON.stringify(msg) + '\n', cb);
// Exit in the write callback: on Windows a pipe write can still be pending when exit() runs.
const fatal = message => send({ event: 'fatal', message }, () => process.exit(1));

// A sibling oh-my-pi checkout runs from source when bun is available (development setups).
function detectSiblingCheckout() {
  if (process.env.OMP_BIN) return;
  const cli = path.resolve(here, '../../oh-my-pi/packages/coding-agent/src/cli.ts');
  const bun = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const onPath = String(process.env.PATH || '').split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, bun)));
  if (fs.existsSync(cli) && onPath) process.env.OMP_BIN = cli;
}

// Rebind the same server instead of restarting the companion: close() would kill every running agent.
// The Host/Origin allowlist is recomputed from server.address() per request, so it follows the new bind.
function bind(host) {
  const server = companion.server;
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(() => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  });
}

async function setLan(on) {
  try { await bind(on ? '0.0.0.0' : '127.0.0.1'); lan = on; return { lan }; }
  catch (e) {
    await bind('127.0.0.1').catch(() => {});
    lan = false;
    throw e;
  }
}

const shutdown = () => (closing ??= companion ? companion.close() : Promise.resolve());

const commands = {
  busy: () => ({ busy: companion.store.sessions.filter(s => s.status === 'running' || s.status === 'queued').length }),
  lan: msg => setLan(Boolean(msg.on)),
  links: () => ({ links: phoneLinks(os.networkInterfaces(), port, companion.token) }),
};

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, cmd } = msg;
  if (cmd === 'quit') {
    try { await shutdown(); } finally { send({ id, ok: true }, () => process.exit(0)); }
    return;
  }
  try {
    const run = commands[cmd];
    if (!run) throw new Error(`Unknown command: ${cmd}`);
    send({ id, ok: true, ...(await run(msg)) });
  } catch (e) {
    send({ id, ok: false, error: e.message });
  }
}

function listen() {
  readline.createInterface({ input: process.stdin }).on('line', line => { void handle(line); });
  // The shell died or closed the pipe: save sessions as paused and stop every OMP process instead of leaving an orphan.
  process.stdin.once('close', async () => {
    try { await shutdown(); } finally { process.exit(0); }
  });
}

async function main() {
  listen();
  detectSiblingCheckout();
  // Before createCompanion: it pauses running sessions and saves workspace.json, which would clobber a live companion.
  if (await portBusy(port)) return fatal(alreadyRunning);
  try { companion = await createCompanion({ exposeToken: false }); }
  catch (e) { return fatal(`The companion could not start: ${e.message}`); }
  const { server } = companion;
  const onStartError = e => fatal(e.code === 'EADDRINUSE' ? alreadyRunning : `The companion could not start: ${e.message}`);
  server.once('error', onStartError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onStartError);
    send({ event: 'ready', port, token: companion.token });
  });
}

main();
