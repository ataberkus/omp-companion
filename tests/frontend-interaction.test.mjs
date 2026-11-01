import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Runs the real dashboard script against a tiny DOM: elements by id, a few extra selectors, recorded fetches.
// `coarse: true` reports a touch screen through matchMedia('(pointer: coarse)'); without it there is no matchMedia at all.
// `size` is the viewport (a landscape phone is { width: 844, height: 390 }).
async function boot({ hash = '#/s/a', sessions = [], models = { models: [], roles: {} }, routes = {}, coarse = false, size = { width: 1360, height: 900 } } = {}) {
  const location = { hash, pathname: '/', search: '' };
  const listeners = [], winListeners = new Map(), calls = [], elements = new Map(), extras = new Map(), storage = new Map(), timers = [];
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
    'pickerQ', 'pickerProvs', 'pickerThink', 'pickerList', 'pickerQuick', 'pickerFoot', 'pickerClose', 'setList', 'setMeta', 'setNav', 'updateStatus', 'home']) elements.set(id, node(id));
  elements.get('input').tagName = 'TEXTAREA';
  extras.set('[data-act="ompUpdate"]', node());
  for (const s of ['.composer-wrap', '.composer']) extras.set(s, node());
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
    document, location, window: { innerHeight: size.height, addEventListener: (type, fn) => winListeners.set(type, fn) }, addEventListener() {}, innerWidth: size.width, innerHeight: size.height,
    history: { replaceState() {} }, URLSearchParams, AbortSignal, CSS: { escape: s => String(s) },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }, sessionStorage: { getItem: () => 'test-token' },
    // Timers are recorded, never run on their own: a test runs the ones it means to (see saveDrafts).
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} }, confirm: () => true,
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body, ...(opts?.keepalive ? { keepalive: true } : {}) });
      const data = await reply(url, body);
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    },
    ...(coarse ? { matchMedia: q => ({ matches: /pointer:\s*coarse|hover:\s*none/.test(q), media: q, addEventListener() {}, removeEventListener() {} }) } : {}),
  });
  await flush();
  const fire = async (type, e) => { for (const [t, fn] of listeners) if (t === type) fn({ preventDefault() {}, stopPropagation() {}, ...e }); await flush(); };
  const target = (map = {}, extra = {}) => node(extra.id || '', { tagName: 'BUTTON', closest: sel => map[sel] ?? null, ...extra });
  const act = (name, data = {}) => target({ '[data-act]': node('', { dataset: { act: name, ...data } }) });
  const key = (k, mods = {}, t = elements.get('input')) => fire('keydown', { target: t, key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const go = async h => { location.hash = h; winListeners.get('hashchange')(); await flush(); };
  const commands = () => calls.filter(c => /\/command$/.test(c.url)).map(c => ({ session: c.url.split('/')[3], ...c.body }));
  // Runs the composer-draft saves waiting out their 700 ms debounce.
  const saveDrafts = async () => { for (const t of timers.filter(t => t.ms === 700 && !t.cleared && !t.ran)) { t.ran = true; t.fn(); } await flush(); };
  const draftPosts = () => calls.filter(c => c.url === '/api/draft' && c.body);
  return { elements, extras, calls, commands, fire, target, act, key, go, node, document, location, storage, winListeners, saveDrafts, draftPosts };
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

const MODELS_R = { models: [...MODELS.models, { selector: 'p/r', id: 'r', name: 'R', provider: 'p', reasoning: true, thinking: ['low', 'high'] }], roles: MODELS.roles };
const pickerTap = (d, sel, data) => d.target({ '#picker': d.elements.get('picker'), '.picker': d.node(), [sel]: d.node('', { dataset: data }) });
const rowIndex = (d, sel) => d.elements.get('pickerList').innerHTML.match(new RegExp(`data-pi="(\\d+)" title="${sel}"`))[1];
const setModels = d => d.commands().filter(c => c.type === 'set_model').map(c => ({ model: c.model, thinking: c.thinking }));

test('desktop: opening the picker focuses search and shows no quick-switch strip; touch: no keyboard on open', async () => {
  const desk = await boot({ sessions: [idle('a', { modelSelector: 'p/a' })], models: MODELS_R });
  await desk.fire('click', { target: desk.act('model') });
  assert.equal(desk.document.activeElement, desk.elements.get('pickerQ'));
  assert.equal(desk.elements.get('pickerQuick').hidden, true);
  await desk.fire('click', { target: pickerTap(desk, '[data-pi]', { pi: rowIndex(desk, 'p/r') }), detail: 1 });
  assert.deepEqual(setModels(desk), [{ model: 'p/r', thinking: '' }], 'a desktop click still applies at once');

  const touch = await boot({ sessions: [idle('a', { modelSelector: 'p/a' })], models: MODELS_R, coarse: true });
  await touch.fire('click', { target: touch.act('model') });
  assert.notEqual(touch.document.activeElement, touch.elements.get('pickerQ'), 'the search box is not focused, so no on-screen keyboard');
  assert.equal(touch.document.activeElement, touch.elements.get('pickerClose'));
  await touch.fire('click', { target: pickerTap(touch, '[data-pclose]', {}), detail: 1 });
  assert.equal(touch.elements.get('picker').hidden, true, 'the visible close button closes the picker');
});

test('touch: tapping a row with reasoning levels selects it; "Use model" applies it with the chosen level', async () => {
  const d = await boot({ sessions: [idle('a', { modelSelector: 'p/a' })], models: MODELS_R, coarse: true });
  await d.fire('click', { target: d.act('model') });
  assert.doesNotMatch(d.elements.get('pickerThink').innerHTML, /data-think="high"/, 'p/a has no levels');
  const pi = rowIndex(d, 'p/r');
  await d.fire('click', { target: pickerTap(d, '[data-pi]', { pi }), detail: 1 });
  assert.deepEqual(setModels(d), [], 'the first tap only selects');
  assert.match(d.elements.get('pickerThink').innerHTML, /data-think="high"/, 'the levels follow the tapped row');
  assert.match(d.elements.get('pickerFoot').innerHTML, /<b>R<\/b> · default reasoning/);
  await d.fire('click', { target: pickerTap(d, '[data-think]', { think: 'high' }), detail: 1 });
  assert.notEqual(d.document.activeElement, d.elements.get('pickerQ'), 'a level tap does not raise the keyboard');
  assert.match(d.elements.get('pickerFoot').innerHTML, /<b>R<\/b> · high/);
  await d.fire('click', { target: pickerTap(d, '[data-puse]', {}), detail: 1 });
  assert.deepEqual(setModels(d), [{ model: 'p/r', thinking: 'high' }]);
  assert.equal(d.elements.get('picker').hidden, true);

  // A second tap on the selected row applies too; a row without levels applies on the first tap.
  await d.fire('click', { target: d.act('model') });
  await d.fire('click', { target: pickerTap(d, '[data-pi]', { pi: rowIndex(d, 'p/r') }), detail: 1 });
  await d.fire('click', { target: pickerTap(d, '[data-pi]', { pi: rowIndex(d, 'p/r') }), detail: 1 });
  await d.fire('click', { target: d.act('model') });
  await d.fire('click', { target: pickerTap(d, '[data-pi]', { pi: rowIndex(d, 'p/c') }), detail: 1 });
  assert.deepEqual(setModels(d).slice(1), [{ model: 'p/r', thinking: 'high' }, { model: 'p/c', thinking: '' }]);
});

test('touch: quick-switch chips apply a role or a favorite with its remembered level in one tap', async () => {
  const d = await boot({ sessions: [idle('a', { modelSelector: 'p/a' })], models: MODELS_R, coarse: true });
  d.storage.set('omp-fav-models', JSON.stringify(['p/r']));
  d.storage.set('omp-think-levels', JSON.stringify({ 'p/r': 'high' }));
  const chip = sel => d.elements.get('pickerQuick').innerHTML.match(new RegExp(`data-pquick="(\\d+)" title="${sel}"`))[1];
  await d.fire('click', { target: d.act('model') });
  assert.equal(d.elements.get('pickerQuick').hidden, false);
  assert.match(d.elements.get('pickerQuick').innerHTML, /title="p\/a" aria-current="true"/, 'the current model is marked');
  await d.fire('click', { target: pickerTap(d, '[data-pquick]', { pquick: chip('p/b') }), detail: 1 });
  await d.fire('click', { target: d.act('model') });
  await d.fire('click', { target: pickerTap(d, '[data-pquick]', { pquick: chip('p/r') }), detail: 1 });
  assert.deepEqual(setModels(d), [{ model: 'p/b', thinking: '' }, { model: 'p/r', thinking: 'high' }]);
});

// The ⚑ advisor menu opens from the composer at the bottom of the screen; on a landscape phone it is taller than the room above.
async function advMenu({ size, coarse, height, top }) {
  const d = await boot({ sessions: [idle('a', { advisor: { enabled: true } })], models: MODELS, size, coarse });
  const make = d.document.createElement;
  d.document.createElement = tag => Object.assign(make(tag), { offsetHeight: height, offsetWidth: 280 });
  const chip = d.node('', { dataset: { act: 'advMenu' }, getBoundingClientRect: () => ({ left: 40, top, bottom: top + 30 }) });
  await d.fire('click', { target: d.target({ '[data-act]': chip }) });
  return d.elements.get('advMenu').style;
}
test('the advisor menu stays on screen on a landscape phone; where it fits, it opens above its chip as before', async () => {
  const phone = await advMenu({ size: { width: 844, height: 390 }, coarse: true, height: 340, top: 330 });
  assert.equal(phone.top, '42px', 'no room above or below: pinned to the bottom edge instead of opening off-screen at 366px');
  assert.equal(phone.maxHeight, '374px', 'and never taller than the screen');
  const desk = await advMenu({ size: { width: 1360, height: 900 }, coarse: false, height: 340, top: 700 });
  assert.equal(desk.top, '354px', 'desktop: above the chip, unchanged');
  assert.equal(desk.left, '40px');
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
    '/mcp': () => ({ servers: [{ name: 'gh', enabled: true, state: 'active', reason: '', transport: 'stdio', command: 'gh-mcp', source: { provider: 'native', providerName: 'OMP', path: 'mcp.json', level: 'user' }, writable: true }], userFile: 'mcp.json', projectConfig: true, warnings: [] }),
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
  const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map(m => m[0]).filter(t => /data-(set|hotkey|plugin-toggle|mcp-toggle)=/.test(t));
  assert.ok(controls.some(t => t.includes('data-mcp-toggle')), 'the MCP server switch is rendered');
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

// Changes view of session a: one edit of /p/src/a.js (line 2 replaced).
const edited = (extra = {}, diff = ' 1|x\n-2|y\n+2|Y') => idle('a', { status: 'review', messages: [{ id: 't1', role: 'tool', text: 'edit', at: new Date().toISOString(), tool: { name: 'edit', status: 'done', files: [{ path: '/p/src/a.js', op: 'modify', diff }] } }], ...extra });
const diffLine = (d, ln, edit = '0') => d.target({ '.commentable td[data-ln]': d.node('', { dataset: { ln }, closest: s => ({ '[data-cpath]': d.node('', { dataset: { cpath: '/p/src/a.js' } }), '[data-cedit]': d.node('', { dataset: { cedit: edit } }) })[s] ?? null }) });
const noteForm = (d, text) => d.node('', { hasAttribute: k => k === 'data-noteform', elements: { note: { value: text } } });

test('comments on diff lines go back to the session as one "path:line: note" message, as a steer while it works', async () => {
  for (const [status, type] of [['review', 'prompt'], ['running', 'steer']]) {
    const d = await boot({ hash: '#/changes/s:a', sessions: [edited({ status })] });
    await d.fire('click', { target: diffLine(d, 'n:2') });
    await d.fire('submit', { target: noteForm(d, 'rename this') });
    await d.fire('click', { target: diffLine(d, 'o:2') });
    await d.fire('submit', { target: noteForm(d, 'keep y') });
    await d.fire('click', { target: diffLine(d, 'n:1') });
    await d.fire('submit', { target: noteForm(d, '   ') });
    for (const note of ['rename this', 'keep y']) assert.match(d.elements.get('thread').innerHTML, new RegExp(`class="note-text">${note}<`));
    assert.match(d.elements.get('topbar').innerHTML, /Request changes <small>2<\/small>/, 'a blank comment is not kept');
    await d.fire('click', { target: d.act('requestChanges') });
    assert.deepEqual(d.commands().filter(c => c.type === type).map(c => [c.session, c.message]), [['a', 'src/a.js:2: rename this\nsrc/a.js:2: (removed line) keep y']]);
    assert.equal(d.location.hash, '#/s/a');
    assert.deepEqual(JSON.parse(d.storage.get('omp-review-notes')), {}, 'sent comments are cleared');
  }
});

test('a file marked Viewed folds until its diff changes again', async () => {
  const sessions = [edited()];
  const d = await boot({ hash: '#/changes/s:a', sessions });
  const sig = d.elements.get('thread').innerHTML.match(/data-viewed="([^"]+)"/)[1];
  const box = d.node('', { checked: true, dataset: { viewed: sig }, matches: s => s === '[data-viewed]', closest: s => s === '[data-cpath]' ? d.node('', { dataset: { cpath: '/p/src/a.js' } }) : null });
  await d.fire('change', { target: box });
  let html = d.elements.get('thread').innerHTML;
  assert.match(html, /class="change-file viewed"/);
  assert.doesNotMatch(html, /class="diff/, 'the diff is folded away');
  assert.match(html, /data-viewed="[^"]+" checked/);

  sessions[0] = edited({ updatedAt: new Date(Date.now() + 1000).toISOString() }, ' 1|x\n-2|y\n+2|Z');
  await d.fire('visibilitychange', {});
  html = d.elements.get('thread').innerHTML;
  assert.doesNotMatch(html, /change-file viewed/, 'a new edit unfolds it');
  assert.match(html, /class="diff/);
});

test('the tab title counts sessions that finished, failed or asked while you were elsewhere', async () => {
  const sessions = [idle('a'), idle('b', { status: 'running' }), idle('c', { status: 'running' })];
  const d = await boot({ sessions });
  assert.equal(d.document.title, 'OMP Control Room');
  sessions[1] = { ...sessions[1], status: 'review' };
  sessions[2] = { ...sessions[2], uiRequests: [{ id: 'q', method: 'confirm', title: 'Proceed?' }] };
  await d.fire('visibilitychange', {});
  assert.equal(d.document.title, '(2) OMP Control Room');
  await d.go('#/s/b');
  assert.equal(d.document.title, '(1) OMP Control Room', 'opening a session counts as seen');
  sessions[2] = { ...sessions[2], uiRequests: [] };
  await d.fire('visibilitychange', {});
  assert.equal(d.document.title, 'OMP Control Room', 'an answered question is no longer waiting');
  sessions[0] = { ...sessions[0], status: 'review', workFinishedAt: new Date().toISOString() };
  await d.fire('visibilitychange', {});
  assert.equal(d.document.title, '(1) OMP Control Room', 'a run that started and ended between polls still counts');
});

test('composer drafts follow the companion: a remote draft fills an untouched composer and a sent one clears it', async () => {
  const state = { drafts: { 'session:a': 5 } }, texts = { 'session:a': { text: 'from my phone', at: 5 } };
  const d = await boot({ routes: { '/state': () => ({ projects: [], archived: [], sessions: [idle('a')], ...state }), '/draft': (_, url) => texts[new URLSearchParams(url.split('?')[1]).get('key')] } });
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, 'from my phone');
  texts['session:a'] = { text: 'edited on the laptop', at: 9 }; state.drafts = { 'session:a': 9 };
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, 'edited on the laptop');
  state.drafts = {};
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, '', 'sent from another device');
  assert.equal(d.calls.filter(c => c.url.startsWith('/api/draft') && c.body).length, 0, 'pulling never writes back');
});

test('composer drafts carry their images: a remote image fills an untouched composer, goes out with a send and clears with a send elsewhere', async () => {
  const shot = name => ({ image: { type: 'image', mimeType: 'image/png', data: 'QUJD' + name.length }, preview: `data:image/jpeg;base64,${name}`, name, tokens: 1 });
  const state = { drafts: { 'session:a': 5 } }, remote = { 'session:a': { text: '', at: 5, images: [shot('one')] } };
  const routes = {
    '/state': () => ({ projects: [], archived: [], sessions: [idle('a')], ...state }),
    // As the companion answers: images the dashboard names in ?have= come without their data.
    '/draft': (body, url) => { if (body) return {}; const q = new URLSearchParams(url.split('?')[1]), d = remote[q.get('key')], have = q.getAll('have');
      return { ...d, images: d.images.map(i => have.includes(i.name) ? { name: i.name, mimeType: i.image.mimeType, tokens: i.tokens } : i) }; },
  };
  const d = await boot({ routes }), preview = d.elements.get('imagePreview');
  await d.fire('visibilitychange', {});
  assert.equal(preview.hidden, false);
  assert.match(preview.innerHTML, /data:image\/jpeg;base64,one/, 'an image-only draft from the laptop shows on the phone');
  remote['session:a'] = { text: 'enhanced on the laptop', at: 9, images: [shot('one'), shot('two')] }; state.drafts = { 'session:a': 9 };
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, 'enhanced on the laptop');
  assert.match(preview.innerHTML, /base64,one.*base64,two/);
  assert.match(d.calls.filter(c => c.url.startsWith('/api/draft?')).at(-1).url, /&have=one$/, 'the image it already has is not fetched again');
  state.drafts = {};
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, '');
  assert.equal(preview.hidden, true, 'sent from another device: its images leave this composer too');
  assert.equal(d.calls.filter(c => c.url.startsWith('/api/draft') && c.body).length, 0, 'pulling never writes back');

  // Sent from here, the remote images go with the message.
  remote['session:a'] = { text: 'fix this', at: 12, images: [shot('one')] }; state.drafts = { 'session:a': 12 };
  await d.fire('visibilitychange', {});
  await d.key('Enter');
  assert.deepEqual(d.commands().filter(c => c.type === 'prompt').map(({ message, images, preview }) => ({ message, images, preview })),
    [{ message: 'fix this', images: [shot('one').image], preview: [shot('one').preview] }]);
  assert.equal(preview.hidden, true);
});

