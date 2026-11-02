import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { busySessions, portBusy, tailscaleSelf } from '../companion/server.mjs';
import { pickTailnetHost } from '../desktop/links.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  await once(s, 'close');
  return port;
}

async function startHost(t, setup, env = {}, nodeArgs = []) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-desktop-host-'));
  const port = await freePort();
  if (setup) await setup(dir, port);
  const child = spawn(process.execPath, [...nodeArgs, 'desktop/host.mjs'], {
    cwd: repoRoot, stdio: 'pipe', windowsHide: true,
    env: { ...process.env, OMP_WEB_PORT: String(port), OMP_WEB_DATA_DIR: dir, PI_CODING_AGENT_DIR: dir, OMP_SESSIONS_DIR: join(dir, 'sessions'), OMP_BIN: process.execPath, OMP_WEB_NO_UPDATE: '1', ...env },
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    await rm(dir, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error('host closed stdout');
      try { return JSON.parse(value); } catch {}
    }
  };
  let id = 0;
  const request = async msg => { const req = { id: ++id, ...msg }; child.stdin.write(JSON.stringify(req) + '\n'); const res = await next(); assert.equal(res.id, req.id); return res; };
  return { dir, port, child, exited, next, request };
}

test('host reports ready, serves the dashboard, answers busy/lan/links and quits cleanly', async t => {
  const { port, exited, next, request } = await startHost(t);
  const ready = await next();
  assert.equal(ready.event, 'ready');
  assert.equal(ready.port, port);
  assert.match(ready.token, /^[0-9a-f]{64}$/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.deepEqual(await request({ cmd: 'busy' }), { id: 1, ok: true, busy: 0 });
  assert.equal((await request({ cmd: 'lan', on: true })).lan, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal((await request({ cmd: 'lan', on: false })).lan, false);
  const links = await request({ cmd: 'links' });
  assert.equal(links.ok, true);
  assert.ok(Array.isArray(links.links));
  const unknown = await request({ cmd: 'nope' });
  assert.deepEqual(unknown, { id: 5, ok: false, error: 'Unknown command: nope' });
  assert.deepEqual(await request({ cmd: 'quit' }), { id: 6, ok: true });
  assert.equal(await exited, 0);
});

// The quit/update prompt counts what the dashboard's "In panel" filter shows: a hidden session (a removed one, or a
// draft whose worktree Windows still held) is out of the panel, so it never asks "N sessions are still working".
test('busy counts running and queued panel sessions, not hidden ones, review or paused', () => {
  const s = (status, hidden) => ({ id: status + (hidden ? '-hidden' : ''), status, ...(hidden ? { hidden: true } : {}) });
  assert.equal(busySessions([s('running'), s('queued')]), 2);
  assert.equal(busySessions([s('running', true), s('queued', true)]), 0);
  assert.equal(busySessions([s('review'), s('paused'), s('done'), s('error')]), 0);
  assert.equal(busySessions([s('running'), s('running', true), s('queued', true), s('review')]), 1);
});

// Like network access, screen sharing starts off at every launch: OMP_WEB_SCREEN is for the plain companion, the tray decides here.
test('host starts with screen sharing off and turns it on and off on request', async t => {
  const { port, next, request } = await startHost(t, null, { OMP_WEB_SCREEN: '1' });
  const { token } = await next();
  const state = async () => (await (await fetch(`http://127.0.0.1:${port}/api/screen`, { headers: { Authorization: `Bearer ${token}` } })).json()).enabled;
  assert.equal(await state(), false);
  const on = process.platform === 'win32';
  assert.equal((await request({ cmd: 'screen', on: true })).screen, on);
  assert.equal(await state(), on);
  assert.equal((await request({ cmd: 'screen', on: false })).screen, false);
  assert.equal(await state(), false);
});

// An open screen WebSocket would keep server.close() waiting forever, so the LAN toggle would hang with a viewer connected.
test('the LAN toggle rebinds with a screen viewer connected and sends the viewer away to reconnect', { skip: process.platform !== 'win32' && 'screen sharing is Windows only' }, async t => {
  const { port, child, next, request } = await startHost(t);
  const { token } = await next();
  assert.equal((await request({ cmd: 'screen', on: true })).screen, true);
  const { ticket } = await (await fetch(`http://127.0.0.1:${port}/api/screen/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).json();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws?ticket=${ticket}`);
  await once(ws, 'open');
  assert.deepEqual(await next(), { event: 'screen', address: '127.0.0.1' });
  const closed = once(ws, 'close');
  // The viewer-gone event comes before the reply, so read both lines in order instead of through request().
  child.stdin.write(JSON.stringify({ id: 99, cmd: 'lan', on: true }) + '\n');
  assert.deepEqual(await next(), { event: 'screen', address: null });
  assert.deepEqual(await next(), { id: 99, ok: true, lan: true });
  assert.equal((await closed)[0].code, 1001);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('a busy port is refused before workspace.json is touched', async t => {
  const holder = createServer();
  t.after(() => holder.close());
  const { dir, exited, next } = await startHost(t, async (dir, port) => {
    const at = new Date().toISOString();
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'running', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
    holder.listen(port, '0.0.0.0');
    await once(holder, 'listening');
  });
  const fatal = await next();
  assert.equal(fatal.event, 'fatal');
  assert.match(fatal.message, /already running on port/);
  assert.equal(await exited, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions[0].status, 'running');
});

test('closing stdin shuts the companion down and frees the port', async t => {
  const { port, child, exited, next } = await startHost(t);
  assert.equal((await next()).event, 'ready');
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('host did not exit within 10s')), 10000).unref())]);
  assert.equal(code, 0);
  assert.equal(await portBusy(port), false);
});

