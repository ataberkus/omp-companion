import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

for (const kind of ['session', 'home']) test(`${kind} slash completion finds skills by bare name and inserts the qualified command`, async () => {
  const session = { id: 'session', title: 'Chat', cwd: '/project', status: 'paused', messages: [], updatedAt: new Date().toISOString() };
  const commands = [
    { name: 'review', aliases: ['inspect'] },
    { name: 'skill:frontend-design', aliases: [] },
    { name: 'skill:ponytail', aliases: [] },
    ...Array.from({ length: 9 }, (_, i) => ({ name: 'command-' + i, aliases: [] })),
  ];
  const listeners = new Map();
  const node = id => ({ id, tagName: 'TEXTAREA', innerHTML: '', value: '', style: {}, dataset: {}, children: [], scrollHeight: 20, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], focus() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'slash', 'scroller', 'tasks', 'chatPlan', 'extras', 'questions', 'queued', 'statusLine', 'modelSlot', 'hint', 'buttons', 'imagePreview'].map(id => [id, node(id)]));
  if (kind === 'home') { elements.delete('input'); for (const id of ['home', 'homePrompt', 'pathInput']) elements.set(id, node(id)); }
  const document = {
    hidden: false,
    getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.slice(1)) || null,
    querySelectorAll: () => [],
    addEventListener: (type, fn, capture) => { if (!capture) listeners.set(type, fn); },
  };
  runInNewContext(await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8'), {
    document, window: { innerHeight: 900, addEventListener() {} }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location: { hash: kind === 'home' ? '#/new' : '#/s/session', pathname: '/' }, URLSearchParams, AbortSignal,
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async url => ({ ok: true, status: 200, json: async () => structuredClone(
      url.startsWith('/api/state') ? { projects: [], sessions: [session], archived: [] }
        : url === '/api/models' ? { models: [], roles: {} }
        : url.startsWith('/api/browse') ? { roots: [], recent: [], path: '/project', dirs: [] }
        : url.startsWith('/api/commands?') ? { commands } : { sessions: [] }) }),
  });
  await new Promise(setImmediate);
  if (kind === 'home') {
    elements.get('pathInput').value = '/project';
    listeners.get('submit')({ target: { id: 'pathForm', hasAttribute: () => false, dataset: {} }, preventDefault() {} });
    await new Promise(setImmediate);
  }
  const input = elements.get(kind === 'home' ? 'homePrompt' : 'input'), slash = elements.get('slash');
  const complete = async value => {
    input.value = value;
    listeners.get('input')({ target: input });
    await new Promise(setImmediate);
    return slash.hidden ? [] : [...slash.innerHTML.matchAll(/data-slash="([^"]+)"/g)].map(([, name]) => name);
  };

  assert.deepEqual(await complete('/'), commands.map(c => c.name));
  assert.deepEqual(await complete('/front'), ['skill:frontend-design']);
  assert.deepEqual(await complete('/FRONT'), ['skill:frontend-design']);
  assert.deepEqual(await complete('/skill:fr'), ['skill:frontend-design']);
  assert.deepEqual(await complete('/pony'), ['skill:ponytail']);
  assert.deepEqual(await complete('/rev'), ['review']);
  assert.deepEqual(await complete('/insp'), ['review']);
  assert.deepEqual(await complete('/front arguments'), []);
  await complete('/front');
  listeners.get('keydown')({ target: input, key: 'Tab', preventDefault() {} });
  assert.equal(input.value, '/skill:frontend-design ');
  assert.equal(slash.hidden, true);
  await complete('/skill');
  listeners.get('keydown')({ target: input, key: 'ArrowDown', preventDefault() {} });
  listeners.get('keydown')({ target: input, key: 'Enter', preventDefault() {} });
  assert.equal(input.value, '/skill:ponytail ');
  await complete('/front');
  listeners.get('keydown')({ target: input, key: 'Escape', preventDefault() {} });
  assert.equal(slash.hidden, true);
});
