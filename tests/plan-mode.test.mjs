import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// A stale browser tab must never approve a newer plan or grant implementation access.
test('plan approval rejects stale IDs and invalid choices without consuming the pending review', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-plan-api-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  let enabled = false, proposal, sequence = 0;
  const omp = fakeOmp({
    state: () => ({ model: { provider: 'test', id: 'test' }, todoPhases: [], planMode: { available: true, enabled, paused: false, reviewPending: !!proposal }, planReview: proposal }),
    setPlanMode(value) { enabled = value; return {}; },
    reviewPlan() { proposal = { id: String(++sequence), title: 'Change', planFilePath: 'local://change-plan.md', content: '# Change\nReview before implementation.' }; return { proposal }; },
    approvePlan(c) {
      if (c.proposalId !== proposal?.id) throw Object.assign(new Error('Stale proposal'), { code: 'stale_proposal' });
      const id = proposal.id; proposal = undefined;
      this.emit({ type: 'plan_review_clear', proposalId: id });
      if (c.action !== 'refine') { enabled = false; this.emit({ type: 'command_output', text: 'Implementation started' }); }
      return {};
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Plan', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
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
  let reviewPending = false;
  const planMode = () => ({ available: true, enabled: true, paused: false, reviewPending });
  const omp = fakeOmp({
    state: () => ({ model: { provider: 'test', id: 'test' }, todoPhases: [], planMode: planMode() }),
    prompt() {
      // OMP answered the prompt before streaming its events.
      setTimeout(() => {
        this.emit({ type: 'agent_start' });
        reviewPending = true;
        this.emit({ type: 'plan_mode_changed', planMode: planMode() });
        this.emit({ type: 'agent_end', messages: [] });
        this.emit({ type: 'session_settled' });
      });
      return {};
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({
    projects: [], activity: [],
    sessions: [{ id: 'session', title: 'Plan', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at,
      queuedMessages: [{ id: 'queued', text: 'Future user turn', at }] }],
  }));
  app = await createCompanion({ dataDir: dir, omp });
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
