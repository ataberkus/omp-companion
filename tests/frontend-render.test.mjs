import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createCompanion } from '../companion/server.mjs';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };
const at = (s = 0) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
const session = (id, messages, extra = {}) => ({ id, title: 'Chat ' + id, cwd: '/project', status: 'paused', messages, updatedAt: at(), ...extra });
const store = sessions => ({ projects: [], sessions, archived: [] });
const reply = (id, text, s = 0) => ({ id, role: 'assistant', text, at: at(s) });

// Real app.js in a vm with just enough DOM: elements keep the innerHTML the app writes.
function boot({ hash = '#/s/s1', token = 'tok', respond, elements = {} } = {}) {
  const calls = [], timers = [], toasts = [], listeners = {}, winListeners = {};
  const node = id => ({
    id, tagName: 'DIV', innerHTML: '', value: '', style: {}, dataset: {}, children: [], attributes: [], hidden: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute(k, v) { this['@' + k] = v; }, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false, matches: () => false, closest: () => null,
    appendChild(c) { if (id === 'toasts') toasts.push(c.textContent); }, append() {}, remove() {},
  });
  const els = new Map('app main list conn input thread topbar newBtn scrim groupBy disconnect slash scroller tasks chatPlan extras questions queued statusLine modelSlot hint buttons imagePreview toasts composer-wrap composer promptRail tokenInput search sidebar home'.split(' ').map(id => [id, node(id)]));
  const document = {
    hidden: false, activeElement: null, body: node('body'),
    getElementById: id => els.get(id) || null, querySelector: sel => els.get(sel.replace(/^[#.]/, '')) || null, querySelectorAll: () => [], createElement: tag => node(tag),
    addEventListener: (type, fn, capture) => { if (!capture) (listeners[type] ||= []).push(fn); },
  };
  for (const [id, make] of Object.entries(elements)) els.set(id, make(document));
  const location = { hash, pathname: '/', search: '', reloads: 0, reload() { this.reloads++; } };
  const fetch = async (url, opts = {}) => {
    const call = { url, auth: opts.headers?.Authorization, inm: opts.headers?.['If-None-Match'] };
    calls.push(call);
    const r = (await respond?.(url, opts)) ?? (url.startsWith('/api/models') ? { body: { models: [], roles: {} } } : { body: { sessions: [] } });
    if (r.reject) throw new TypeError('Failed to fetch');
    const status = r.status || 200;
    return { ok: status < 400, status, headers: { get: k => r.headers?.[k] ?? null }, json: async () => { call.read = true; return structuredClone(r.body ?? {}); }, text: async () => { call.read = true; return ''; } };
  };
  runInNewContext(source, {
    document, window: { innerHeight: 900, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); } }, addEventListener() {}, innerWidth: 1360, innerHeight: 900,
    location, history: { replaceState() {} }, URLSearchParams, AbortSignal, CSS: { escape: s => String(s) }, matchMedia: () => ({ matches: false }), Date, console: { ...console, error() {} },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => token, setItem() {}, removeItem() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, requestAnimationFrame: fn => fn(), ResizeObserver: class { observe() {} disconnect() {} }, fetch,
  });
  const loops = () => timers.filter(t => t.fn.name === 'loop');
  const poll = async () => { await loops().at(-1).fn().catch(() => {}); await flush(); };
  const go = async h => { location.hash = h; winListeners.hashchange.forEach(fn => fn()); await flush(); };
  return { els, calls, toasts, loops, poll, go, document, location, listeners, thread: () => els.get('thread').innerHTML };
}
const stateOf = st => url => url.startsWith('/api/state') ? { body: typeof st === 'function' ? st(url) : st } : undefined;
// Renders one assistant reply through the real thread and returns its bubble HTML.
async function renderReply(text) {
  const app = boot({ respond: stateOf(store([session('s1', [reply('m1', text)])])) });
  await flush();
  return app.thread();
}

test('polling keeps going after a render throws, and the failed render is retried', async () => {
  let boom = true;
  const app = boot({
    respond: stateOf(store([session('s1', [reply('m1', 'hello')])])),
    elements: { thread: () => { const n = { children: [], classList: { add() {} }, _h: '' }; Object.defineProperty(n, 'innerHTML', { get: () => n._h, set: v => { if (boom && v.includes('hello')) throw new Error('render failed'); n._h = v; } }); return n; } },
  });
  await flush();
  const before = app.loops().length;
  await app.poll();
  assert.equal(app.loops().length, before + 1, 'the next tick is scheduled even though rendering threw');
  boom = false;
  await app.poll();
  assert.match(app.thread(), /hello/, 'a render that threw must not be recorded as done');
});

test('Connect probes a pasted token without adopting it; a wrong one keeps the form and gets its own message', async () => {
  const app = boot({ token: null, respond: (url, opts) => url.startsWith('/api/state') ? opts.headers.Authorization === 'Bearer good' ? { body: store([]) } : { status: 401, body: { error: 'Invalid connection token.' } } : undefined });
  await flush();
  const submit = value => { app.els.get('tokenInput').value = value; app.listeners.submit[0]({ target: { id: 'connectForm', hasAttribute: () => false, dataset: {} }, preventDefault() {} }); };
  const mainHtml = app.els.get('main').innerHTML;
  submit('wrong');
  await flush();
  assert.ok(app.toasts.includes('That token was not accepted. Check it and try again.'), app.toasts.join('|'));
  assert.equal(app.els.get('tokenInput').value, 'wrong');
  assert.equal(app.els.get('main').innerHTML, mainHtml, 'the connect form is not re-rendered');
  const n = app.calls.length;
  await app.poll();
  assert.equal(app.calls.length, n, 'a rejected token is never used by the poll loop');
  submit('good');
  await flush();
  assert.ok(app.toasts.includes('Connected'));
  assert.ok(app.calls.some(c => c.url.startsWith('/api/state?session=') && c.auth === 'Bearer good'));
});

test('a stale page-embedded token reloads the page instead of asking for a token nobody printed', async () => {
  const app = boot({ token: null, elements: { 'meta[name="omp-token"]': () => ({ content: 'stale' }) }, respond: url => url.startsWith('/api/state') ? { status: 401, body: {} } : undefined });
  await flush();
  assert.equal(app.location.reloads, 1);
  assert.doesNotMatch(app.els.get('main').innerHTML, /connectForm/);
});

test('/state is asked for the viewed session only, switching sessions fetches at once and never shows the old messages', async () => {
  let release;
  const full = { s1: session('s1', [reply('m1', 'first session reply')]), s2: session('s2', [reply('m2', 'second session reply')], { status: 'running' }) };
  const slim = id => store(Object.values(full).map(s => s.id === id ? s : { ...s, messages: undefined }));
  const app = boot({ respond: url => {
    if (!url.startsWith('/api/state')) return;
    const id = new URL(url, 'http://x').searchParams.get('session');
    if (id === 's2') return new Promise(r => { release = () => r({ body: slim('s2'), headers: { ETag: '"v2"' } }); });
    return { body: slim(id), headers: { ETag: '"v1"' } };
  } });
  await flush();
  assert.ok(app.calls.some(c => c.url === '/api/state?session=s1'));
  assert.match(app.thread(), /first session reply/);
  const n = app.calls.length;
  await app.go('#/s/s2');
  assert.ok(app.calls.slice(n).some(c => c.url === '/api/state?session=s2'), 'no wait for the next poll');
  assert.match(app.thread(), /Loading…/);
  assert.match(app.els.get('topbar').innerHTML, /Chat s2/, 'the top bar shows the new session at once');
  assert.match(app.els.get('buttons').innerHTML, /data-act="follow_up"/, 'the composer already has the running session’s buttons');
  assert.doesNotMatch(app.thread(), /first session reply/);
  release();
  await flush();
  assert.match(app.thread(), /second session reply/);
  // Conditional polls: the last ETag goes back as If-None-Match, and a 304 keeps what is shown.
  const app2 = boot({ respond: (url, opts) => url.startsWith('/api/state') ? opts.headers['If-None-Match'] === '"v1"' ? { status: 304 } : { body: slim('s1'), headers: { ETag: '"v1"' } } : undefined });
  await flush();
  await app2.poll();
  const conditional = app2.calls.filter(c => c.url.startsWith('/api/state')).at(-1);
  assert.equal(conditional.inm, '"v1"');
  assert.equal(conditional.read, true, 'the empty 304 body is read, or Chrome cancels the request (ERR_ABORTED)');
  assert.match(app2.thread(), /first session reply/);
});

test('a visible tab refreshes at once; offline polls say so in the view and in the status dot label', async () => {
  let down = false;
  const app = boot({ respond: url => url.startsWith('/api/state') ? down ? { reject: true } : { body: store([session('s1', [reply('m1', 'hi')])]) } : undefined });
  await flush();
  const n = app.calls.length;
  app.listeners.visibilitychange.forEach(fn => fn());
  await flush();
  assert.ok(app.calls.slice(n).some(c => c.url.startsWith('/api/state')));
  down = true;
  await app.poll();
  assert.match(app.els.get('topbar').innerHTML, /Offline — retrying/);
  assert.equal(app.els.get('conn')['@aria-label'], 'Companion not reachable');
});

test('crafted markdown renders fast and deep nesting does not overflow the stack', async () => {
  const inputs = [
    '# a' + ' '.repeat(8000) + 'b',
    'a|\n|--' + ' '.repeat(200000) + 'x',
    'a|\n' + ' '.repeat(200000) + '|--x',
    '['.repeat(200000),
    '**a '.repeat(50000),
    '__a '.repeat(50000),
    '~~a '.repeat(50000),
    '<https://'.repeat(20000),
    '- '.repeat(1000) + 'x',
    '>'.repeat(4000) + ' x',
  ];
  await renderReply('warm up **the** [jit](https://x.dev)');
  for (const text of inputs) {
    const t0 = performance.now();
    const html = await renderReply(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${JSON.stringify(text.slice(0, 12))}… took ${ms.toFixed(1)} ms`);
    assert.match(html, /data-key="msg:m1"/);
  }
});

test('markdown keeps normal output, links parentheses and autolinks safely, and leaves plain fences uncoloured', async () => {
  const html = await renderReply([
    '## Title ##', '', 'Some **bold**, __strong__, *em* and ~~gone~~ text with `code`.', '',
    '| a | b |', '|---|:--:|', '| 1 | 2 |', '',
    '[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and https://en.wikipedia.org/wiki/Foo_(bar) and <https://x.dev> and (see https://y.dev).',
    '[bad](javascript:alert(1)) <javascript:alert(1)>', '',
    '```bash', 'curl -fsSL https://example.com/install.sh | sh', '```', '', '```', 'for x in list do done', '```', '', '```js', 'const a = 1; // note', '```',
  ].join('\n'));
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>, <strong>strong<\/strong>, <em>em<\/em> and <del>gone<\/del> text with <code>code<\/code>\./);
  assert.match(html, /<th>a<\/th><th style="text-align:center">b<\/th>/);
  assert.equal([...html.matchAll(/href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/g)].length, 2);
  assert.match(html, /<a href="https:\/\/x\.dev"[^>]*>https:\/\/x\.dev<\/a>/);
  assert.match(html, /<a href="https:\/\/y\.dev"[^>]*>https:\/\/y\.dev<\/a>\)/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /curl -fsSL https:\/\/example\.com\/install\.sh \| sh<\/code>/, 'bash: no // comment colouring');
  assert.match(html, /<code>for x in list do done<\/code>/, 'unlabeled fence: no keyword colouring');
  assert.match(html, /<span class="tok-c">\/\/ note<\/span>/, 'C-like languages keep // comments');
});

