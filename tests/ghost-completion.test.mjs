import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Boots app.js against a stub DOM; predict_word answers come from `answer(text)`, resolved when the test says so.
async function composer() {
  const session = { id: 'session', title: 'Chat', cwd: '/project', status: 'review', messages: [], queuedMessages: [], updatedAt: new Date().toISOString() };
  const listeners = new Map(), sent = [], waiting = [], timers = [];
  const node = id => ({ id, tagName: 'TEXTAREA', innerHTML: '', value: '', hidden: false, style: {}, dataset: {}, children: [], scrollHeight: 20, scrollTop: 0, clientHeight: 20, clientWidth: 600, selectionStart: 0, selectionEnd: 0, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, matches: () => false, closest: () => null, appendChild() {}, remove() {}, scrollTo() {} });
  const elements = new Map(['app', 'main', 'list', 'conn', 'input', 'ghost', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'slash', 'scroller', 'tasks', 'chatPlan', 'extras', 'questions', 'queued', 'statusLine', 'modelSlot', 'hint', 'buttons', 'imagePreview', 'toasts'].map(id => [id, node(id)]));
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
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout: (fn, ms) => { if (ms === 120) timers.push(fn); }, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url, opts) => {
      if (url === '/api/sessions/session/command') {
        const body = JSON.parse(opts.body); sent.push(body);
        if (body.type === 'predict_word') { const data = await new Promise(resolve => waiting.push({ text: body.text, resolve })); return { ok: true, status: 200, json: async () => data }; }
      }
      return { ok: true, status: 200, json: async () => structuredClone(url.startsWith('/api/state') ? { projects: [], sessions: [session], archived: [] } : url === '/api/models' ? { models: [], roles: {} } : {}) };
    },
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
  await settle();
  const input = elements.get('input'), ghost = elements.get('ghost');
  const type = async value => { input.value = value; input.selectionStart = input.selectionEnd = value.length; listeners.get('input')({ target: input }); timers.splice(0).forEach(fn => fn()); await settle(); };
  const answer = async (text, suffix) => { const i = waiting.findIndex(w => w.text === text); waiting.splice(i, 1)[0].resolve({ suffix }); await settle(); };
  const key = async k => { let prevented = false; listeners.get('keydown')({ target: input, key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() { prevented = true; } }); await settle(); return prevented; };
  const shown = () => ghost.hidden ? null : ghost.innerHTML.match(/<i>(.*)<\/i>/)?.[1];
  return { input, type, answer, key, shown, sent };
}

test('Tab accepts the suggested rest of the word and reports it accepted', async () => {
  const c = await composer();
  await c.type('refactor the compon');
  await c.answer('refactor the compon', 'ents');
  assert.equal(c.shown(), 'ents');
  assert.equal(await c.key('Tab'), true);
  assert.equal(c.input.value, 'refactor the components');
  assert.equal(c.shown(), null);
  assert.deepEqual(c.sent.filter(b => b.type === 'predict_word_feedback').map(b => [b.text, b.suggestion, b.accepted]), [['refactor the compon', 'ents', true]]);
});

test('a reply for an older draft never shows', async () => {
  const c = await composer();
  await c.type('check the doc');
  await c.type('check the docu');
  await c.answer('check the doc', 'ument');
  assert.equal(c.shown(), null);
  await c.answer('check the docu', 'ment');
  assert.equal(c.shown(), 'ment');
});

test('typing its letters narrows the suggestion; typing past it rejects it', async () => {
  const c = await composer();
  await c.type('the compon');
  await c.answer('the compon', 'ents');
  await c.type('the compone');
  assert.equal(c.shown(), 'nts');
  assert.equal(c.sent.filter(b => b.type === 'predict_word').length, 1);
  await c.type('the componex');
  assert.equal(c.shown(), null);
  assert.deepEqual(c.sent.filter(b => b.type === 'predict_word_feedback').map(b => [b.text, b.suggestion, b.accepted]), [['the compon', 'ents', false]]);
  assert.equal(await c.key('Tab'), false);
});

test('typing the whole suggestion out counts as accepted; backspace and Esc send no feedback', async () => {
  const c = await composer();
  const feedback = () => c.sent.filter(b => b.type === 'predict_word_feedback').map(b => [b.text, b.suggestion, b.accepted]);
  await c.type('the docu');
  await c.answer('the docu', 'ment');
  await c.type('the docum');
  await c.type('the docume');
  await c.type('the documen');
  await c.type('the document');
  assert.deepEqual(feedback(), [['the docu', 'ment', true]]);
  await c.type('the compon');
  await c.answer('the compon', 'ents');
  await c.type('the compo');
  assert.equal(c.shown(), null);
  await c.answer('the compo', 'nent');
  assert.equal(await c.key('Escape'), true);
  assert.equal(c.shown(), null);
  assert.deepEqual(feedback(), [['the docu', 'ment', true]]);
});
