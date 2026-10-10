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
import { portBusy } from '../companion/server.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  s.close();
  await once(s, 'close');
  return port;
}

async function startHost(t, setup) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-desktop-host-'));
  const port = await freePort();
  if (setup) await setup(dir, port);
  const child = spawn(process.execPath, ['desktop/host.mjs'], {
    cwd: repoRoot, stdio: 'pipe', windowsHide: true,
    env: { ...process.env, OMP_WEB_PORT: String(port), OMP_WEB_DATA_DIR: dir, PI_CODING_AGENT_DIR: dir, OMP_SESSIONS_DIR: join(dir, 'sessions'), OMP_BIN: process.execPath },
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