const toolSession = (tool, extra) => session('s1', [{ id: 'u1', role: 'user', text: 'go', at: at() }, { id: 't1', role: 'tool', at: at(1), tool }], extra);

test('live tool output keeps streaming after the server clips it to its last 8,000 characters', async () => {
  let tail = 'A'.repeat(10);
  const st = () => store([toolSession({ name: 'bash', status: 'running', args: '{"command":"npm test"}', result: 'x'.repeat(7990) + tail }, { status: 'running' })]);
  const app = boot({ respond: stateOf(st) });
  await flush();
  assert.match(app.thread(), /AAAAAAAAAA/);
  tail = 'B'.repeat(10);
  await app.poll();
  assert.match(app.thread(), /BBBBBBBBBB/);
});

test('diffs: line-number jumps get a gap row, CR rows survive, word marks keep emoji and syntax colours', async () => {
  const files = [
    { path: 'a.js', op: 'edit', diff: ' 1|a\n-2|b\n+2|B\n 3|c\n 15|x\n-16|y\n+16|Y\n 17|z' },
    { path: 'b.js', op: 'edit', diff: ' 1|one\r\n-2|old\rtext\r\n+2|new\r\n 3|three\r' },
    { path: 'c.js', op: 'edit', diff: '-1|icon = "😀"\n+1|icon = "😁"\n-2|const msg = "hello world";\n+2|const msg = "hello there";' },
  ];
  const app = boot({ respond: stateOf(store([toolSession({ name: 'edit', status: 'done', args: '{}', files })])) });
  await flush();
  const html = app.thread();
  assert.match(html, /class="d-gap"><td colspan="\d">⋯ line 15</);
  const b = html.slice(html.indexOf('title="b.js"'), html.indexOf('title="c.js"'));
  assert.match(b, /class="minus">−1</, 'the CR row still counts as a removal');
  assert.doesNotMatch(b, /d-gap/);
  const c = html.slice(html.indexOf('title="c.js"'));
  assert.doesNotMatch(c, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate halves');
  assert.match(c, /<span class="tok-s">&quot;hello <mark>there<\/mark>&quot;<\/span>/, 'the changed string stays coloured');
});

test('clipped task args still show the task names and Open subagent buttons; a failed tool says so to screen readers', async () => {
  const args = '{"context":"' + 'c'.repeat(5000) + '","tasks":[{"name":"ParserFix","task":"x"},{"name":"LexerFix","task":"y' + 'z'.repeat(800);
  const app = boot({ respond: stateOf(store([toolSession({ name: 'task', status: 'error', args, result: 'failed' })])) });
  await flush();
  assert.match(app.thread(), /Delegated <b>ParserFix, LexerFix<\/b>/);
  assert.match(app.thread(), /data-subname="ParserFix"/);
  assert.match(app.thread(), /✕<span class="sr-only">failed<\/span>/);
});

test('history previews: failures are fetched again on return and loads are never duplicated', async () => {
  let fail = true, previews = 0;
  const app = boot({ hash: '#/f/' + encodeURIComponent('/x/h.jsonl'), respond: url => {
    if (url.startsWith('/api/state')) return { body: store([session('s1', [])]) };
    if (url.startsWith('/api/omp-sessions/preview')) {
      previews++;
      if (url.includes('slow')) return new Promise(() => {});
      if (url.includes('bad')) return { status: 404, body: { error: 'Session file not found.' } };
      return fail ? { status: 500, body: { error: 'boom' } } : { body: { title: 'H', messages: [reply('p1', 'from history')] } };
    }
  } });
  await flush();
  assert.match(app.thread(), /boom/);
  fail = false;
  await app.go('#/s/s1');
  await app.go('#/f/' + encodeURIComponent('/x/h.jsonl'));
  assert.match(app.thread(), /from history/);
  assert.equal(previews, 2);
  await app.go('#/changes/' + encodeURIComponent('f:/x/slow.jsonl'));
  await app.poll(); await app.poll(); await app.poll();
  assert.equal(previews, 3, 'one in-flight preview request, not one per poll');
  await app.go('#/changes/' + encodeURIComponent('f:/x/bad.jsonl'));
  assert.match(app.thread(), /Session file not found\./, 'the Changes page shows preview errors');
});

test('advisor reviews that sort after a running tool do not take the live state from it', async () => {
  const s = toolSession({ name: 'bash', status: 'running', args: '{"command":"npm test"}', result: '' }, { status: 'running', sessionFile: '/x/s1.jsonl' });
  const app = boot({ respond: url => {
    if (url.startsWith('/api/state')) return { body: store([s]) };
    if (url.startsWith('/api/background')) return { body: { tasks: [], agents: [], subagents: [{ advisor: true, name: '__advisor', file: '/x/adv.jsonl', updatedAt: at(5) }] } };
    if (url.startsWith('/api/transcript')) return { body: { updatedAt: at(5), messages: [reply('a1', 'Advisor note', 5)] } };
  } });
  await flush();
  await app.poll(); await app.poll();
  assert.match(app.thread(), /advisor-review/);
  assert.match(app.thread(), /class="activity live"/);
});

test('sidebar polls keep keyboard focus on the same row', async () => {
  // A list whose innerHTML setter builds one focusable button per data-key, like the browser would.
  const list = document => {
    const n = { children: [], kids: [], _h: '', querySelector: () => null, closest: () => null, contains: k => n.kids.includes(k) };
    n.querySelectorAll = sel => n.kids.filter(k => sel === `button[data-key="${k.dataset.key}"]`);
    Object.defineProperty(n, 'innerHTML', { get: () => n._h, set: v => {
      n._h = v;
      n.kids = [...v.matchAll(/<button class="item[^>]*data-key="([^"]+)"/g)].map(([, key]) => ({ tagName: 'BUTTON', dataset: { key }, attributes: [{ name: 'data-key', value: key }], parentElement: n, focus() { document.activeElement = this; } }));
      if (!n.kids.includes(document.activeElement)) document.activeElement = document.body;
    } });
    return n;
  };
  const st = () => store([session('s1', [], { status: 'running', workStartedAt: at() }), session('s2', [])]);
  const app = boot({ elements: { list }, respond: stateOf(st) });
  await flush();
  const row = app.els.get('list').kids.find(k => k.dataset.key === 's:s2');
  row.focus();
  const html = app.els.get('list').innerHTML;
  await new Promise(r => setTimeout(r, 1100));
  await app.poll();
  assert.notEqual(app.els.get('list').innerHTML, html, 'the running timer changed the sidebar');
  assert.notEqual(app.document.activeElement, row, 'the old row was replaced');
  assert.equal(app.document.activeElement.dataset?.key, 's:s2');
});

test('server: /api/state?session= sends messages only for that session and answers unchanged polls with 304', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-state-'));
  const msgs = n => Array.from({ length: n }, (_, i) => reply('m' + i, 'text ' + i));
  await writeFile(join(dataDir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [session('a', msgs(3)), session('b', msgs(5))], activity: [{ id: 'x', text: 'log', at: at() }], archived: [] }));
  const app = await createCompanion({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${app.token}`, ...headers } });
  const full = await (await get('/state')).json();
  assert.equal(full.sessions.find(s => s.id === 'b').messages.length, 5, 'without ?session the whole store, as before');
  assert.equal(full.activity.length, 1);
  const res = await get('/state?session=a');
  const slim = await res.json();
  assert.equal(slim.sessions.find(s => s.id === 'a').messages.length, 3);
  assert.equal(slim.sessions.find(s => s.id === 'b').messages, undefined);
  assert.equal(slim.sessions.find(s => s.id === 'b').title, 'Chat b', 'other sessions keep their summary fields');
  assert.equal(slim.activity, undefined);
  const tag = res.headers.get('etag');
  assert.ok(tag);
  const again = await get('/state?session=a', { 'If-None-Match': tag });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  assert.equal((await get('/state?session=b', { 'If-None-Match': tag })).status, 200, 'another session is a different body');
});
