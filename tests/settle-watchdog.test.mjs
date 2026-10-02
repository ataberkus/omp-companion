import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// A native idle snapshot must win over unrelated command output, even when session_settled is missing.
test('idle polling settles a finished turn despite unrelated command output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-settle-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
let settled = true;
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') {
    if (settled) process.stdout.write(JSON.stringify({ type: 'command_output', text: 'Advisor disabled.' }) + '\\n');
    data = { todoPhases: [], model: { provider: 'test', id: 'test' }, isSettled: settled, isCompacting: false };
  }
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (c.type === 'prompt' && !c.message.startsWith('/')) {
    settled = false;
    process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
    setTimeout(() => { settled = true; }, 200);
    data = { agentInvoked: true };
  }
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const [code, started] = await request('/sessions/session/command', { type: 'prompt', message: 'Do it' });
  assert.equal(code, 200);
  assert.equal(started.status, 'running');
  let status = 'running';
  for (let i = 0; i < 30 && status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 500));
    const [, state] = await request('/state');
    status = state.sessions.find(s => s.id === 'session').status;
  }
  assert.equal(status, 'review');
});

test('completion frames settle once, preserve queued work, and correlate fast replies', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-completion-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = frames => process.stdout.write(frames.map(f => JSON.stringify(f) + '\\n').join(''));
out([{ type: 'ready' }]);
let promptId, stalePoll = false;
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const frames = [{ type: 'response', id: c.id, command: c.type, success: true, data: c.type === 'prompt' ? { agentInvoked: true } : {} }];
  if (c.type === 'prompt' && !c.message.startsWith('/')) {
    promptId = c.id;
    frames.push({ type: 'agent_start' });
    if (c.message === 'Third turn') frames.push(
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All work finished' }], stopReason: 'stop' } },
      { type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true });
  }
  if (c.type === 'set_steering_mode') stalePoll = true;
  if (c.type === 'get_state' && stalePoll) {
    stalePoll = false;
    frames[0].data = { isSettled: true, isCompacting: false };
    frames.unshift({ type: 'agent_start' });
  }
  if (c.type === 'set_auto_retry') frames.push({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: false });
  if (c.type === 'set_fast_mode') {
    frames.push({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true });
    if (c.enabled) frames.push({ type: 'session_settled' });
  }
  out(frames);
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const post = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const session = app.store.sessions[0];
  const until = async check => { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('Completion transition did not arrive'); };
  await post({ type: 'prompt', message: 'First turn' });
  const startedAt = session.workStartedAt;
  await post({ type: 'pref', key: 'steeringMode', value: 'all' });
  await post({ type: 'rename', name: 'Continued run' });
  assert.equal(session.status, 'running', 'an old idle snapshot must not finish a newer native run');
  assert.equal(session.workFinishedAt, undefined);
  await post({ type: 'follow_up', message: 'Second turn' });
  await post({ type: 'follow_up', message: 'Third turn' });
  await post({ type: 'pref', key: 'autoRetry', value: true });
  assert.equal(session.status, 'running', 'a yielded turn with pending work is not finished');
  assert.equal(session.queuedMessages.length, 2);
  await post({ type: 'pref', key: 'fast', value: true });
  await until(() => session.queuedMessages.length < 2);
  assert.equal(session.status, 'running', 'duplicate completion must not finish the next turn');
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Third turn']);
  assert.equal(session.workFinishedAt, undefined);
  await post({ type: 'pref', key: 'fast', value: false });
  await until(() => session.status === 'review');
  assert.deepEqual(session.messages.filter(m => m.role === 'user').map(m => m.text), ['First turn', 'Second turn', 'Third turn']);
  assert.equal(session.messages.at(-1).text, 'All work finished');
  assert.equal(session.queuedMessages.length, 0);
  assert.equal(session.workStartedAt, startedAt, 'queued continuations share one work interval');
  assert.ok(session.workFinishedAt, 'the final completion freezes the work timer');
});
