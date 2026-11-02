import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// Scripts, styles and icons of 1 KB or more go out gzipped to clients that accept it, each encoding with its own ETag and
// 304; the page and fonts stay raw. node:http rather than fetch, which asks for gzip and decodes it on its own.
const request = (port, path, headers = {}) => new Promise((resolve, reject) => get({ host: '127.0.0.1', port, path, headers }, res => {
  const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
}).on('error', reject));

test('static assets are gzipped per encoding, with their own validators', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-static-gzip-'));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port, gzip = { 'Accept-Encoding': 'gzip, deflate' };
  const page = await request(port, '/', gzip);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-encoding'], undefined, 'the page stays raw');
  assert.equal(page.headers.vary, undefined);
  const js = /src="(\/app\.js\?v=[^"]+)"/.exec(page.body.toString())[1], raw = await readFile(new URL('../local-dist/app.js', import.meta.url));

  const z = await request(port, js, gzip);
  assert.equal(z.status, 200);
  assert.equal(z.headers['content-encoding'], 'gzip');
  assert.equal(z.headers.vary, 'Accept-Encoding');
  assert.match(z.headers.etag, /^"[\w-]{12}-gz"$/);
  assert.equal(z.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(z.body.length < raw.length / 2);
  assert.deepEqual(gunzipSync(z.body), raw);
  assert.equal((await request(port, js, { ...gzip, 'If-None-Match': z.headers.etag })).status, 304);

  const plain = await request(port, js);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.equal(plain.headers.etag, z.headers.etag.replace('-gz', ''));
  assert.deepEqual(plain.body, raw);
  const revalidated = await request(port, js, { 'If-None-Match': plain.headers.etag });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);
  // A validator of the other encoding is not a match.
  assert.equal((await request(port, js, { 'If-None-Match': z.headers.etag })).status, 200);
  assert.equal((await request(port, js, { ...gzip, 'If-None-Match': plain.headers.etag })).status, 200);

  const css = await request(port, '/app.css', gzip);
  assert.equal(css.headers['content-encoding'], 'gzip');
  assert.equal(css.headers['cache-control'], 'no-cache', 'without ?v= the asset is revalidated');
  assert.deepEqual(gunzipSync(css.body), await readFile(new URL('../local-dist/app.css', import.meta.url)));
  for (const path of ['/favicon.svg', '/fonts/geist-latin-wght-normal.woff2']) {
    const r = await request(port, path, gzip);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined, `${path} stays raw`);
  }
});
