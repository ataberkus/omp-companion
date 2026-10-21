import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('shutdown commands are fixed argv per platform', () => {
  assert.deepEqual(internals.shutdownCommand('win32'), ['shutdown', ['/s', '/t', '0']]);
  assert.deepEqual(internals.shutdownCommand('darwin'), ['osascript', ['-e', 'tell application "System Events" to shut down']]);
  assert.deepEqual(internals.shutdownCommand('linux'), ['systemctl', ['poweroff']]);
});

// The OS may kill the companion before any signal handler runs, so sessions must be saved before the command starts.
test('Shut down PC pauses and saves sessions first; a refused shutdown is reported and the panel keeps working', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-shutdown-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({ state: () => ({ todoPhases: [], isSettled: false }) });
  const at = new Date().toISOString();
  const session = (id, status) => ({ id, projectId: 'project', title: id, status, cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at });
  const file = join(dir, 'workspace.json');
  await writeFile(file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('run', 'paused'), session('rev', 'review')], activity: [] }));
  let saved, outcome;
  app = await createCompanion({ dataDir: dir, omp, shutdownHost: async () => { saved = JSON.parse(await readFile(file, 'utf8')); if (outcome) throw outcome; } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  for (const id of ['run', 'rev']) assert.equal((await call(`/commands?session=${id}`))[0], 200, 'starts a live OMP runner');
  app.store.sessions.find(s => s.id === 'run').status = 'running';

  assert.deepEqual(await call('/shutdown', {}), [200, { ok: true }]);
  const status = id => saved.sessions.find(s => s.id === id).status;
  assert.equal(status('run'), 'paused', 'running session saved as paused before the command ran');
  assert.equal(status('rev'), 'review', 'other sessions keep their status, as on quit');

  outcome = Object.assign(new Error('Could not shut down this PC: Access is denied.'), { status: 500 });
  assert.deepEqual(await call('/shutdown', {}), [500, { error: 'Could not shut down this PC: Access is denied.' }]);
  const [code, state] = await call('/state');
  assert.equal(code, 200, 'the companion keeps serving after a refused shutdown');
  assert.equal(state.sessions.find(s => s.id === 'run').status, 'paused');
  assert.equal((await call('/commands?session=run'))[0], 200, 'a paused session can start again');
});

// "Shut down PC when all work is done": each session's fake OMP runs in its own folder; finishTurn announces a settled
// turn there.
async function autoCompanion(t, sessions, shutdownHost) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-auto-shutdown-'));
  const app = { app: null };
  t.after(async () => { if (app.app) await app.app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({
    state: () => ({ todoPhases: [], isSettled: false }),
    prompt() { queueMicrotask(() => this.emit({ type: 'agent_start' })); return {}; },
  });
  const at = new Date().toISOString();
  for (const id of sessions) await mkdir(join(dir, id));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: sessions.map(id => ({ id, projectId: 'project', title: id, status: 'paused', cwd: join(dir, id), model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at })), activity: [] }));
  app.app = await createCompanion({ dataDir: dir, omp, shutdownHost });
  app.app.server.listen(0, '127.0.0.1');
  await once(app.app.server, 'listening');
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  for (const id of sessions) assert.equal((await call(`/commands?session=${id}`))[0], 200, 'starts a live OMP runner');
  const until = async (done, what) => {
    for (const end = Date.now() + 5000; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (await done()) return new Promise(r => setTimeout(r, 200));
    assert.fail(`Timed out waiting: ${what}`);
  };
  // Ends the running turn of session `id`; resolves once `done()` holds, plus a moment for anything it triggers.
  const finishTurn = async (id, done) => {
    for (const s of omp.sessions) if (s.alive && s.cwd === join(dir, id)) s.emit({ type: 'session_settled' });
    await until(done, `${id} settles`);
  };
  return { store: app.app.store, call, finishTurn, until };
}

