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
    // Class selectors the view builders hide (Changes, subagent views); everything else stays unresolved.
    querySelector: s => /^#[\w-]+$/.test(s) ? elements.get(s.slice(1)) || null : ['.composer', '.composer-wrap'].includes(s) ? node() : null,
    querySelectorAll: () => [],
    createElement: tag => { const n = node('', { tagName: tag.toUpperCase(), ...(tag === 'canvas' ? { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,UFJF' } : {}) }); created.push(n); return n; },
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
    // Pasted images: a 10×10 bitmap read as base64 "ABC" (see attachImage).
    createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,QUJD'; Promise.resolve().then(() => this.onload()); } },
    fetch: async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body });
      const data = await reply(url, body);
      // A route answering { httpStatus, error } is refused like the companion refuses: non-OK status, JSON error.
      if (data?.httpStatus) return { ok: false, status: data.httpStatus, json: async () => ({ error: data.error }) };
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
  const paste = file => fire('paste', { target: input, clipboardData: { getData: () => '', items: [{ type: file.type, getAsFile: () => file }] } });
  return { elements, calls, fire, act, key, go, type, paste, input, runPolls, timers, toasts, toastAction, posts, location, target, node };
}
const idle = (id, extra = {}) => ({ id, title: id, cwd: '/p', status: 'paused', messages: [], queuedMessages: [], updatedAt: new Date().toISOString(), ...extra });

test('Enhance replaces the draft, Undo restores it, Send is blocked meanwhile', async () => {
  const polls = seq([{ status: 'running', step: 'reading src/a.js', model: 'p/m' }, { status: 'done', text: 'Better' }]);
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => body ? { id: 'j', model: 'p/m' } : polls() } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: 'fix it', mode: 'full' }]);
  assert.ok(d.calls.some(c => c.url === '/api/commands?session=a'), 'OMP is started alongside');
  assert.equal(d.input.readOnly, true);
  assert.match(d.elements.get('statusLine').innerHTML, /Enhancing \(Full spec\) with m · reading src\/a\.js…/);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /aria-label="Cancel enhance"[^>]*>✕</);
  await d.key('Enter');
  assert.ok(!d.calls.some(c => c.body?.type === 'prompt'), 'Enter does not send while enhancing');
  await d.runPolls();
  assert.equal(d.input.value, 'Better');
  assert.equal(d.input.readOnly, false);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /aria-label="Enhance prompt"[^>]*>✨</);
  d.toastAction('Undo');
  assert.equal(d.input.value, 'fix it');
});

test('the composer mode picker switches the mode at once; a failed save puts the previous mode back', async () => {
  let refuse = false;
  const d = await boot({ sessions: [idle('a')], routes: { '/enhance': body => body ? { id: 'j', model: 'p/m', mode: body.mode } : { status: 'running', step: '' }, '/enhance-mode': () => refuse ? { httpStatus: 500, error: 'disk full' } : { mode: 'fast' } } });
  assert.match(d.elements.get('enhanceSlot').innerHTML, /data-enhmode[^>]*>.*<option value="full" [^>]*selected/);
  await d.type('fix it');
  const pick = mode => d.fire('change', { target: d.node('', { tagName: 'SELECT', value: mode, matches: s => s === '[data-enhmode]' }) });
  await pick('fast');
  assert.deepEqual(d.posts('/enhance-mode'), [{ mode: 'fast' }]);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /title="Rewrite this draft with project context: Fast/);
  assert.match(d.elements.get('enhanceSlot').innerHTML, /<option value="fast" [^>]*selected/);
  refuse = true;
  await pick('notest');
  assert.match(d.elements.get('enhanceSlot').innerHTML, /<option value="fast" [^>]*selected/, 'back to the saved mode');
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: 'fix it', mode: 'fast' }]);
  assert.match(d.elements.get('statusLine').innerHTML, /Enhancing \(Fast\)/);
  assert.doesNotMatch(d.elements.get('enhanceSlot').innerHTML, /data-enhmode/, 'no picker while it runs');
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

