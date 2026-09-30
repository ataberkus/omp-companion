import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const restoredGoal = { objective: 'Restored objective', status: 'paused', tokensUsed: 125, tokenBudget: 1000 };
const wait = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected session transition did not arrive');
};

async function fixture(t, support = 'enabled') {
  const dir = await mkdtemp(join(tmpdir(), 'omp-goal-api-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs'), log = join(dir, 'actions.jsonl'), release = join(dir, 'release');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const log = ${JSON.stringify(log)}, release = ${JSON.stringify(release)}, support = ${JSON.stringify(support)};
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
const record = action => appendFileSync(log, JSON.stringify(action) + '\\n');
const reply = (c, data = {}) => emit({ type: 'response', id: c.id, command: c.type, success: true, data });
let goal = ${JSON.stringify(restoredGoal)}, active = false, released = '', question;
record('launch');
emit({ type: 'ready' });
emit({ type: 'available_commands_update', commands: support === 'enabled' ? [{ name: 'goal', description: 'Native goal controls', source: 'builtin', input: { hint: '[objective|set|show|pause|resume|drop|budget]' } }] : [] });
createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  if (c.type === 'extension_ui_response') {
    if (!question || c.id !== question.id) return;
    const pending = question; question = undefined;
    if (!c.cancelled && c.confirmed) { goal = null; emit({ type: 'goal_updated', goal }); }
    reply(pending.command, { agentInvoked: false });
    return;
  }
  if (c.type === 'get_state') {
    const nextRelease = existsSync(release) ? readFileSync(release, 'utf8') : '';
    if (active && nextRelease !== released) {
      released = nextRelease; active = false;
      emit({ type: 'prompt_result', status: 'completed' });
      emit({ type: 'session_settled' });
    }
    reply(c, { model: { provider: 'test', id: 'test' }, todoPhases: [], isSettled: !active,
      ...(support === 'legacy' ? {} : { goalMode: { available: support === 'enabled', enabled: !!goal && goal.status === 'active', goal } }) });
    return;
  }
  if (c.type === 'get_subagents') { reply(c, { subagents: [] }); return; }
  if (c.type === 'prompt' && c.message.startsWith('/advisor')) { reply(c, { agentInvoked: false }); return; }
  if (['prompt', 'steer', 'follow_up'].includes(c.type)) {
    if (c.type === 'prompt' && /^\\/goal(?:\\s|$)/.test(c.message) && support === 'enabled') {
      const [, action = 'show', value] = c.message.match(/^\\/goal(?:\\s+(\\S+)(?:\\s+([\\s\\S]*))?)?$/);
      record('goal:' + action + (value ? ':' + value : ''));
      if (action === 'drop') {
        question = { id: 'drop-' + c.id, command: c };
        emit({ type: 'extension_ui_request', id: question.id, method: 'confirm', title: 'Drop goal?', message: 'Drop the current objective?' });
        return;
      }
      if (action === 'set') {
        goal = { objective: value, status: 'active', tokensUsed: 0, tokenBudget: 1000 };
        active = true;
        emit({ type: 'goal_updated', goal }); emit({ type: 'agent_start' });
      }
      // Pause intentionally emits no event: get_state must repair the UI snapshot.
      if (action === 'pause' && goal) goal.status = 'paused';
      if (action === 'resume' && goal) { goal.status = 'active'; emit({ type: 'goal_updated', goal }); }
      if (action === 'budget' && goal) goal.tokenBudget = Number(value);
      reply(c, { agentInvoked: action === 'set' });
      return;
    }
    record('model:' + c.message);
    active = true; emit({ type: 'agent_start' }); reply(c, { agentInvoked: true }); return;
  }
  reply(c);
});
`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], activity: [], sessions: [{
    id: 'session', title: 'Goal', cwd: dir, native: false, status: 'paused', model: 'OMP default',
    messages: [], todos: [], goal: { objective: 'Stale cached objective', status: 'active' }, createdAt: at, updatedAt: at,
  }] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return [res.status, await res.json()];
  };
  return {
    app, session: app.store.sessions[0], request,
    command: body => request('/api/sessions/session/command', body),
    actions: () => readFile(log, 'utf8').then(data => data.trim().split('\n').map(JSON.parse)),
    release: async turn => { await writeFile(release, String(turn)); return request('/api/sessions/session/command', { type: 'set_model', model: 'test/test' }); },
  };
}

test('fresh command discovery validates the session and restores native goal state without starting work', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/commands?session=unknown'))[0], 404);
  const results = await Promise.all([f.request('/api/commands?session=session'), f.request('/api/commands?session=session')]);
  for (const [status, data] of results) {
    assert.equal(status, 200);
    assert.ok(data.commands.some(c => c.name === 'goal'));
  }
  assert.deepEqual(await f.actions(), ['launch'], 'Discovery must neither run a restored goal nor launch competing runners');
  assert.equal(f.session.status, 'paused');
  assert.equal(f.session.goal.objective, restoredGoal.objective);
  assert.equal(f.session.goal.status, 'paused');
  assert.equal(f.session.goal.tokensUsed, 125);
  assert.equal(f.session.goal.tokenBudget, 1000);
});

test('unsupported and disabled goal runtimes reject every live submission without treating it as model work', async t => {
  for (const support of ['legacy', 'disabled']) await t.test(support, async t => {
    const f = await fixture(t, support);
    await f.request('/api/commands?session=session');
    if (support === 'legacy') assert.equal(f.session.goal, undefined, 'Old runtime state must clear the cached goal');
    await f.command({ type: 'prompt', message: 'Current work' });
    for (const type of ['prompt', 'steer', 'follow_up']) {
      const [status] = await f.command({ type, message: '/goal show' });
      assert.equal(status, 409);
      assert.equal(f.session.status, 'running');
    }
    const [, queued] = await f.command({ type: 'follow_up', message: 'Later work' });
    const id = queued.queuedMessages[0].id;
    await f.command({ type: 'edit_follow_up', id, message: '/goal pause' });
    assert.equal((await f.command({ type: 'send_follow_up', id }))[0], 409);
    assert.equal(f.session.queuedMessages[0].id, id, 'A refused queued control remains editable/removable');
    assert.deepEqual(await f.actions(), ['launch', 'model:Current work']);
    assert.deepEqual(f.session.messages.filter(m => m.role === 'user').map(m => m.text), ['Current work']);
  });
});

test('local controls refresh pause/budget, consume goal events, preserve live work, and allow dialog replies', async t => {
  const f = await fixture(t);
  await f.command({ type: 'prompt', message: 'Current work' });
  assert.equal((await f.command({ type: 'prompt', message: '/goal show' }))[1].status, 'running');
  assert.equal((await f.command({ type: 'steer', message: '/goal pause' }))[1].status, 'running');
  assert.equal(f.session.goal.status, 'paused');
  assert.equal(f.session.messages.find(m => m.text === '/goal pause').steer, undefined);
  await f.command({ type: 'prompt', message: '/goal budget 900' });
  assert.equal(f.session.goal.tokenBudget, 900);
  assert.equal(f.session.goal.tokensUsed, 125);
  await f.command({ type: 'steer', message: '/goal resume' });
  assert.equal(f.session.goal.status, 'active');
  assert.equal(f.session.status, 'running');

  const [, queued] = await f.command({ type: 'follow_up', message: '/goal pause' });
  assert.equal(f.session.goal.status, 'active', 'Explicit queue must not change the live goal');
  await f.command({ type: 'send_follow_up', id: queued.queuedMessages[0].id });
  assert.equal(f.session.goal.status, 'paused');
  assert.equal(f.session.queuedMessages.length, 0);
  assert.equal(f.session.status, 'running');

  for (const cancelled of [true, false]) {
    const pending = f.command({ type: 'prompt', message: '/goal drop' });
    await wait(() => f.session.uiRequests?.length === 1);
    assert.equal(f.session.status, 'running');
    const q = f.session.uiRequests[0];
    const [status] = await f.command({ type: 'answer', id: q.id, ...(cancelled ? { cancelled: true } : { confirmed: true }) });
    assert.equal(status, 200);
    assert.equal((await pending)[1].status, 'running');
    if (cancelled) assert.equal(f.session.goal.objective, restoredGoal.objective);
    else assert.equal(f.session.goal, undefined, 'Dropping the native goal must remove the dashboard snapshot');
  }
  assert.ok(!(await f.actions()).some(action => action.startsWith('model:/goal')), 'Goal controls must not enter the provider prompt');
});

test('queued goal replacement starts work at its ordered boundary and later controls wait for that work', async t => {
  const f = await fixture(t);
  await f.command({ type: 'prompt', message: 'Current work' });
  for (const message of ['/goal set Next objective', '/goal budget 333', 'Last follow-up']) await f.command({ type: 'follow_up', message });
  assert.equal(f.session.goal.objective, restoredGoal.objective);
  assert.equal(f.session.queuedMessages.length, 3);
  await f.release(1);
  await wait(() => f.session.goal?.objective === 'Next objective' && f.session.queuedMessages.length === 2);
  assert.equal(f.session.status, 'running');
  assert.equal(f.session.goal.tokenBudget, 1000, 'Budget control must wait until the replacement turn finishes');
  assert.deepEqual(f.session.queuedMessages.map(m => m.text), ['/goal budget 333', 'Last follow-up']);
  await f.release(2);
  await wait(() => f.session.queuedMessages.length === 0);
  assert.equal(f.session.status, 'running');
  assert.equal(f.session.goal.tokenBudget, 333);
  assert.deepEqual(await f.actions(), ['launch', 'model:Current work', 'goal:set:Next objective', 'goal:budget:333', 'model:Last follow-up']);
});
