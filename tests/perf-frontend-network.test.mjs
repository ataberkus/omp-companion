import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };
const at = (s = 0) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
const session = (id, messages, extra = {}) => ({ id, title: 'Chat ' + id, cwd: '/project', status: 'paused', messages, updatedAt: at(), ...extra });
const store = (sessions, extra = {}) => ({ projects: [], sessions, archived: [], ...extra });
const reply = (id, text, s = 0) => ({ id, role: 'assistant', text, at: at(s) });
const query = url => Object.fromEntries(new URL(url, 'http://x').searchParams);

// A reply body the test hands out chunk by chunk: send() delivers one, fail() errors the read (a dropped link). Reads
// reject with the request signal's reason once it aborts, as a browser's do.
function chunked(text) {
  const enc = new TextEncoder(), parts = [], waiting = [];
  let error = null, done = false;
  const settle = () => { while (waiting.length && (parts.length || error || done)) { const w = waiting.shift(); if (parts.length) w.ok({ done: false, value: parts.shift() }); else if (error) w.no(error); else w.ok({ done: true, value: undefined }); } };
  const body = {
    send(n) { const s = text.slice(0, n); text = text.slice(n); parts.push(enc.encode(s)); if (!text) done = true; settle(); },
    fail(e) { error = e; settle(); },
    attach(signal) { signal?.addEventListener('abort', () => { error = signal.reason; settle(); }); },
    reader: { read: () => new Promise((ok, no) => { waiting.push({ ok, no }); settle(); }) },
    get left() { return text.length; },
  };
  return body;
}

// The real app.js in a vm with just enough DOM (as frontend-render.test.mjs boots it), plus what these tests drive:
// document.hidden, a clock the api() timers run on (advance()), AbortController/TextDecoder for api()'s own timeout,
// replies with headers, a status or a chunked body, and a count of every innerHTML write per element.
function boot({ hash = '#/s/s1', respond, size = { width: 1360, height: 900 } } = {}) {
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
    // res.json() reads the same body, so a page reading it whole sees the same failures.
    const all = async () => { let s = ''; const dec = new TextDecoder(); for (let x; !(x = await stream.reader.read()).done;) s += dec.decode(x.value, { stream: true }); return s + dec.decode(); };
    return { ok: status < 400, status, headers: { get: k => r.headers?.[k] ?? null }, body: stream && !r.noStream ? { getReader: () => stream.reader } : null,
      json: async () => JSON.parse(await all()), text: async () => stream ? all() : '' };
  };
  // AbortSignal.timeout on the same clock, so a page that times out the whole request (as app.js did) shows it too.
  const timeoutSignal = ms => { const c = new AbortController(); timers.push({ fn: function signalTimeout() { c.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms, due: clock.now + ms }); return c.signal; };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  runInNewContext(source, {
    document, window: { innerHeight: size.height, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); } }, addEventListener() {}, innerWidth: size.width, innerHeight: size.height,
    location, history: { replaceState() {} }, URLSearchParams, AbortSignal: { timeout: timeoutSignal }, AbortController, TextDecoder, CSS: { escape: s => String(s) }, matchMedia: () => ({ matches: false }),
    Date: FakeDate, console: { ...console, error() {} }, confirm: () => true,
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
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
  return { els, calls, timers, writes, states, loops, poll, advance, go, visible, document, location, clock, thread: () => els.get('thread').innerHTML, list: () => els.get('list').innerHTML };
}

// ---------- api(): body failures and the timeout ----------
test('a first /state body that keeps arriving finishes although it takes longer than the timeout', async () => {
  const text = JSON.stringify(store([session('s1', [reply('m1', 'slowly delivered reply')])]));
  const body = chunked(text);
  const app = boot({ respond: url => url.startsWith('/api/state') ? { chunked: body, headers: { ETag: '"v1"' } } : undefined });
  await flush();
  const third = Math.ceil(text.length / 3);
  await app.advance(20000); body.send(third);
  await app.advance(25000); body.send(third); // 45 s in: past the 30 s timeout, but the body made progress
  await app.advance(25000); body.send(Infinity); // 70 s in
  await flush();
  assert.match(app.thread(), /slowly delivered reply/);
});

test('a stalled body fails the poll after the timeout without progress, and its ETag is not kept', async () => {
  let body;
  const full = store([session('s1', [reply('m1', 'the store at last')])]);
  const app = boot({ respond: url => url.startsWith('/api/state') ? (body ? { body: full, headers: { ETag: '"v2"' } } : { chunked: body = chunked(JSON.stringify(full)), headers: { ETag: '"v1"' } }) : undefined });
  await flush();
  await app.advance(10000); body.send(40);
  await app.advance(29000);
  assert.ok(body.left > 0, 'still waiting 29 s after the last chunk');
  await app.advance(2000);
  assert.ok(app.loops().length, 'the failed first poll scheduled the next one');
  await app.poll();
  assert.equal(app.states().at(-1).inm, undefined, 'the next poll is unconditional: the failed reply’s ETag was not kept');
  assert.match(app.thread(), /the store at last/);
});

test('a body cut off mid-download, or one that is not a store, does not leave the page on an empty store', async () => {
  for (const broken of [
    () => { const b = chunked(JSON.stringify(store([session('s1', [reply('m1', 'never arrives')])]))); b.send(30); setImmediate(() => b.fail(new TypeError('network error'))); return { chunked: b, headers: { ETag: '"v1"' } }; },
    () => ({ raw: '<html>Bad gateway</html>', headers: { ETag: '"v1"' } }),
    () => ({ body: {}, headers: { ETag: '"v1"' } }),
  ]) {
    let first = true;
    const app = boot({ respond: (url, call) => {
      if (!url.startsWith('/api/state')) return;
      if (first) { first = false; return broken(); }
      return call.inm === '"v1"' ? { status: 304 } : { body: store([session('s1', [reply('m1', 'whole store')])]), headers: { ETag: '"v2"' } };
    } });
    await flush();
    await app.poll();
    assert.equal(app.states()[1].inm, undefined, 'the broken reply’s ETag is not sent back');
    assert.match(app.thread(), /whole store/);
  }
});
