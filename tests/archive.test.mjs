import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

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
