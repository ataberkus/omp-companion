import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('work time spans steers, questions, yields and queued turns, then freezes until new work starts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  const dir = await mkdtemp(join(tmpdir(), 'omp-work-time-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
let promptId, stoppedId, settled = true;
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'extension_ui_response') { out({ type: 'tool_execution_end', toolCallId: 'ask', toolName: 'ask', result: { content: [] } }); continue; }
  const local = c.type === 'prompt' && c.message.startsWith('/');
  const data = c.type === 'get_state' ? { isSettled: settled } : c.type === 'get_subagents' ? { subagents: [] } : c.type === 'prompt' ? { agentInvoked: !local } : {};
  if (c.type === 'prompt' && !local) { promptId = c.id; settled = false; out({ type: 'agent_start' }); }
  if (c.type === 'steer') {
    out({ type: 'message_start', message: { role: 'user', content: c.message } });
    out({ type: 'tool_execution_start', toolCallId: 'ask', toolName: 'ask', args: {} });
    out({ type: 'extension_ui_request', id: 'question', method: 'select', title: 'Continue?', options: ['Yes'] });
  }
  if (c.type === 'set_model' && c.modelId === 'yield') {
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Still waiting for background work' }], stopReason: 'stop' } });
    out({ type: 'agent_end', isTerminal: false });
    out({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: false });
  }
  if (c.type === 'set_model' && c.modelId === 'finish') { settled = true; out({ type: 'session_settled' }); }
  if (c.type === 'abort') { stoppedId = promptId; settled = true; }
  if (c.type === 'set_model' && c.modelId === 'late') out({ type: 'prompt_result', id: stoppedId, agentInvoked: true, status: 'aborted' });
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Work', status: 'paused', cwd: dir, model: 'OMP default', messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  const launch = async () => {
    app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
  };
  await launch();
  const session = () => app.store.sessions[0];
  const command = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const wait = async fn => { for (let i = 0; i < 80 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(fn()); };
  const active = start => { assert.equal(session().workStartedAt, start); assert.equal(session().workFinishedAt, undefined); };

  assert.equal(session().workStartedAt, undefined, 'old sessions do not invent past durations');
  await command({ type: 'prompt', message: '/dirs' });
  assert.equal(session().workStartedAt, undefined, 'local commands are not agent work');
  await command({ type: 'prompt', message: 'Initial work' });
  active(at);
  t.mock.timers.tick(1000);
  await command({ type: 'steer', message: 'Adjust the task' });
  await wait(() => session().uiRequests?.length === 1);
  active(at);
  t.mock.timers.tick(10000);
  await command({ type: 'answer', id: 'question', value: 'Yes' });
  active(at);
  await command({ type: 'follow_up', message: '/dirs' });
  await command({ type: 'follow_up', message: 'Queued work' });
  await command({ type: 'set_model', model: 'test/yield' });
  assert.equal(session().queuedMessages.length, 2, 'a yield with pending background work must not dispatch the queue');
  active(at);
  t.mock.timers.tick(2000);
  await command({ type: 'set_model', model: 'test/finish' });
  await wait(() => session().queuedMessages.length === 0 && session().messages.some(m => m.text === 'Queued work'));
  assert.equal(session().status, 'running');
  active(at);
  t.mock.timers.tick(3000);
  await command({ type: 'set_model', model: 'test/finish' });
  await wait(() => session().status === 'review');
  const finished = new Date().toISOString();
  assert.equal(session().workFinishedAt, finished);
  assert.equal(new Date(finished) - new Date(at), 16000);
  t.mock.timers.tick(60000);
  await command({ type: 'prompt', message: '/dirs' });
  assert.equal(session().workStartedAt, at);
  assert.equal(session().workFinishedAt, finished, 'idle activity must not extend the last duration');
  await app.close();
  await launch();
  assert.equal(session().workStartedAt, at);
  assert.equal(session().workFinishedAt, finished, 'last work survives a companion restart');

  const next = new Date().toISOString();
  await command({ type: 'prompt', message: 'Independent work' });
  active(next);
  t.mock.timers.tick(4000);
  await command({ type: 'abort' });
  assert.equal(session().workFinishedAt, new Date().toISOString());
  t.mock.timers.tick(5000);
  const resumed = new Date().toISOString();
  await command({ type: 'prompt', message: 'Resumed work' });
  await command({ type: 'set_model', model: 'test/late' });
  active(resumed);
  t.mock.timers.tick(6000);
  const closed = new Date().toISOString();
  await app.close();
  app = null;
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions[0];
  assert.equal(saved.workStartedAt, resumed);
  assert.equal(saved.workFinishedAt, closed, 'shutdown must not keep counting offline time');
});
