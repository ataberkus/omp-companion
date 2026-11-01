import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// workspace.json holds every session's transcript (tens of MB in real use); the 4 s background refresh of an idle
// live session must not rewrite it, nor serialize its transcript (megabytes) to check.
// Runs about 13 s (three refresh ticks); bun's test runner otherwise stops a test after 5 s.
test('an idle live session does not rewrite workspace.json on background refresh', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-idle-save-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({ state: () => ({ todoPhases: [], isSettled: true }) });
  const at = new Date().toISOString();
  const file = join(dir, 'workspace.json');
  await writeFile(file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [{ id: 'm1', role: 'assistant', text: 'Earlier reply', at }], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/commands?session=session`, { headers: { Authorization: 'Bearer ' + app.token } });
  assert.equal(res.status, 200);
  // Let the first refresh (advisor status probe, model fields) settle, then watch two more refresh ticks.
  await new Promise(r => setTimeout(r, 4500));
  await app.flush();
  const before = (await stat(file)).mtimeMs;
  // Nor serialize its transcript only to find it unchanged: an enumerable getter counts each serialization.
  let serialized = 0;
  Object.defineProperty(app.store.sessions[0].messages[0], 'probe', { get() { serialized++; return undefined; }, enumerable: true, configurable: true });
  await new Promise(r => setTimeout(r, 8500));
  await app.flush();
  assert.equal((await stat(file)).mtimeMs, before);
  assert.equal(serialized, 0, 'the idle transcript was not serialized by background refreshes');
});

// Each session's transcript is its own file, so a streaming session rewrites only its own; a workspace.json that still
// embeds transcripts (before the split) moves them out, and everything comes back after a restart.
test('a streaming session rewrites only its own transcript, and transcripts survive migration and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-transcript-save-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({
    prompt(c) {
      if (!c.message.startsWith('/')) setImmediate(() => {
        this.emit({ type: 'agent_start' });
        this.emit({ type: 'message_start', message: { role: 'assistant' } });
        for (const delta of ['Hello', ' streamed', ' world']) this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
        this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello streamed world' }], stopReason: 'stop' } });
        this.emit({ type: 'prompt_result', id: c.id, agentInvoked: true, status: 'completed', sessionSettled: true });
      });
      return { agentInvoked: true };
    },
    state: () => ({ todoPhases: [], isSettled: true }),
  });
  const at = new Date().toISOString();
  const session = (id, text) => ({ id, projectId: 'project', title: id, status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [{ id: id + '-old', role: 'user', text, at }], todos: [], createdAt: at, updatedAt: at });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('a', 'earlier in a'), session('b', 'earlier in b')], activity: [] }));
  const open = async () => { app = await createCompanion({ dataDir: dir, omp }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); };
  const transcript = async id => JSON.parse(await readFile(join(dir, 'transcripts', id + '.json'), 'utf8')).map(m => m.text);
  await open();
  assert.ok(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions.every(s => !('messages' in s)), 'workspace.json no longer embeds transcripts');
  assert.deepEqual(await transcript('a'), ['earlier in a']);
  assert.deepEqual(await transcript('b'), ['earlier in b']);
  const untouched = (await stat(join(dir, 'transcripts', 'b.json'))).mtimeMs;

  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/a/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'Go' }) });
  assert.equal(res.status, 200);
  const a = app.store.sessions.find(s => s.id === 'a');
  for (let n = 0; n < 100 && a.status !== 'review'; n++) await new Promise(r => setTimeout(r, 20));
  assert.equal(a.status, 'review');
  await app.flush();
  assert.deepEqual(await transcript('a'), ['earlier in a', 'Go', 'Hello streamed world']);
  assert.equal((await stat(join(dir, 'transcripts', 'b.json'))).mtimeMs, untouched, 'an idle session keeps its transcript file');

  await app.close(); app = undefined;
  await open();
  assert.deepEqual(app.store.sessions.find(s => s.id === 'a').messages.map(m => m.text), ['earlier in a', 'Go', 'Hello streamed world']);
  assert.deepEqual(app.store.sessions.find(s => s.id === 'b').messages.map(m => m.text), ['earlier in b']);
});

// Every transcript is checked at startup but held in memory only once something reads it: hundreds of sessions'
// transcripts cost more than the rest of the companion. Saves skip the unread ones; replies that carry a transcript read it.
test('transcripts are held only once read; saves skip the unread ones; replies and restarts still have them all', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-transcript-lazy-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  const session = id => ({ id, projectId: 'project', title: id, status: 'paused', cwd: dir, model: 'OMP default', native: false, todos: [], createdAt: at, updatedAt: at });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: ['a', 'b', 'c'].map(session), activity: [] }));
  await mkdir(join(dir, 'transcripts'));
  for (const id of ['a', 'b', 'c']) await writeFile(join(dir, 'transcripts', id + '.json'), JSON.stringify([{ id: id + '1', role: 'user', text: 'earlier in ' + id, at }]));
  const open = async () => { app = await createCompanion({ dataDir: dir, omp: fakeOmp() }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); };
  const call = async (path, body) => { const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return res.json(); };
  const held = id => !Object.getOwnPropertyDescriptor(app.store.sessions.find(s => s.id === id), 'messages').get;
  await open();
  assert.deepEqual(['a', 'b', 'c'].map(held), [false, false, false], 'nothing read yet, nothing held');

  assert.deepEqual((await call('/state?session=a&since=&store=')).tx.messages.map(m => m.text), ['earlier in a']);
  assert.deepEqual(['a', 'b', 'c'].map(held), [true, false, false], 'viewing a session holds its transcript only');
  const full = await call('/state');
  assert.deepEqual(full.sessions.map(s => s.messages?.map(m => m.text)), [['earlier in a'], ['earlier in b'], ['earlier in c']], 'the whole store still carries every transcript');
  assert.equal(held('b'), false, 'read for that reply only');
  const renamed = await call('/sessions/b/command', { type: 'rename', name: 'b renamed' });
  assert.deepEqual(renamed.messages.map(m => m.text), ['earlier in b'], 'a command\'s reply carries the transcript as before');

  const files = async () => Promise.all(['a', 'b', 'c'].map(async id => [await readFile(join(dir, 'transcripts', id + '.json'), 'utf8'), (await stat(join(dir, 'transcripts', id + '.json'))).mtimeMs]));
  const before = await files();
  app.store.sessions.find(s => s.id === 'a').messages.push({ id: 'a2', role: 'assistant', text: 'new in a', at });
  await app.close(); app = undefined; // quitting saves every session
  const after = await files();
  assert.deepEqual(JSON.parse(after[0][0]).map(m => m.text), ['earlier in a', 'new in a']);
  assert.deepEqual(after.slice(1), before.slice(1), 'unread transcripts are not rewritten');
  assert.ok(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions.every(s => !('messages' in s)));

  await open();
  assert.deepEqual(app.store.sessions.map(s => [s.title, s.messages.map(m => m.text)]), [['a', ['earlier in a', 'new in a']], ['b renamed', ['earlier in b']], ['c', ['earlier in c']]]);
  await app.close(); app = undefined;
  await writeFile(join(dir, 'transcripts', 'c.json'), '[{"id":"c1",');
  await assert.rejects(createCompanion({ dataDir: dir, omp: fakeOmp() }), /Cannot read the transcript of session c/, 'a transcript that does not parse still stops the companion at startup');
});
