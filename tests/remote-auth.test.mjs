import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// node:http, not fetch: fetch cannot set the Host header.
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
    let body = '';
    res.setEncoding('utf8').on('data', c => { body += c; }).on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject).end();
});

async function start(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-remote-auth-'));
  const app = await createCompanion({ dataDir, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '0.0.0.0');
  await once(app.server, 'listening');
  return app.server.address().port;
}

test('OMP_WEB_PASSWORD is the only credential and is never served in the page, even with no-token mode on', async t => {
  const port = await start(t, { password: 'correct horse battery', exposeToken: true });
  assert.equal((await get(port, '/api/state')).status, 401);
  const wrong = await get(port, '/api/state', { Authorization: 'Bearer correct horse batterz' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /Wrong password/);
  assert.equal((await get(port, '/api/state', { Authorization: 'Bearer correct horse battery' })).status, 200);
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /omp-token|correct horse/);
});

test('a password the browser could not send is refused at start', async () => {
  for (const password of [' padded', 'padded ', 'pässword']) await assert.rejects(createCompanion({ dataDir: join(tmpdir(), 'unused'), password }), /OMP_WEB_PASSWORD/);
});

test('OMP_WEB_PUBLIC_HOSTS names pass Host and Origin by exact match; other names stay refused', async t => {
  const port = await start(t, { password: 'pw-1234', publicHosts: ['My-PC.tail1234.ts.net'] });
  const auth = { Authorization: 'Bearer pw-1234' };
  const name = `my-pc.tail1234.ts.net:${port}`;
  assert.equal((await get(port, '/api/state', { ...auth, Host: name })).status, 200);
  assert.equal((await get(port, '/api/state', { ...auth, Host: name, Origin: `http://${name}` })).status, 200);
  for (const host of [`evil.example:${port}`, `x.my-pc.tail1234.ts.net:${port}`, `my-pc.tail1234.ts.net:${port + 1}`]) {
    const res = await get(port, '/api/state', { ...auth, Host: host });
    assert.equal(res.status, 403, host);
    assert.match(res.body, /Invalid Host header/);
  }
  assert.equal((await get(port, '/api/state', { ...auth, Host: name, Origin: 'http://evil.example' })).status, 403);
});

test('a public host entry that is not a bare name is refused at start', async () => {
  for (const h of ['http://pc.ts.net', 'pc.ts.net:4545']) await assert.rejects(createCompanion({ dataDir: join(tmpdir(), 'unused'), publicHosts: [h] }), /OMP_WEB_PUBLIC_HOSTS/);
});
