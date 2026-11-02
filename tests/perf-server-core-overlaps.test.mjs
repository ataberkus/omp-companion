import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
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