test('composer draft images removed on this device and not yet synced are not replaced by the remote ones', async () => {
  const shot = name => ({ image: { type: 'image', mimeType: 'image/png', data: 'QUJD' }, preview: `data:image/jpeg;base64,${name}`, name, tokens: 1 });
  const state = { drafts: { 'session:a': 5 } }, remote = { text: 'look', at: 5, images: [shot('one')] };
  const d = await boot({ routes: { '/state': () => ({ projects: [], archived: [], sessions: [idle('a')], ...state }), '/draft': body => body ? {} : remote } });
  const preview = d.elements.get('imagePreview');
  await d.fire('visibilitychange', {});
  assert.match(preview.innerHTML, /base64,one/);
  await d.fire('click', { target: d.act('removeImage', { name: 'one' }) });
  assert.equal(preview.hidden, true);
  Object.assign(remote, { at: 9, images: [shot('one'), shot('two')] }); state.drafts = { 'session:a': 9 };
  await d.fire('visibilitychange', {});
  assert.equal(preview.hidden, true, 'the local removal stands and is saved over the remote images');
});

test('a composer draft still waiting out its debounce is saved when the page is hidden or closed, with a request that outlives it', async () => {
  const d = await boot({ sessions: [idle('a')], routes: { '/draft': () => ({ at: 1, images: [] }) } });
  const input = d.elements.get('input'), type = async v => { input.value = v; await d.fire('input', { target: input }); };
  await type('typed, then switched apps');
  assert.equal(d.draftPosts().length, 0);
  d.document.hidden = true;
  await d.fire('visibilitychange', {});
  assert.deepEqual(d.draftPosts(), [{ url: '/api/draft', body: { key: 'session:a', text: 'typed, then switched apps' }, keepalive: true }]);
  d.document.hidden = false;
  await type('typed, then closed the tab');
  d.winListeners.get('pagehide')();
  await flush();
  assert.deepEqual(d.draftPosts().at(-1), { url: '/api/draft', body: { key: 'session:a', text: 'typed, then closed the tab' }, keepalive: true });
  await d.saveDrafts();
  assert.equal(d.draftPosts().length, 2, 'the debounced saves were sent already');
});

