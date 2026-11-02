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

// The real app.js in a vm, its page elements from the small DOM above. ros: ResizeObserver callbacks; ls: localStorage.
function boot({ hash = '#/s/s1', respond, ls = {}, intl, now } = {}) {
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
    return { ok: status < 400, status, headers: { get: k => r.headers?.[k] ?? null }, json: async () => structuredClone(r.body ?? {}), text: async () => '', blob: async () => ({}) };
  };
  const clock = { offset: 0 };
  const FakeDate = class extends Date { constructor(...a) { super(...(a.length ? a : [Date.now() + clock.offset])); } static now() { return Date.now() + clock.offset; } };
  runInNewContext(source, {
    document, window: { innerHeight: 900, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); } }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
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
