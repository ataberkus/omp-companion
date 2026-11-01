import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const at = new Date().toISOString();
const session = (id, dir, extra = {}) => ({ id, projectId: 'project', title: id, status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at, ...extra });

async function start(t, sessions, omp, options = {}, project = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-multi-'));
  const c = { dir, app: null };
  t.after(async () => { if (c.app) await c.app.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', ...project }], sessions: sessions(dir), activity: [] }));
  c.app = await createCompanion({ dataDir: dir, omp, ...options });
  c.app.server.listen(0, '127.0.0.1');
  await once(c.app.server, 'listening');
  c.get = async path => { const res = await fetch(`http://127.0.0.1:${c.app.server.address().port}/api${path}`, { headers: { Authorization: 'Bearer ' + c.app.token } }); return [res.status, await res.json().catch(() => null), res]; };
  c.post = async (path, body) => { const res = await fetch(`http://127.0.0.1:${c.app.server.address().port}/api${path}`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return [res.status, await res.json()]; };
  return c;
}

// The background refresh runs every 4 s. A session whose OMP holds its command queue for long (/compact, a handoff, a
// login waiting for the user) answers get_state only afterwards; it must not hold back every other session's refresh.
// Runs about 9 s (two refresh ticks); bun's test runner otherwise stops a test after 5 s.
test('a session stuck in a long OMP command does not stall the other sessions\' background refresh', { timeout: 30000 }, async t => {
  const calls = { a: 0, b: 0 };
  const omp = fakeOmp(s => ({
    state() {
      // Sessions run in folders named after them; anything else (the provider-account probe) is not counted.
      const id = basename(s.cwd);
      if (!(id in calls)) return {};
      // The first get_state comes from the session's start; later ones (the background refresh) hang for `a`.
      if (++calls[id] > 1 && id === 'a') return new Promise(() => {});
      return { todoPhases: [], isSettled: true, contextUsage: { percent: calls[id], tokens: calls[id], contextWindow: 100 } };
    },
  }));
  const c = await start(t, dir => [session('a', join(dir, 'a')), session('b', join(dir, 'b'))], omp);
  for (const id of ['a', 'b']) assert.equal((await c.get(`/commands?session=${id}`))[0], 200, `${id} starts`);
  const b = c.app.store.sessions.find(s => s.id === 'b');
  // Ticks land about 4 s and 8 s after start: b is refreshed by both while a's refresh still hangs.
  await new Promise(r => setTimeout(r, 8700));
  assert.ok(calls.b >= 3, `b refreshed on every tick (get_state calls: ${calls.b})`);
  assert.equal(b.contextPercent, calls.b, 'b shows its latest state');
  assert.equal(calls.a, 2, 'a keeps a single refresh in flight instead of piling one up per tick');
});

const msg = (id, text, extra = {}) => ({ id, role: 'assistant', text, at, ...extra });

// /api/state?session=<id>&since=<epoch>.<rev>: the viewed transcript goes out as the messages changed after the rev the
// dashboard holds. Changes are found by content, so even an in-place edit nothing announced is sent.
test('polls send the viewed transcript as deltas: changed messages, the order when it changed, everything on an unknown epoch', async t => {
  const omp = fakeOmp();
  const c = await start(t, dir => [session('a', dir, { messages: [msg('m1', 'one'), msg('m2', 'two')] }), session('b', dir, { messages: [msg('x1', 'other')] })], omp);
  const a = c.app.store.sessions.find(s => s.id === 'a'), b = c.app.store.sessions.find(s => s.id === 'b');
  const view = async since => { const [status, body] = await c.get('/state?session=a' + (since === undefined ? '' : '&since=' + since)); assert.equal(status, 200); return { tx: body.tx, messages: body.sessions.find(s => s.id === 'a').messages, other: body.sessions.find(s => s.id === 'b') }; };

  const legacy = await view();
  assert.equal(legacy.tx, undefined, 'dashboards that do not ask for deltas get today\'s reply');
  assert.deepEqual(legacy.messages.map(m => m.text), ['one', 'two']);

  const first = await view('');
  assert.deepEqual(first.messages.map(m => m.text), ['one', 'two'], 'nothing held yet: the full transcript');
  assert.equal(first.tx.session, 'a');
  assert.equal(first.other.messages, undefined, 'other sessions stay summaries');
  const { epoch } = first.tx;
  let rev = first.tx.rev;

  let r = await view(`${epoch}.${rev}`);
  assert.equal(r.messages, undefined, 'unchanged: no messages');
  assert.deepEqual(r.tx, { session: 'a', epoch, rev, changed: [] });

  a.messages[1].text = 'two, edited in place';
  r = await view(`${epoch}.${rev}`);
  assert.ok(r.tx.rev > rev);
  assert.deepEqual(r.tx.changed.map(m => [m.id, m.text]), [['m2', 'two, edited in place']]);
  assert.equal(r.tx.order, undefined, 'same messages in the same order');
  rev = r.tx.rev;

  a.messages.push(msg('m3', 'three'));
  r = await view(`${epoch}.${rev}`);
  assert.deepEqual(r.tx.changed.map(m => m.id), ['m3']);
  assert.deepEqual(r.tx.order, ['m1', 'm2', 'm3']);
  const afterAppend = r.tx.rev;

  a.messages.shift();
  r = await view(`${epoch}.${afterAppend}`);
  assert.deepEqual(r.tx.changed, []);
  assert.deepEqual(r.tx.order, ['m2', 'm3'], 'a removed message shows as an order without it');

  r = await view(`${epoch}.${rev}`);
  assert.deepEqual(r.tx.changed.map(m => m.id), ['m3'], 'an older rev gets everything changed since then');
  assert.deepEqual(r.tx.order, ['m2', 'm3']);
  rev = r.tx.rev;

  b.messages[0].text = 'other session streaming';
  r = await view(`${epoch}.${rev}`);
  assert.deepEqual(r.tx.changed, [], 'another session\'s activity does not resend this transcript');
  assert.equal(r.tx.rev, rev);

  r = await view('stale.3');
  assert.deepEqual(r.messages.map(m => m.text), ['two, edited in place', 'three'], 'an unknown epoch gets the full transcript');
  r = await view(`${epoch}.${rev + 99}`);
  assert.ok(r.messages, 'a rev the companion never issued gets the full transcript');

  a.messages.push(msg('m2', 'duplicate id'));
  r = await view(`${epoch}.${rev}`);
  assert.equal(r.tx, undefined, 'repeated IDs cannot be merged: the full transcript, no delta');
  assert.equal(r.messages.length, 3);
});

test('an unchanged delta poll is answered 304, and a delta stays small however long the transcript is', async t => {
  const omp = fakeOmp();
  const long = Array.from({ length: 500 }, (_, i) => msg('m' + i, 'x'.repeat(2000) + i));
  // The first poll starts a background branch probe; a temp folder outside any repo is 'workspace'. Starting with that
  // branch keeps the probe from changing the reply (and its ETag) between the polls below.
  const c = await start(t, dir => [session('a', dir, { messages: long, branch: 'workspace' })], omp, {}, { branch: 'workspace' });
  const a = c.app.store.sessions.find(s => s.id === 'a');
  const [, full, fullRes] = await c.get('/state?session=a&since=');
  assert.ok(Number(fullRes.headers.get('content-length') || JSON.stringify(full).length) > 900000);
  const since = `${full.tx.epoch}.${full.tx.rev}`;
  const poll = inm => fetch(`http://127.0.0.1:${c.app.server.address().port}/api/state?session=a&since=${since}`, { headers: { Authorization: 'Bearer ' + c.app.token, ...(inm ? { 'If-None-Match': inm } : {}) } });
  const first = await poll();
  const tag = first.headers.get('etag');
  await first.text();
  const again = await poll(tag);
  assert.equal(again.status, 304);
  a.messages.at(-1).text += ' and a streamed word';
  const changed = await poll(tag);
  assert.equal(changed.status, 200);
  const body = await changed.text();
  assert.ok(body.length < 20000, `one changed message out of 500 is a small reply (${body.length} bytes)`);
  assert.deepEqual(JSON.parse(body).tx.changed.map(m => m.id), ['m499']);
});

// Every dashboard lists OMP's history every 20 s. Heads are cached by file and read again only when the file changed.
test('OMP history listing serves unchanged files from the cache, reads changed ones again, and matches panel sessions', async t => {
  const native = await mkdtemp(join(tmpdir(), 'omp-native-'));
  t.after(() => rm(native, { recursive: true, force: true }));
  await mkdir(join(native, 'proj'));
  const file = join(native, 'proj', 'one.jsonl'), second = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  const write = async title => { await writeFile(file, [JSON.stringify({ type: 'session', cwd: '/x', id: 'n1', timestamp: at }), JSON.stringify({ type: 'title', title })].join('\n') + '\n'); await utimes(file, second, second); };
  await write('First title');
  const c = await start(t, dir => [session('a', dir, { sessionFile: file })], fakeOmp(), { ompSessionsDir: native });
  const list = async () => { const [status, body] = await c.get('/omp-sessions'); assert.equal(status, 200); return body.sessions; };
  let [one] = await list();
  assert.equal(one.title, 'First title');
  assert.equal(one.managedId, 'a', 'the panel session on that file');
  // Same size and mtime: the cached head is used (this content would read as an untitled session).
  await writeFile(file, 'x'.repeat((await stat(file)).size));
  await utimes(file, second, second);
  [one] = await list();
  assert.equal(one.title, 'First title', 'unchanged file: served from the cache');
  await write('Second title, longer');
  [one] = await list();
  assert.equal(one.title, 'Second title, longer', 'changed file: read again');
  await rm(file);
  assert.deepEqual(await list(), []);
});