test('composer draft saves for one view go one at a time, and a poll never pulls over a save still under way', async () => {
  const answers = [], state = { drafts: {} };
  const d = await boot({ routes: {
    '/state': () => ({ projects: [], archived: [], sessions: [idle('a')], ...state }),
    '/draft': body => { if (!body) return { text: 'older, from the phone', at: 7, images: [] }; const r = deferred(); answers.push(r); return r.promise; },
  } });
  const input = d.elements.get('input'), type = async v => { input.value = v; await d.fire('input', { target: input }); await d.saveDrafts(); };
  await type('first');
  await type('first, then more');
  assert.deepEqual(d.draftPosts().map(c => c.body.text), ['first'], 'the newer save waits for the one under way');
  state.drafts = { 'session:a': 7 };
  await d.fire('visibilitychange', {});
  assert.equal(d.calls.filter(c => c.url.startsWith('/api/draft?')).length, 0, 'no pull while a save is under way');
  answers[0].resolve({ at: 8, images: [] });
  await flush();
  assert.deepEqual(d.draftPosts().map(c => c.body.text), ['first', 'first, then more']);
  answers[1].resolve({ at: 9, images: [] });
  await flush();
  state.drafts = { 'session:a': 9 };
  await d.fire('visibilitychange', {});
  assert.equal(input.value, 'first, then more');
  assert.equal(d.calls.filter(c => c.url.startsWith('/api/draft?')).length, 0, 'the last save is what this page knows as synced');
});

