import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// A paired phone keeps its token: a new launch (reboot, app update, quit) must accept the token the last one gave out.
test('the connection token survives a relaunch and is revoked by deleting its file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omp-token-'));
  try {
    const launch = async options => { const app = await createCompanion({ dataDir: dir, ...options }); await app.close(); return app.token; };
    const first = await launch();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await launch(), first);
    await rm(path.join(dir, 'connection-token'));
    assert.notEqual(await launch(), first);
    assert.equal(await launch({ password: 'pw-123' }), 'pw-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
