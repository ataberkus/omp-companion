import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('only the current dashboard is available', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-dashboard-'));
  const app = await createCompanion({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/classic')).status, 404);
  assert.equal((await fetch(base + '/local.html')).status, 404);
});
