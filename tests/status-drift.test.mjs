import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// error: a provider error OMP keeps working through. paused: Stop & send's own prompt_result reports the interrupted
// run as aborted while the new prompt streams on (seen live).
for (const drift of ['error', 'paused']) {
  test(`a message sent while the status says ${drift} but OMP still streams is steered or queued, not rejected`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-status-drift-'));
    let app;
    t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
    let streaming = false;
    const omp = fakeOmp({
      state: () => ({ todoPhases: [], isStreaming: streaming, isSettled: !streaming }),
      prompt({ id, message }) {
        if (message.startsWith('/')) return { agentInvoked: false };
        if (streaming) {
          this.emit({ type: 'prompt_result', id, agentInvoked: false, status: 'error', error: { message: 'Agent is already processing.' } });
          throw new Error('Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.');
        }
        streaming = true;
        queueMicrotask(() => {
          this.emit({ type: 'agent_start' });
          if (drift === 'error' && message === 'Work') this.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' } });
        });
        return { agentInvoked: true };
      },
      interrupt({ id }) {
        queueMicrotask(() => this.emit({ type: 'prompt_result', id, agentInvoked: true, status: 'aborted', sessionSettled: false }));
        return {};
      },
      steer({ message }) {
        queueMicrotask(() => this.emit({ type: 'message_start', message: { role: 'user', content: message } }));
        return {};
      },
      sessionStats() {
        streaming = false;
        queueMicrotask(() => this.emit({ type: 'session_settled' }));
        return {};
      },
    });
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], tokens: 0 }], activity: [] }));
    app = await createCompanion({ dataDir: dir, omp });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const post = async body => {
      const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
      return res.json();
    };
    const session = app.store.sessions[0];
    const until = async (ok, what) => {
      for (let n = 0; n < 200; n++) { if (ok()) return; await new Promise(r => setTimeout(r, 10)); }
      assert.fail(`Timed out waiting for ${what}`);
    };
    const sent = () => omp.calls.filter(c => ['prompt', 'steer', 'interrupt'].includes(c.method)).map(c => [c.method, c.args[0].message]);

    await post({ type: 'prompt', message: 'Work' });
    if (drift === 'paused') await post({ type: 'interrupt', message: 'Instead' });
    await until(() => session.status === drift, `status ${drift}`);

    const steered = await post({ type: 'prompt', message: 'cont' });
    assert.equal(steered.status, 'running');
    assert.equal(steered.error, undefined);
    assert.deepEqual(sent().slice(-1), [['steer', 'cont']]);
    const queued = await post({ type: 'follow_up', message: 'later' });
    assert.deepEqual(queued.queuedMessages.map(m => m.text), ['later']);

    await post({ type: 'stats' });
    await until(() => !session.queuedMessages?.length, 'the queued message to send');
    assert.deepEqual(sent().slice(-1), [['prompt', 'later']]);
    assert.notEqual(session.status, 'error');
    assert.ok(!session.messages.some(m => /already processing/.test(m.text)), 'OMP never rejects a message as busy');
  });
}