test('a composer draft save that fails while offline is sent again after the next poll that reaches the companion', async () => {
  let offline = true;
  const d = await boot({ sessions: [idle('a')], routes: { '/draft': body => { if (body && offline) throw new Error('offline'); return { at: 3, images: [] }; } } });
  const input = d.elements.get('input');
  input.value = 'written in a tunnel';
  await d.fire('input', { target: input });
  await d.saveDrafts();
  assert.equal(d.draftPosts().length, 1);
  offline = false;
  await d.fire('visibilitychange', {});
  await d.saveDrafts();
  assert.deepEqual(d.draftPosts().map(c => c.body.text), ['written in a tunnel', 'written in a tunnel']);
  await d.fire('visibilitychange', {});
  await d.saveDrafts();
  assert.equal(d.draftPosts().length, 2, 'once saved, not sent again');
});

test('an extension pre-fill joins the synced draft once: added after the pulled draft, then forgotten by the companion', async () => {
  const state = { drafts: { 'session:a': 5 } }, session = idle('a', { _editorText: { id: 'e1', text: 'from the extension' } });
  const d = await boot({ routes: {
    '/state': () => ({ projects: [], archived: [], sessions: [session], ...state }),
    '/draft': body => body ? { at: 6, images: [] } : { text: 'my draft', at: 5, images: [] },
  } });
  await d.fire('visibilitychange', {});
  assert.equal(d.elements.get('input').value, 'my draft\n\nfrom the extension', 'added to the synced draft, not to an empty composer saved over it');
  assert.deepEqual(d.commands().filter(c => c.type === 'editor_text_applied'), [{ session: 'a', type: 'editor_text_applied', id: 'e1' }]);
  await d.saveDrafts();
  assert.deepEqual(d.draftPosts().map(c => c.body.text), ['my draft\n\nfrom the extension']);
});

