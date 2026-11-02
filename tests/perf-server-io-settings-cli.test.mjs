import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// Settings, the advisor and the model list start as few omp CLI processes as they need: `config path` once (again after a
// failure), validation from `config list --json` alone, and one `models --json` for concurrent requests. Values always
// come from a fresh listing.
test('settings routes start only the omp CLI runs they need', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-settings-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // No WATCHDOG.yml or config.yml of this machine's OMP.
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  const log = join(dir, 'calls.log'), state = join(dir, 'state.json'), cli = join(dir, 'omp');
  await writeFile(state, JSON.stringify({ foo: false, pathFails: 1 }));
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2), st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const defaults = String(process.env.PI_CODING_AGENT_DIR || '').includes('omp-web-defaults-');
if (args[0] === 'config' || args[0] === 'models') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(defaults ? ['defaults', ...args] : args) + '\\n');
const key = args.join(' ');
if (key === 'config list --json') console.log(JSON.stringify({ foo: { type: 'boolean', value: defaults ? false : st.foo, description: 'Foo' }, 'advisor.enabled': { type: 'boolean', value: true }, modelRoles: { type: 'record', value: { advisor: 'p/advisor' } } }));
else if (key === 'config list') console.log('[general]\\n  foo = ' + st.foo + ' (true|false)');
else if (key === 'config path') { if (st.pathFails-- > 0) { fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.exit(1); } console.log('/fake/config.yml'); }
else if (args[0] === 'config' && args[1] === 'set') { st[args[2]] = JSON.parse(args[3]); fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); }
else if (key === 'models --json') setTimeout(() => console.log(JSON.stringify({ models: [{ provider: 'p', id: 'm', name: 'M' }] })), 300);
`);
  await chmod(cli, 0o755);
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp(), ompCommand: cli });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`, H = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const get = async p => { const r = await fetch(base + p, { headers: H }); assert.equal(r.status, 200, p); return r.json(); };
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); assert.equal(r.status, 200, p); return r.json(); };
  let seen = 0;
  const runs = async () => { const all = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean); const out = all.slice(seen).map(l => JSON.parse(l).join(' ')).sort(); seen = all.length; return out; };

  // The defaults list once; `config path` fails the first time and is asked again next time.
  let r = await get('/settings');
  assert.equal(r.file, '');
  assert.deepEqual(r.settings.find(x => x.key === 'foo'), { key: 'foo', type: 'boolean', group: 'general', options: ['true', 'false'], description: 'Foo', sensitive: false, value: false, isSet: true, default: false, modified: false });
  assert.deepEqual(await runs(), ['config list', 'config list --json', 'config path', 'defaults config list --json']);
  r = await get('/settings');
  assert.equal(r.file, '/fake/config.yml');
  assert.deepEqual(await runs(), ['config list', 'config list --json', 'config path']);
  assert.equal((await get('/settings')).file, '/fake/config.yml');
  assert.deepEqual(await runs(), ['config list', 'config list --json']);

  // A change is validated against `config list --json` alone; its reply lists the settings afresh.
  r = await post('/settings', { key: 'foo', value: true });
  assert.equal(r.changed, 'foo');
  assert.equal(r.settings.find(x => x.key === 'foo').value, true);
  assert.equal(r.file, '/fake/config.yml');
  assert.deepEqual(await runs(), ['config list', 'config list --json', 'config list --json', 'config set foo true']);
  assert.deepEqual(await get('/advisor'), { model: 'p/advisor', source: 'advisor role', enabled: true });
  assert.deepEqual(await runs(), ['config list --json']);

  // Concurrent model lists share one run; a settings change makes the next one run again.
  const lists = await Promise.all([get('/models'), get('/models'), get('/models')]);
  assert.deepEqual(lists[0].models.map(m => m.selector), ['p/m']);
  assert.deepEqual(lists[1], lists[0]);
  assert.deepEqual(await runs(), ['models --json']);
  await get('/models');
  assert.deepEqual(await runs(), []);
  await post('/settings', { key: 'foo', value: false });
  await runs();
  await get('/models');
  assert.deepEqual(await runs(), ['models --json']);
});
