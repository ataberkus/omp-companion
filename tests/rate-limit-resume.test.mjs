import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// Like OMP when a 429's retry-after-ms exceeds retry.maxDelayMs: the failed turn's message_end, auto_retry_end without
// a retry, then the terminal prompt_result. The first `fails` prompts get the 429; get_session_stats reports the prompt count.
const fakeOmp = (wait, fails) => `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
const reply = (c, data = {}) => out({ type: 'response', id: c.id, command: c.type, success: true, data });
const error = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\\'s rate limit. Please try again later."},"request_id":"req_1"} retry-after-ms=${wait}';
let prompts = 0;
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'get_state') reply(c, { todoPhases: [] });
  else if (c.type === 'get_subagents') reply(c, { subagents: [] });
  else if (c.type === 'get_session_stats') reply(c, { prompts });
  else if (c.type === 'prompt') {
    reply(c, { agentInvoked: true }); out({ type: 'agent_start' });
    if (++prompts <= ${fails}) {
      out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: error } });
      out({ type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Provider requested a longer wait. Original error: ' + error });
      out({ type: 'agent_end', messages: [] });
      out({ type: 'prompt_result', id: c.id, agentInvoked: true, status: 'error', error: { message: error } });
    } else {
      out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } });
      out({ type: 'prompt_result', id: c.id, agentInvoked: true, status: 'completed', sessionSettled: true });
      out({ type: 'session_settled' });
    }
  } else reply(c);
}
`;

async function setup(t, { wait, fails = 1, session = {} }) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-rate-limit-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, fakeOmp(wait, fails));
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at, ...session }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
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

test('with auto-approve, a 429 OMP gave up on resumes by itself once retry-after-ms has passed', async t => {
  const { post, s, until, system } = await setup(t, { wait: 50 });
  await post({ type: 'auto_approve', enabled: true });
  await post({ type: 'prompt', message: 'Do the work' });
  await until(() => s.status === 'review', 'the resumed turn to finish');
  assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['Do the work', 'Do the work']);
  assert.ok(system().some(t => /^Rate limit reached; resuming automatically at \d\d:\d\d\.$/.test(t)), 'the expected resume time is shown');
  assert.ok(system().includes('Rate limit wait is over; resuming automatically.'));
  assert.equal(s.rateLimitResume, undefined);
  assert.equal((await post({ type: 'stats' })).stats.prompts, 2);
});

test('without auto-approve, a 429 leaves the session in error for Retry', async t => {
  const { post, s, until, system } = await setup(t, { wait: 50 });
  await post({ type: 'prompt', message: 'Do the work' });
  await until(() => s.status === 'error' && s._promptId && !s._rateLimit, 'the 429');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(s.status, 'error');
  assert.match(s.error, /^429 /);
  assert.equal(s.rateLimitResume, undefined);
  assert.ok(!system().some(t => t.startsWith('Rate limit')));
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1);
});

for (const [stop, body, reason] of [
  ['Stop', { type: 'abort' }, 'session stopped'],
  ['turning auto-approve off', { type: 'auto_approve', enabled: false }, 'auto-approve turned off'],
]) test(`${stop} cancels a pending rate-limit resume`, async t => {
  // Long enough that a loaded machine still sees the wait armed before it runs out.
  const { post, s, until, system } = await setup(t, { wait: 1500 });
  await post({ type: 'auto_approve', enabled: true });
  await post({ type: 'prompt', message: 'Do the work' });
  await until(() => s.rateLimitResume, 'the resume to be scheduled');
  await post(body);
  assert.ok(system().includes(`Automatic resume cancelled: ${reason}.`));
  await new Promise(r => setTimeout(r, 2000));
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1, 'nothing was resent');
});

test('a resume saved before a restart fires after it', async t => {
  const at = new Date().toISOString();
  const { post, s, until } = await setup(t, { wait: 50, fails: 0, session: { status: 'error', error: '429 rate limited', autoApprove: true, rateLimitResume: { at }, messages: [{ id: 'u', role: 'user', text: 'Do the work', at }] } });
  await until(() => s.status === 'review', 'the restored resume');
  assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['Do the work', 'Do the work']);
  assert.equal(s.rateLimitResume, undefined);
  assert.equal((await post({ type: 'stats' })).stats.prompts, 1);
});
