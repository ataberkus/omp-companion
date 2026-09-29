import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the dashboard unchanged; only browser I/O is replaced for this sidebar check.
test('pending questions take review priority until the last question clears', async () => {
  const session = { id: 'session', title: 'Chat', cwd: '/project', status: 'running', updatedAt: new Date().toISOString() };
  const store = { projects: [], sessions: [session], archived: [] };
  const listeners = new Map(), timers = new Map();
  const node = () => ({ innerHTML: '', value: '', style: {}, scrollHeight: 20, classList: { remove() {}, toggle() {} }, addEventListener() {}, focus() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'disconnect'].map(id => [id, node()]));
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    querySelectorAll: () => [],
    addEventListener: (type, fn, capture) => { if (!capture) listeners.set(type, fn); },
  };
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document, window: { addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: '#/s/unopened', pathname: '/' }, URLSearchParams,
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout: fn => timers.set(fn.name, fn),
    fetch: async url => ({ ok: true, status: 200, json: async () => structuredClone(url === '/api/state' ? store : url === '/api/models' ? { models: [], roles: {} } : { sessions: [] }) }),
  });
  await new Promise(setImmediate);
  const groups = () => new Map([...elements.get('list').innerHTML.matchAll(/<div class="group-label">([^<]+)<\/div>([\s\S]*?)(?=<div class="group-label">|$)/g)]
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
