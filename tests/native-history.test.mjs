import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { readSessionHead } from '../companion/transcript.mjs';
import { fakeOmp } from './fake-omp.mjs';

const line = f => JSON.stringify(f) + '\n';
// OMP 18's layout: a fixed-width title slot on the first line, then the session header.
const slot = (title, updatedAt) => { const s = JSON.stringify({ type: 'title', v: 1, title, source: 'auto', updatedAt, pad: '' }); return s.slice(0, -2) + ' '.repeat(Math.max(0, 255 - s.length)) + '"}\n'; };
const header = (id, cwd, extra = {}) => line({ type: 'session', version: 3, id, timestamp: '2026-11-15T12:00:00.000Z', cwd, ...extra });
const user = (id, text, ts = '2026-11-15T12:00:01.000Z', parentId = null) => line({ type: 'message', id, parentId, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = (id, parentId, text, model = 'm1', ts = '2026-11-15T12:00:02.000Z') => line({ type: 'message', id, parentId, timestamp: ts, message: { role: 'assistant', provider: 'p', model, content: [{ type: 'text', text }] } });

test('session heads take the title OMP shows: the slot, a newer title change anywhere in the file, and the fork parent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-head-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const big = 'x'.repeat(200 * 1024);
  // Legacy layout (no slot): two renames, the second past the 64 KB head window.
  const legacy = join(dir, 'legacy.jsonl');
  await writeFile(legacy, header('a', dir) + line({ type: 'title_change', id: 't1', timestamp: '2026-11-15T12:00:00.500Z', title: 'First' }) + user('u1', 'hello') + reply('r1', 'u1', big) + line({ type: 'title_change', id: 't2', timestamp: '2026-11-15T13:00:00.000Z', title: '🔁 REVRS: Renamed later' }) + reply('r2', 't2', 'done', 'm2'));
  let h = await readSessionHead(legacy);
  assert.equal(h.title, '🔁 REVRS: Renamed later');
  assert.equal(h.model, 'p/m2');
  // Slot layout: the slot is current unless a title change is newer than it.
  const slotted = join(dir, 'slot.jsonl');
  await writeFile(slotted, slot('🐙 REINIT: Slot title', '2026-11-15T14:00:00.000Z') + header('b', dir, { parentSession: legacy }) + user('u1', 'hi') + reply('r1', 'u1', 'ok'));
  h = await readSessionHead(slotted);
  assert.equal(h.title, '🐙 REINIT: Slot title');
  assert.equal(h.parent, legacy);
  // An empty slot is an untitled session, even with a stale header title.
  const empty = join(dir, 'empty.jsonl');
  await writeFile(empty, slot('', '2026-11-15T14:00:00.000Z') + header('c', dir, { title: 'stale' }) + user('u1', 'what about this'));
  assert.equal((await readSessionHead(empty)).title, '');
  // A first prompt longer than the head window still gives a preview.
  const long = join(dir, 'long.jsonl');
  await writeFile(long, header('d', dir) + user('u1', 'Long prompt start ' + 'y'.repeat(100 * 1024)));
  assert.match((await readSessionHead(long)).preview, /^Long prompt start y+/);
});

async function companion(t, sessions = []) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-hist-'));
  t.after(async () => { await c.app?.close(); await rm(dir, { recursive: true, force: true }); });
  const native = join(dir, 'native'), proj = join(dir, 'proj');
  await mkdir(join(native, 'bucket'), { recursive: true }); await mkdir(proj);
  const c = { dir, native, proj, bucket: join(native, 'bucket') };
  c.start = async extra => {
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: proj, name: 'Project' }], sessions: sessions.map(s => ({ projectId: 'project', status: 'paused', cwd: proj, model: 'OMP default', messages: [], todos: [], createdAt: '2026-11-15T12:00:00.000Z', updatedAt: '2026-11-15T12:00:00.000Z', ...s })), activity: [] }));
    c.app = await createCompanion({ dataDir: dir, omp: fakeOmp(), ompSessionsDir: native, ...extra });
    c.app.server.listen(0, '127.0.0.1'); await once(c.app.server, 'listening');
  };
  const req = async (p, body) => { const res = await fetch(`http://127.0.0.1:${c.app.server.address().port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + c.app.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return [res.status, await res.json()]; };
  c.get = p => req(p); c.post = req;
  return c;
}

test('the history lists every session file, skips one OMP is still creating, and links forks to their parent', async t => {
  const c = await companion(t);
  for (let i = 0; i < 260; i++) await writeFile(join(c.bucket, `s${String(i).padStart(3, '0')}.jsonl`), slot(`Session ${i}`, '2026-11-15T12:00:00.000Z') + header('id' + i, c.proj) + user('u', 'prompt ' + i));
  // OMP may record the parent path in another case on Windows, where paths are case-insensitive; elsewhere the case is exact.
  const parentPath = join(c.bucket, 's005.jsonl');
  await writeFile(join(c.bucket, 'fork.jsonl'), slot('Session 5', '2026-11-15T12:00:00.000Z') + header('fork', c.proj, { parentSession: process.platform === 'win32' ? parentPath.toUpperCase() : parentPath }) + user('u', 'p'));
  await writeFile(join(c.bucket, 'partial.jsonl'), '{"type":"title","v":1,"title":"');
  await c.start();
  const [, first] = await c.get('/omp-sessions');
  assert.equal(first.sessions.length, 261, 'no cap at 200, the half-written file left out');
  const fork = first.sessions.find(s => s.id === 'fork');
  assert.equal(fork.title, 'Session 5');
  assert.equal(fork.parentTitle, 'Session 5');
  assert.equal(fork.parent, parentPath, 'the parent matched case-insensitively on Windows');
  await writeFile(join(c.bucket, 'partial.jsonl'), slot('Now written', '2026-11-15T12:00:00.000Z') + header('late', c.proj));
  const [, second] = await c.get('/omp-sessions');
  assert.ok(second.sessions.some(s => s.id === 'late' && s.title === 'Now written'), 'listed once OMP wrote its header');
});

test('a panel session continued in a terminal shows the turns, title and model the terminal added', async t => {
  const c = await companion(t, []);
  const file = join(c.bucket, 'one.jsonl');
  await writeFile(file, slot('Old title', '2026-11-15T12:00:00.000Z') + header('n1', c.proj) + user('u1', 'first question') + reply('r1', 'u1', 'first answer'));
  await c.start();
  let [status, s] = await c.post('/omp-sessions/resume', { file });
  assert.equal(status, 201);
  assert.equal(s.title, 'Old title');
  // A terminal `omp --resume` renames it and adds a turn.
  await new Promise(r => setTimeout(r, 20));
  await writeFile(file, slot('🔁 New title', '2026-11-15T15:00:00.000Z') + header('n1', c.proj) + user('u1', 'first question') + reply('r1', 'u1', 'first answer'));
  await appendFile(file, user('u2', 'terminal question', '2026-11-15T15:00:01.000Z', 'r1') + reply('r2', 'u2', 'terminal answer', 'm9', '2026-11-15T15:00:02.000Z'));
  const [, list] = await c.get('/omp-sessions');
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].managedId, s.id, 'one row, matched to the panel session');
  assert.equal(list.sessions[0].title, '🔁 New title');
  [status, s] = await c.post('/omp-sessions/resume', { file });
  assert.equal(status, 200);
  assert.equal(s.title, '🔁 New title');
  assert.equal(s.model, 'm9');
  assert.deepEqual(s.messages.filter(m => m.role !== 'system').map(m => m.text), ['first question', 'first answer', 'terminal question', 'terminal answer']);
  // A rename in the panel outlives a later title in the file.
  await c.post(`/sessions/${s.id}/command`, { type: 'rename', name: 'Mine' });
  await appendFile(file, line({ type: 'title_change', id: 't9', parentId: 'r2', timestamp: '2026-11-15T16:00:00.000Z', title: 'Terminal again' }) + user('u3', 'more', '2026-11-15T16:00:01.000Z', 't9'));
  [, s] = await c.post('/omp-sessions/resume', { file });
  assert.equal(s.title, 'Mine');
  assert.ok(s.messages.some(m => m.text === 'more'));
});

test('a session continued while OMP holds the file open shows its real last activity, not the file mtime', async t => {
  const c = await companion(t, []);
  const recent = new Date(Date.now() - 50 * 60 * 1000).toISOString(); // ~50 min ago, the last terminal turn
  const old = '2026-11-15T12:00:00.000Z';
  const stale = new Date(Date.now() - 2 * 86400 * 1000); // mtime two days behind the content (Windows lazy write time)
  // A large transcript: the recent turn sits past the 64 KB head window, so only the tail read can see its timestamp.
  const big = 'x'.repeat(300 * 1024);
  const file = join(c.bucket, 'held.jsonl');
  await writeFile(file, slot('REVRS: Project Aeon', old) + header('held', c.proj) + user('u1', 'first', old) + reply('r1', 'u1', big, 'm1', old));
  await appendFile(file, user('u2', 'terminal question', recent) + reply('r2', 'u2', 'terminal answer', 'm9', recent));
  await utimes(file, stale, stale);
  // An untouched older session, with a fresh mtime, must not outrank the held one once activity (not mtime) orders the list.
  const other = join(c.bucket, 'other.jsonl');
  await writeFile(other, slot('Older', old) + header('other', c.proj) + user('o1', 'hi', old) + reply('or1', 'o1', 'ok', 'm1', old));
  await c.start();
  const [, list] = await c.get('/omp-sessions');
  const row = list.sessions.find(s => s.id === 'held');
  assert.ok(row, 'the held session is listed');
  assert.equal(row.updatedAt, recent, 'updatedAt is the newest transcript timestamp, not the two-day-old mtime');
  assert.ok(row.size > 300 * 1024, 'the large file is listed with its real size');
  assert.equal(list.sessions[0].id, 'held', 'ordered by real activity, ahead of the fresher-mtime older session');
});
