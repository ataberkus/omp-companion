import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('GET /api/browse keeps default behavior without files=1, includes files with files=1, and GET /api/files searches cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-ios-browse-'));
  const ws = join(dir, 'repo');
  await mkdir(join(ws, 'src', 'nested'), { recursive: true });
  await mkdir(join(ws, '.git'), { recursive: true });
  await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(ws, 'README.md'), '# hello');
  await writeFile(join(ws, 'src', 'app.swift'), '// swift');
  await writeFile(join(ws, 'src', 'nested', 'helper.ts'), '// ts');
  await writeFile(join(ws, '.hidden'), 'secret');
  await writeFile(join(ws, 'node_modules', 'pkg', 'index.js'), '');

  const dataDir = join(dir, 'data');
  const app = await createCompanion({
    dataDir,
    omp: fakeOmp(() => ({})),
    networkInterfaces: () => ({
      Tailscale: [{ family: 'IPv4', address: '100.114.117.34', internal: false }],
    }),
    tailscale: async () => ({ name: 'my-workstation.tail1234.ts.net', ips: ['100.114.117.34'] }),
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const auth = { Authorization: `Bearer ${app.token}` };

  const browsePlain = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(ws)}`, { headers: auth }).then(r => r.json());
  assert.equal(browsePlain.files, undefined);
  assert.deepEqual(browsePlain.dirs.map(d => d.name), ['src']);

  const browseWithFiles = await fetch(`http://127.0.0.1:${port}/api/browse?path=${encodeURIComponent(ws)}&files=1`, { headers: auth }).then(r => r.json());
  assert.deepEqual(browseWithFiles.files.map(f => f.name), ['README.md']);

  const searchAll = await fetch(`http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(ws)}`, { headers: auth }).then(r => r.json());
  assert.deepEqual(searchAll.files.map(f => f.rel).sort(), ['README.md', 'src/app.swift', 'src/nested/helper.ts']);

  const searchSwift = await fetch(`http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(ws)}&q=app.swift`, { headers: auth }).then(r => r.json());
  assert.deepEqual(searchSwift.files.map(f => f.rel), ['src/app.swift']);

  const searchDot = await fetch(`http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(ws)}&q=.hidden`, { headers: auth }).then(r => r.json());
  assert.deepEqual(searchDot.files.map(f => f.rel), ['.hidden']);

  const tsUnauth = await fetch(`http://127.0.0.1:${port}/api/tailscale`);
  assert.equal(tsUnauth.status, 401);

  const tsInfo = await fetch(`http://127.0.0.1:${port}/api/tailscale`, { headers: auth }).then(r => r.json());
  assert.equal(tsInfo.port, port);
  assert.equal(tsInfo.tailscale.name, 'my-workstation.tail1234.ts.net');
  assert.ok(tsInfo.tailnetUrls.includes(`http://my-workstation.tail1234.ts.net:${port}`));
  assert.ok(tsInfo.tailnetUrls.includes(`http://100.114.117.34:${port}`));
  assert.ok(!JSON.stringify(tsInfo).includes(app.token), 'tailscale endpoint must never include bearer token');
});

test('web dashboard includes Pair iOS App button and valid SVG QR generator', async () => {
  const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
  assert.match(source, /data-act="pairIos"/);
  assert.match(source, /function qrSvg\(/);
  assert.match(source, /omp:\/\/connect\?/);

  const fnMatch = source.match(/function qrSvg\(text\) \{[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'qrSvg function extracted');
  const ctx = { TextEncoder };
  runInNewContext(`${fnMatch[0]}; globalThis.qrSvg = qrSvg;`, ctx);
  const svg = ctx.qrSvg('omp://connect?url=http%3A%2F%2Fmy-pc.tail1234.ts.net%3A4545&name=PC&token=0123456789abcdef');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path fill="#111" d="(?:M\d+,\d+h1v1h-1z)+"\/>/);
});
