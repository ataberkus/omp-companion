// Companion host for the Tauri shell: runs the companion and talks line-delimited JSON over stdin/stdout.
// Events: {"event":"ready","port","token"} | {"event":"fatal","message"} | {"event":"attention","title","body"} (a session finished, failed or asks something)
//   | {"event":"screen","address"} (a device started viewing and controlling this PC; address null when it stopped)
//   | {"event":"restart"} (Restart companion, or the restart after an OMP SDK update: the host exits next, and the shell starts a new one).
// Requests: {"id","cmd":"busy"|"lan"|"screen"|"links"|"quit",...} → {"id","ok":true,...} | {"id","ok":false,"error"}.
//   {"cmd":"quit","resume":true} (an app update) also leaves the resume note below before replying, so the new version
//   resumes the sessions that were working; a plain quit does not.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { adoptLoginShellEnv } from './shell-env.mjs';

// A macOS app opened from Finder or the Dock gets launchd's bare environment: take the login shell's (PATH, API keys,
// OMP_* settings) first. The companion's modules are imported only afterwards because they read the environment as they load.
const shellEnv = await adoptLoginShellEnv();
// stdout carries the protocol, so this goes to stderr (the Tauri shell keeps its tail for crash reports).
if (shellEnv.error) console.error(`Could not read your login shell's environment (${shellEnv.error}); added to PATH: ${shellEnv.added.join(', ') || 'nothing'}.`);
const { busySessions, createCompanion, portBusy, startupUpdate, tailscaleKeeper, tailscaleSelf } = await import('../companion/server.mjs');
const { restartHandoff } = await import('../companion/system.mjs');
const { defaultDataDir } = await import('../companion/update.mjs');
const { phoneLinks, pickTailnetHost } = await import('./links.mjs');

const port = Number(process.env.OMP_WEB_PORT || 4545);
const alreadyRunning = `The companion is already running on port ${port}, probably node companion/server.mjs or another OMP Control Room. Close it and try again.`;
let companion, closing, lan = false;
// A second listener on this PC's Tailscale address lets devices on the tailnet reach the app from launch while the LAN stays
// closed (the window needs 127.0.0.1 and only the tray toggle opens the LAN). With OMP_WEB_HOST unset the address comes from
// `tailscale status` and is rechecked every 30 s, following Tailscale as it connects, disconnects or changes address. A lookup
// that finds nothing (tailscaled reconnecting, a timeout) keeps the listener until the last good one is 5 minutes old
// (tailscaleKeeper, as the Host/Origin gate does): closing it at once dropped every phone over a blip.
// OMP_WEB_HOST naming a tailnet address (100.x.y.z or fd7a:115c:a1e0::…) pins it; any other OMP_WEB_HOST turns the listener off.
// While the toggle is on, 0.0.0.0 covers the tailnet and this listener steps aside.
const envHost = process.env.OMP_WEB_HOST || '';
const autoTailnet = !envHost;
const TAILNET_CHECK = 30000;
// listen() and close() answer through callbacks. One that never fires (a socket whose peer never closes, a runtime quirk) held
// the chain below forever: no later open or close ran and the listener never came back. Past this limit the step goes on.
const STEP_LIMIT = 10000;
const keepTailscale = tailscaleKeeper();
// tailnetBroken: the listener reported an error after it started; the next check replaces it.
let tailnet, tailnetHost = '', tailnetUp = false, tailnetBroken = false, tailnetRetry, tailnetTask = Promise.resolve();
// A failed step must not break the chain: every later open or close would be skipped.
const tailnetStep = step => (tailnetTask = tailnetTask.then(step).catch(e => console.error(`Tailnet listener: ${e.message}`)));

// p's value, or `late` when p has not settled within STEP_LIMIT.
function within(p, late) {
  let timer;
  return Promise.race([p, new Promise(resolve => { timer = setTimeout(resolve, STEP_LIMIT, late); })]).finally(() => clearTimeout(timer));
}

// Resolves with true once srv listens on host, with the listen error, or with null when neither came within STEP_LIMIT.
function listenOn(srv, host) {
  return new Promise(resolve => {
    const done = v => { clearTimeout(timer); srv.off('error', done).off('listening', onListening); resolve(v); };
    const onListening = () => done(true);
    const timer = setTimeout(done, STEP_LIMIT, null);
    srv.once('error', done).once('listening', onListening);
    try { srv.listen(port, host); } catch (e) { done(e); }
  });
}

// stdout carries only protocol lines; the shell ignores anything that is not JSON.
const send = (msg, cb) => process.stdout.write(JSON.stringify(msg) + '\n', cb);
// Exit in the write callback: on Windows a pipe write can still be pending when exit() runs.
const fatal = message => send({ event: 'fatal', message }, () => process.exit(1));

