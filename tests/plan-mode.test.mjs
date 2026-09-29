import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// A stale browser tab must never approve a newer plan or grant implementation access.
test('plan approval rejects stale IDs and invalid choices without consuming the pending review', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-plan-api-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
let enabled = false, proposal, sequence = 0;
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { model: { provider: 'test', id: 'test' }, todoPhases: [], planMode: { available: true, enabled, paused: false, reviewPending: !!proposal }, planReview: proposal };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (c.type === 'set_plan_mode') enabled = c.enabled;
  if (c.type === 'review_plan') { proposal = { id: String(++sequence), title: 'Change', planFilePath: 'local://change-plan.md', content: '# Change\\nReview before implementation.' }; data = { proposal }; }
  if (c.type === 'approve_plan') {
    if (c.proposalId !== proposal?.id) { emit({ type: 'response', id: c.id, command: c.type, success: false, code: 'stale_proposal', error: 'Stale proposal' }); continue; }
    const id = proposal.id; proposal = undefined;
    emit({ type: 'plan_review_clear', proposalId: id });
    if (c.action !== 'refine') { enabled = false; emit({ type: 'command_output', text: 'Implementation started' }); }
  }
  emit({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Plan', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  assert.equal((await command({ type: 'plan_mode', enabled: 'true' }))[0], 400);
  assert.equal((await command({ type: 'plan_mode', enabled: true, workflow: 'unknown' }))[0], 400);
  assert.equal((await command({ type: 'plan_mode', enabled: true }))[0], 200);
  const [, first] = await command({ type: 'plan_review' });
  const firstId = first.proposal.id;
  assert.equal((await command({ type: 'plan_approve', proposalId: firstId, action: 'unknown' }))[0], 400);
  assert.equal((await command({ type: 'plan_approve', proposalId: firstId, action: 'preserve', executionModel: 'not a model' }))[0], 400);
  assert.equal((await command({ type: 'plan_approve', proposalId: firstId, action: 'refine' }))[0], 400);
  assert.equal(app.store.sessions[0]._planReview.id, firstId);
  const [, second] = await command({ type: 'plan_review' });
  const secondId = second.proposal.id;
  assert.notEqual(secondId, firstId);
  assert.equal((await command({ type: 'plan_approve', proposalId: firstId, action: 'preserve' }))[0], 409);
  assert.equal(app.store.sessions[0]._planReview.id, secondId);
  assert.equal(app.store.sessions[0].planMode.enabled, true);
  assert.ok(!app.store.sessions[0].messages.some(m => m.text === 'Implementation started'));
  assert.equal((await command({ type: 'plan_approve', proposalId: secondId, action: 'refine', feedback: 'Keep planning; do not implement yet.' }))[0], 200);
  assert.equal(app.store.sessions[0]._planReview, undefined);
  assert.equal(app.store.sessions[0].planMode.enabled, true);
});

test('queued turns wait when review preparation precedes the proposal frame', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-plan-queue-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
let reviewPending = false;
const planMode = () => ({ available: true, enabled: true, paused: false, reviewPending });
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const data = c.type === 'get_state' ? { model: { provider: 'test', id: 'test' }, todoPhases: [], planMode: planMode() } : {};
  emit({ type: 'response', id: c.id, command: c.type, success: true, data });
  if (c.type === 'prompt') {
    emit({ type: 'agent_start' });
    reviewPending = true;
    emit({ type: 'plan_mode_changed', planMode: planMode() });
    emit({ type: 'agent_end', messages: [] });
    emit({ type: 'session_settled' });
  }
}
`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({
    projects: [], activity: [],
    sessions: [{ id: 'session', title: 'Plan', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at,
      queuedMessages: [{ id: 'queued', text: 'Future user turn', at }] }],
  }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, {
    method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'prompt', message: 'Plan this task' }),
  });
  assert.equal(res.status, 200);
  await res.json();
  const session = app.store.sessions[0];
  for (let i = 0; i < 100 && session.status !== 'review'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(session.status, 'review');
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Future user turn']);
});