// Finished sessions (review, done) use the same ✨ rule as any idle composer: text, or images alone, as Send accepts.
const enhanceSlot = d => d.elements.get('enhanceSlot').innerHTML;
const shot = [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }], shotPreview = ['data:image/jpeg;base64,UFJF'];
const enhanceRoutes = () => ({ '/enhance': body => body ? { id: 'j', model: 'p/m' } : { status: 'running', step: '' } });
for (const status of ['review', 'done']) {
  test(`${status}: a typed draft enables ✨ and a click enhances it`, async () => {
    const d = await boot({ sessions: [idle('a', { status })], routes: enhanceRoutes() });
    assert.match(enhanceSlot(d), /title="Type a draft or attach an image to enhance" disabled>✨/);
    await d.type('fix it');
    assert.doesNotMatch(enhanceSlot(d), /disabled/);
    await d.fire('click', { target: d.act('enhance') });
    assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: 'fix it', mode: 'full' }]);
  });
  test(`${status}: an image with no text is enhanced, slash and shell drafts say why they are not`, async () => {
    const d = await boot({ sessions: [idle('a', { status })], routes: enhanceRoutes() });
    await d.paste({ type: 'image/png', size: 3, name: 'shot.png' });
    assert.doesNotMatch(enhanceSlot(d), /disabled/);
    assert.doesNotMatch(d.elements.get('buttons').innerHTML, /disabled/, 'Send accepts it too');
    await d.type('/compact');
    assert.match(enhanceSlot(d), /title="Slash and shell commands are not enhanced" disabled>✨/);
    await d.type('');
    await d.fire('click', { target: d.act('enhance') });
    assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: '', images: shot, preview: shotPreview, mode: 'full' }]);
  });
  test(`${status}: a draft restored on switching back enables ✨ without typing`, async () => {
    const d = await boot({ sessions: [idle('a', { status }), idle('b', { status })], routes: enhanceRoutes() });
    await d.type('fix it');
    await d.go('#/s/b');
    assert.match(enhanceSlot(d), /disabled/);
    await d.go('#/s/a');
    assert.equal(d.input.value, 'fix it');
    assert.doesNotMatch(enhanceSlot(d), /disabled/);
  });
  for (const outcome of ['succeeds', 'fails']) test(`${status}: ✨ is enabled again once a send ${outcome}`, async () => {
    const pending = deferred();
    const d = await boot({ sessions: [idle('a', { status })], routes: { ...enhanceRoutes(), '/sessions/a/command': () => pending.promise } });
    await d.type('hi');
    await d.key('Enter');
    assert.match(enhanceSlot(d), /title="Wait until the message is sent" disabled>✨/);
    if (outcome === 'fails') pending.reject(new Error('down')); else pending.resolve({ id: 'a', status: 'running' });
    for (let i = 0; i < 16; i++) await new Promise(setImmediate);
    await d.type('again');
    assert.doesNotMatch(enhanceSlot(d), /disabled/);
    await d.fire('click', { target: d.act('enhance') });
    assert.deepEqual(d.posts('/enhance'), [{ session: 'a', text: 'again', mode: 'full' }]);
  });
}

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
  assert.deepEqual(d.posts('/enhance'), [{ path: 'C:/proj', model: 'p/a', text: 'fix it', mode: 'full' }]);
});

