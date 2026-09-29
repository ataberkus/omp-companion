import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// OMP skips session_settled when async work is still pending at agent_end; the companion must notice the idle state itself.
test('a session that goes idle without session_settled leaves the running state', async t => {
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
  if (c.type === 'get_state') data = { todoPhases: [], model: { provider: 'test', id: 'test' }, isSettled: settled };
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
