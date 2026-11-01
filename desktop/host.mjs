// Companion host for the Tauri shell: runs the companion and talks line-delimited JSON over stdin/stdout.
// Events: {"event":"ready","port","token"} | {"event":"fatal","message"} | {"event":"attention","title","body"} (a session finished, failed or asks something)
//   | {"event":"screen","address"} (a device started viewing and controlling this PC; address null when it stopped).
// Requests: {"id","cmd":"busy"|"lan"|"screen"|"links"|"quit",...} → {"id","ok":true,...} | {"id","ok":false,"error"}.
import * as os from 'node:os';
import * as readline from 'node:readline';
import { createCompanion, portBusy, startupUpdate, tailscaleSelf } from '../companion/server.mjs';
import { phoneLinks, pickTailnetHost } from './links.mjs';

const port = Number(process.env.OMP_WEB_PORT || 4545);
const alreadyRunning = `The companion is already running on port ${port}, probably node companion/server.mjs or another OMP Control Room. Close it and try again.`;
let companion, closing, lan = false;
// A second listener on this PC's Tailscale address lets devices on the tailnet reach the app from launch while the LAN stays
// closed (the window needs 127.0.0.1 and only the tray toggle opens the LAN). With OMP_WEB_HOST unset the address comes from
// `tailscale status` and is rechecked every 30 s, following Tailscale as it connects, disconnects or changes address.
// OMP_WEB_HOST naming a tailnet address (100.x.y.z or fd7a:115c:a1e0::…) pins it; any other OMP_WEB_HOST turns the listener off.
// While the toggle is on, 0.0.0.0 covers the tailnet and this listener steps aside.
const envHost = process.env.OMP_WEB_HOST || '';
const autoTailnet = !envHost;
let tailnet, tailnetHost = '', tailnetUp = false, tailnetRetry, tailnetTask = Promise.resolve();
// A failed step must not break the chain: every later open or close would be skipped.
const tailnetStep = step => (tailnetTask = tailnetTask.then(step).catch(e => console.error(`Tailnet listener: ${e.message}`)));

// stdout carries only protocol lines; the shell ignores anything that is not JSON.
const send = (msg, cb) => process.stdout.write(JSON.stringify(msg) + '\n', cb);
// Exit in the write callback: on Windows a pipe write can still be pending when exit() runs.
const fatal = message => send({ event: 'fatal', message }, () => process.exit(1));