test('New-session Enhance creates a draft session, moves the draft there and enhances in it', async () => {
  const sessions = [];
  const d = await boot({ hash: '#/new', sessions, routes: {
    '/browse': () => ({ path: 'C:/proj', parent: null, roots: [], recent: [], dirs: [], isGit: true }),
    '/quick-start': () => { sessions.push(idle('n', { draft: true, cwd: 'C:/proj' })); return { id: 'n' }; },
    '/enhance': body => body ? { id: 'j', model: 'p/m' } : { status: 'running', step: '' },
  } });
  await d.fire('click', { target: d.target({ '[data-go]': d.node('', { dataset: { go: 'C:/proj' } }) }) });
  const home = d.elements.get('homePrompt');
  home.value = 'fix it'; await d.fire('input', { target: home });
  await d.fire('click', { target: d.act('enhance') });
  const [qs] = d.posts('/quick-start');
  assert.equal(qs.draft, true);
  assert.equal(qs.path, 'C:/proj');
  assert.ok(!('prompt' in qs) && !('images' in qs), 'the draft session starts empty');
  assert.ok(d.calls.some(c => c.url === '/api/commands?session=n'), 'OMP is started in the picked folder');
  assert.equal(d.location.hash, '#/s/n');
  assert.deepEqual(d.posts('/enhance'), [{ session: 'n', text: 'fix it', mode: 'full' }]);
  assert.equal(d.input.value, 'fix it');
  assert.equal(d.input.readOnly, true);
});

test('a failed draft-session start leaves New session untouched', async () => {
  const d = await boot({ hash: '#/new', routes: {
    '/browse': () => ({ path: 'C:/proj', parent: null, roots: [], recent: [], dirs: [], isGit: false }),
    '/quick-start': () => { throw new Error('nope'); },
  } });
  await d.fire('click', { target: d.target({ '[data-go]': d.node('', { dataset: { go: 'C:/proj' } }) }) });
  const home = d.elements.get('homePrompt');
  home.value = 'fix it'; await d.fire('input', { target: home });
  await d.fire('click', { target: d.act('enhance') });
  assert.equal(d.location.hash, '#/new');
  assert.deepEqual(d.posts('/enhance'), []);
  assert.equal(d.toasts().filter(t => /\berr\b/.test(t.className)).length, 1);
});

// New-session Enhance, from /quick-start until its enhance runs: the draft session already shows in the panel, so the
// user can open it and leave it again. That leave used to discard it, and the enhance then got "Session not found.".
const homeEnhance = async (routes, sessions = []) => {
  const d = await boot({ hash: '#/new', sessions, routes: { '/browse': () => ({ path: 'C:/proj', parent: null, roots: [], recent: [], dirs: [], isGit: true }), ...routes } });
  await startHomeEnhance(d);
  return d;
};
// Picks C:/proj on New session, types a draft with an image and clicks ✨ (New session must be the current view).
const startHomeEnhance = async d => {
  await d.fire('click', { target: d.target({ '[data-go]': d.node('', { dataset: { go: 'C:/proj' } }) }) });
  const home = d.elements.get('homePrompt');
  home.value = 'fix it'; await d.fire('input', { target: home });
  await d.fire('paste', { target: home, clipboardData: { getData: () => '', items: [{ type: 'image/png', getAsFile: () => ({ type: 'image/png', size: 3, name: 'shot.png' }) }] } });
  await d.fire('click', { target: d.act('enhance') });
};
// One dashboard poll (the loop's next tick), as it runs while a request is pending.
const poll = async d => { const due = d.timers.filter(t => t.ms === 1200 || t.ms === 3500); d.timers.splice(0, d.timers.length, ...d.timers.filter(t => !due.includes(t))); for (const t of due) t.fn(); await flush(); };
const errToasts = d => d.toasts().filter(t => /\berr\b/.test(t.className)).map(t => t.textContent);
const discardUrls = d => d.calls.filter(c => c.body?.type === 'discard').map(c => c.url);
// New session as rendered: its prompt holds the draft, its staged image is shown, ✨ and Start are usable.
const homeHasDraft = d => {
  const html = d.elements.get('home').innerHTML;
  assert.match(html, /aria-label="Initial prompt"[^>]*>fix it<\/textarea>/);
  assert.match(d.elements.get('imagePreview').innerHTML, /src="data:image\/jpeg;base64,UFJF"/);
  assert.match(html, /aria-label="Enhance prompt"[^>]*>✨/);
  assert.match(html, />Start session ↵</);
};
// The companion lists the session as soon as it is created, before /quick-start answers (`started`).
const created = (sessions, started) => ({
  '/quick-start': async () => { sessions.push(idle('n', { draft: true, cwd: 'C:/proj' })); await started.promise; return { id: 'n' }; },
  '/sessions/n/command': body => { if (body.type === 'discard') sessions.splice(sessions.findIndex(s => s.id === 'n'), 1); return { discarded: true }; },
  '/enhance': body => !body ? { status: 'running', step: '' } : sessions.some(s => s.id === 'n') ? { id: 'j', model: 'p/m' } : { httpStatus: 404, error: 'Session not found.' },
});

