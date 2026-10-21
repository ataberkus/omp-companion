import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('sessions can be archived and restored, and the choice persists', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-archive-'));
  let app = await createCompanion({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, body) => {
    const port = app.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');

  const key = 'f:' + join(dataDir, 'native.jsonl');
  assert.deepEqual((await call('/state')).data.archived, []);
  assert.deepEqual((await call('/archive', { key })).data.archived, [key]);
  assert.deepEqual((await call('/archive', { key })).data.archived, [key]);
  assert.equal((await call('/archive', { key: 'bogus' })).status, 400);
  assert.equal((await call('/archive', { key: 's:missing' })).status, 404);

  await app.close();
  app = await createCompanion({ dataDir });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  assert.deepEqual((await call('/state')).data.archived, [key]);
  assert.deepEqual((await call('/archive', { key, archived: false })).data.archived, []);
});

test('archiving a session ready for review marks it done and stops its OMP process', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-archive-review-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({ state: () => ({ todoPhases: [] }) });
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };

  await call('/sessions/session/command', { type: 'stats' }); // starts the OMP runner
  const session = omp.last;
  assert.ok(session, 'OMP session was started');
  assert.deepEqual((await call('/archive', { key: 's:session' })).archived, ['s:session']);
  for (let i = 0; i < 50 && session.alive; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(session.alive, false, 'OMP process was stopped');
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await call('/state')).sessions.find(s => s.id === 'session').status, 'done');
});
