import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

for (const type of ['abort', 'abort_retry']) for (const phase of ['backoff', 'request']) {
  test(`${type} stops retries during ${phase} and leaves the session resumable`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-retry-stop-'));
    let app;
    t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
    const omp = fakeOmp(s => {
      let timer, promptId, phase, attempts = 0;
      const fail = () => {
        attempts++;
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '503 overloaded' } });
        s.emit({ type: 'auto_retry_start', attempt: attempts, maxAttempts: 10, delayMs: 250, errorMessage: '503 overloaded' });
        timer = setTimeout(fail, 250);
      };
      return {
        state: () => ({ todoPhases: [] }),
        sessionStats: () => ({ attempts }),
        prompt(c) {
          promptId = c.id; phase = c.message; attempts = 0;
          setImmediate(() => { s.emit({ type: 'agent_start' }); fail(); });
          return { agentInvoked: true };
        },
        abort() {
          clearTimeout(timer);
          // An in-flight aborted request need not emit auto_retry_end.
          if (phase === 'backoff') s.emit({ type: 'auto_retry_end', success: false, attempt: attempts, finalError: 'Retry cancelled' });
          const stoppedId = promptId, status = phase === 'backoff' ? 'error' : 'aborted';
          // A stopped prompt can still flush error and retry frames after the abort reply.
          setTimeout(() => {
            s.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '503 overloaded' } });
            s.emit({ type: 'auto_retry_start', attempt: attempts + 1, maxAttempts: 10, delayMs: 250, errorMessage: '503 overloaded' });
            s.emit({ type: 'prompt_result', id: stoppedId, status, error: { message: '503 overloaded' } });
            s.emit({ type: 'session_settled' });
          }, 20);
        },
      };
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
    const waitForRetry = async () => {
      for (let n = 0; n < 100; n++) {
        if (session._retry) return;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.fail('Timed out waiting for retry');
    };

    await post({ type: 'prompt', message: phase });
    await waitForRetry();
    const stopped = await post({ type });
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped._retry, undefined, 'Stopped sessions must not keep displaying retry progress');
    assert.equal(stopped.error, undefined);
    const attempts = (await post({ type: 'stats' })).stats.attempts;
    await new Promise(r => setTimeout(r, 350));
    assert.equal((await post({ type: 'stats' })).stats.attempts, attempts, 'No retry may run after Stop returns');
    assert.equal(session.status, 'paused');
    assert.equal(session._retry, undefined);

    await post({ type: 'prompt', message: phase });
    await waitForRetry();
    assert.equal(session.status, 'running', 'A resumed session can still automatically retry');
    assert.equal(session.error, undefined, 'A recoverable provider error is not a terminal session error');
    const queued = await post({ type: 'follow_up', message: 'Send later' });
    assert.deepEqual(queued.queuedMessages.map(m => m.text), ['Send later']);
    await post({ type });
    assert.deepEqual(session.queuedMessages.map(m => m.text), ['Send later'], 'Stopping retries must not send or discard queued work');
  });
}
