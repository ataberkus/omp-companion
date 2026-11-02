import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { cliCatalog } from '../companion/cli-tools.mjs';

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
function boot({ hash = '#/s/s1', respond, size = { width: 1360, height: 900 }, storage = {} } = {}) {
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

// ---------- hidden pages ----------
test('a hidden page renders nothing on its polls but keeps the title badge current; showing it renders at once', async () => {
  let s2 = session('s2', [], { status: 'running' });
  const app = boot({ respond: url => url.startsWith('/api/state') ? { body: store([session('s1', [reply('m1', 'hello')]), s2]) } : undefined });
  await flush(); await app.poll();
  assert.equal(app.document.title, 'OMP Control Room');
  await app.visible(false);
  const before = JSON.stringify([...app.writes]);
  s2 = session('s2', [], { status: 'review', title: 'Chat s2 settled', workFinishedAt: at(5) });
  await app.poll(); await app.poll();
  assert.equal(app.document.title, '(1) OMP Control Room', 'the badge counts the session that settled while hidden');
  assert.equal(JSON.stringify([...app.writes]), before, 'nothing rendered while hidden');
  assert.doesNotMatch(app.list(), /Chat s2 settled/);
  await app.visible(true);
  assert.match(app.list(), /Chat s2 settled/, 'shown again: rendered at once');
});

test('the first visible poll after hidden ones renders even when it brings nothing new', async () => {
  let title = 'before';
  const app = boot({ respond: (url, call) => url.startsWith('/api/state') ? (call.inm === `"${title}"` ? { status: 304 } : { body: store([session('s1', [reply('m1', 'hello')], { title })]), headers: { ETag: `"${title}"` } }) : undefined });
  await flush(); await app.poll();
  app.document.hidden = true; // no visibilitychange: this page is seen again only by its next poll
  title = 'renamed while hidden';
  await app.poll();
  assert.doesNotMatch(app.els.get('topbar').innerHTML, /renamed while hidden/);
  app.document.hidden = false;
  await app.poll();
  assert.equal(app.states().at(-1).inm, '"renamed while hidden"', 'a 304: nothing new since the hidden poll');
  assert.match(app.els.get('topbar').innerHTML, /renamed while hidden/, 'rendered what the hidden poll brought');
});

// ---------- OMP's session list (/api/omp-sessions) ----------
const nativeList = (n = 1) => ({ dir: '/omp', sessions: Array.from({ length: n }, (_, i) => ({ file: `/omp/h${i}.jsonl`, title: 'History ' + i, cwd: '/project', updatedAt: at(-100 - i), preview: 'p' })) });
test('the OMP session list loads alongside /state, and conditionally: a 304 keeps the list and renders nothing', async () => {
  let release, list = nativeList(1), unauthorized = false;
  const gate = new Promise(r => { release = r; });
  const app = boot({ hash: '#/new', respond: async (url, call) => {
    if (url.startsWith('/api/state')) { if (unauthorized) return { status: 401, body: { error: 'Invalid connection token.' } }; await gate; return call.inm === '"s"' ? { status: 304 } : { body: store([session('s1', [])]), headers: { ETag: '"s"' } }; }
    if (url.startsWith('/api/omp-sessions')) { const tag = `"n${list.sessions.length}"`; return call.inm === tag ? { status: 304 } : { body: list, headers: { ETag: tag } }; }
  } });
  await flush();
  const listings = () => app.calls.filter(c => c.url.startsWith('/api/omp-sessions'));
  assert.equal(listings().length, 1, 'requested while /state is still on its way');
  release(); await flush();
  assert.match(app.list(), /History 0/);
  await app.advance(15000); await app.poll(); // the 10 s "ago" render
  await app.advance(6000);
  const writes = JSON.stringify([...app.writes]);
  await app.poll();
  assert.equal(listings().at(-1).inm, '"n1"', 'due again: asked conditionally');
  assert.match(app.list(), /History 0/, 'the 304 kept the list');
  assert.equal(JSON.stringify([...app.writes]), writes, 'and, with /state unchanged too, nothing rendered');
  list = nativeList(2);
  await app.advance(21000); await app.poll();
  assert.match(app.list(), /History 1/, 'a changed list is a 200 that renders');
  // Signed out (the token no longer accepted): the list is dropped, and so is its ETag, or a 304 would keep it empty.
  unauthorized = true; await app.poll();
  unauthorized = false; await app.connect('tok');
  assert.equal(listings().at(-1).inm, undefined);
  assert.match(app.list(), /History 1/);
});

// ---------- session commands: ?lean=1 (protocol P1) ----------
test('session commands ask for lean replies, and a reply without the transcript leaves the shown one alone', async () => {
  const s1 = session('s1', [reply('m1', 'the transcript so far')], { queuedMessages: [] });
  const app = boot({ respond: url => {
    if (url.startsWith('/api/state')) return { body: store([s1]) };
    // As the companion answers: ?lean=1 leaves out the transcript (and /btw answers).
    if (/\/command(\?|$)/.test(url)) return { body: url.endsWith('?lean=1') ? { ...s1, messages: undefined } : s1 };
  } });
  await flush();
  await app.type('a prompt');
  s1.status = 'running';
  await app.poll();
  await app.type('a steer');
  await app.click('commitRelated'); // queued as a follow-up while it works (sendOrQueue)
  await app.click('abort');
  const sent = app.calls.filter(c => c.body?.type).map(c => [c.body.type, c.url]);
  assert.deepEqual(sent, [['prompt', '/api/sessions/s1/command?lean=1'], ['steer', '/api/sessions/s1/command?lean=1'], ['follow_up', '/api/sessions/s1/command?lean=1'], ['abort', '/api/sessions/s1/command?lean=1']]);
  assert.match(app.thread(), /the transcript so far/, 'the lean replies did not blank the thread');
});

// ---------- background work and subagent transcripts: conditional (protocol P2) ----------
// The companion's side: a 304 when If-None-Match names the body's ETag.
const tagged = (call, body, tag) => call.inm === tag ? { status: 304 } : { body, headers: { ETag: tag } };
test('the Activity panel and a subagent transcript poll conditionally and keep what they hold on a 304', async () => {
  const bg = { tasks: [{ id: 'j1', type: 'bash', title: 'npm test', status: 'done', startedAt: at(1), finishedAt: at(2) }], agents: [], subagents: [], live: true };
  const sub = { file: '/x/sub.jsonl', messages: [reply('r1', 'subagent reasoning shown')], updatedAt: at(3), active: true };
  const app = boot({ respond: (url, call) => {
    if (url.startsWith('/api/state')) return { body: store([session('s1', [reply('m1', 'hi')], { sessionFile: '/x/s1.jsonl', status: 'running' })]) };
    if (url.startsWith('/api/background')) return tagged(call, bg, '"b1"');
    if (url.startsWith('/api/transcript')) return tagged(call, sub, '"t1"');
  } });
  await flush();
  const bgCalls = () => app.calls.filter(c => c.url.startsWith('/api/background'));
  assert.match(app.els.get('tasks').innerHTML, /npm test/);
  await app.advance(4000); await app.poll();
  assert.equal(bgCalls().at(-1).inm, '"b1"');
  assert.match(app.els.get('tasks').innerHTML, /npm test/, 'the 304 kept the jobs');
  // Hidden: background work waits until the page is shown again.
  app.document.hidden = true;
  const n = bgCalls().length;
  await app.advance(4000); await app.go('#/s/s1');
  assert.equal(bgCalls().length, n, 'no reload while hidden');
  await app.visible(true);
  assert.equal(bgCalls().length, n + 1, 'reloaded once shown');

  await app.go('#/sub/' + encodeURIComponent('/x/sub.jsonl'));
  assert.match(app.thread(), /subagent reasoning shown/);
  await app.advance(5000); await app.poll();
  assert.equal(app.calls.filter(c => c.url.startsWith('/api/transcript')).at(-1).inm, '"t1"');
  assert.match(app.thread(), /subagent reasoning shown/, 'the 304 kept the transcript');
});

// ---------- Changes > Working tree / Commits ----------
test('Working tree and Commits rebuild the page only when a reload brings something new, and a hidden page does not reload', async () => {
  for (const mode of ['tree', 'commits']) {
    let n = 0, edit = 'TWO';
    const tree = () => ({ cwd: '/project', base: 'abc123456789', baseLabel: 'HEAD', files: [{ path: '/project/a.txt', op: 'modify', diff: ` 1|one\n-2|two\n+2|${edit}` }] });
    const log = () => ({ cwd: '/project', branch: 'main', head: 'h', upstream: '', ahead: 0, behind: 0, dirty: edit === 'TWO' ? 1 : 2, limit: 50, commits: [{ sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Commit ' + edit, author: 'T', date: at(-60), merge: false, session: true }] });
    const app = boot({ hash: '#/changes/s:s1', storage: { 'omp-changes': JSON.stringify({ mode }) }, respond: (url, call) => {
      // The session works: its updatedAt moves on every poll, so the view reloads once 5 s have passed.
      if (url.startsWith('/api/state')) return { body: store([session('s1', [], { status: 'running', updatedAt: at(++n) })]) };
      if (call.body?.type === 'changes_worktree') return { body: tree() };
      if (call.body?.type === 'git_log') return { body: log() };
    } });
    await flush();
    const loads = () => app.calls.filter(c => c.body?.type === (mode === 'tree' ? 'changes_worktree' : 'git_log')).length;
    const shown = mode === 'tree' ? /TWO/ : /Commit TWO/;
    assert.match(app.thread(), shown);
    const writes = app.writes.get('thread');
    await app.advance(6000); await app.poll();
    await app.advance(6000); await app.poll();
    assert.equal(loads(), 3, `${mode}: reloaded while the session works`);
    assert.equal(app.writes.get('thread'), writes, `${mode}: identical replies rebuild nothing`);
    edit = 'THREE';
    await app.advance(6000); await app.poll();
    assert.match(app.thread(), mode === 'tree' ? /THREE/ : /Commit THREE/, `${mode}: a changed reply renders`);
    app.document.hidden = true;
    await app.advance(6000); await app.go('#/changes/s:s1');
    assert.equal(loads(), 4, `${mode}: no reload while hidden`);
    await app.visible(true);
    assert.equal(loads(), 5, `${mode}: reloaded once shown`);
  }
});

// ---------- switching back to a session viewed before ----------
// A companion's transcript sync, per session: an epoch, and a rev per message change. since=<epoch>.<rev> of that
// session gets the messages changed after rev, with the order; anything else (no since, another epoch) the whole one.
function txServer(ids) {
  const tx = Object.fromEntries(ids.map(id => [id, { epoch: 'e-' + id, rev: 1, messages: [{ ...reply(id + '-1', 'first reply of ' + id), rev: 1 }] }]));
  const strip = ({ rev, ...m }) => m;
  const server = {
    tx, sent: [],
    add(id, text) { const t = tx[id]; t.rev++; t.messages.push({ ...reply(id + '-' + t.rev, text, t.rev), rev: t.rev }); },
    restart(id) { tx[id].epoch += 'b'; },
    respond(url) {
      if (!url.startsWith('/api/state')) return;
      const { session: view, since = '' } = query(url), t = tx[view], [epoch, rev] = since.split('.');
      const delta = t && epoch === t.epoch;
      server.sent.push(view ? (delta ? 'delta' : 'whole') : 'none');
      const sessions = ids.map(id => session(id, id === view && !delta ? tx[id].messages.map(strip) : undefined));
      return { body: { ...store(sessions), ...(t ? { tx: delta ? { session: view, epoch: t.epoch, rev: t.rev, order: t.messages.map(m => m.id), changed: t.messages.filter(m => m.rev > +rev).map(strip) } : { session: view, epoch: t.epoch, rev: t.rev } } : {}) } };
    },
  };
  return server;
}
test('switching back to a session viewed before asks for its changes only, and shows what a full load shows', async () => {
  const server = txServer(['s1', 's2']);
  const app = boot({ respond: url => server.respond(url) });
  await flush();
  await app.go('#/s/s2');
  server.add('s1', 'written while s2 was viewed');
  await app.go('#/s/s1');
  assert.equal(query(app.states().at(-1).url).since, 'e-s1.1', 'asked with the rev held from the earlier view');
  assert.deepEqual(server.sent, ['whole', 'whole', 'delta']);
  assert.match(app.thread(), /first reply of s1[\s\S]*written while s2 was viewed/);
  const fresh = boot({ respond: url => server.respond(url) });
  await flush();
  assert.equal(app.thread(), fresh.thread(), 'the merged transcript renders exactly like a full load');
  await app.poll();
  assert.equal(query(app.states().at(-1).url).since, 'e-s1.2', 'and polls carry on from it');
});

test('a restarted companion (another epoch) and an evicted transcript are fetched whole; the phone layout keeps one', async () => {
  const server = txServer(['s1', 's2', 's3']);
  const app = boot({ respond: url => server.respond(url) });
  await flush();
  await app.go('#/s/s2');
  server.restart('s1'); server.add('s1', 'after the restart');
  await app.go('#/s/s1');
  assert.equal(query(app.states().at(-1).url).since, 'e-s1.1');
  assert.equal(server.sent.at(-1), 'whole', 'another epoch: the whole transcript');
  assert.match(app.thread(), /after the restart/);
  await app.poll();
  assert.equal(query(app.states().at(-1).url).since, 'e-s1b.2');
  // Desktop: the two sessions viewed before are kept; a phone keeps only the last one.
  for (const [size, back] of [[{ width: 1360, height: 900 }, 'e-s1.1'], [{ width: 390, height: 844 }, '']]) {
    const s = txServer(['s1', 's2', 's3']), page = boot({ size, respond: url => s.respond(url) });
    await flush();
    await page.go('#/s/s2'); await page.go('#/s/s3'); await page.go('#/s/s1');
    assert.equal(query(page.states().at(-1).url).since, back, `${size.width} px wide`);
    assert.match(page.thread(), /first reply of s1/);
  }
});

// ---------- Tools page: job revisions (protocol P3) ----------
test('the Tools page polls its jobs by revision: unchanged ones keep what is held, the catalog is fetched once', async () => {
  const job = (id, rev, extra) => ({ id, rev, tool: 'commit', action: 'run', command: 'omp commit', cwd: '/project', startedAt: at(1), ...extra });
  let jobs = [job('j1', 3, { status: 'running', output: 'line one' }), job('j2', 1, { status: 'done', output: 'finished earlier', finishedAt: at(2) })];
  const app = boot({ hash: '#/tools', respond: url => {
    if (!url.startsWith('/api/cli')) return;
    const q = query(url), have = new Set((q.have || '').split(',').filter(Boolean));
    if (q.revs !== '1') return { body: { tools: cliCatalog(), jobs: jobs.map(({ rev, ...j }) => j) } };
    return { body: { ...(q.catalog === '0' ? {} : { tools: cliCatalog() }), jobs: jobs.map(j => have.has(j.id + '.' + j.rev) ? { id: j.id, rev: j.rev, unchanged: true } : j) } };
  } });
  await flush();
  const cli = () => app.calls.filter(c => c.url.startsWith('/api/cli')).map(c => c.url);
  assert.equal(cli()[0], '/api/cli?revs=1', 'the first load gets the catalog and the jobs with their revisions');
  assert.ok(cli().slice(1).every(u => u === '/api/cli?revs=1&catalog=0&have=j1.3,j2.1'), 'later polls name what they hold');
  assert.match(app.els.get('toolJobs').innerHTML, /line one[\s\S]*finished earlier/);
  jobs[0] = job('j1', 4, { status: 'running', output: 'line one\nline two' });
  await app.poll();
  assert.equal(cli().at(-1), '/api/cli?revs=1&catalog=0&have=j1.3,j2.1');
  const html = app.els.get('toolJobs').innerHTML;
  assert.match(html, /line two/, 'the changed job is replaced');
  assert.match(html, /finished earlier/, 'the unchanged one keeps what was held');
  await app.poll();
  assert.equal(cli().at(-1), '/api/cli?revs=1&catalog=0&have=j1.4,j2.1');
});

// ---------- composer: Push to <base> ----------
test('Push to <base> names the project folder’s branch from the store, without asking git for the worktree status', async () => {
  for (const [branch, base] of [['develop', 'develop'], ['detached', 'main'], ['workspace', 'main'], [undefined, 'main']]) {
    const s1 = session('s1', [reply('m1', 'done')], { projectId: 'p1', isolated: true, branch: 'omp-web/abcd1234', queuedMessages: [] });
    const app = boot({ respond: url => {
      if (url.startsWith('/api/state')) return { body: { ...store([s1]), projects: [{ id: 'p1', name: 'proj', path: '/project', branch, color: 'x' }] } };
      if (url.includes('/command')) return { body: s1 };
    } });
    await flush();
    assert.match(app.els.get('commitSlot').innerHTML, new RegExp(`>Push to ${base}</button>`), String(branch));
    await app.click('pushMain');
    const sent = app.calls.filter(c => c.body?.type);
    assert.deepEqual(sent.map(c => c.body.type), ['prompt'], 'no worktree_status');
    assert.match(sent[0].body.message, new RegExp(`merge omp-web/abcd1234 into ${base} in the project folder`));
  }
});