test('a send still in flight to one session never blocks sending in another, and each composer shows only its own send', async () => {
  const slow = deferred();
  const d = await boot({ sessions: [idle('a'), idle('b')], routes: { '/sessions/a/command': body => body.type === 'prompt' ? slow.promise : {} } });
  const input = d.elements.get('input'), buttons = () => d.elements.get('buttons').innerHTML;
  const type = async v => { input.value = v; await d.fire('input', { target: input }); };
  await type('to a');
  await d.key('Enter');
  assert.match(buttons(), /disabled>Sending…/, 'a shows its own send in flight');
  await d.go('#/s/b');
  await type('to b');
  assert.doesNotMatch(buttons(), /disabled/, "b's composer is not blocked by a's send");
  await d.key('Enter');
  assert.deepEqual(d.commands().filter(c => c.type === 'prompt').map(c => [c.session, c.message]), [['a', 'to a'], ['b', 'to b']]);
  await type('again');
  assert.doesNotMatch(buttons(), /disabled/, "b's finished send frees b while a's is still pending");
  await d.go('#/s/a');
  assert.match(buttons(), /Sending…/, 'back on a, its send is still in flight');
  slow.resolve(idle('a', { status: 'running' }));
  await flush();
  assert.doesNotMatch(buttons(), /Sending…/);
});

