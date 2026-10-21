import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('slash controls execute during work without consuming steers or replacing the live turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-slash-command-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  let turn, finished = false, release = false;
  const omp = fakeOmp({
    prompt(c) {
      if (c.message === '/dirs') { this.emit({ type: 'command_output', text: 'Workspace: /project' }); return { agentInvoked: false }; }
      if (c.message === '/computer invalid') throw new Error('Usage: /computer [on|off]');
      if (c.message === '/extension-status') { setImmediate(() => this.emit({ type: 'prompt_result', id: c.id, status: 'completed', agentInvoked: false })); return undefined; }
      turn = c.id;
      this.emit({ type: 'agent_start' });
      return {};
    },
    state() {
      if (turn && !finished && release) {
        finished = true;
        this.emit({ type: 'prompt_result', id: turn, status: 'error', agentInvoked: true, error: { message: 'Active provider failed' } });
      }
      return { isSettled: false, todoPhases: [] };
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Commands', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const session = app.store.sessions[0];
  await command({ type: 'prompt', message: 'Current work' });
  await command({ type: 'steer', message: 'Ordinary steer' });
  await command({ type: 'follow_up', message: 'Future work' });
  const [status, result] = await command({ type: 'steer', message: '/dirs' });
  assert.equal(status, 200);
  assert.equal(result.messages.at(-1).text, 'Workspace: /project');
  assert.equal(result.status, 'running');
  assert.equal(result.messages.find(m => m.text === '/dirs').steer, undefined);
  assert.equal((await command({ type: 'prompt', message: '/computer invalid' }))[0], 400);
  assert.equal(session.status, 'running', 'An invalid control must not stop active work');
  await command({ type: 'steer', message: '/extension-status' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(session.status, 'running');
  assert.equal(session.messages.find(m => m.text === 'Ordinary steer').steer, 'pending', 'A local command result must not drop unread steers');
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Future work']);
  release = true;
  await command({ type: 'set_model', model: 'test/model' });
  for (let i = 0; i < 50 && session.status !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(session.status, 'error', 'The original turn must still own its terminal result');
  assert.equal(session.error, 'Active provider failed');
});
