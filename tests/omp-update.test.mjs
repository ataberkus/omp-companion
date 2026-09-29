import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('one update runs in the background, reports CLI output and failure, and requires authorization', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-update-test-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'updates.txt'), fail = join(dir, 'fail');
  await writeFile(join(dir, 'update'), `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, 'update\\n');
if (fs.existsSync(${JSON.stringify(fail)})) { console.error('\\x1b[31mUpdate failed: test\\x1b[0m'); process.exitCode = 17; }
else { console.log('Current version: 18.4.2'); setTimeout(() => console.log('New version available: 18.4.3'), 300); }
`);
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/omp-update`;
  const request = async (method, token = app.token) => {
    const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return [res.status, await res.json()];
  };
  const waitFor = async status => {
    for (let i = 0; i < 100; i++) {
      const [code, result] = await request('GET');
      assert.equal(code, 200);
      if (result.status === status) return result;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail(`Update never reached ${status}`);
  };

  assert.equal((await request('GET', 'wrong-token'))[0], 401);
  assert.equal((await request('GET'))[1].status, 'idle');
  assert.equal((await request('POST', 'wrong-token'))[0], 401);
  assert.equal((await request('POST'))[0], 202);
  assert.equal((await request('POST'))[0], 409);
  const done = await waitFor('done');
  assert.match(done.output, /Current version: 18\.4\.2/);
  assert.match(done.output, /New version available: 18\.4\.3/);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);

  await writeFile(fail, 'fail');
  assert.equal((await request('POST'))[0], 202);
  const error = await waitFor('error');
  assert.equal(error.exitCode, 17);
  assert.match(error.output, /Update failed: test/);
  assert.doesNotMatch(error.output, /\x1b\[/);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
});
