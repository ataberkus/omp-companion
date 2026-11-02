// Render-path caches (frontend-render perf work): whatever a poll reuses must read exactly like a fresh full render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };
const T0 = Date.UTC(2026, 0, 1);
const at = (s = 0) => new Date(T0 + s * 1000).toISOString();
const session = (id, messages, extra = {}) => ({ id, title: 'Chat ' + id, cwd: '/project', status: 'paused', messages, updatedAt: at(), ...extra });
const store = (sessions, extra = {}) => ({ projects: [], sessions, archived: [], ...extra });
const reply = (id, text, s = 0, extra = {}) => ({ id, role: 'assistant', text, at: at(s), ...extra });
const user = (id, text, s = 0, extra = {}) => ({ id, role: 'user', text, at: at(s), ...extra });
const think = (id, text, s = 0) => ({ id, role: 'thinking', text, at: at(s) });
const DIFF = n => ` 1|a\n-2|b${n}\n+2|c${n}\n 3|d`;
const tool = (id, name, s = 0, extra = {}) => ({ id, role: 'tool', at: at(s), tool: { name, intent: 'doing ' + id, args: JSON.stringify({ path: 'src/' + id + '.js' }), status: 'done', result: 'ok ' + id, ...extra } });
const edit = (id, s = 0, extra = {}) => tool(id, 'edit', s, { files: [{ path: 'src/' + id + '.js', op: 'edit', diff: DIFF(id) }], ...extra });

