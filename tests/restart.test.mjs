import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';

test('a restart handoff carries a fresh random token only; stale or malformed notes mean a normal start', () => {
  const token = 'ab'.repeat(32), at = 1_000_000;
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token }), at + 5000), { token });
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at }), at), {}, 'password mode hands over no token');
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token: 'my password' }), at), {}, 'only a random token is accepted');
  assert.equal(internals.restartHandoff(JSON.stringify({ at, token }), at + 3 * 60 * 1000), null, 'stale');
  assert.equal(internals.restartHandoff(JSON.stringify({ at: at + 1, token }), at), null, 'from the future');
  assert.equal(internals.restartHandoff('', at), null);
  assert.equal(internals.restartHandoff('null', at), null);
});

async function start(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-restart-'));
  const state = { dir, file: join(dir, 'workspace.json') };
  t.after(async () => { if (state.app) await state.app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
out({ type: 'ready', protocolVersion: 1 });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const data = c.type === 'get_state' ? { todoPhases: [], isSettled: false } : c.type === 'get_subagents' ? { subagents: [] } : {};
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`);
  const at = new Date().toISOString();
  const session = (id, status) => ({ id, projectId: 'project', title: id, status, cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at });
  await writeFile(state.file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('run', 'paused'), session('rev', 'review')], activity: [] }));
  state.app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake], ...options(state) });
  state.app.server.listen(0, '127.0.0.1');
  await once(state.app.server, 'listening');
  state.call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${state.app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  return state;
}

test('Restart companion pauses and saves sessions before relaunching, stops only after replying, and reports a failed restart', async t => {
  const events = [];let outcome;
  const c = await start(t, state => ({ restart: async () => {
    events.push(['prepare', JSON.parse(await readFile(state.file, 'utf8')).sessions.map(s => s.status)]);
    if (outcome) throw outcome;
    return async () => { events.push(['relaunch']); };
  } }));
  for (const id of ['run', 'rev']) assert.equal((await c.call(`/commands?session=${id}`))[0], 200, 'starts a live OMP runner');
  c.app.store.sessions.find(s => s.id === 'run').status = 'running';
  const [, before] = await c.call('/state?session=');
  assert.equal(before.canRestart, true);

  assert.deepEqual(await c.call('/restart', {}), [200, { ok: true }]);
  for (let i = 0; i < 100 && events.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, [['prepare', ['paused', 'review']], ['relaunch']], 'running session saved as paused, others keep their status; the stop step runs after the reply');

  events.length = 0;
  outcome = Object.assign(new Error('Could not write the restart note.'), { status: 500 });
  assert.deepEqual(await c.call('/restart', {}), [500, { error: 'Could not write the restart note.' }]);
  assert.deepEqual(events.map(e => e[0]), ['prepare'], 'a failed restart never stops the companion');
  const [code, after] = await c.call('/state?session=');
  assert.equal(code, 200, 'the companion keeps serving');
  assert.equal(after.instance, before.instance);
  assert.equal((await c.call('/commands?session=run'))[0], 200, 'a paused session can start again');
});

test('without a launcher that starts it again, Restart companion is refused and not offered', async t => {
  const c = await start(t, () => ({}));
  assert.equal((await c.call('/state?session='))[1].canRestart, false);
  const [code, body] = await c.call('/restart', {});
  assert.equal(code, 409);
  assert.match(body.error, /start\.bat/);
});
