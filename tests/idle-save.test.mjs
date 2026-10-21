import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// workspace.json holds every session's transcript (tens of MB in real use); the 4 s background refresh of an idle
// live session must not rewrite it.
test('an idle live session does not rewrite workspace.json on background refresh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-idle-save-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({ state: () => ({ todoPhases: [], isSettled: true }) });
  const at = new Date().toISOString();
  const file = join(dir, 'workspace.json');
  await writeFile(file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/commands?session=session`, { headers: { Authorization: 'Bearer ' + app.token } });
  assert.equal(res.status, 200);
  // Let the first refresh (advisor status probe, model fields) settle, then watch two more refresh ticks.
  await new Promise(r => setTimeout(r, 4500));
  await app.flush();
  const before = (await stat(file)).mtimeMs;
  await new Promise(r => setTimeout(r, 8500));
  await app.flush();
  assert.equal((await stat(file)).mtimeMs, before);
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
