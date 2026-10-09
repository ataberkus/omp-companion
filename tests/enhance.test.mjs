import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const seq = list => () => list.length > 1 ? list.shift() : list[0];

// Runs the real dashboard against a tiny DOM (as frontend-interaction.test.mjs), plus queued timers and recorded toasts.
async function boot({ hash = '#/s/a', sessions = [], routes = {}, home } = {}) {
  const location = { hash, pathname: '/', search: '' };
  const listeners = [], winListeners = new Map(), calls = [], elements = new Map(), created = [], timers = [];
  const document = { activeElement: null };
  const node = (id = '', extra = {}) => ({
    id, tagName: 'DIV', innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, children: [], attrs: {}, hidden: false, isConnected: true, readOnly: false,
    scrollHeight: 20, scrollTop: 0, clientHeight: 20, clientWidth: 600, offsetHeight: 10, offsetWidth: 10, selectionStart: 0, selectionEnd: 0,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false,
    focus() { document.activeElement = this; }, appendChild(c) { this.children.push(c); if (c.id) elements.set(c.id, c); c.isConnected = true; },
    remove() { if (elements.get(this.id) === this) elements.delete(this.id); this.isConnected = false; },
    scrollTo() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0 }),
    ...extra,
  });
  for (const id of ['app', 'main', 'list', 'conn', 'input', 'ghost', 'enhanceSlot', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'search', 'slash', 'scroller', 'tasks', 'chatPlan', 'extras', 'questions', 'queued', 'statusLine', 'modelSlot', 'hint', 'buttons', 'imagePreview', 'toasts', 'promptRail', 'home', 'homePrompt']) elements.set(id, node(id));
  elements.get('input').tagName = 'TEXTAREA';
  Object.assign(document, {
    hidden: false, body: node('body'),
    getElementById: id => elements.get(id) || null,
    querySelector: s => /^#[\w-]+$/.test(s) ? elements.get(s.slice(1)) || null : null,
    querySelectorAll: () => [],
    createElement: tag => { const n = node('', { tagName: tag.toUpperCase() }); created.push(n); return n; },
    addEventListener: (type, fn) => listeners.push([type, fn]),
  });
  const reply = (url, body) => {
    const path = url.slice(4).split('?')[0];
    if (routes[path]) return routes[path](body, url);
    if (path === '/state') return { projects: [], sessions, archived: [] };
    if (path === '/models') return { models: [], roles: {} };
    if (path === '/omp-sessions') return { sessions: [] };
    return {};
  };
  const ctx = {
    document, location, window: { innerHeight: 900, addEventListener: (type, fn) => winListeners.set(type, fn) }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    history: { replaceState() {} }, URLSearchParams, AbortSignal, CSS: { escape: s => String(s) },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} }, confirm: () => true,
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body });
      const data = await reply(url, body);
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
  };
  runInNewContext(source, ctx);
  await flush();
  const fire = async (type, e) => { for (const [t, fn] of listeners) if (t === type) fn({ preventDefault() {}, stopPropagation() {}, ...e }); await flush(); };
  const target = (map = {}, extra = {}) => node(extra.id || '', { tagName: 'BUTTON', closest: sel => map[sel] ?? null, ...extra });
  const act = (name, data = {}) => target({ '[data-act]': node('', { dataset: { act: name, ...data } }) });
  const input = elements.get('input');
  const key = (k, mods = {}, t = input) => fire('keydown', { target: t, key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const go = async h => { location.hash = h; winListeners.get('hashchange')(); await flush(); };
  const type = async v => { input.value = v; input.selectionStart = input.selectionEnd = v.length; await fire('input', { target: input }); };
  // Runs only the 500 ms enhance polls (ghost-text predictions use other delays).
  const runPolls = async () => { for (let i = 0; i < 20; i++) { const due = timers.filter(t => t.ms === 500); if (!due.length) return; timers.splice(0, timers.length, ...timers.filter(t => t.ms !== 500)); for (const t of due) t.fn(); await flush(); } };
  const toasts = () => created.filter(n => /\btoast\b/.test(n.className || ''));
  const toastAction = label => { const b = created.find(n => n.className === 'toast-act' && n.textContent === label); assert.ok(b, `toast action "${label}"`); b.onclick(); };
  const posts = path => calls.filter(c => c.url.split('?')[0] === '/api' + path && c.body).map(c => c.body);
  return { elements, calls, fire, act, key, go, type, input, runPolls, timers, toasts, toastAction, posts, location };
}
const idle = (id, extra = {}) => ({ id, title: id, cwd: '/p', status: 'paused', messages: [], queuedMessages: [], updatedAt: new Date().toISOString(), ...extra });

test('Enhance replaces the draft, Undo restores it, Send is blocked meanwhile', async () => {
  const polls = seq([{ status: 'running', step: 'reading src/a.js', model: 'p/m' }, { status: 'done', text: 'Better' }]);
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => body ? { id: 'j', model: 'p/m' } : polls() } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: 'fix it' }]);
  assert.ok(d.calls.some(c => c.url === '/api/commands?session=a'), 'OMP is started alongside');
  assert.equal(d.input.readOnly, true);
  assert.match(d.elements.get('statusLine').innerHTML, /Enhancing with m · reading src\/a\.js…/);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /Cancel/);
  await d.key('Enter');
  assert.ok(!d.calls.some(c => c.body?.type === 'prompt'), 'Enter does not send while enhancing');
  await d.runPolls();
  assert.equal(d.input.value, 'Better');
  assert.equal(d.input.readOnly, false);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /Enhance/);
  d.toastAction('Undo');
  assert.equal(d.input.value, 'fix it');
});

