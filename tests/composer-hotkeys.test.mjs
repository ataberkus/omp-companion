import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function composer(status, saved) {
  const session = { id: 'session', title: 'Chat', cwd: '/project', status, messages: [], queuedMessages: [], updatedAt: new Date().toISOString() };
  const listeners = new Map(), sent = [];
  const node = id => ({ id, tagName: 'TEXTAREA', innerHTML: '', value: '', style: {}, dataset: {}, children: [], scrollHeight: 20, scrollTop: 0, clientHeight: 20, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, matches: () => false, closest: () => null, appendChild() {}, remove() {}, scrollTo() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'slash', 'scroller', 'tasks', 'chatPlan', 'extras', 'questions', 'queued', 'statusLine', 'modelSlot', 'hint', 'buttons', 'imagePreview', 'toasts'].map(id => [id, node(id)]));
  const document = {
    hidden: false, body: node('body'),
    getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    querySelectorAll: () => [],
    createElement: tag => node(tag),
    addEventListener: (type, fn, capture) => { if (!capture) listeners.set(type, fn); },
  };
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document, window: { innerHeight: 900, addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: '#/s/session', pathname: '/' }, URLSearchParams, AbortSignal,
    localStorage: { getItem: key => key === 'omp-hotkeys' && saved ? JSON.stringify(saved) : null, setItem() {} }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url, opts) => {
      if (url === '/api/sessions/session/command') sent.push(JSON.parse(opts.body).type);
      return { ok: true, status: 200, json: async () => structuredClone(url.startsWith('/api/state') ? { projects: [], sessions: [session], archived: [] } : url === '/api/models' ? { models: [], roles: {} } : { sessions: [], queuedMessages: [] }) };
    },
  });
  await new Promise(setImmediate);
  const input = elements.get('input');
  const press = async (key, mods = {}) => {
    input.value = 'x';
    listeners.get('keydown')({ target: input, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods, preventDefault() {} });
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    return sent.splice(0);
  };
  return { press, hint: () => elements.get('hint').textContent };
}

test('default hotkeys queue while OMP works and steer on plain Enter', async () => {
  const c = await composer('running');
  assert.deepEqual(await c.press('Enter', { ctrlKey: true }), ['follow_up']);
  assert.deepEqual(await c.press('Enter', { altKey: true }), ['follow_up']);
  assert.deepEqual(await c.press('q', { ctrlKey: true }), ['follow_up']);
  assert.deepEqual(await c.press('Enter'), ['steer']);
});

test('hotkeys do nothing special when OMP is idle', async () => {
  const c = await composer('paused');
  assert.deepEqual(await c.press('q', { ctrlKey: true }), []);
  assert.deepEqual(await c.press('Enter', { ctrlKey: true }), ['prompt']);
});

test('saved hotkeys replace the defaults', async () => {
  const c = await composer('running', { follow_up: 'Alt+Q', interrupt: 'Ctrl+Shift+Enter' });
  assert.deepEqual(await c.press('q', { altKey: true }), ['follow_up']);
  assert.deepEqual(await c.press('Enter', { ctrlKey: true, shiftKey: true }), ['interrupt']);
  assert.deepEqual(await c.press('q', { ctrlKey: true }), []);
  assert.deepEqual(await c.press('Enter', { ctrlKey: true }), ['steer']);
  assert.match(c.hint(), /Ctrl\+Shift\+Enter stops & sends · Alt\+Q queues/);
});

test('modifier aliases bind, but typos and bare keys never hijack typing', async () => {
  const c = await composer('running', { follow_up: 'Control+Enter', interrupt: 'Ctl+X, q, Shift+Enter' });
  assert.deepEqual(await c.press('Enter', { ctrlKey: true }), ['follow_up']);
  assert.deepEqual(await c.press('x'), []);
  assert.deepEqual(await c.press('q'), []);
  assert.deepEqual(await c.press('Enter'), ['steer']);
});