// Rebind the same server instead of restarting the companion: close() would kill every running agent.
// The Host/Origin allowlist is recomputed from server.address() per request, so it follows the new bind.
// The screen viewer goes first: a device that lost access must not keep watching. closeServer() ends every connection,
// upgraded ones included, so nothing keeps the close waiting; should it still not call back, the bind goes ahead.
async function bind(host) {
  const server = companion.server;
  companion.closeScreen();
  if (!await within(companion.closeServer(server).then(() => true), false)) console.error(`Closing the listener on port ${port} took over 10 s; binding ${host} anyway.`);
  const result = await listenOn(server, host);
  if (result !== true) throw result || new Error(`Listening on ${host}:${port} did not finish within 10 s.`);
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
// The timer keeps running while listening: auto mode follows a dropped or changed address, and both modes replace a listener
// that stopped or failed.
function openTailnet() {
  clearTimeout(tailnetRetry);
  return tailnetStep(async () => {
    if (lan || closing) return;
    const retry = () => { clearTimeout(tailnetRetry); tailnetRetry = setTimeout(openTailnet, TAILNET_CHECK); tailnetRetry.unref?.(); };
    let want = pickTailnetHost(envHost, null);
    if (autoTailnet) {
      const found = await within(tailscaleSelf().catch(() => null), null);
      want = pickTailnetHost('', keepTailscale(found));
      if (!found && tailnetUp && want === tailnetHost) console.error(`Tailscale did not report this PC's address; keeping the listener on ${tailnetHost}:${port} until it has been gone for 5 minutes.`);
    }
    if (lan || closing) return;
    if (tailnetUp && want === tailnetHost && !tailnetBroken && tailnet.listening) return retry();
    if (tailnetUp) {
      console.error(want === tailnetHost ? `The listener on ${tailnetHost}:${port} stopped working; starting a new one.` : `Stopped listening on ${tailnetHost}:${port}: Tailscale disconnected or changed its address.`);
      await stopTailnet();
    }
    if (!want) return autoTailnet && retry();
    // A listener that failed to listen is reused; a closed or stuck one was dropped, so this makes a new one.
    const srv = tailnet ??= newTailnet();
    const result = await listenOn(srv, want);
    if (result === true) {
      tailnetUp = true; tailnetHost = want;
      console.error(`Listening on the tailnet: http://${want.includes(':') ? `[${want}]` : want}:${port}/`);
    } else if (result) {
      console.error(`Could not listen on ${want}:${port} (${result.code || result.message}); is Tailscale connected? Retrying in 30 s.`);
    } else {
      console.error(`Listening on ${want}:${port} did not finish within 10 s; trying again with a new listener in 30 s.`);
      // Should it start listening after all, it closes at once instead of holding the port.
      tailnet = undefined;
      srv.once('listening', () => void companion.unserve(srv));
      void companion.unserve(srv);
    }
    retry();
  });
}

// Its 'error' handler stays for good. An error after it started listening (accept failing, say) marks it broken, and the check
// it starts replaces it; without a handler that error would crash the host. Errors while listening starts go to listenOn(),
// and a listener already replaced has nothing left to fix.
function newTailnet() {
  const srv = companion.serve();
  srv.on('error', e => {
    if (srv !== tailnet || !tailnetUp || tailnetBroken) return;
    console.error(`The listener on ${tailnetHost}:${port} failed (${e.code || e.message}); starting a new one.`);
    tailnetBroken = true;
    openTailnet();
  });
  return srv;
}

// Runs inside a tailnetStep. The screen viewer goes first, as in bind(). The closed listener leaves the companion for good
// (unserve), so a stuck one can't hold quit either; the next open makes a new one.
async function stopTailnet() {
  if (!tailnetUp) return;
  const srv = tailnet, host = tailnetHost;
  tailnetUp = false; tailnetBroken = false; tailnetHost = ''; tailnet = undefined;
  companion.closeScreen();
  if (!await within(companion.unserve(srv).then(() => true), false)) console.error(`Closing the listener on ${host}:${port} took over 10 s; went on without it.`);
}

// The timer is cleared again inside the step: an open step queued before this one may have rearmed it.
function closeTailnet() {
  clearTimeout(tailnetRetry);
  return tailnetStep(() => { clearTimeout(tailnetRetry); return stopTailnet(); });
}

// companion.close() closes every listener, the tailnet one included, and resolves with the IDs of the sessions it paused.
const shutdown = () => { clearTimeout(tailnetRetry); return (closing ??= companion ? companion.close() : Promise.resolve()); };

// The resume note: an app update (the tray's Install update, or a newer installer asking the app to quit) or a restart
// (Restart companion) writes {at, resume} here, and the next host resumes those sessions. Tray Quit, sign-out and crash
// recovery send a plain quit and leave none, so their sessions come back paused. Its own file: restart.json belongs to
// start.bat's companion, which may share the data dir, and the two never read each other's note. No token: an update gets
// a new one at launch, and a restart keeps the window's through the shell (OMP_WEB_DESKTOP_TOKEN).
const updateNote = path.join(defaultDataDir(), 'update-resume.json');
// Long enough for an installer that replaces node_modules; a note left by an install that failed goes stale after it.
const UPDATE_NOTE_MAX_AGE = 10 * 60 * 1000;

async function writeUpdateNote(resume) {
  if (!resume?.length) return;
  await fs.mkdir(path.dirname(updateNote), { recursive: true, mode: 0o700 });
  await fs.writeFile(updateNote, JSON.stringify({ at: Date.now(), resume }), { mode: 0o600 });
}

// Read once and deleted at once, so a later launch or a crash recovery resumes nothing. Stale or malformed: nothing.
async function takeUpdateNote() {
  const text = await fs.readFile(updateNote, 'utf8').catch(() => '');
  if (!text) return [];
  await fs.rm(updateNote, { force: true }).catch(e => console.error(`Could not remove the update note: ${e.message}`));
  return restartHandoff(text, Date.now(), UPDATE_NOTE_MAX_AGE)?.resume ?? [];
}

const commands = {
  busy: () => ({ busy: busySessions(companion.store.sessions) }),
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
    try {
      const paused = await shutdown();
      // Written before the reply: the shell waits for it, then the installer replaces the app's files.
      if (msg.resume === true) await writeUpdateNote(paused).catch(e => console.error(`Could not save the sessions to resume after the update: ${e.message}`));
    } finally { send({ id, ok: true }, () => process.exit(0)); }
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
  // Taken before the OMP update below, which can use up to 45 s of the note's freshness.
  const resume = await takeUpdateNote();
  // The shell gives up on a host that is not ready within 60 s, reading the login shell included; an update cut short
  // starts with the installed OMP, and an OMP install (no omp found) cut short finishes in the background while the
  // companion starts without the CLI. stdout carries the protocol, so update and install progress go to stderr.
  // A restart skips it (the shell sets OMP_WEB_NO_UPDATE).
  const update = await startupUpdate({ timeout: 45000 - (shellEnv.ms || 0), log: m => console.error(m) });
  // OMP_WEB_NO_TOKEN=1 (read by createCompanion) embeds the token in the page: phones need no token, anyone on the LAN gets control.
  // Attention events become native notifications in the shell; it skips them while the main window has focus.
  const verbs = { review: 'is ready for review', error: 'failed', question: 'is asking a question' };
  const onAttention = a => send({ event: 'attention', title: `${a.title} ${verbs[a.kind] || 'needs you'}`.slice(0, 200), body: a.detail || 'Open OMP Control Room to continue.' });
  // Screen sharing starts off at every launch, like network access; only the tray turns it on (OMP_WEB_SCREEN doesn't apply here).
  const onScreen = v => send({ event: 'screen', address: v?.address ?? null });
  // A host the shell restarts after a crash keeps the window's token (unless a password is the token). Removed from the
  // environment at once, so OMP's tools and CLI runs never inherit it.
  const token = process.env.OMP_WEB_DESKTOP_TOKEN;
  delete process.env.OMP_WEB_DESKTOP_TOKEN;
  // Restart companion: the sessions are paused and saved already; the working ones go to the resume note, the shell is told
  // this exit is meant, and once the companion closed the host exits. The shell starts a new host on the same port and token.
  const restart = async resume => {
    await writeUpdateNote(resume).catch(e => console.error(`Could not save the sessions to resume after the restart: ${e.message}`));
    return async () => {
      send({ event: 'restart' });
      try { await shutdown(); } finally { process.exit(0); }
    };
  };
  try { companion = await createCompanion({ desktop: true, onAttention, screen: false, onScreen, restart, ...(token && !process.env.OMP_WEB_PASSWORD ? { token } : {}), ...(resume.length ? { resume } : {}) }); }
  catch (e) { return fatal(`The companion could not start: ${e.message}`); }
  // An OMP SDK whose install outlived the startup limit loads only in a new process: restart once no session is working.
  update?.sdkLate?.then(r => r?.status === 'installed' && companion.restartWhenIdle()).catch(() => {});
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