// ---------- a small DOM: nested elements parsed from the app's (well-formed) markup, serialized back verbatim ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const attrsOf = start => Object.fromEntries([...start.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map(m => [m[1], m[2] ?? '']));
function compound(sel) { // tag, .class, [attr], [attr="v"], :not([attr]): enough for the app's thread selectors
  const tag = /^[a-z][\w-]*/i.exec(sel)?.[0], classes = [...sel.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  const has = [...sel.replace(/:not\([^)]*\)/g, '').matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map(m => [m[1], m[2]]);
  const not = [...sel.matchAll(/:not\(\[([\w-]+)\]\)/g)].map(m => m[1]);
  return n => n.nodeType === 1 && (!tag || n.tagName === tag.toUpperCase()) && classes.every(c => n.classList.contains(c))
    && has.every(([k, v]) => k in n.attrs && (v === undefined || n.attrs[k] === v)) && not.every(k => !(k in n.attrs));
}
const matcher = sel => { const parts = sel.split(',').map(s => compound(s.trim())); return n => parts.some(f => f(n)); };
class Node {
  constructor(doc) { this.doc = doc; this.parentNode = null; this.kids = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get childNodes() { return this.kids; }
  get children() { return this.kids.filter(k => k.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get nextElementSibling() { const s = this.parentNode?.children || []; return s[s.indexOf(this) + 1] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n.root; }
  get innerHTML() { return this.kids.map(k => k.outerHTML).join(''); }
  set innerHTML(html) { for (const k of this.kids.splice(0)) k.parentNode = null; parseInto(this, String(html)); this.writes = (this.writes || 0) + 1; }
  get textContent() { return this.kids.map(k => k.textContent).join(''); }
  set textContent(v) { for (const k of this.kids.splice(0)) k.parentNode = null; this.appendChild(new Text(this.doc, String(v))); }
  remove() { if (this.parentNode) { this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1); this.parentNode = null; } }
  appendChild(n) { n.remove(); n.parentNode = this; this.kids.push(n); return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); n.remove(); n.parentNode = this; this.kids.splice(this.kids.indexOf(ref), 0, n); this.doc.inserted++; return n; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  querySelectorAll(sel) { const f = matcher(sel), out = [], walk = n => { for (const k of n.kids) { if (f(k)) out.push(k); walk(k); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Text extends Node { constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; } get outerHTML() { return this.data; } get textContent() { return this.data; } }
class Element extends Node {
  constructor(doc, name, start) {
    super(doc); this.nodeType = 1; this.name = name; this.tagName = name.toUpperCase(); this.start = start; this.attrs = attrsOf(start); this.style = {}; this.scrollTop = 0; this.scrollLeft = 0;
    this.dataset = Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v]));
    const cls = () => (this.attrs.class || '').split(/\s+/).filter(Boolean);
    this.classList = { contains: c => cls().includes(c), add() {}, remove() {}, toggle() {} };
    this.open = 'open' in this.attrs;
  }
  get outerHTML() { return this.start + (VOID.has(this.name.toLowerCase()) ? '' : this.innerHTML + `</${this.name}>`); }
  get id() { return this.attrs.id || ''; }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); } removeAttribute(k) { delete this.attrs[k]; }
  matches(sel) { return matcher(sel)(this); }
  closest(sel) { const f = matcher(sel); for (let n = this; n?.nodeType === 1; n = n.parentNode) if (f(n)) return n; return null; }
  addEventListener() {} focus() {} replaceWith(n) { this.parentNode.insertBefore(n, this); this.remove(); }
  getBoundingClientRect() { return { top: this.y || 0, bottom: (this.y || 0) + 10, left: 0, right: 100, width: 100, height: 10 }; }
}
function parseInto(parent, html) {
  const stack = [parent];
  let last = 0;
  const text = s => { if (s) stack.at(-1).appendChild(new Text(parent.doc, s)); };
  for (const m of html.matchAll(TAG)) {
    text(html.slice(last, m.index)); last = m.index + m[0].length;
    if (m[1]) { while (stack.length > 1 && stack.at(-1).tagName !== m[2].toUpperCase()) stack.pop(); if (stack.length > 1) stack.pop(); continue; }
    const el = stack.at(-1).appendChild(new Element(parent.doc, m[2], m[0]));
    if (!VOID.has(m[2].toLowerCase()) && !m[0].endsWith('/>')) stack.push(el);
  }
  text(html.slice(last));
}

// The real app.js in a vm, its page elements from the small DOM above. ros: ResizeObserver callbacks; ls: localStorage;
// wrap: applied to every JSON body the app reads (the objects it then holds).
function boot({ hash = '#/s/s1', respond, ls = {}, intl, now, wrap = b => b } = {}) {
  const timers = [], listeners = {}, winListeners = {}, ros = [], errors = [];
  const doc = { inserted: 0 };
  const els = new Map();
  const el = (id, tag = 'div') => { const n = new Element(doc, tag, `<${tag} id="${id}">`); n.root = true; els.set(id, n); return n; };
  for (const id of 'app main list conn input thread topbar newBtn scrim groupBy disconnect slash scroller tasks chatPlan extras questions queued statusLine modelSlot hint buttons imagePreview toasts composer-wrap composer promptRail tokenInput search sidebar home'.split(' ')) el(id);
  const document = {
    hidden: false, activeElement: null, body: el('body'), hasFocus: () => true,
    getElementById: id => els.get(id) || null, querySelector: sel => els.get(sel.replace(/^[#.]/, '')) || null, querySelectorAll: () => [],
    createElement: tag => tag !== 'template' ? new Element(doc, tag, `<${tag}>`) : { set innerHTML(v) { const f = new Element(doc, 'fragment', '<fragment>'); parseInto(f, v); this.content = f; } },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const location = { hash, pathname: '/', search: '', reload() {} };
  const fetch = async (url, opts = {}) => {
    const r = (await respond?.(url, opts)) ?? (url.startsWith('/api/models') ? { body: { models: [], roles: {} } } : { body: { sessions: [] } });
    const status = r.status || 200;
    return { ok: status < 400, status, headers: { get: k => r.headers?.[k] ?? null }, json: async () => wrap(structuredClone(r.body ?? {}), url), text: async () => '', blob: async () => ({}) };
  };
  const clock = { offset: 0 };
  const FakeDate = class extends Date { constructor(...a) { super(...(a.length ? a : [Date.now() + clock.offset])); } static now() { return Date.now() + clock.offset; } };
  runInNewContext(source, {
    document, Element, window: { innerHeight: 900, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); } }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location, history: { replaceState() {} }, URLSearchParams, AbortSignal, CSS: { escape: s => String(s) }, matchMedia: () => ({ matches: false }), Date: now ? FakeDate : Date, console: { ...console, error: (...a) => errors.push(a) }, confirm: () => true,
    localStorage: { getItem: k => ls[k] ?? null, setItem() {} }, sessionStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { constructor(fn) { ros.push(fn); } observe() {} disconnect() {} }, fetch,
    ...(intl ? { Intl: intl } : {}),
  });
  const poll = async () => { await timers.filter(t => t.fn.name === 'loop').at(-1).fn().catch(() => {}); await flush(); };
  // The app's toggle listener runs on <details> toggles; record a user's toggle the way the browser would report it.
  const toggle = node => { node.open = !node.open; for (const fn of listeners.toggle || []) fn({ target: node }); };
  const click = target => { for (const fn of listeners.click || []) fn({ target, preventDefault() {}, stopPropagation() {} }); };
  return { els, doc, poll, toggle, click, ros, errors, clock, listeners, thread: () => els.get('thread').innerHTML };
}
const stateOf = st => url => url.startsWith('/api/state') ? { body: typeof st === 'function' ? st(url) : st } : undefined;
const fullRender = async (st, opts = {}) => { const fresh = boot({ respond: stateOf(st), ...opts }); await flush(); return fresh.thread(); };

test('ago() and clock() read exactly like toLocale*String, from formatters rebuilt only once they are a second old', async () => {
  let built = 0;
  const intl = { ...Intl, DateTimeFormat: class extends Intl.DateTimeFormat { constructor(...a) { super(...a); built++; } } };
  const messages = Array.from({ length: 40 }, (_, i) => i % 2 ? reply('a' + i, 'answer ' + i, i * 3700) : user('u' + i, 'question ' + i, i * 3700));
  const old = Array.from({ length: 30 }, (_, i) => session('o' + i, [], { updatedAt: new Date(T0 - (8 + i * 9) * 86400e3).toISOString() }));
  let st = store([session('s1', messages, { status: 'running' }), ...old]);
  const app = boot({ respond: stateOf(() => st), intl, now: true });
  await flush();
  for (const m of messages) assert.ok(app.thread().includes(`<time>${new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>`), m.id);
  const list = app.els.get('list').innerHTML;
  for (const s of old) assert.ok(list.includes(`>${new Date(s.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}<`), s.id);
  assert.ok(built <= 4, `${built} formatters for 40 times and 30 dates`);
  const before = built;
  st = store([session('s1', [...messages, reply('late', 'one more', 200000)], { status: 'running' }), ...old]);
  await app.poll();
  assert.equal(built, before, 'a render within the second reuses them');
  app.clock.offset += 1500;
  st = store([session('s1', [...messages, reply('later', 'and more', 200001)], { status: 'running' }), ...old]);
  await app.poll();
  assert.ok(built > before, 'a second later they are built again, so a time-zone change shows');
});

// The companion's delta protocol for the viewed session s1: a poll gets the messages changed since the rev it holds, so the
// app keeps the objects of unchanged ones (as mergeTx does with the real companion). set() replaces the transcript.
function txServer(initial, extra = {}) {
  let rev = 1, held = initial.map(m => ({ m, rev })), models = { models: [], roles: {} };
  const sess = { status: 'running', ...extra };
  return {
    set(list, patch = {}) { rev++; const old = new Map(held.map(x => [x.m.id, x])); held = list.map(m => { const o = old.get(m.id); return o && JSON.stringify(o.m) === JSON.stringify(m) ? o : { m, rev }; }); Object.assign(sess, patch); },
    get messages() { return held.map(x => x.m); },
    models(m) { models = m; },
    respond: url => {
      if (url.startsWith('/api/models')) return { body: models };
      if (!url.startsWith('/api/state')) return;
      const since = new URL(url, 'http://x').searchParams.get('since'), n = since?.startsWith('e1.') ? +since.slice(3) : 0;
      const tx = { session: 's1', epoch: 'e1', rev, ...(n ? { changed: held.filter(x => x.rev > n).map(x => x.m), order: held.map(x => x.m.id) } : {}) };
      return { body: { ...store([session('s1', n ? undefined : held.map(x => x.m), sess)]), tx } };
    },
    full: () => store([session('s1', held.map(x => x.m), sess)]),
  };
}
// Counts reads of one message field (per message id) on the objects the app holds; targets: those objects, unwrapped.
function counting(field) {
  const reads = new Map(), targets = new Map();
  const wrapMsg = m => { targets.set(m.id, m); return new Proxy(m, { get(t, k) { if (k === field) reads.set(t.id, (reads.get(t.id) || 0) + 1); return t[k]; } }); };
  const wrap = b => { for (const s of b.sessions || []) if (s.messages) s.messages = s.messages.map(wrapMsg); if (b.tx?.changed) b.tx.changed = b.tx.changed.map(wrapMsg); return b; };
  return { reads, targets, wrap };
}
const thread1 = () => [user('u0', 'first question', 0, { entryId: 'e0' }), reply('a1', 'an **answer** with\n\n- a list\n- of items', 1, { model: 'prov/m1' }), edit('t2', 2), think('k3', 'pondering\n\n- nested *list*', 3), tool('t4', 'bash', 4, { args: JSON.stringify({ command: 'npm test' }) }),
  user('u5', 'second question', 5, { entryId: 'e5' }), reply('a6', 'another answer', 6), tool('t7', 'read', 7), edit('t8', 8, { status: 'running', result: 'partial' })];
const streamT8 = (srv, result, extra = {}) => srv.set(srv.messages.map(m => m.id === 't8' ? { ...m, tool: { ...m.tool, result, ...extra } } : m));

test('a streaming poll reuses the markup of unchanged thread parts, and the thread still reads like a full render', async () => {
  const srv = txServer(thread1()), c = counting('text');
  const app = boot({ respond: srv.respond, wrap: c.wrap });
  await flush();
  assert.equal(app.thread(), await fullRender(srv.full()));
  for (let k = 1; k <= 3; k++) {
    c.reads.clear();
    streamT8(srv, 'partial' + '.'.repeat(k));
    await app.poll();
    assert.equal(app.thread(), await fullRender(srv.full()), `poll ${k}`);
    assert.deepEqual(['u0', 'a1', 'k3', 'u5', 'a6'].filter(id => c.reads.get(id)), [], `poll ${k}: unchanged messages are not rendered again`);
  }
  srv.set([...srv.messages.map(m => m.id === 't8' ? { ...m, tool: { ...m.tool, status: 'done', result: 'all done' } } : m), reply('a9', 'finished', 9)], { status: 'review' });
  await app.poll();
  assert.equal(app.thread(), await fullRender(srv.full()), 'the turn ends: the live group settles, history buttons appear');
});

test('cached thread parts follow every other input: toggles, expand-all, diff layout, model names, history buttons, steer edits', async () => {
  const srv = txServer(thread1());
  let models;
  const respond = url => url.startsWith('/api/models') ? new Promise(r => { models = () => r({ body: { models: [{ selector: 'prov/m1', name: 'Model One' }], roles: {} } }); }) : srv.respond(url);
  // omp-debug-parts: every cache hit is built again and compared; a stale part is logged.
  const app = boot({ respond, ls: { 'omp-debug-parts': '1' } });
  await flush();
  const thread = app.els.get('thread');
  assert.match(app.thread(), /who-model">m1</);
  models(); await flush(); streamT8(srv, 'out 1'); await app.poll();
  assert.match(app.thread(), /who-model">Model One</, 'model names arrive: the reply that names one is rebuilt');
  app.click({ closest: sel => sel === '[data-act]' ? { dataset: { act: 'expandAll' }, closest: () => null } : null }); await flush();
  assert.match(app.thread(), /data-gid="t2" data-def="1" open/, 'expand-all opens the settled group');
  app.click({ closest: sel => sel === '[data-diffmode]' ? { dataset: { diffmode: 'unified' } } : null }); await flush();
  assert.match(app.thread(), /class="diff unified/);
  streamT8(srv, 'out 2'); await app.poll();
  srv.models({ models: [{ selector: 'prov/m1', name: 'Model One' }], roles: {} });
  assert.equal(app.thread(), await fullRender(srv.full(), { respond: srv.respond, ls: { 'omp-expand-activity': '1', 'omp-diff-mode': 'unified' } }), 'reads like a full render with the same settings');
  // Toggle a group and a row the way a click would; the next render keeps them that way.
  app.toggle(thread.querySelector('details.activity'));
  app.toggle(thread.querySelectorAll('details.row')[1]);
  streamT8(srv, 'out 3'); await app.poll();
  assert.doesNotMatch(app.thread(), /data-gid="t2" data-def="1" open/, 'the closed group stays closed');
  srv.set([...srv.messages.map(m => m.id === 't8' ? { ...m, tool: { ...m.tool, status: 'done' } } : m), user('u9', 'steer this', 9, { steer: 'pending' })]);
  await app.poll();
  app.click({ closest: sel => sel === '[data-steeract]' ? { dataset: { steeract: 'edit_steer', id: 'u9' } } : null }); await flush();
  assert.match(app.thread(), /data-steerinput[^>]*>steer this</, 'the steer being edited shows its text box');
  app.click({ closest: sel => sel === '[data-steerclose]' ? {} : null }); await flush();
  assert.doesNotMatch(app.thread(), /data-steerinput/);
  srv.set(srv.messages.filter(m => m.id !== 'u9'), { status: 'review' });
  await app.poll();
  assert.match(app.thread(), /data-msgact="regenerate"/, 'idle: history buttons appear on the parts that get them');
  assert.deepEqual(app.errors.filter(e => e[0] === 'Stale thread part'), [], 'no cached part differed from a fresh build');
});

test('the live activity group is patched in place: unchanged rows keep their elements, rebuilt ones their scroll offsets', async () => {
  const head = thread1().slice(0, 6);
  const srv = txServer([...head, tool('t7', 'read', 7), edit('e8', 8), think('k9', 'hmm', 9), tool('t10', 'bash', 10, { status: 'running', result: 'line 1', args: JSON.stringify({ command: 'make' }) })]);
  const app = boot({ respond: srv.respond, ls: { 'omp-debug-parts': '1' } });
  await flush();
  const thread = app.els.get('thread'), group = () => thread.querySelector('details.activity.live'), rows = () => [...group().querySelectorAll('details.row')];
  const G = group(), R = rows(), S0 = G.firstElementChild;
  assert.deepEqual(R.map(r => r.dataset.rid), ['t7', 'e8', 'k9', 't10']);
  // The running row's output was scrolled: the app records that from the scroll event.
  const out = R[3].querySelector('pre');
  out.scrollTop = 50;
  for (const fn of app.listeners.scroll) fn({ target: out });
  srv.set(srv.messages.map(m => m.id === 't10' ? { ...m, tool: { ...m.tool, result: 'line 1\nline 2' } } : m));
  thread.writes = 0; app.doc.inserted = 0;
  await app.poll();
  assert.equal(app.thread(), await fullRender(srv.full()));
  assert.equal(group(), G, 'the group keeps its element');
  assert.equal(G.firstElementChild, S0, 'and its summary, which did not change');
  assert.deepEqual(rows().map((r, i) => r === R[i]), [true, true, true, false], 'only the streaming row is rebuilt');
  assert.equal(rows()[3].querySelector('pre').scrollTop, 50, 'its output keeps the scroll offset');
  assert.equal(thread.writes, 0, 'nothing is rewritten whole');
  // A new row: the previous one settles, the summary counts it.
  srv.set([...srv.messages.map(m => m.id === 't10' ? { ...m, tool: { ...m.tool, status: 'done' } } : m), tool('t11', 'grep', 11, { status: 'running', args: JSON.stringify({ pattern: 'TODO' }) })]);
  await app.poll();
  assert.equal(app.thread(), await fullRender(srv.full()));
  assert.equal(group(), G);
  assert.deepEqual(rows().map((r, i) => r === R[i]), [true, true, true, false, false]);
  assert.match(G.firstElementChild.innerHTML, /searched code/);
  // A row the user closed stays closed; the rest stay put.
  const e8 = rows()[1];
  app.toggle(e8);
  srv.set(srv.messages.map(m => m.id === 't11' ? { ...m, tool: { ...m.tool, result: 'a:1' } } : m));
  await app.poll();
  assert.equal(group(), G);
  assert.ok(!rows()[1].open && !('open' in rows()[1].attrs), 'the closed edit row is rendered closed');
  assert.equal(rows()[0], R[0]);
  // The turn ends: the group is no longer live and is rebuilt once, as a settled group.
  srv.set([...srv.messages.map(m => m.id === 't11' ? { ...m, tool: { ...m.tool, status: 'done' } } : m), reply('a12', 'done', 12)], { status: 'review' });
  app.toggle(rows()[1]);
  await app.poll();
  assert.equal(app.thread(), await fullRender(srv.full()));
  assert.notEqual(thread.querySelector('details.activity[data-gid="t7"]'), G);
  assert.deepEqual(app.errors.filter(e => e[0] === 'Stale thread part'), []);
});

test('omp-debug-parts catches a part whose input is missing from its ctx (here: a message edited in place)', async () => {
  for (const debug of [false, true]) {
    const srv = txServer(thread1()), c = counting('text');
    const app = boot({ respond: srv.respond, wrap: c.wrap, ls: debug ? { 'omp-debug-parts': '1' } : {} });
    await flush();
    c.targets.get('a6').text = 'edited in place';
    streamT8(srv, 'more');
    await app.poll();
    assert.doesNotMatch(app.thread(), /edited in place/, 'the cached markup is what shows');
    assert.equal(app.errors.filter(e => e[0] === 'Stale thread part').length, debug ? 1 : 0);
  }
});