// Rebind the same server instead of restarting the companion: close() would kill every running agent.
// The Host/Origin allowlist is recomputed from server.address() per request, so it follows the new bind.
// The screen viewer goes first: its WebSocket would keep server.close() waiting, and a device that lost access must not keep watching.
function bind(host) {
  const server = companion.server;
  return new Promise((resolve, reject) => {
    companion.closeScreen();
    server.closeAllConnections();
    server.close(() => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  });
}

async function setLan(on) {
  try {
    if (on) await closeTailnet();
    await bind(on ? '0.0.0.0' : '127.0.0.1'); lan = on;
    if (!on) openTailnet();
    return { lan };
  } catch (e) {
    await bind('127.0.0.1').catch(() => {});
    lan = false;
    openTailnet();
    throw e;
  }
}

// Tailscale often connects after the app starts (both start at sign-in), so an address that is not up yet is retried every 30 s.
// Auto mode keeps that timer running while listening, so a dropped or changed address is closed and the new one bound.
function openTailnet() {
  clearTimeout(tailnetRetry);
  return tailnetStep(async () => {
    if (lan || closing) return;
    const want = autoTailnet ? pickTailnetHost('', await tailscaleSelf().catch(() => null)) : pickTailnetHost(envHost, null);
    if (lan || closing) return;
    const retry = () => { tailnetRetry = setTimeout(openTailnet, 30000); tailnetRetry.unref?.(); };
    if (tailnetUp && want === tailnetHost) return autoTailnet && retry();
    if (tailnetUp) {
      console.error(`Stopped listening on ${tailnetHost}:${port}: Tailscale disconnected or changed its address.`);
      await stopTailnet();
    }
    if (!want) return autoTailnet && retry();
    tailnet ??= companion.serve();
    await new Promise(resolve => {
      const onError = e => {
        tailnet.off('listening', onListening);
        console.error(`Could not listen on ${want}:${port} (${e.code || e.message}); is Tailscale connected? Retrying in 30 s.`);
        retry();
        resolve();
      };
      const onListening = () => {
        tailnet.off('error', onError);
        tailnetUp = true; tailnetHost = want;
        console.error(`Listening on the tailnet: http://${want.includes(':') ? `[${want}]` : want}:${port}/`);
        if (autoTailnet) retry();
        resolve();
      };
      tailnet.once('error', onError).once('listening', onListening).listen(port, want);
    });
  });
}

// Runs inside a tailnetStep. The screen viewer goes first, as in bind().
function stopTailnet() {
  if (!tailnetUp) return;
  tailnetUp = false; tailnetHost = '';
  companion.closeScreen();
  return new Promise(resolve => { tailnet.closeAllConnections(); tailnet.close(() => resolve()); });
}

// The timer is cleared again inside the step: an open step queued before this one may have rearmed it.
function closeTailnet() {
  clearTimeout(tailnetRetry);
  return tailnetStep(() => { clearTimeout(tailnetRetry); return stopTailnet(); });
}

// companion.close() closes every listener, the tailnet one included.
const shutdown = () => { clearTimeout(tailnetRetry); return (closing ??= companion ? companion.close() : Promise.resolve()); };

const commands = {
  busy: () => ({ busy: companion.store.sessions.filter(s => s.status === 'running' || s.status === 'queued').length }),
  lan: msg => setLan(Boolean(msg.on)),
  screen: msg => ({ screen: companion.setScreen(Boolean(msg.on)) }),
  links: async () => ({ links: phoneLinks(os.networkInterfaces(), port, companion.password ? '' : companion.token, await tailscaleSelf()) }),
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
  // Before createCompanion: it pauses running sessions and saves workspace.json, which would clobber a live companion.
  if (await portBusy(port)) return fatal(alreadyRunning);
  // The shell gives up on a host that is not ready within 60 s; an update cut short starts with the installed OMP.
  // stdout carries the protocol, so update progress goes to stderr.
  await startupUpdate({ timeout: 45000, log: m => console.error(m) });
  // OMP_WEB_NO_TOKEN=1 (read by createCompanion) embeds the token in the page: phones need no token, anyone on the LAN gets control.
  // Attention events become Windows notifications in the shell; it skips them while the main window has focus.
  const verbs = { review: 'is ready for review', error: 'failed', question: 'is asking a question' };
  const onAttention = a => send({ event: 'attention', title: `${a.title} ${verbs[a.kind] || 'needs you'}`.slice(0, 200), body: a.detail || 'Open OMP Control Room to continue.' });
  // Screen sharing starts off at every launch, like network access; only the tray turns it on (OMP_WEB_SCREEN doesn't apply here).
  const onScreen = v => send({ event: 'screen', address: v?.address ?? null });
  // A host the shell restarts after a crash keeps the window's token (unless a password is the token). Removed from the
  // environment at once, so OMP's tools and CLI runs never inherit it.
  const token = process.env.OMP_WEB_DESKTOP_TOKEN;
  delete process.env.OMP_WEB_DESKTOP_TOKEN;
  try { companion = await createCompanion({ desktop: true, onAttention, screen: false, onScreen, ...(token && !process.env.OMP_WEB_PASSWORD ? { token } : {}) }); }
  catch (e) { return fatal(`The companion could not start: ${e.message}`); }
  const { server } = companion;
  const onStartError = e => fatal(e.code === 'EADDRINUSE' ? alreadyRunning : `The companion could not start: ${e.message}`);
  server.once('error', onStartError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onStartError);
    send({ event: 'ready', port, token: companion.token });
    openTailnet();
  });
}

main();