test('New-session Enhance: the draft session opened and left before its enhance starts is kept and enhanced', async () => {
  const sessions = [], started = deferred(), d = await homeEnhance(created(sessions, started), sessions);
  await poll(d);
  await d.go('#/s/n');
  await d.go('#/new');
  started.resolve(); await flush();
  assert.deepEqual(discardUrls(d), [], 'not discarded under the starting enhance');
  assert.deepEqual(errToasts(d), []);
  assert.equal(d.location.hash, '#/s/n');
  assert.deepEqual(d.posts('/enhance'), [{ session: 'n', text: 'fix it', images: shot, preview: shotPreview, mode: 'full' }]);
  assert.equal(d.input.value, 'fix it');
  assert.equal(d.input.readOnly, true);
});

// Draft session d enhances on its own while a New-session Enhance starts. Leaving d then used to queue it behind the
// start, and the start's end discarded it: the companion stopped d's enhance and removed the session.
const enhancingDraftAndHomeStart = async (hash = '#/s/d') => {
  const sessions = [idle('d', { draft: true })], started = deferred(), routes = created(sessions, started);
  const own = { status: 'running', step: 'reading src/a.js' };
  const d = await boot({ hash, sessions, routes: {
    ...routes,
    '/browse': () => ({ path: 'C:/proj', parent: null, roots: [], recent: [], dirs: [], isGit: true }),
    '/enhance': (body, url) => body?.session === 'd' ? { id: 'jd', model: 'p/m' } : !body && url.includes('id=jd') ? own.result || own : routes['/enhance'](body),
  } });
  return { d, sessions, started, own };
};

test('New-session Enhance: a draft session left while its own enhance runs is not discarded when the start ends', async () => {
  const { d, started, own } = await enhancingDraftAndHomeStart();
  await d.type('tidy it');
  await d.fire('click', { target: d.act('enhance') });
  await d.go('#/new');
  await startHomeEnhance(d);
  await d.go('#/s/d');
  await d.go('#/new');
  started.resolve(); await flush();
  await d.runPolls();
  assert.equal(d.location.hash, '#/s/n', 'the New-session Enhance still went ahead');
  assert.deepEqual(discardUrls(d), [], 'd is kept');
  assert.deepEqual(d.posts('/enhance/stop'), [], "d's enhance keeps running");
  await d.go('#/s/d');
  assert.equal(d.input.readOnly, true, 'still enhancing on return');
  assert.match(d.elements.get('statusLine').innerHTML, /Draft kept if you leave/);
  own.result = { status: 'done', text: 'Tidier' };
  await d.runPolls();
  assert.equal(d.input.value, 'Tidier');
  await d.go('#/new');
  assert.deepEqual(discardUrls(d), ['/api/sessions/d/command'], 'leaving once its enhance ended discards it as before');
});

