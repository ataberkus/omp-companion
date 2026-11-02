import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// While a parent waits on its task tool, its subagents stream and the tool repeats the same progress line: none of that
// changes the parent's transcript, so saves must not serialize it (megabytes in real use) only to find it unchanged.
// They still save workspace.json, which holds the subagent roster.
test('transcript-neutral frames save workspace.json without serializing the transcript', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-neutral-save-'));
  let app, fake;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp(f => { fake = f; return { prompt: () => ({ agentInvoked: true }), state: () => ({ isSettled: false, isStreaming: true }) }; });
  const at = new Date().toISOString();
  const messages = Array.from({ length: 600 }, (_, i) => ({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', text: 'message ' + i, at }));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages, todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'Go' }) });
  assert.equal(res.status, 200);
  const s = app.store.sessions[0];
  const progress = text => ({ type: 'tool_execution_update', toolCallId: 'task1', partialResult: { content: [{ type: 'text', text }] } });
  fake.emit({ type: 'agent_start' });
  fake.emit({ type: 'tool_execution_start', toolCallId: 'task1', toolName: 'task', args: { tasks: [] } });
  fake.emit(progress('Running 2 agents...'));
  await app.flush();

  let serialized = 0;
  Object.defineProperty(s.messages[0], 'probe', { get() { serialized++; return undefined; }, enumerable: true, configurable: true });
  for (let i = 0; i < 50; i++) {
    for (const id of ['a', 'b']) {
      fake.emit({ type: 'subagent_progress', payload: { id, status: 'running', progress: { id, status: 'running' } } });
      fake.emit({ type: 'subagent_event', payload: { id, event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought ' + i }] } } } });
    }
    fake.emit({ type: 'turn_start' });
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"x":' } });
    fake.emit({ type: 'extension_ui_request', id: 'st' + i, method: 'setStatus', statusKey: 'k', statusText: 'working ' + i });
    fake.emit({ type: 'extension_ui_request', id: 'w' + i, method: 'setWidget', widgetKey: 'w', widgetLines: ['line ' + i] });
    fake.emit({ type: 'extension_ui_request', id: 'panel', method: 'custom', lines: ['frame ' + i] });
    fake.emit(progress('Running 2 agents...'));
    fake.emit({ type: 'turn_end' });
  }
  fake.emit({ type: 'subagent_lifecycle', payload: { id: 'a', status: 'completed' } });
  fake.emit({ type: 'extension_ui_request', id: 'c1', method: 'cancel', targetId: 'panel' });
  await app.flush();
  assert.equal(serialized, 0, 'the unchanged transcript was not serialized');
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions[0];
  assert.deepEqual(saved.subagentList.map(a => [a.id, a.status]), [['a', 'completed'], ['b', 'running']]);

  // Progress that changes the tool's output is a transcript change.
  fake.emit(progress('Running 1 agent...'));
  await app.flush();
  assert.ok(serialized > 0, 'a changed tool update saves the transcript');
  const transcript = JSON.parse(await readFile(join(dir, 'transcripts', 'session.json'), 'utf8'));
  assert.equal(transcript.find(m => m.id === 'tool-task1').tool.result, 'Running 1 agent...');
});