test('Shut down PC when all work is done waits for running turns and queued messages, then shuts down once', async t => {
  let calls = 0;
  const { store, call, finishTurn, until } = await autoCompanion(t, ['a', 'b'], async () => { calls++; });
  const a = store.sessions.find(s => s.id === 'a'), b = store.sessions.find(s => s.id === 'b');
  a.status = 'running';
  a.queuedMessages = [{ id: 'q1', text: 'next', at: new Date().toISOString() }];
  b.status = 'running';

  const [code, view] = await call('/shutdown/auto', { on: true });
  assert.equal(code, 200);
  assert.equal(view.on, true);
  assert.equal((await call('/state'))[1].autoShutdown.on, true, 'every panel sees the armed option');

  await finishTurn('b', () => b.status === 'review');
  assert.equal(calls, 0, 'session a is still running');
  await finishTurn('a', () => !a.queuedMessages.length);
  assert.equal(a.status, 'running', 'the queued message started the next turn');
  assert.equal(calls, 0, 'no shutdown while the queued message runs');
  await finishTurn('a', () => a.status === 'review');
  await until(() => calls > 0, 'the shutdown command');
  assert.equal(calls, 1, 'the last finished turn shuts the PC down');
  assert.deepEqual((await call('/state'))[1].autoShutdown, { on: false, since: null, firing: false, error: null });
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(calls, 1, 'background refreshes do not shut down again');
});

// A stopped session's queued message only goes out with the user's next message there, so it must not hold the
// shutdown forever; it stays queued and is saved for later.
test('a stopped session with a queued message does not hold the automatic shutdown', async t => {
  let saved;
  const { store, call, until } = await autoCompanion(t, ['a', 'b'], async () => { saved = structuredClone(store.sessions.find(s => s.id === 'a').queuedMessages); });
  const a = store.sessions.find(s => s.id === 'a'), b = store.sessions.find(s => s.id === 'b');
  a.queuedMessages = [{ id: 'q1', text: 'Commit and push', at: new Date().toISOString() }];
  b._bash = 'tool-bash-1';
  assert.equal((await call('/shutdown/auto', { on: true }))[0], 200);
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(saved, undefined, 'a shell command in progress holds the shutdown');
  delete b._bash;
  await until(() => saved, 'the shutdown command');
  assert.deepEqual(saved.map(q => q.text), ['Commit and push'], 'the queued message stays queued');
});

test('a canceled automatic shutdown never runs; a refused one is reported and the panel keeps working', async t => {
  let calls = 0, outcome;
  const { store, call, finishTurn, until } = await autoCompanion(t, ['a'], async () => { calls++; if (outcome) throw outcome; });
  const a = store.sessions.find(s => s.id === 'a');
  a.status = 'running';
  await call('/shutdown/auto', { on: true });
  assert.deepEqual(await call('/shutdown/auto', { on: false }), [200, { on: false, since: null, firing: false, error: null }]);
  await finishTurn('a', () => a.status === 'review');
  assert.equal(calls, 0, 'canceled before the work ended');

  outcome = Object.assign(new Error('Could not shut down this PC: Access is denied.'), { status: 500 });
  assert.equal((await call('/shutdown/auto', { on: true }))[0], 200, 'nothing is working: shuts down right away');
  await until(async () => (await call('/state'))[1].autoShutdown.error, 'the refused shutdown');
  const [code, state] = await call('/state');
  assert.equal(code, 200, 'the companion keeps serving after a refused shutdown');
  assert.equal(calls, 1);
  assert.equal(state.autoShutdown.on, false, 'a refused shutdown turns the option off instead of retrying');
  assert.equal(state.autoShutdown.error.message, 'Could not shut down this PC: Access is denied.');
  assert.equal(state.sessions.find(s => s.id === 'a').status, 'review');
  assert.equal((await call('/commands?session=a'))[0], 200, 'the session can start again');
});
