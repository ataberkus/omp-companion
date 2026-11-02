// The dashboard's app.js in a vm with a small DOM and a scripted companion (the boot() of perf-frontend-network.test.mjs),
// for tests/perf-frontend-network-native.test.mjs. Not a test file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';


export const APP = process.env.APP || new URL('../local-dist/app.js', import.meta.url).pathname; const source = await readFile(APP, 'utf8');
export const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };
export const at = (s = 0) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
export const session = (id, messages, extra = {}) => ({ id, title: 'Chat ' + id, cwd: '/project', status: 'paused', messages, updatedAt: at(), ...extra });
export const store = (sessions, extra = {}) => ({ projects: [], sessions, archived: [], ...extra });
export const reply = (id, text, s = 0) => ({ id, role: 'assistant', text, at: at(s) });
export const query = url => Object.fromEntries(new URL(url, 'http://x').searchParams);

// A reply body the test hands out chunk by chunk: send() delivers one, fail() errors the reads (a dropped link). Reads
// reject with the request signal's reason once it aborts, as a browser's do. Every reader() gets every chunk, as the
// reply and its clone() do.
export function chunked(text) {
  const enc = new TextEncoder(), parts = [], waiting = [];
  let error = null, done = false;
  const settle = () => { for (const w of waiting.splice(0)) { if (w.r.at < parts.length) w.ok({ done: false, value: parts[w.r.at++] }); else if (error) w.no(error); else if (done) w.ok({ done: true, value: undefined }); else waiting.push(w); } };
  const body = {
    send(n) { const s = text.slice(0, n); text = text.slice(n); parts.push(enc.encode(s)); if (!text) done = true; settle(); },
    fail(e) { error = e; settle(); },
    attach(signal) { signal?.addEventListener('abort', () => { error = signal.reason; settle(); }); },
    reader() { const r = { at: 0 }; return { read: () => new Promise((ok, no) => { waiting.push({ r, ok, no }); settle(); }) }; },
    get left() { return text.length; },
  };
  return body;
}

