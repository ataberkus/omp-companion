import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('plugin management lists, toggles, and validates actions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-plugins-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // ompBin() is `node`, so the first CLI arg is a script resolved against cwd (dataDir).
  // State lives in a JSON file because every `omp plugin …` call is a fresh process.
  await writeFile(join(dir, 'plugin'), [
    `const fs = require('node:fs');`,
    `const stateFile = ${JSON.stringify(join(dir, 'plugin-state.json'))};`,
    `const argsFile = ${JSON.stringify(join(dir, 'plugin-args.json'))};`,
    `const args = process.argv.slice(2);`,
    `fs.appendFileSync(argsFile, JSON.stringify(args) + "\\n");`,
    `const fail = how => { console.error('Error: plugin ' + how); process.exit(1); };`,
    `let enabled = true;`,
    `try { enabled = JSON.parse(fs.readFileSync(stateFile, 'utf8')).enabled; } catch {}`,
    `const entry = () => ({ scope: 'user', version: '4.9.0', enabled });`,
    `const list = () => console.log(JSON.stringify({ npm: [], marketplace: [{ id: 'ponytail@ponytail', scope: 'user', entries: [entry()] }] }));`,
    `if (args.join(' ').startsWith('list --json')) list();`,
    `else if (args.join(' ') === 'discover') console.log('Available Plugins:\\n\\n  ponytail@4.9.0\\n    Test plugin.\\n');`,
    `else if (['install', 'uninstall', 'enable', 'disable'].includes(args[0])) {`,
    `  if (args[1] === 'missing@missing' || args[1] === 'broken') fail('not found');`,
    `  if (args[0] === 'enable' || args[0] === 'install') enabled = true;`,
    `  if (args[0] === 'disable' || args[0] === 'uninstall') enabled = false;`,
    `  fs.writeFileSync(stateFile, JSON.stringify({ enabled }));`,
    `  list();`,
    `} else fail('unsupported');`,
    ``,
  ].join('\n'));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body, token = app.token) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };

  assert.equal((await request('/plugins', { action: 'enable', id: 'x' }, 'wrong-token'))[0], 401);
  const [, listed] = await request('/plugins');
  assert.equal(listed.plugins.length, 1);
  assert.equal(listed.plugins[0].id, 'ponytail@ponytail');
  assert.equal(listed.plugins[0].enabled, true);
  assert.equal(listed.plugins[0].description, 'Test plugin.');
  assert.ok(listed.available.some(a => a.id === 'ponytail@4.9.0'));

  const calls = async () => (await readFile(join(dir, 'plugin-args.json'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const [, disabled] = await request('/plugins', { action: 'disable', id: 'ponytail@ponytail' });
  assert.ok((await calls()).some(a => JSON.stringify(a) === JSON.stringify(['disable', 'ponytail@ponytail'])));
  assert.equal(disabled.plugins[0].enabled, false);
  const [, enabled] = await request('/plugins', { action: 'enable', id: 'ponytail@ponytail', scope: 'project' });
  assert.ok((await calls()).some(a => JSON.stringify(a) === JSON.stringify(['enable', 'ponytail@ponytail', '--scope', 'project'])));
  assert.equal(enabled.plugins[0].enabled, true);

  assert.equal((await request('/plugins', { action: 'bogus', id: 'ponytail@ponytail' }))[0], 400);
  assert.equal((await request('/plugins', { action: 'enable', id: 'missing@missing' }))[0], 400);
  assert.equal((await request('/plugins', { action: 'install', id: 'broken' }))[0], 400);
  assert.equal((await request('/plugins', { action: 'install', id: 'evil; rm -rf' }))[0], 400);
  assert.equal((await request('/plugins', { action: 'enable', id: 'evil; rm -rf' }))[0], 400);
  assert.equal((await request('/plugins', { action: 'enable', id: 'ponytail@ponytail', scope: 'global' }))[0], 400);
});
