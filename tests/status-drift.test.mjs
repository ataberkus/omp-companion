import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// error: a provider error OMP keeps working through. paused: Stop & send's own prompt_result reports the interrupted
// run as aborted while the new prompt streams on (seen live).
for (const drift of ['error', 'paused']) {
  test(`a message sent while the status says ${drift} but OMP still streams is steered or queued, not rejected`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-status-drift-'));
    let app;
    t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
    const fake = join(dir, 'omp.mjs'), log = join(dir, 'sent.jsonl');
    await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
const reply = (c, data = {}) => out({ type: 'response', id: c.id, command: c.type, success: true, data });
let streaming = false;
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (['prompt', 'steer', 'abort_and_prompt'].includes(c.type)) appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n');
  if (c.type === 'get_state') reply(c, { todoPhases: [], isStreaming: streaming, isSettled: !streaming });
  else if (c.type === 'get_subagents') reply(c, { subagents: [] });
  else if (c.type === 'prompt' && c.message.startsWith('/')) reply(c, { agentInvoked: false });
  else if (c.type === 'prompt' && streaming) {
    out({ type: 'response', id: c.id, command: c.type, success: false, error: 'Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.' });
    out({ type: 'prompt_result', id: c.id, agentInvoked: false, status: 'error', error: { message: 'Agent is already processing.' } });
  } else if (c.type === 'prompt') {
    streaming = true; reply(c, { agentInvoked: true }); out({ type: 'agent_start' });
    if (${JSON.stringify(drift)} === 'error' && c.message === 'Work') out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' } });
  } else if (c.type === 'abort_and_prompt') {
    reply(c); out({ type: 'prompt_result', id: c.id, agentInvoked: true, status: 'aborted', sessionSettled: false });
  } else if (c.type === 'steer') {
    reply(c); out({ type: 'message_start', message: { role: 'user', content: c.message } });
  } else if (c.type === 'get_session_stats') {
    streaming = false; reply(c, {}); out({ type: 'session_settled' });
  } else reply(c);
}
`);
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], tokens: 0 }], activity: [] }));
    app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
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
    const sent = async () => (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));

    await post({ type: 'prompt', message: 'Work' });
    if (drift === 'paused') await post({ type: 'interrupt', message: 'Instead' });
    await until(() => session.status === drift, `status ${drift}`);

    const steered = await post({ type: 'prompt', message: 'cont' });
    assert.equal(steered.status, 'running');
    assert.equal(steered.error, undefined);
    assert.deepEqual((await sent()).slice(-1).map(c => [c.type, c.message]), [['steer', 'cont']]);
    const queued = await post({ type: 'follow_up', message: 'later' });
    assert.deepEqual(queued.queuedMessages.map(m => m.text), ['later']);

    await post({ type: 'stats' });
    await until(() => !session.queuedMessages?.length, 'the queued message to send');
    assert.deepEqual((await sent()).slice(-1).map(c => [c.type, c.message]), [['prompt', 'later']]);
    assert.notEqual(session.status, 'error');
    assert.ok(!session.messages.some(m => /already processing/.test(m.text)), 'OMP never rejects a message as busy');
  });
}
