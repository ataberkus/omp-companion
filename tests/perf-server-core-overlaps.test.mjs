import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { createWorkspaces } from '../companion/workspaces.mjs';
import { fakeOmp } from './fake-omp.mjs';

const edit = (id, p) => ({ id, role: 'tool', text: 'edit', at: new Date(0).toISOString(), tool: { name: 'edit', status: 'done', files: [{ path: p, op: 'modify', diff: '+1|x' }] } });
async function start(t, sessions, transcripts) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-overlaps-'));
  const state = { app: null, dir };
  t.after(async () => { if (state.app) await state.app.close(); await rm(dir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'P' }], sessions: sessions.map(s => ({ projectId: 'p', title: s.id, cwd: dir, native: false, todos: [], createdAt: at, updatedAt: at, ...s })), activity: [] }));
  await mkdir(join(dir, 'transcripts'));
  for (const [id, list] of Object.entries(transcripts)) await writeFile(join(dir, 'transcripts', id + '.json'), typeof list === 'string' ? list : JSON.stringify(list(dir)));
  state.app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  state.app.server.listen(0, '127.0.0.1');
  await once(state.app.server, 'listening');
  state.call = async path => (await fetch(`http://127.0.0.1:${state.app.server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${state.app.token}` } })).json();
  state.held = id => !Object.getOwnPropertyDescriptor(state.app.store.sessions.find(s => s.id === id), 'messages').get;
  return state;
}

// The overlap check runs on every poll over every review session; it used to read (and keep) each one's transcript to do it,
// undoing the lazy loading. Startup notes their file records instead, so the first poll flags them with nothing read.
test('review sessions whose transcripts are only on disk are flagged as overlapping without being read', async t => {
  const c = await start(t, [{ id: 'a', status: 'review' }, { id: 'b', status: 'review' }, { id: 'c', status: 'paused' }], {
    a: dir => [edit('a1', 'src/x.js'), edit('a2', 'only-a.js')],
    b: dir => [{ id: 'b0', role: 'user', text: 'go', at: new Date(0).toISOString() }, edit('b1', join(dir, 'src', 'x.js'))],
    c: dir => [edit('c1', 'src/x.js')],
  });
  const first = await c.call('/state?session=none&since=&store=');
  const by = Object.fromEntries(first.sx.changed.map(s => [s.id, s._overlaps]));
  assert.deepEqual(by.a, [{ id: 'b', title: 'b', files: [join(c.dir, 'src', 'x.js')], count: 1 }]);
  assert.deepEqual(by.b, [{ id: 'a', title: 'a', files: [join(c.dir, 'src', 'x.js')], count: 1 }]);
  assert.equal(by.c, undefined);
  assert.deepEqual(['a', 'b', 'c'].map(c.held), [false, false, false], 'no transcript read for the overlap check');
  await c.call('/state?session=none&since=&store=');
  assert.deepEqual(['a', 'b', 'c'].map(c.held), [false, false, false], 'nor on later polls');

  // Once read, the transcript itself counts: a new edit in it shows up, and one that goes away clears the warning.
  const a = c.app.store.sessions.find(s => s.id === 'a');
  a.messages = [...a.messages, edit('a3', 'shared-later.js')];
  c.app.store.sessions.find(s => s.id === 'b').messages.push(edit('b2', 'shared-later.js'));
  let st = (await c.call('/state')).sessions.find(s => s.id === 'a');
  assert.deepEqual(st._overlaps.map(o => o.files), [[join(c.dir, 'src', 'x.js'), join(c.dir, 'shared-later.js')]]);
  a.messages = a.messages.filter(m => m.id === 'a2');
  st = (await c.call('/state')).sessions.find(s => s.id === 'a');
  assert.equal(st._overlaps, undefined);
});

// Odd records are skipped exactly as the transcript walk skips them. One startup cannot walk (a null message) is not
// noted; the overlap check then reads that transcript itself, as before.
test('the noted records follow the overlap check\'s own rules, and a transcript startup cannot walk is read as before', async t => {
  const c = await start(t, [{ id: 'a', status: 'review' }, { id: 'b', status: 'review' }, { id: 'e', status: 'review' }], {
    a: dir => [edit('a1', 'x.js'), { id: 'a2', role: 'tool', tool: { files: [{ path: 'y.js' }] } }],
    b: dir => [edit('b1', 'x.js'), { id: 'b2', role: 'tool', tool: { files: 'abc' } }, { id: 'b3', role: 'tool', tool: { files: [null, 'y.js', { path: '' }, { path: 5 }] } }, 7, 'text'],
    e: 'null',
  });
  await c.call('/state?session=none&since=&store=');
  assert.deepEqual(c.app.store.sessions.map(s => [s.id, s._overlaps?.map(o => [o.id, o.count])]), [['a', [['b', 1]]], ['b', [['a', 1]]], ['e', undefined]]);
  assert.deepEqual(['a', 'b', 'e'].map(c.held), [false, false, false]);

  const n = await start(t, [{ id: 'n', status: 'review' }], { n: '[null]' });
  await n.call('/state?session=none&since=&store=');
  assert.equal(n.held('n'), true, 'a transcript startup could not walk is read by the overlap check, as before');
});