test('an edited draft is not overwritten; the offer toast applies it', async () => {
  const polls = seq([{ status: 'running', step: '' }, { status: 'done', text: 'Better' }]);
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => body ? { id: 'j', model: 'p/m' } : polls() } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  d.input.value = 'fix it now';
  await d.runPolls();
  assert.equal(d.input.value, 'fix it now');
  d.toastAction('Use enhanced prompt');
  assert.equal(d.input.value, 'Better');
});

test('Ctrl+Shift+E starts and cancels; slash and shell drafts are ignored', async () => {
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => body ? { id: 'j', model: 'p/m' } : { status: 'running', step: '' }, '/enhance/stop': () => ({ status: 'cancelled' }) } });
  const shortcut = () => d.key('E', { ctrlKey: true, shiftKey: true, code: 'KeyE' });
  for (const draft of ['/compact', '!ls', '   ']) { await d.type(draft); await shortcut(); }
  assert.deepEqual(d.posts('/enhance'), []);
  await d.type('go');
  await shortcut();
  assert.equal(d.posts('/enhance').length, 1);
  await shortcut();
  assert.deepEqual(d.posts('/enhance/stop'), [{ id: 'j' }]);
  assert.equal(d.input.readOnly, false);
  assert.equal(d.toasts().length, 0, 'cancel is silent');
});

test('poll failure stops polling with one error toast', async () => {
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => { if (body) return { id: 'j', model: 'p/m' }; throw new Error('gone'); } } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  await d.runPolls();
  assert.equal(d.toasts().filter(t => /\berr\b/.test(t.className)).length, 1);
  assert.equal(d.timers.filter(t => t.ms === 500).length, 0, 'no further polls');
  assert.equal(d.input.readOnly, false);
  assert.equal(d.input.value, 'fix it');
});

test('history view enhances in its folder with the chosen model', async () => {
  const file = 'C:/s/x.jsonl';
  const d = await boot({ hash: '#/f/' + encodeURIComponent(file), routes: { '/omp-sessions': () => ({ sessions: [{ file, cwd: 'C:/proj', title: 'x', model: 'p/a', updatedAt: new Date().toISOString() }] }), '/omp-sessions/preview': () => ({ file, cwd: 'C:/proj', messages: [] }), '/enhance': body => body ? { id: 'j', model: 'p/a' } : { status: 'running', step: '' } } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance'), [{ path: 'C:/proj', model: 'p/a', text: 'fix it' }]);
});