test('New-session Enhance: a draft queued for discard during the start but enhancing when it ends is kept', async () => {
  const { d, started } = await enhancingDraftAndHomeStart('#/new');
  await startHomeEnhance(d);
  await d.go('#/s/d'); // left while idle during the start: queued behind it
  await d.go('#/new');
  await d.go('#/s/d');
  await d.type('tidy it');
  await d.fire('click', { target: d.act('enhance') });
  await d.go('#/new');
  started.resolve(); await flush();
  assert.deepEqual(discardUrls(d), [], 'its enhance keeps it');
  assert.deepEqual(d.posts('/enhance/stop'), []);
  await d.go('#/s/d');
  assert.match(d.elements.get('statusLine').innerHTML, /Draft kept if you leave/);
});

test('New-session Enhance: a draft session gone before /enhance puts the text and images back on New session', async () => {
  const sessions = [], started = deferred(), routes = created(sessions, started);
  started.resolve();
  // Removed elsewhere (another dashboard left it) between /quick-start and /enhance.
  const d = await homeEnhance({ ...routes, '/enhance': body => { if (body) sessions.length = 0; return routes['/enhance'](body); } }, sessions);
  assert.equal(errToasts(d).length, 1);
  assert.equal(d.location.hash, '#/new');
  homeHasDraft(d);
});

test('New-session Enhance: a draft save answered while the start refreshes does not empty the composer', async () => {
  const sessions = [], state = deferred();
  let slow = false;
  const d = await homeEnhance({
    '/quick-start': () => { sessions.push(idle('n', { draft: true, cwd: 'C:/proj' })); slow = true; return { id: 'n' }; },
    '/state': () => slow ? (slow = false, state.promise) : { projects: [], sessions, archived: [] },
    '/draft': body => ({ at: 5, images: (body.images || []).map(i => i.name) }),
    ...enhanceRoutes(),
  }, sessions);
  // That /state request went out before the draft was saved: its reply does not know the saved draft.
  for (const t of d.timers.filter(t => t.ms === 700)) t.fn();
  await flush();
  state.resolve({ projects: [], sessions, archived: [] }); await flush();
  assert.equal(d.location.hash, '#/s/n');
  assert.equal(d.input.value, 'fix it');
  assert.match(d.elements.get('imagePreview').innerHTML, /src="data:image\/jpeg;base64,UFJF"/);
});

test('New-session Enhance: leaving New session while the start runs keeps you there and the draft on New session', async () => {
  const sessions = [idle('b')], started = deferred(), d = await homeEnhance(created(sessions, started), sessions);
  await d.go('#/s/b');
  started.resolve(); await flush();
  assert.equal(d.location.hash, '#/s/b', 'no jump to the new session');
  assert.deepEqual(d.posts('/enhance'), []);
  assert.deepEqual(discardUrls(d), ['/api/sessions/n/command'], 'the unused draft session goes');
  await d.go('#/new');
  homeHasDraft(d);
});

test('New-session Enhance: a draft session removed elsewhere while its enhance runs puts the draft back on New session', async () => {
  const sessions = [], started = deferred(), d = await homeEnhance(created(sessions, started), sessions);
  started.resolve(); await flush();
  assert.equal(d.location.hash, '#/s/n');
  sessions.length = 0; // another dashboard left it: the companion discarded it and stopped its enhance
  await poll(d);
  assert.equal(errToasts(d).length, 1);
  assert.equal(d.location.hash, '#/new');
  homeHasDraft(d);
});

test('leaving an idle draft for New session or another session discards it; its own Changes view does not', async () => {
  const d = await boot({ hash: '#/s/d', sessions: [idle('d', { draft: true }), idle('b')] });
  const discards = () => d.calls.filter(c => c.body?.type === 'discard').map(c => c.url);
  await d.go('#/changes/s:d');
  await d.go('#/s/d');
  assert.deepEqual(discards(), []);
  await d.go('#/new');
  assert.deepEqual(discards(), ['/api/sessions/d/command']);
  await d.go('#/s/b');
  await d.go('#/new');
  assert.equal(discards().length, 1, 'normal sessions are never discarded');
});