// The real app.js in a vm with just enough DOM (as frontend-render.test.mjs boots it), plus what these tests drive:
// document.hidden, a clock the api() timers run on (advance()), AbortController for api()'s own timeout,
// replies with headers, a status or a chunked body, and a count of every innerHTML write per element.
export function boot({ hash = '#/s/s1', respond, size = { width: 1360, height: 900 }, storage = {} } = {}) {
  const calls = [], timers = [], writes = new Map(), listeners = {}, winListeners = {}, clock = { now: Date.UTC(2026, 0, 1, 12) };
  const node = id => {
    let html = '';
    return {
      id, tagName: 'DIV', value: '', style: {}, dataset: {}, children: [], attributes: [], hidden: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      get innerHTML() { return html; }, set innerHTML(v) { html = v; writes.set(id, (writes.get(id) || 0) + 1); },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute(k, v) { this['@' + k] = v; }, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false, matches: () => false, closest: () => null,
      appendChild() {}, append() {}, remove() {},
    };
  };
  const els = new Map('app main list conn input thread topbar newBtn scrim groupBy disconnect slash scroller tasks chatPlan extras questions queued statusLine modelSlot hint buttons imagePreview toasts composer-wrap composer promptRail tokenInput search sidebar home commitSlot toolNav toolForm toolJobs'.split(' ').map(id => [id, node(id)]));
  const document = {
    hidden: false, activeElement: null, body: node('body'), title: '',
    getElementById: id => els.get(id) || null, querySelector: sel => els.get(sel.replace(/^[#.]/, '')) || null, querySelectorAll: () => [], createElement: tag => node(tag),
    addEventListener: (type, fn, capture) => { if (!capture) (listeners[type] ||= []).push(fn); },
  };
  const location = { hash, pathname: '/', search: '', reload() {} };
  const fetch = async (url, opts = {}) => {
    const call = { url, inm: opts.headers?.['If-None-Match'], body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const r = (await respond?.(url, call)) ?? (url.startsWith('/api/models') ? { body: { models: [], roles: {} } } : { body: { sessions: [] } });
    if (r.reject) throw new TypeError('Failed to fetch');
    const status = r.status || 200;
    const stream = r.chunked || (status === 304 ? null : chunked(r.raw ?? JSON.stringify(r.body ?? {})));
    stream?.attach(opts.signal);
    if (stream && !r.chunked) stream.send(Infinity);
    // res.json() reads the same body (and a clone a copy of it), so a page reading it whole sees the same failures.
    const all = async () => { let s = ''; const dec = new TextDecoder(), reader = stream.reader(); for (let x; !(x = await reader.read()).done;) s += dec.decode(x.value, { stream: true }); return s + dec.decode(); };
    const res = { ok: status < 400, status, headers: { get: k => r.headers?.[k] ?? null }, body: stream ? { getReader: () => stream.reader() } : null,
      json: async () => JSON.parse(await all()), text: async () => stream ? all() : '' };
    return { ...res, clone: () => res };
  };
  // AbortSignal.timeout on the same clock, so a page that times out the whole request (as app.js did) shows it too.
  const timeoutSignal = ms => { const c = new AbortController(); timers.push({ fn: function signalTimeout() { c.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms, due: clock.now + ms }); return c.signal; };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  runInNewContext(source, {
    document, window: { innerHeight: size.height, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); } }, addEventListener() {}, innerWidth: size.width, innerHeight: size.height,
    location, history: { replaceState() {} }, URLSearchParams, AbortSignal: { timeout: timeoutSignal }, AbortController, CSS: { escape: s => String(s) }, matchMedia: () => ({ matches: false }),
    Date: FakeDate, console: { ...console, error() {} }, confirm: () => true,
    localStorage: { getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } }, sessionStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    setTimeout: (fn, ms = 0) => { timers.push({ fn, ms, due: clock.now + ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} }, fetch,
  });
  const loops = () => timers.filter(t => t.fn.name === 'loop');
  const poll = async () => { await loops().at(-1).fn().catch(() => {}); await flush(); };
  // Moves the clock on, running api()'s own timers (named idle) and AbortSignal.timeout's as they come due.
  const advance = async ms => {
    await flush();
    const end = clock.now + ms;
    for (let t; (t = timers.find(t => !t.cleared && !t.ran && /^(idle|signalTimeout)$/.test(t.fn.name) && t.due <= end));) { clock.now = Math.max(clock.now, t.due); t.ran = true; t.fn(); await flush(); }
    clock.now = end; await flush();
  };
  const go = async h => { location.hash = h; winListeners.hashchange.forEach(fn => fn()); await flush(); };
  const visible = async on => { document.hidden = !on; for (const fn of listeners.visibilitychange || []) fn(); await flush(); };
  const states = () => calls.filter(c => c.url.startsWith('/api/state'));
  els.get('input').tagName = 'TEXTAREA';
  const type = async (text, mods = {}) => { const input = els.get('input'); input.value = text; for (const fn of listeners.keydown || []) fn({ target: input, key: 'Enter', code: 'Enter', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, ...mods }); await flush(); };
  const click = async (act, data = {}) => { const el = node(''); el.dataset = { act, ...data }; for (const fn of listeners.click || []) fn({ target: { ...node(''), closest: sel => sel === '[data-act]' ? el : null }, preventDefault() {}, stopPropagation() {} }); await flush(); };
  const connect = async token => { els.get('tokenInput').value = token; listeners.submit[0]({ target: { id: 'connectForm', hasAttribute: () => false, dataset: {} }, preventDefault() {} }); await flush(); };
  return { els, calls, timers, writes, states, loops, poll, advance, go, visible, connect, type, click, document, location, clock, thread: () => els.get('thread').innerHTML, list: () => els.get('list').innerHTML };
}