test('Commit related changes in one session is not blocked by one still sending in another', async () => {
  const slow = deferred();
  const d = await boot({ sessions: [idle('a'), idle('b')], routes: { '/sessions/a/command': body => body.type === 'prompt' ? slow.promise : {} } });
  await d.fire('click', { target: d.act('commitRelated') });
  await d.go('#/s/b');
  await d.fire('click', { target: d.act('commitRelated') });
  assert.deepEqual(d.commands().filter(c => c.type === 'prompt').map(c => c.session), ['a', 'b']);
  slow.resolve(idle('a'));
  await flush();
});

test('on touch a session row\'s ⋯ lists pin and archive; choosing one closes the menu and applies it', async () => {
  const d = await boot({ coarse: true, sessions: [idle('a'), idle('b')], size: { width: 390, height: 844 } });
  const list = d.elements.get('list').innerHTML;
  const key = list.match(/data-rowmenu="([^"]+)"/)?.[1];
  assert.ok(key, 'each row renders its ⋯');
  assert.match(list, /data-pin="[^"]+"[^>]*>/, 'the hover buttons stay in the markup for pointers that can hover');
  const row = d.node('', { querySelector: s => s === '[data-pin]' ? d.node('', { title: 'Pin to top', dataset: { unpin: '' } }) : s === '[data-archive]' ? d.node('', { title: 'Archive', dataset: { restore: '' } }) : null });
  const btn = d.node('', { dataset: { rowmenu: key }, getAttribute: k => k === 'aria-label' ? 'Session actions: a' : undefined, closest: s => s === '.item-row' ? row : null,
    getBoundingClientRect: () => ({ left: 330, right: 360, top: 806, bottom: 836 }) });
  await d.fire('click', { target: d.target({ '[data-rowmenu]': btn }) });
  const menu = d.elements.get('ctxMenu');
  assert.ok(menu, 'the ⋯ opens a menu');
  assert.deepEqual([...menu.innerHTML.matchAll(/<button[^>]*>([^<]+)</g)].map(m => m[1]), ['Pin to top', 'Archive', 'Open in new tab']);
  assert.equal(menu.style.top, '792px', 'near the bottom of the screen it opens above its ⋯');
  assert.equal(menu.style.left, '350px', 'right-aligned to the ⋯');

  await d.fire('click', { target: d.target({ '[data-rowmenu]': btn }) });
  assert.ok(!d.elements.has('ctxMenu'), 'a second tap on the same ⋯ closes it');
  await d.fire('click', { target: d.target({ '[data-rowmenu]': btn }) });
  const menu2 = d.elements.get('ctxMenu');
  const pin = d.node('', { dataset: { pin: key, unpin: '' } });
  await d.fire('click', { target: d.target({ '[data-pin]': pin, '#ctxMenu': menu2 }) });
  assert.ok(!d.elements.has('ctxMenu'), 'choosing an action closes the menu');
  assert.deepEqual(d.calls.filter(c => c.url.startsWith('/api/pin')).map(c => c.body), [{ key, pinned: true }]);
});

