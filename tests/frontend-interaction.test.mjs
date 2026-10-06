import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Runs the real dashboard script against a tiny DOM: elements by id, a few extra selectors, recorded fetches.
async function boot({ hash = '#/s/a', sessions = [], models = { models: [], roles: {} }, routes = {} } = {}) {
  const location = { hash, pathname: '/', search: '' };
  const listeners = [], winListeners = new Map(), calls = [], elements = new Map(), extras = new Map(), storage = new Map();
  const document = { activeElement: null };
  const node = (id = '', extra = {}) => ({
    id, tagName: 'DIV', innerHTML: '', value: '', style: {}, dataset: {}, children: [], attrs: {}, hidden: false, isConnected: true,
    scrollHeight: 20, scrollTop: 0, clientHeight: 20, offsetHeight: 10, offsetWidth: 10,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false,
    focus() { document.activeElement = this; }, appendChild(c) { if (c.id) elements.set(c.id, c); c.isConnected = true; },
    remove() { if (elements.get(this.id) === this) elements.delete(this.id); this.isConnected = false; },
    scrollTo() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0 }),
    ...extra,
  });
  for (const id of ['app', 'main', 'list', 'conn', 'input', 'thread', 'topbar', 'newBtn', 'scrim', 'groupBy', 'disconnect', 'search', 'slash', 'scroller', 'tasks', 'chatPlan', 'extras', 'questions', 'queued', 'statusLine', 'modelSlot', 'hint', 'buttons', 'imagePreview', 'toasts', 'promptRail',
    'pickerQ', 'pickerProvs', 'pickerThink', 'pickerList', 'setList', 'setMeta', 'setNav', 'updateStatus', 'home']) elements.set(id, node(id));
  elements.get('input').tagName = 'TEXTAREA';
  extras.set('[data-act="ompUpdate"]', node());
  Object.assign(document, {
    hidden: false, body: node('body'),
    getElementById: id => elements.get(id) || null,
    querySelector: s => /^#[\w-]+$/.test(s) ? elements.get(s.slice(1)) || null : extras.get(s) || null,
    querySelectorAll: () => [],
    createElement: tag => node('', { tagName: tag.toUpperCase(), querySelector: () => node(), querySelectorAll: () => [] }),
    addEventListener: (type, fn) => listeners.push([type, fn]),
  });
  const reply = (url, body) => {
    const path = url.slice(4).split('?')[0];
    if (routes[path]) return routes[path](body, url);
    if (path === '/state') return { projects: [], sessions, archived: [] };
    if (path === '/models') return models;
    if (path === '/omp-sessions') return { sessions: [] };
    return {};
  };
  runInNewContext(source, {
    document, location, window: { innerHeight: 900, addEventListener: (type, fn) => winListeners.set(type, fn) }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    history: { replaceState() {} }, URLSearchParams, AbortSignal, CSS: { escape: s => String(s) },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }, sessionStorage: { getItem: () => 'test-token' },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} }, confirm: () => true,
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body });
      const data = await reply(url, body);
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
  });
  await flush();
  const fire = async (type, e) => { for (const [t, fn] of listeners) if (t === type) fn({ preventDefault() {}, stopPropagation() {}, ...e }); await flush(); };
  const target = (map = {}, extra = {}) => node(extra.id || '', { tagName: 'BUTTON', closest: sel => map[sel] ?? null, ...extra });
  const act = (name, data = {}) => target({ '[data-act]': node('', { dataset: { act: name, ...data } }) });
  const key = (k, mods = {}, t = elements.get('input')) => fire('keydown', { target: t, key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const go = async h => { location.hash = h; winListeners.get('hashchange')(); await flush(); };
  const commands = () => calls.filter(c => /\/command$/.test(c.url)).map(c => ({ session: c.url.split('/')[3], ...c.body }));
  return { elements, extras, calls, commands, fire, target, act, key, go, node, document, location, storage };
}
const idle = (id, extra = {}) => ({ id, title: id, cwd: '/p', status: 'paused', messages: [], queuedMessages: [], updatedAt: new Date().toISOString(), ...extra });
const MODELS = { models: ['a', 'b', 'c'].map(x => ({ selector: 'p/' + x, id: x, name: x.toUpperCase(), provider: 'p' })), roles: { default: 'p/a', smol: 'p/b', slow: 'p/c' } };

test('dialogs and the model picker close when the view changes; Alt+N and "/" wait for them', async () => {
  const d = await boot({ sessions: [idle('a'), idle('b')], models: MODELS });
  await d.fire('click', { target: d.act('launch') });
  assert.ok(d.elements.has('modal'), 'Launch options opened');
  await d.key('n', { altKey: true, code: 'KeyN' });
  assert.equal(d.location.hash, '#/s/a', 'Alt+N does nothing behind a dialog');
  await d.key('/', {}, d.node('', { tagName: 'BODY' }));
  assert.notEqual(d.document.activeElement, d.elements.get('search'), '"/" does not reach the sidebar search behind a dialog');
  await d.go('#/s/b');
  assert.ok(!d.elements.has('modal'), 'the dialog closed, so its submit cannot restart session b');

  await d.fire('click', { target: d.act('model') });
  assert.equal(d.elements.get('picker')?.hidden, false, 'picker open on b');
  await d.go('#/s/a');
  assert.equal(d.elements.get('picker').hidden, true, 'picker closed on navigation');
  await d.key('Enter', {}, d.elements.get('pickerQ'));
  assert.deepEqual(d.commands().filter(c => c.type === 'set_model'), [], 'no model change after the picker closed');
});

test('picker Enter applies the highlighted row only from the search box', async () => {
  const d = await boot({ sessions: [idle('a', { modelSelector: 'p/b' })], models: MODELS });
  await d.fire('click', { target: d.act('model') });
  await d.key('Enter', {}, d.target({}, { id: 'chip' }));
  assert.deepEqual(d.commands().filter(c => c.type === 'set_model'), [], 'Enter on a focused chip is left to the browser');
  await d.key('Enter', {}, d.elements.get('pickerQ'));
  assert.deepEqual(d.commands().filter(c => c.type === 'set_model').map(c => c.model), ['p/b']);
});

test('a pointer click on a picker chip returns focus to the search box; keyboard activation keeps it on the chip', async () => {
  const d = await boot({ sessions: [idle('a')], models: MODELS });
  await d.fire('click', { target: d.act('model') });
  const picker = d.elements.get('picker'), q = d.elements.get('pickerQ');
  for (const [sel, data] of [['[data-prov]', { prov: 'p' }], ['[data-think]', { think: 'high' }]]) {
    const chip = d.target({ '#picker': picker, [sel]: d.node('', { dataset: data }) });
    chip.focus();
    await d.fire('click', { target: chip, detail: 0 });
    assert.equal(d.document.activeElement, chip, `Enter/Space on a ${sel} chip leaves focus on it`);
    await d.fire('click', { target: chip, detail: 1 });
    assert.equal(d.document.activeElement, q, `a pointer click on a ${sel} chip lets typing filter again`);
  }
});

test('Ctrl+P moves past a role without a reasoning suffix while OMP reports a level', async () => {
  const d = await boot({ sessions: [idle('a', { modelSelector: 'p/a', thinking: 'high' })], models: MODELS });
  await d.key('p', { ctrlKey: true, code: 'KeyP' });
  assert.deepEqual(d.commands().filter(c => c.type === 'set_model').map(c => c.model), ['p/b']);
});

const SETTINGS = () => ({ file: '/cfg.yml', settings: [
  { key: 'modelRoles', type: 'record', group: 'internal', value: { default: 'p/a', smol: 'p/b' } },
  { key: 'ui.flag', type: 'boolean', group: 'appearance', value: false, description: 'A flag' },
  { key: 'ui.count', type: 'number', group: 'appearance', value: 2 },
  { key: 'bash.patterns', type: 'array', group: 'shell', value: [], default: [] },
] });
async function settings(extra = {}) {
  const gets = [], posts = [], models = deferred();
  const routes = {
    '/settings': body => { if (!body) { const g = deferred(); gets.push(g); return g.promise; } const p = deferred(); posts.push({ body, ...p }); return p.promise; },
    '/plugins': () => ({ plugins: [{ id: 'pl@1', enabled: true }], available: [] }),
    '/models': () => models.promise,
    ...extra,
  };
  const d = await boot({ hash: '#/settings', routes });
  return { d, gets, posts, models, list: () => d.elements.get('setList').innerHTML };
}

test('Settings render before `omp models` finishes, and the model list is requested once', async () => {
  const { d, gets, list } = await settings();
  gets[0].resolve(SETTINGS()); await flush();
  assert.match(list(), /data-row="ui\.flag"/);
  assert.equal(d.calls.filter(c => c.url === '/api/models').length, 1);
});

test('a model-role edit during Reload keeps the other roles; with no data it does nothing', async () => {
  const { d, gets, posts } = await settings();
  const del = d.target({ '[data-mmdel]': d.node('', { dataset: { mmdel: 'modelRoles', mmname: 'smol' } }) });
  await d.fire('click', { target: del });
  assert.equal(posts.length, 0, 'nothing is saved before settings are loaded');
  gets[0].resolve(SETTINGS()); await flush();
  await d.fire('click', { target: d.act('setReload') });
  assert.equal(gets.length, 2, 'reload pending');
  await d.fire('click', { target: del });
  assert.deepEqual(posts.map(p => p.body), [{ key: 'modelRoles', value: { default: 'p/a' } }]);
});

test('re-renders during a save keep the row locked, and the row is redrawn by key afterwards', async () => {
  const { d, gets, posts, list } = await settings();
  gets[0].resolve(SETTINGS()); await flush();
  const parent = d.node('', { contains: () => false });
  const row = d.node('', { parentElement: parent, outerHTML: '' });
  d.extras.set('[data-row="ui.flag"]', row);
  await d.fire('change', { target: d.node('', { dataset: { set: 'ui.flag', kind: 'boolean' }, checked: true }) });
  await d.fire('input', { target: d.node('setSearch', { value: 'flag' }) });
  assert.match(list(), /class="set-row [^"]*saving[^"]*" data-row="ui\.flag"/, 'search re-render keeps the saving lock');
  const saved = SETTINGS(); saved.settings[1].value = true; saved.settings[1].modified = true;
  posts[0].resolve(saved); await flush();
  assert.match(row.outerHTML, /data-set="ui\.flag"[^>]*checked/);
  assert.doesNotMatch(row.outerHTML, /saving/);
});

test('a second plugin action on the same plugin waits for the first', async () => {
  const pending = deferred(); let n = 0;
  const { d, gets } = await settings({ '/plugins': body => { if (!body) return { plugins: [{ id: 'pl@1', enabled: true }], available: [] }; n++; return pending.promise; } });
  gets[0].resolve(SETTINGS()); await flush();
  const toggle = () => d.fire('change', { target: d.node('', { dataset: { pluginToggle: 'pl@1' }, checked: false }) });
  await toggle(); await toggle();
  assert.equal(n, 1);
});

test('every settings control is named by its visible label', async () => {
  const { gets, list } = await settings();
  gets[0].resolve(SETTINGS()); await flush();
  const html = list();
  const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map(m => m[0]).filter(t => /data-(set|hotkey|plugin-toggle)=/.test(t));
  assert.ok(controls.length >= 6);
  for (const tag of controls) {
    const id = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(id && html.includes(`id="${id}"`), `${tag} has a label`);
  }
  assert.match(html, /data-set="bash\.patterns" data-kind="json"/, 'an empty list of objects gets the JSON editor');
});

test('home keeps the typed folder path, focus and caret when late data re-renders it', async () => {
  const browse = deferred();
  const d = await boot({ hash: '#/new', routes: { '/browse': () => browse.promise } });
  const home = d.elements.get('home');
  const typed = d.node('pathInput', { tagName: 'INPUT', type: 'text', value: 'D:\\work', selectionStart: 3, selectionEnd: 3 });
  let caret;
  const fresh = d.node('pathInput', { tagName: 'INPUT', type: 'text', setSelectionRange(a, b) { caret = [a, b]; } });
  home.contains = n => n === typed;
  home.querySelector = s => s === '#pathInput' ? fresh : null;
  await d.fire('input', { target: typed });
  typed.focus();
  browse.resolve({ roots: [{ name: 'C', path: 'C:\\' }], recent: [] }); await flush();
  assert.match(home.innerHTML, /id="pathInput"[^>]*value="D:\\work"/);
  assert.equal(d.document.activeElement, fresh);
  assert.equal(fresh.value, 'D:\\work');
  assert.deepEqual(caret, [3, 3]);
});

test('hotkeys match the physical key, accept key names, and refuse the dashboard\'s own shortcuts', async () => {
  const d = await boot({ sessions: [idle('a', { status: 'running' })] });
  const queued = async (k, mods) => { d.elements.get('input').value = 'x'; const n = d.commands().length; await d.key(k, mods); return d.commands().slice(n).map(c => c.type); };
  // Default Ctrl+Q on a Cyrillic layout: e.key is "й", e.code is KeyQ.
  assert.deepEqual(await queued('й', { ctrlKey: true, code: 'KeyQ' }), ['follow_up']);
  // AZERTY: the key labelled A sits at physical KeyQ, so Ctrl+A must stay select-all.
  assert.deepEqual(await queued('a', { ctrlKey: true, code: 'KeyQ' }), []);
  await d.fire('change', { target: d.node('', { dataset: { hotkey: 'follow_up' }, value: 'Alt+Q' }) });
  // Mac Option+Q types "œ"; the physical key still matches.
  assert.deepEqual(await queued('œ', { altKey: true, code: 'KeyQ' }), ['follow_up']);
  const save = v => d.fire('change', { target: d.node('', { dataset: { hotkey: 'follow_up' }, value: v }) });
  await save('Alt+N');
  assert.equal(JSON.parse(d.storage.get('omp-hotkeys')).follow_up, 'Alt+Q', 'reserved combo is not saved');
  await save('Ctrl+Space');
  assert.equal(JSON.parse(d.storage.get('omp-hotkeys')).follow_up, 'Ctrl+Space');
  assert.deepEqual(await queued(' ', { ctrlKey: true, code: 'Space' }), ['follow_up']);
});
