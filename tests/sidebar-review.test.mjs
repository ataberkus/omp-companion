import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the dashboard unchanged; only browser I/O is replaced for this sidebar check.
test('pending questions take review priority until the last question clears', async () => {
  const session = { id: 'session', title: 'Chat', cwd: '/project', status: 'running', updatedAt: new Date().toISOString() };
  const store = { projects: [], sessions: [session], archived: [] };
  const listeners = new Map(), timers = new Map();
  const node = () => ({ innerHTML: '', value: '', style: {}, scrollHeight: 20, classList: { remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, focus() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect'].map(id => [id, node()]));
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    querySelectorAll: () => [],
    addEventListener: (type, fn, capture) => { if (!capture) listeners.set(type, fn); },
  };
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document, window: { addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: '#/s/unopened', pathname: '/' }, URLSearchParams, AbortSignal,
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout: fn => timers.set(fn.name, fn), ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async url => ({ ok: true, status: 200, json: async () => structuredClone(url.startsWith('/api/state') ? store : url === '/api/models' ? { models: [], roles: {} } : { sessions: [] }) }),
  });
  await new Promise(setImmediate);
  const groups = () => new Map([...elements.get('list').innerHTML.matchAll(/data-group="([^"]+)"[\s\S]*?<\/button>([\s\S]*?)(?=<button\b[^>]*\bdata-group=|$)/g)]
    .map(([, label, html]) => [label, [...html.matchAll(/data-key="([^"]+)"/g)].map(([, key]) => key)]));
  const refresh = async () => { await timers.get('loop')(); };
  const filter = value => listeners.get('click')({ target: { closest: selector => selector === '[data-filter]' ? { dataset: { filter: value } } : null } });

  assert.deepEqual(groups().get('Working now'), ['s:session']);
  session.uiRequests = [{ id: 'first' }, { id: 'second' }];
  await refresh();
  assert.deepEqual(groups().get('Needs your review'), ['s:session']);
  assert.equal(groups().has('Working now'), false);
  assert.equal(session.status, 'running');

  session.uiRequests.shift();
  await refresh();
  assert.deepEqual(groups().get('Needs your review'), ['s:session']);
  session.uiRequests = [];
  await refresh();
  assert.deepEqual(groups().get('Working now'), ['s:session']);
  assert.equal(groups().has('Needs your review'), false);

  // Idle extension/login prompts must stay visible, including previously archived sessions.
  session.status = 'paused';
  session.uiRequests = [{ id: 'login' }];
  store.archived = ['s:session'];
  await refresh();
  assert.deepEqual(groups().get('Needs your review'), ['s:session']);
  filter('active');
  assert.deepEqual(groups().get('Needs your review'), ['s:session']);
  session.uiRequests = [];
  await refresh();
  assert.equal(groups().size, 0);
});

// A panel session continued in a terminal: its history row merges into the panel row (no second row), the file's title
// and later time win unless the session was renamed here, and forks carry their badge.
test('a panel session\'s OMP history row merges into it: newer time and title, one row, fork badge', async () => {
  const old = new Date(Date.now() - 3 * 86400000).toISOString(), fresh = new Date().toISOString();
  const store = { projects: [], archived: [], sessions: [
    { id: 'a', title: 'Panel title', cwd: '/p', status: 'done', updatedAt: old, sessionFile: 'C:/s/a.jsonl' },
    { id: 'b', title: 'Mine', renamed: true, cwd: '/p', status: 'done', updatedAt: old, sessionFile: 'C:/s/b.jsonl' },
  ] };
  const native = { sessions: [
    { file: 'C:/s/a.jsonl', title: '🔁 REVRS: Terminal title', named: true, cwd: '/p', preview: '', updatedAt: fresh, managedId: 'a', parent: 'C:/s/p.jsonl', parentTitle: 'Parent' },
    { file: 'C:/s/b.jsonl', title: 'Terminal rename', named: true, cwd: '/p', preview: '', updatedAt: fresh, managedId: 'b' },
    { file: 'C:/s/p.jsonl', title: 'Parent', named: true, cwd: '/p', preview: '', updatedAt: old },
  ] };
  const node = () => ({ innerHTML: '', value: '', style: {}, scrollHeight: 20, classList: { remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, focus() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect'].map(id => [id, node()]));
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document: { hidden: false, getElementById: id => elements.get(id), querySelector: s => elements.get(s.slice(1)) || null, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: '#/s/unopened', pathname: '/' }, URLSearchParams, AbortSignal,
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout() {}, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async url => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => structuredClone(url.startsWith('/api/state') ? store : url === '/api/models' ? { models: [], roles: {} } : url.startsWith('/api/omp-sessions') ? native : {}) }),
  });
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  const html = elements.get('list').innerHTML;
  const today = html.slice(html.indexOf('data-group="Today"'), html.indexOf('data-group="Previous 7 days"'));
  assert.deepEqual([...today.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]), ['s:a', 's:b'], 'the terminal turn moves both to Today, one row each');
  assert.deepEqual([...html.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]).filter(k => k.startsWith('f:')), ['f:C:/s/p.jsonl'], 'only the unmanaged file is a history row');
  assert.match(today, /🔁 REVRS: Terminal title/);
  assert.match(today, /Mine/, 'a rename in the panel stays');
  assert.doesNotMatch(html, /Terminal rename/);
  assert.match(today, /class="fork" title="Forked from Parent">fork</);
});