// The stylesheet as top-level rules and @media blocks (one level deep, as app.css is written).
const css = await readFile(new URL('../local-dist/app.css', import.meta.url), 'utf8');
const cssRules = (() => {
  const out = [], text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  const block = (media, end) => {
    while (i < end) {
      const open = text.indexOf('{', i);
      if (open < 0 || open >= end) return;
      const head = text.slice(i, open).trim();
      if (head.startsWith('@media')) {
        let depth = 1, j = open + 1;
        for (; depth; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
        i = open + 1; block(head.slice(6).trim(), j - 1); i = j;
      } else {
        const close = text.indexOf('}', open);
        out.push({ media, selector: head, body: text.slice(open + 1, close) });
        i = close + 1;
      }
    }
  };
  block('', text.length);
  return out;
})();
const rulesFor = (pattern, media) => cssRules.filter(r => pattern.test(r.selector) && (media === undefined || media(r.media)));
const TOUCH = m => m.includes('max-width:820px') && m.includes('pointer:coarse');

test('phones: markdown table cells wrap between words and keep a minimum width; desktop table rules are unchanged', () => {
  const top = m => m === '';
  assert.ok(rulesFor(/^\.md :is\(th,td\)$/, TOUCH).some(r => /overflow-wrap:break-word/.test(r.body)), 'cells no longer inherit overflow-wrap:anywhere on phones');
  assert.ok(rulesFor(/^\.md :is\(th,td\):not\(\.num\)$/, TOUCH).some(r => /min-width:7em/.test(r.body)), 'a column cannot shrink below a readable width');
  assert.deepEqual(rulesFor(/\.md (:is\()?(th|td)/, top).map(r => r.selector + '{' + r.body + '}'), [
    '.md th,.md td{padding:7px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
    '.md th{background:var(--card);font-weight:650}',
  ], 'desktop cells keep their rules and get no wrapping override');
  assert.deepEqual(rulesFor(/^\.md table$/, top).map(r => r.body), ['border-collapse:collapse;width:100%;font-size:13.5px']);
});

test('the compact touch sidebar and plan bar live only inside touch/narrow media queries', () => {
  const compact = [/^\.filters button::after$/, /^\.list-bar \.seg button::after$/, /^\.sidebar \.sidebar-foot$/, /^\.sidebar-foot a svg$/, /^\.sidebar \.theme-btn$/,
    /\.group-act,\.group-new\)::after$/, /^\.chat-plan \.chat-plan-link::after/];
  for (const p of compact) {
    const rules = rulesFor(p);
    assert.ok(rules.length, `${p} exists`);
    for (const r of rules) assert.ok(TOUCH(r.media), `${r.selector} is inside a touch/narrow query, not "${r.media || 'top level'}"`);
  }
  assert.deepEqual(rulesFor(/^\.item-row \.row-acts \.row-more$/).map(r => [r.media, /display:(none|grid)/.exec(r.body)?.[1]]), [['', 'none'], ['(hover:none)', 'grid']],
    'the row ⋯ is hidden wherever rows can be hovered (desktop keeps its hover-revealed pin and archive)');
  for (const r of rulesFor(/^\.item-row \.row-acts :is\(\.pin,\.arch\)$/)) assert.equal(r.media, '(hover:none)', 'pin and archive buttons hide only without hover');
});

test('a long draft grows the composer to a third of the screen on touch, 40% of the window on desktop as before', async () => {
  for (const [opts, cap] of [[{ coarse: true, size: { width: 393, height: 659 } }, 659 / 3], [{}, 900 * 0.4]]) {
    const d = await boot({ sessions: [idle('a')], ...opts });
    const input = d.elements.get('input');
    Object.assign(input, { value: 'a long paste\n'.repeat(80), scrollHeight: 2000 });
    await d.fire('input', { target: input });
    assert.equal(input.style.height, cap + 'px', opts.coarse ? 'touch' : 'desktop');
  }
});
