import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createCompanion } from '../companion/server.mjs';

test('sessions can be pinned and unpinned, pins persist and exclude archiving', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-pin-'));
  const now = new Date().toISOString();
  await writeFile(join(dataDir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'panel', title: 'Chat', status: 'paused', cwd: dataDir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  let app = await createCompanion({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const start = async () => { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); };
  const saved = async () => JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
  await start();

  const file = 'f:' + join(dataDir, 'native.jsonl');
  assert.deepEqual((await call('/state')).data.pinned, []);
  assert.deepEqual((await call('/pin', { key: file })).data.pinned, [file]);
  assert.deepEqual((await call('/pin', { key: 's:panel', pinned: true })).data.pinned, [file, 's:panel']);
  assert.deepEqual((await call('/pin', { key: file })).data.pinned, [file, 's:panel'], 'pinning twice keeps one entry');
  assert.equal((await call('/pin', { key: 'bogus' })).status, 400);
  assert.equal((await call('/pin', { key: 's:missing' })).status, 404);
  assert.deepEqual((await saved()).pinned, [file, 's:panel']);

  await app.close();
  app = await createCompanion({ dataDir });
  await start();
  assert.deepEqual((await call('/state')).data.pinned, [file, 's:panel']);

  // Archiving a pinned session unpins it; pinning an archived one restores it.
  assert.deepEqual((await call('/archive', { key: 's:panel' })).data, { archived: ['s:panel'], pinned: [file] });
  assert.deepEqual((await call('/pin', { key: 's:panel' })).data, { archived: [], pinned: [file, 's:panel'] });

  assert.deepEqual((await call('/pin', { key: file, pinned: false })).data.pinned, ['s:panel']);
  assert.deepEqual((await call('/pin', { key: 's:panel', pinned: false })).data.pinned, []);
  assert.deepEqual((await saved()).pinned, []);
});

// The real dashboard in a vm; /api/pin is answered like the companion does.
async function dashboard(store, storage = {}) {
  const listeners = new Map(), timers = new Map(), posts = [], toasts = [];
  const node = () => ({ innerHTML: '', value: '', style: {}, dataset: {}, scrollHeight: 20, classList: { remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, focus() {}, remove() {}, appendChild(child) { toasts.push(child); } });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'toasts'].map(id => [id, node()]));
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    querySelectorAll: () => [],
    createElement: () => ({ ...node(), children: [], appendChild(child) { this.children.push(child); } }),
    addEventListener: (type, fn, capture) => { if (!capture) listeners.set(type, fn); },
  };
  const reply = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document, window: { addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: '#/s/unopened', pathname: '/' }, URLSearchParams, AbortSignal,
    localStorage: { getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; } }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout: fn => timers.set(fn.name, fn), ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url, opts) => {
      if (url === '/api/pin') {
        const { key, pinned } = JSON.parse(opts.body);
        posts.push({ key, pinned });
        store.pinned = pinned ? [...new Set([...store.pinned, key])] : store.pinned.filter(k => k !== key);
        if (pinned) store.archived = store.archived.filter(k => k !== key);
        return reply({ archived: store.archived, pinned: store.pinned });
      }
      return reply(url.startsWith('/api/state') ? store : url === '/api/models' ? { models: [], roles: {} } : { sessions: [] });
    },
  });
  await new Promise(setImmediate);
  const groups = () => [...elements.get('list').innerHTML.matchAll(/data-group="([^"]+)"[\s\S]*?<\/button>([\s\S]*?)(?=<button\b[^>]*\bdata-group=|$)/g)]
    .map(([, label, html]) => [label, [...html.matchAll(/data-key="([^"]+)"/g)].map(([, key]) => key)]);
  const click = (attr, dataset) => listeners.get('click')({ preventDefault() {}, target: { closest: selector => selector === `[${attr}]` ? { dataset } : null } });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
  return { groups, click, settle, posts, toasts, refresh: () => timers.get('loop')() };
}

const session = (id, extra = {}) => ({ id, title: 'Chat ' + id, cwd: '/project', status: 'paused', updatedAt: new Date().toISOString(), ...extra });

test('pinned sessions render in their own group on top, not in their date group', async () => {
  const yesterday = new Date(new Date().setHours(0, 0, 0, 0) - 3600000).toISOString();
  const store = { projects: [], sessions: [session('a'), session('b', { updatedAt: new Date(Date.now() - 1000).toISOString() }), session('old', { updatedAt: yesterday }), session('run', { status: 'running' })], archived: [], pinned: ['s:old'] };
  const storage = {};
  const ui = await dashboard(store, storage);
  assert.deepEqual(ui.groups(), [['Pinned', ['s:old']], ['Working now', ['s:run']], ['Today', ['s:a', 's:b']]]);

  // Pinning from the row moves the session up at once, persists it via /api/pin, and Undo unpins it.
  ui.click('data-pin', { pin: 's:b', unpin: '' });
  assert.deepEqual(ui.groups()[0], ['Pinned', ['s:b', 's:old']]);
  await ui.settle();
  assert.deepEqual(ui.posts, [{ key: 's:b', pinned: true }]);
  assert.deepEqual(store.pinned, ['s:old', 's:b']);
  const toast = ui.toasts.at(-1);
  assert.equal(toast.textContent, 'Session pinned');
  toast.children[0].onclick();
  await ui.settle();
  assert.deepEqual(ui.posts.at(-1), { key: 's:b', pinned: false });
  assert.deepEqual(ui.groups(), [['Pinned', ['s:old']], ['Working now', ['s:run']], ['Today', ['s:a', 's:b']]]);

  // The Pinned group collapses like the others.
  ui.click('data-group', { group: 'Pinned' });
  assert.deepEqual(ui.groups()[0], ['Pinned', []]);
  ui.click('data-group', { group: 'Pinned' });

  // Filters apply to pinned sessions too: a paused pin is not "Active".
  ui.click('data-filter', { filter: 'active' });
  assert.deepEqual(ui.groups(), [['Working now', ['s:run']]]);
  ui.click('data-filter', { filter: 'all' });

  // Grouped by project, pinned sessions lead their folder instead of getting a group.
  storage['omp-group-by'] = 'project';
  const byProject = await dashboard(store, storage);
  assert.deepEqual(byProject.groups(), [['/project', ['s:old', 's:run', 's:a', 's:b']]]);
});