// The app update path: sessions run on fakeOmp (tests/fake-omp-host.mjs), so a resumed one is working until the host quits.
const fakeOmpHost = ['--import', './tests/fake-omp-host.mjs'];
const seedSessions = note => async dir => {
  const at = new Date().toISOString();
  const session = id => ({ id, projectId: 'project', title: id, status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('run'), session('idle')], activity: [] }));
  if (note) await writeFile(join(dir, 'update-resume.json'), JSON.stringify(note));
};
const noteOf = async dir => readFile(join(dir, 'update-resume.json'), 'utf8').then(JSON.parse, e => e.code);
const statuses = async (port, token) => Object.fromEntries((await (await fetch(`http://127.0.0.1:${port}/api/state?session=`, { headers: { Authorization: `Bearer ${token}` } })).json()).sessions.map(s => [s.id, s.status]));
const waitFor = async (check, ms = 5000) => { for (const end = Date.now() + ms; !(await check()) && Date.now() < end;) await new Promise(r => setTimeout(r, 20)); return check(); };

test('a fresh update note resumes its sessions at launch and is deleted; an update quit writes the working ones for the next version', async t => {
  const { dir, port, exited, next, request } = await startHost(t, seedSessions({ at: Date.now(), resume: ['run'] }), {}, fakeOmpHost);
  const { token } = await next();
  assert.equal(await noteOf(dir), 'ENOENT', 'used up at launch, so a later launch or crash recovery resumes nothing');
  assert.ok(await waitFor(async () => (await statuses(port, token)).run === 'running'), 'the listed session carries on');
  assert.equal((await statuses(port, token)).idle, 'paused', 'a session not in the note stays paused');
  assert.deepEqual(await request({ cmd: 'quit', resume: true }), { id: 1, ok: true });
  assert.equal(await exited, 0);
  const note = await noteOf(dir);
  assert.deepEqual(Object.keys(note).sort(), ['at', 'resume'], 'no token: the app gets a new one at every launch');
  assert.deepEqual(note.resume, ['run']);
  assert.ok(Date.now() - note.at < 60_000);
  assert.equal(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions.find(s => s.id === 'run').status, 'paused');
});

test('a plain quit (tray Quit, sign-out) leaves no update note, so its sessions come back paused', async t => {
  const { dir, port, exited, next, request } = await startHost(t, seedSessions({ at: Date.now(), resume: ['run'] }), {}, fakeOmpHost);
  const { token } = await next();
  assert.ok(await waitFor(async () => (await statuses(port, token)).run === 'running'));
  assert.deepEqual(await request({ cmd: 'quit' }), { id: 1, ok: true });
  assert.equal(await exited, 0);
  assert.equal(await noteOf(dir), 'ENOENT');
  assert.equal(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions.find(s => s.id === 'run').status, 'paused');
});

// An install that failed tells the user to start the app again; that much later the sessions stay paused.
test('a stale update note is ignored and deleted', async t => {
  const { dir, port, next } = await startHost(t, seedSessions({ at: Date.now() - 11 * 60 * 1000, resume: ['run'] }), {}, fakeOmpHost);
  const { token } = await next();
  assert.equal(await noteOf(dir), 'ENOENT');
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(await statuses(port, token), { run: 'paused', idle: 'paused' });
});

// OMP_WEB_HOST unset: the host looks up this PC's Tailscale address itself. Without Tailscale it simply stays on 127.0.0.1;
// with it, the tailnet listener answers from launch, survives a LAN toggle round trip and is freed on quit.
test('with OMP_WEB_HOST unset the host listens on this PC\'s Tailscale address when there is one and quits cleanly', async t => {
  const { port, exited, next, request } = await startHost(t, null, { OMP_WEB_HOST: '' });
  const { token } = await next();
  const host = pickTailnetHost('', await tailscaleSelf());
  const base = host && `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const tailnetAnswers = async () => {
    for (let i = 0; i < 40; i++) {
      try { return (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status; } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    return 0;
  };
  if (base) assert.equal(await tailnetAnswers(), 200);
  assert.equal((await request({ cmd: 'lan', on: true })).lan, true);
  assert.equal((await request({ cmd: 'lan', on: false })).lan, false);
  if (base) assert.equal(await tailnetAnswers(), 200);
  assert.equal((await request({ cmd: 'links' })).ok, true);
  assert.deepEqual(await request({ cmd: 'quit' }), { id: 4, ok: true });
  assert.equal(await exited, 0);
  assert.equal(await portBusy(port), false);
  // A connect probe to the tailnet address can time out instead of being refused (portBusy counts that as busy), so bind it instead.
  if (host) { const s = createServer().listen(port, host); await once(s, 'listening'); s.close(); await once(s, 'close'); }
});
