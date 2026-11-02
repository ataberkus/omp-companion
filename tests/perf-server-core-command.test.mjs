import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// A command answers with the session, transcript included (read for the reply when nothing has read it). The dashboard
// takes the transcript from its polls, so it asks with ?lean=1: no transcript, no /btw answers, nothing read.
test('session commands with ?lean=1 answer without the transcript and read nothing; without it the reply is unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-lean-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const at = new Date(0).toISOString();
  const session = id => ({ id, projectId: 'p', title: id, status: 'paused', cwd: dir, model: 'OMP default', native: false, todos: [], createdAt: at, updatedAt: at });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'P' }], sessions: [session('a'), session('b')], activity: [] }));
  await mkdir(join(dir, 'transcripts'));
  for (const id of ['a', 'b']) await writeFile(join(dir, 'transcripts', id + '.json'), JSON.stringify([{ id: id + '1', role: 'user', text: 'earlier in ' + id, at }]));
  app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async (id, body, query = '') => { const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${id}/command${query}`, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(res.status, 200); return res.json(); };
  const held = id => !Object.getOwnPropertyDescriptor(app.store.sessions.find(s => s.id === id), 'messages').get;

  const lean = await command('a', { type: 'rename', name: 'a renamed' }, '?lean=1');
  assert.equal(lean.title, 'a renamed');
  assert.equal(lean.id, 'a');
  assert.equal('messages' in lean, false);
  assert.equal(held('a'), false, 'the unread transcript was not read for a lean reply');
  const full = await command('a', { type: 'rename', name: 'a again' });
  assert.deepEqual(full.messages.map(m => m.text), ['earlier in a'], 'without lean the reply carries the transcript as before');
  assert.equal(held('a'), false, 'read for that reply only');

  // A held transcript and /btw answers: left out with lean only.
  const b = app.store.sessions.find(s => s.id === 'b');
  b.messages.push({ id: 'b2', role: 'assistant', text: 'new in b', at }); b._btw = [{ id: 'q', question: 'why', answer: 'because' }];
  const leanHeld = await command('b', { type: 'rename', name: 'b renamed' }, '?lean=1');
  assert.equal('messages' in leanHeld, false);
  assert.equal('_btw' in leanHeld, false);
  assert.equal(leanHeld.title, 'b renamed');
  const fullHeld = await command('b', { type: 'rename', name: 'b again' }, '?lean=0');
  assert.deepEqual(fullHeld.messages.map(m => m.text), ['earlier in b', 'new in b']);
  assert.deepEqual(fullHeld._btw, [{ id: 'q', question: 'why', answer: 'because' }]);

  // Replies that are not the session are the same either way.
  assert.deepEqual(await command('a', { type: 'editor_text_applied', id: 'x' }, '?lean=1'), {});
  assert.deepEqual(await command('a', { type: 'editor_text_applied', id: 'x' }), {});
});
