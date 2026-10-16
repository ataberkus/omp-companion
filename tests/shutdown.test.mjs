import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';

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
  const file = join(dir, 'workspace.json');
  await writeFile(file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('run', 'paused'), session('rev', 'review')], activity: [] }));
  let saved, outcome;
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake], shutdownHost: async () => { saved = JSON.parse(await readFile(file, 'utf8')); if (outcome) throw outcome; } });
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