for (const outcome of ['fails', 'succeeds']) test(`a send in flight defers discard; it is sent once the send ${outcome}`, async () => {
  const pending = deferred();
  const d = await boot({ hash: '#/s/d', sessions: [idle('d', { draft: true })], routes: {
    '/sessions/d/command': body => body.type === 'prompt' ? pending.promise : { discarded: true },
  } });
  const discards = () => d.calls.filter(c => c.body?.type === 'discard').length;
  await d.type('hi');
  await d.key('Enter');
  await d.go('#/new');
  assert.equal(discards(), 0, 'no discard while the send is in flight');
  if (outcome === 'fails') pending.reject(new Error('down')); else pending.resolve({ id: 'd', status: 'review' });
  for (let i = 0; i < 16; i++) await new Promise(setImmediate);
  assert.equal(discards(), 1, 'the server decides once the send settled');
});

// Leaving while the enhance runs keeps the draft session: no discard, no stop; text, images and the enhance state stay,
// and a result that lands meanwhile is in the composer on return. Leaving again once nothing runs discards it.
for (const outcome of ['done', 'error']) test(`a draft left while its enhance runs is kept; on return the ${outcome === 'done' ? 'result' : 'original after a failure'} is there`, async () => {
  let status = { status: 'running', step: 'reading src/a.js' };
  const d = await boot({ hash: '#/s/d', sessions: [idle('d', { draft: true }), idle('b')], routes: {
    '/enhance': body => body ? { id: 'j', model: 'p/m' } : status,
    '/sessions/d/command': () => ({ discarded: true }),
  } });
  const discards = () => d.calls.filter(c => c.body?.type === 'discard').length;
  await d.paste({ type: 'image/png', size: 3, name: 'shot.png' });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance'), [{ session: 'd', text: 'fix it', images: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }], preview: ['data:image/jpeg;base64,UFJF'], mode: 'full' }]);
  await d.runPolls();
  await d.go('#/new');
  await d.runPolls();
  assert.equal(discards(), 0, 'no discard while the enhance runs');
  assert.deepEqual(d.posts('/enhance/stop'), [], 'the enhance keeps running');
  await d.go('#/s/d');
  assert.equal(d.input.value, 'fix it');
  assert.equal(d.input.readOnly, true, 'still enhancing on return');
  assert.match(d.elements.get('statusLine').innerHTML, /Enhancing \(Full spec\) with m · reading src\/a\.js… · Draft kept if you leave/);
  assert.match(d.elements.get('imagePreview').innerHTML, /src="data:image\/jpeg;base64,UFJF"/);
  await d.go('#/s/b');
  status = outcome === 'done' ? { status: 'done', text: 'Better' } : { status: 'error', error: 'model down' };
  await d.runPolls();
  assert.equal(discards(), 0);
  await d.go('#/s/d');
  assert.equal(d.input.value, outcome === 'done' ? 'Better' : 'fix it');
  assert.equal(d.input.readOnly, false);
  assert.match(d.elements.get('statusLine').innerHTML, /Draft · discarded if you leave without sending/);
  assert.match(d.elements.get('imagePreview').innerHTML, /src="data:image\/jpeg;base64,UFJF"/);
  await d.go('#/new');
  assert.equal(discards(), 1, 'an unsent draft with nothing running is discarded as before');
});

test('cancelling the enhance with ✕ makes the draft discardable again', async () => {
  const d = await boot({ hash: '#/s/d', sessions: [idle('d', { draft: true })], routes: {
    '/enhance': body => body ? { id: 'j', model: 'p/m' } : { status: 'running', step: '' },
    '/enhance/stop': () => ({ status: 'cancelled' }),
  } });
  await d.type('fix it');
  await d.fire('click', { target: d.act('enhance') });
  await d.fire('click', { target: d.act('enhance') });
  assert.deepEqual(d.posts('/enhance/stop'), [{ id: 'j' }]);
  await d.go('#/new');
  assert.equal(d.calls.filter(c => c.body?.type === 'discard').length, 1);
});
