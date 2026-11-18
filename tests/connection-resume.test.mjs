import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { createRateLimit } from '../companion/rate-limit.mjs';
import { fakeOmp } from './fake-omp.mjs';

const LOST = 'Connection error: connection lost after 15.4s, after the 1.4MB request body was written to the socket, before any response (ECONNRESET).';

// OMP with its retry off: the first `fails` prompts lose the connection before any response (message_end, agent_end,
// terminal prompt_result); later ones answer. `retried` makes OMP retry it itself and give up (auto_retry_start/_end).
const lossyOmp = ({ fails, retried = false }) => fakeOmp(() => {
  let prompts = 0;
  return {
    state: () => ({ todoPhases: [] }),
    sessionStats: () => ({ prompts }),
    prompt({ id }) {
      const failed = ++prompts <= fails;
      setImmediate(() => {
        this.emit({ type: 'agent_start' });
        if (failed) {
          this.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: LOST } });
          if (retried) {
            this.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 10, errorMessage: LOST });
            this.emit({ type: 'agent_start' });
            this.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: LOST } });
            this.emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: LOST });
          }
          this.emit({ type: 'agent_end', messages: [] });
          this.emit({ type: 'prompt_result', id, agentInvoked: true, status: 'error', error: { message: LOST } });
        } else {
          this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } });
          this.emit({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
          this.emit({ type: 'session_settled' });
        }
      });
      return { agentInvoked: true };
    },
  };
});

async function setup(t, omp, session = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-connection-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at, ...session }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const post = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const s = app.store.sessions[0];
  const until = async (check, what) => {
    for (let n = 0; n < 1000; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail(`Timed out waiting for ${what}`);
  };
  const system = () => s.messages.filter(m => m.role === 'system').map(m => m.text);
  return { post, s, until, system };
}

test('the reported case: Stop retrying while OMP retries a lost connection keeps the error and Retry, not Idle', async t => {
  // OMP's order from the session log: the failed turn, auto_retry_start, the retried run in flight; Stop retrying aborts
  // it (an aborted message, no auto_retry_end), and the prompt's result arrives after the abort reply.
  const omp = fakeOmp(s => {
    let promptId;
    return {
      state: () => ({ todoPhases: [] }),
      prompt({ id }) {
        promptId = id;
        setImmediate(() => {
          s.emit({ type: 'agent_start' });
          s.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: LOST } });
          s.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: LOST });
          s.emit({ type: 'agent_start' });
        });
        return { agentInvoked: true };
      },
      abort() {
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Interrupted by user' } });
        s.emit({ type: 'agent_end', messages: [] });
        setTimeout(() => { s.emit({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'aborted' }); s.emit({ type: 'session_settled' }); }, 20);
      },
    };
  });
  const { post, s, until, system } = await setup(t, omp);
  await post({ type: 'prompt', message: 'Backup içinde bir şeyler düşünelim' });
  await until(() => s._retry && s.status === 'running', 'OMP to retry the lost connection');
  const stopped = await post({ type: 'abort_retry' });
  await new Promise(r => setTimeout(r, 100));
  for (const view of [stopped, s]) {
    assert.equal(view.status, 'error');
    assert.equal(view.error, LOST);
    assert.equal(view._retry, undefined);
  }
  assert.equal(system().filter(x => x === LOST).length, 1, 'the error card is shown once');
  assert.deepEqual(system().filter(x => x.startsWith('Retries stopped')), ['Retries stopped after attempt 1: Retry cancelled']);
});

test('with auto-approve, a lost connection OMP did not retry is resent after a short wait; a new message cancels it', async t => {
  const { post, s, until, system } = await setup(t, lossyOmp({ fails: 1 }));
  await post({ type: 'auto_approve', enabled: true });
  await post({ type: 'prompt', message: 'Do the work' });
  await until(() => s.connectionResume, 'the resend to be scheduled');
  assert.equal(s.status, 'error');
  assert.equal(s.error, LOST);
  assert.equal(s.connectionResume.attempt, 1);
  const wait = Date.parse(s.connectionResume.at) - Date.now();
  assert.ok(wait > 3000 && wait <= 5000, `first resend waits 5 s (${wait} ms left)`);
  assert.ok(system().includes('Connection lost before the provider answered; resending automatically in 5 s (attempt 1 of 3).'));
  assert.equal(system().filter(x => x === LOST).length, 1, 'message_end and prompt_result add the error once');
  await post({ type: 'prompt', message: 'Something else' });
  assert.equal(s.connectionResume, undefined, 'the user\'s own message supersedes the resend');
  await until(() => s.status === 'review', 'the new message to finish');
  assert.equal((await post({ type: 'stats' })).stats.prompts, 2);
});

test('a due resend (saved before a restart) resends the last message and counts the attempt', async t => {
  const at = new Date().toISOString();
  const { post, s, until, system } = await setup(t, lossyOmp({ fails: 0 }), { status: 'error', error: LOST, autoApprove: true, connectionResume: { at, attempt: 2 }, messages: [{ id: 'u', role: 'user', text: 'Do the work', at }] });
  await until(() => s.status === 'review', 'the resent turn to finish');
  assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['Do the work', 'Do the work']);
  assert.ok(system().includes('Resending automatically (attempt 2 of 3).'));
  assert.equal(s.connectionResume, undefined);
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1);
});

test('after the third failed resend the session stays in error for Retry', async t => {
  const at = new Date().toISOString();
  const { post, s, until, system } = await setup(t, lossyOmp({ fails: 1 }), { status: 'error', error: LOST, autoApprove: true, connectionResume: { at, attempt: 3 }, messages: [{ id: 'u', role: 'user', text: 'Do the work', at }] });
  await until(() => system().some(x => x.startsWith('Connection lost again')), 'the resends to give up');
  assert.ok(system().includes('Connection lost again after 3 automatic resends; use Retry last message to try again.'));
  assert.equal(s.status, 'error');
  assert.equal(s.error, LOST);
  assert.equal(s.connectionResume, undefined);
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1);
});

for (const [name, options, session] of [
  ['without auto-approve', { fails: 1 }, {}],
  ['when OMP already retried it', { fails: 1, retried: true }, { autoApprove: true }],
]) test(`a lost connection is not resent ${name}; the session stays in error`, async t => {
  const { post, s, until, system } = await setup(t, lossyOmp(options), session);
  await post({ type: 'prompt', message: 'Do the work' });
  await until(() => s.status === 'error' && s._promptId && !s._connectionLost, 'the failed turn');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(s.status, 'error');
  assert.equal(s.error, LOST);
  assert.equal(s.connectionResume, undefined);
  assert.equal(system().filter(x => x === LOST).length, 1);
  assert.ok(!system().some(x => x.startsWith('Connection lost before')));
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1);
});

test('only transport failures before a response count as a lost connection', () => {
  const { connectionHint } = createRateLimit({});
  for (const message of [LOST, 'Connection error: connection lost after 15.7s while uploading the 11.7MB request body; no response received (ECONNRESET).', 'read ETIMEDOUT', 'write EPIPE', 'socket hang up'])
    assert.equal(connectionHint(message), true, message);
  for (const message of ['400 Invalid upload request. (ECONNRESET)', '{"type":"invalid_request_error","message":"socket hang up"}', '429 rate limited', 'Request timed out.', 'OMP provider failed.', undefined])
    assert.equal(connectionHint(message), undefined, String(message));
});
