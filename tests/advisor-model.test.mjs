import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('changing the advisor model rewrites WATCHDOG.yml and restarts the idle session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-advisor-model-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let app;
  t.after(async () => {
    if (app) await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  const watchdog = join(dir, 'WATCHDOG.yml');
  await writeFile(watchdog, '# my advisors\nadvisors:\n  - name: default\n    model: old/model:high # keep this comment\n  - name: second\n    model: other/model\n');
  const starts = join(dir, 'starts.log');
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(starts)}, 'start\\n');
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], model: { provider: 'test', id: 'test' }, isSettled: true };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (c.type === 'prompt' && c.message === '/advisor status') process.stdout.write(JSON.stringify({ type: 'command_output', text: 'Advisor is enabled (new/model). Spend: 1 input, 1 output, $0.0000.' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };

  const [, before] = await request('/advisor');
  assert.deepEqual([before.model, before.source], ['old/model:high', 'WATCHDOG.yml']);
  const [bad] = await request('/sessions/session/command', { type: 'advisor', action: 'model', model: 'x; rm -rf /' });
  assert.equal(bad, 400);
  const [code, session] = await request('/sessions/session/command', { type: 'advisor', action: 'model', model: 'new/model:xhigh' });
  assert.equal(code, 200);
  assert.equal(session.status, 'review');
  assert.equal(session.advisor.model, 'new/model');
  assert.equal(await readFile(watchdog, 'utf8'), '# my advisors\nadvisors:\n  - name: default\n    model: new/model:xhigh # keep this comment\n  - name: second\n    model: other/model\n');
  assert.ok((await readFile(starts, 'utf8')).trim().split('\n').length >= 2, 'OMP was restarted');
});