// The check as it was before keys were kept per tool.files array and pairs found through shared files: every record
// resolved on every call, every pair of active sessions compared.
function overlapsBefore(store) {
  const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const active = store.sessions.filter(s => !s.hidden && !s.isolated && ['running', 'queued', 'review'].includes(s.status)).map(s => { const files = new Map(); for (const m of s.messages || []) for (const f of m.tool?.files || []) if (typeof f?.path === 'string' && f.path) { const abs = resolve(s.cwd, f.path); files.set(key(abs), abs); } return { s, files }; });
  for (const s of store.sessions) delete s._overlaps;
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j], shared = [...a.files.keys()].filter(k => b.files.has(k)).map(k => a.files.get(k)); if (!shared.length) continue;
    (a.s._overlaps ??= []).push({ id: b.s.id, title: b.s.title, files: shared.slice(0, 20), count: shared.length }); (b.s._overlaps ??= []).push({ id: a.s.id, title: a.s.title, files: shared.slice(0, 20), count: shared.length });
  }
}

test('the overlap check gives exactly the old full comparison\'s _overlaps over randomized sessions and edits', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }, pick = a => a[Math.floor(rnd() * a.length)];
  const cwds = ['/w/p1', '/w/p2', '/w', '/w/p1/sub'], paths = ['a.js', 'src/a.js', 'src/../a.js', '/w/p1/a.js', '/w/a.js', 'B.js', 'b.js', 'p1/a.js', '../a.js', 'src/b.js', 'c.js', 'sub/a.js'];
  const record = () => pick([() => ({ path: pick(paths), diff: '+1|x' }), () => ({ path: pick(paths) }), () => null, () => pick(paths), () => ({ path: '' }), () => ({ path: 5 })])();
  const files = () => { const list = Array.from({ length: Math.floor(rnd() * 4) }, record); return rnd() < 0.05 ? new Set(list) : rnd() < 0.03 ? 'ab' : list; };
  const message = () => rnd() < 0.5 ? { id: 'm' + rnd(), role: 'tool', tool: { name: 'edit', files: files() } } : rnd() < 0.5 ? { id: 'm' + rnd(), role: 'assistant', text: 'x' } : { id: 'm' + rnd(), role: 'tool', tool: { name: 'read' } };
  let n = 0;
  const session = () => ({ id: 's' + n++, title: 't' + n, cwd: pick(cwds), status: pick(['running', 'queued', 'review', 'review', 'done', 'paused']), hidden: rnd() < 0.1, isolated: rnd() < 0.1, messages: Array.from({ length: Math.floor(rnd() * 8) }, message) });
  const store = { sessions: Array.from({ length: 30 }, session) };
  // Unread transcripts answer with the records startup noted (store.mjs) until something touches the transcript.
  const kept = new Map(), note = s => { const out = []; for (const m of s.messages) for (const f of m.tool?.files || []) if (typeof f?.path === 'string' && f.path) out.push({ path: f.path }); kept.set(s, out); };
  for (const s of store.sessions) if (rnd() < 0.4) note(s);
  const touch = s => { kept.delete(s); return s; };
  const mutate = () => {
    const s = pick(store.sessions), k = rnd(), m = s.messages.length ? pick(s.messages) : null;
    if (k < 0.15 && m?.tool) touch(s).messages = s.messages.map(x => x === m ? { ...m, tool: { ...m.tool, files: files() } } : x);
    else if (k < 0.3) touch(s).messages = [...s.messages, message()];
    else if (k < 0.37 && m) touch(s).messages = s.messages.filter(x => x !== m);
    else if (k < 0.47) s.cwd = pick(cwds);
    else if (k < 0.6) s.status = pick(['running', 'queued', 'review', 'done', 'paused']);
    else if (k < 0.65) s.hidden = !s.hidden;
    else if (k < 0.7) s.isolated = !s.isolated;
    else if (k < 0.75) s.title = 't' + rnd();
    // An edit copied into another session: the same files array, resolved against another cwd.
    else if (k < 0.8) { const o = pick(store.sessions); if (o !== s && o.messages.length) touch(s).messages = [...s.messages, pick(o.messages)]; }
    else if (k < 0.85) store.sessions.splice(Math.floor(rnd() * store.sessions.length), 0, ...store.sessions.splice(store.sessions.indexOf(s), 1));
    else if (k < 0.88) store.sessions.push(session());
    else if (k < 0.9 && store.sessions.length > 5) store.sessions.splice(store.sessions.indexOf(s), 1);
    else if (k < 0.93) touch(s).messages.push(message());
  };
  const snap = () => JSON.stringify(store.sessions.map(s => [s.id, s._overlaps]));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let flagged = 0;
  try {
    // A second companion on the other platform's rules: Windows compares paths case-insensitively.
    for (let poll = 0, markOverlaps; poll < 1500; poll++) {
      if (poll === 750) Object.defineProperty(process, 'platform', { ...platform, value: process.platform === 'win32' ? 'linux' : 'win32' });
      if (poll % 750 === 0) ({ markOverlaps } = createWorkspaces({ store, unreadEdits: s => kept.get(s) ?? null }));
      for (let i = Math.floor(rnd() * 4); i >= 0; i--) mutate();
      overlapsBefore(store); const before = snap();
      markOverlaps(); const after = snap();
      assert.equal(after, before, `poll ${poll}`);
      flagged += store.sessions.filter(s => s._overlaps).length;
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
  assert.ok(flagged > 3000, `the data overlaps often enough to test anything (${flagged})`);
});
