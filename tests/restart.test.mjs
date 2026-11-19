import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('a restart handoff carries a fresh random token only; stale or malformed notes mean a normal start', () => {
  const token = 'ab'.repeat(32), at = 1_000_000;
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token }), at + 5000), { token });
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at }), at), {}, 'password mode hands over no token');
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token: 'my password' }), at), {}, 'only a random token is accepted');
  assert.equal(internals.restartHandoff(JSON.stringify({ at, token }), at + 3 * 60 * 1000), null, 'stale');
  assert.equal(internals.restartHandoff(JSON.stringify({ at: at + 1, token }), at), null, 'from the future');
  assert.equal(internals.restartHandoff('', at), null);
  assert.equal(internals.restartHandoff('null', at), null);
});

test('a restart handoff carries the IDs of the sessions to resume; a malformed list resumes nothing', () => {
  const token = 'ab'.repeat(32), at = 1_000_000;
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token, resume: ['a', 'b', 'a'] }), at + 5000), { token, resume: ['a', 'b'] });
  assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, resume: ['a'] }), at), { resume: ['a'] }, 'password mode still resumes');
  for (const resume of ['a', [], ['a', 7], ['a', ''], [null], { 0: 'a' }, ['x'.repeat(201)]])
    assert.deepEqual(internals.restartHandoff(JSON.stringify({ at, token, resume }), at), { token }, `malformed: ${JSON.stringify(resume).slice(0, 40)}`);
  assert.equal(internals.restartHandoff(JSON.stringify({ at, token, resume: ['a'] }), at + 3 * 60 * 1000), null, 'a stale note resumes nothing');
});

async function start(t, options, extra = []) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-restart-'));
  const state = { dir, file: join(dir, 'workspace.json') };
  t.after(async () => { if (state.app) await state.app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({ state: () => ({ todoPhases: [], isSettled: false }), prompt() { this.emit({ type: 'agent_start' }); return {}; } });
  const at = new Date().toISOString();
  const session = (id, status, fields) => ({ id, projectId: 'project', title: id, status, cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at, ...fields });
  await writeFile(state.file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [session('run', 'paused'), session('rev', 'review'), ...extra.map(([id, status, fields]) => session(id, status, fields))], activity: [] }));
  const opts = options(state);
  state.omp = opts.omp || omp;
  state.app = await createCompanion({ dataDir: dir, omp, ...opts });
  state.app.server.listen(0, '127.0.0.1');
  await once(state.app.server, 'listening');
  state.call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${state.app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  return state;
}

test('Restart companion pauses and saves sessions before relaunching, stops only after replying, and reports a failed restart', async t => {
  const events = [];let outcome;
  const c = await start(t, state => ({ restart: async () => {
    events.push(['prepare', JSON.parse(await readFile(state.file, 'utf8')).sessions.map(s => s.status)]);
    if (outcome) throw outcome;
    return async () => { events.push(['relaunch']); };
  } }));
  for (const id of ['run', 'rev']) assert.equal((await c.call(`/commands?session=${id}`))[0], 200, 'starts a live OMP runner');
  c.app.store.sessions.find(s => s.id === 'run').status = 'running';
  const [, before] = await c.call('/state?session=');
  assert.equal(before.canRestart, true);

  assert.deepEqual(await c.call('/restart', {}), [200, { ok: true }]);
  for (let i = 0; i < 100 && events.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, [['prepare', ['paused', 'review']], ['relaunch']], 'running session saved as paused, others keep their status; the stop step runs after the reply');

  events.length = 0;
  outcome = Object.assign(new Error('Could not write the restart note.'), { status: 500 });
  assert.deepEqual(await c.call('/restart', {}), [500, { error: 'Could not write the restart note.' }]);
  assert.deepEqual(events.map(e => e[0]), ['prepare'], 'a failed restart never stops the companion');
  const [code, after] = await c.call('/state?session=');
  assert.equal(code, 200, 'the companion keeps serving');
  assert.equal(after.instance, before.instance);
  assert.equal((await c.call('/commands?session=run'))[0], 200, 'a paused session can start again');
});

test('Restart companion hands the IDs of the visible working sessions to the relaunch', async t => {
  const handed = [];
  const c = await start(t, () => ({ restart: async resume => { handed.push(resume); return null; } }), [['queued', 'queued'], ['hidden', 'running'], ['idle', 'paused'], ['subs', 'review']]);
  const byId = id => c.app.store.sessions.find(s => s.id === id);
  byId('run').status = 'running';byId('queued').status = 'queued';byId('hidden').status = 'running';byId('hidden').hidden = true;
  byId('subs').subagentList = [{ id: '0-Scout', status: 'running' }, { id: '1-Fix', status: 'completed' }];
  assert.deepEqual(await c.call('/restart', {}), [200, { ok: true }]);
  assert.deepEqual(handed, [['run', 'queued', 'subs']], 'hidden and idle sessions are not resumed; one whose turn ended with subagents at work is');
  assert.deepEqual(['run', 'queued', 'hidden', 'idle', 'subs'].map(id => byId(id).status), ['paused', 'paused', 'paused', 'paused', 'paused']);
  assert.deepEqual(byId('subs').subagentList.map(a => a.status), ['stopped', 'completed'], 'the restart stopped the one at work');
});

const waitFor = async (check, ms = 3000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(r => setTimeout(r, 10)); return check(); };

test('a companion started from a fresh restart note resumes the listed sessions; the others keep their status', async t => {
  // limited waits for a rate limit (re-armed by its own timer), so the note does not resume it as well.
  const c = await start(t, () => ({ resume: ['run', 'rev', 'limited', 'gone'] }), [['idle', 'paused'], ['limited', 'paused', { autoApprove: true, rateLimitResume: { at: new Date(Date.now() + 3600_000).toISOString() } }]]);
  const byId = id => c.app.store.sessions.find(s => s.id === id);
  const [, view] = await c.call('/state?session=');
  assert.ok(['queued', 'running'].includes(view.sessions.find(s => s.id === 'run').status), 'working as soon as the new companion answers');
  assert.ok(await waitFor(() => byId('run').status === 'running' && c.omp.sent('prompt').length), 'OMP is asked to carry on');
  assert.deepEqual(c.omp.sent('prompt').map(([input]) => input.message), ['Continue where you left off; the companion was restarted.']);
  assert.ok(byId('run').messages.some(m => m.role === 'system' && /Companion restarted; resuming/.test(m.text)));
  assert.ok(byId('run').workStartedAt, 'the resumed turn starts a new work interval');
  assert.equal(byId('rev').status, 'review', 'a session waiting for review stays there');
  assert.equal(byId('idle').status, 'paused', 'a session not in the note stays paused');
  assert.equal(byId('limited').status, 'paused', 'a rate-limit wait is not resumed by the note');
  assert.ok(byId('limited').rateLimitResume, 'its own wait stays armed');
});

test('a companion started without a restart note resumes nothing', async t => {
  const c = await start(t, () => ({}));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.app.store.sessions.find(s => s.id === 'run').status, 'paused');
  assert.equal(c.omp.sessions.length, 0, 'no OMP was started');
});

test('a session that cannot resume stays in error with a note (not Idle); the others still resume', async t => {
  const omp = fakeOmp(s => s.args[s.args.indexOf('--session-dir') + 1].endsWith('bad') ? { prompt() { throw new Error('Provider unavailable.'); } } : {});
  const c = await start(t, () => ({ omp, resume: ['bad', 'run'] }), [['bad', 'paused']]);
  const byId = id => c.app.store.sessions.find(s => s.id === id);
  assert.ok(await waitFor(() => byId('bad').error?.startsWith('Automatic resume failed') && byId('run').status === 'running'));
  assert.equal(byId('bad').status, 'error');
  assert.equal(byId('bad').error, 'Automatic resume failed: Provider unavailable.');
  assert.ok(byId('bad').messages.some(m => m.role === 'system' && m.text === 'Automatic resume failed: Provider unavailable.'));
});

test('a resumed session first has OMP restore the subagents the restart cut off, and is told they run again', async t => {
  const sessionOf = s => s.args[s.args.indexOf('--session-dir') + 1];
  const omp = fakeOmp(s => ({
    prompt() { this.emit({ type: 'agent_start' }); return {}; },
    restore() { return sessionOf(s).endsWith('turn') ? (this.emit({ type: 'agent_start' }), { turn: true, subagents: [] }) : { turn: false, subagents: ['0-Scout', '1-Fix'] }; },
  }));
  const c = await start(t, () => ({ omp, resume: ['run', 'turn'] }), [['turn', 'paused']]);
  const byId = id => c.app.store.sessions.find(s => s.id === id);
  assert.ok(await waitFor(() => byId('run').status === 'running' && byId('turn').status === 'running'));
  const run = omp.sessions.find(s => sessionOf(s).endsWith('run'));
  assert.deepEqual(run.calls.map(x => x.method).filter(m => m === 'restore' || m === 'prompt'), ['restore', 'prompt'], 'subagents are restored before the prompt goes out');
  assert.deepEqual(omp.sent('prompt').map(([input]) => input.message), ['Continue where you left off; the companion was restarted. Your interrupted subagents (0-Scout, 1-Fix) were restored and go on with their tasks; their results arrive as before.'], 'a session whose own turn OMP restored gets no extra prompt');
});

test('a failed subagent restore warns and still resumes the session', async t => {
  const omp = fakeOmp({ prompt() { this.emit({ type: 'agent_start' }); return {}; }, restore() { throw new Error('registry unavailable'); } });
  const c = await start(t, () => ({ omp, resume: ['run'] }));
  const run = c.app.store.sessions.find(s => s.id === 'run');
  assert.ok(await waitFor(() => run.status === 'running'));
  assert.deepEqual(omp.sent('prompt').map(([input]) => input.message), ['Continue where you left off; the companion was restarted.']);
  assert.ok(run.messages.some(m => /Subagents could not be restored: registry unavailable/.test(m.text)));
});

test('without a launcher that starts it again, Restart companion is refused and not offered', async t => {
  const c = await start(t, () => ({}));
  assert.equal((await c.call('/state?session='))[1].canRestart, false);
  const [code, body] = await c.call('/restart', {});
  assert.equal(code, 409);
  assert.match(body.error, /start\.bat/);
});

test('after an OMP update the companion restarts by itself, but only once no session or subagent is working', async t => {
  const events = [];
  const c = await start(t, () => ({ restart: async () => { events.push('prepare'); return async () => { events.push('relaunch'); }; } }));
  const s = c.app.store.sessions.find(x => x.id === 'run');
  s.status = 'running';
  c.app.restartWhenIdle();
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(events, [], 'a running session holds the restart');
  s.status = 'review';s.subagentList = [{ id: '0-Scout', status: 'running' }];
  await new Promise(r => setTimeout(r, 4500)); // the 4 s background refresh re-checks
  assert.deepEqual(events, [], 'a background subagent still at work holds it too');
  s.subagentList[0].status = 'completed';
  await new Promise(r => setTimeout(r, 4500));
  assert.deepEqual(events, ['prepare', 'relaunch']);
});

// The dashboard's ⋯ menu offers the app update only where there is an app to update: the browser companion refuses it,
// and the desktop host answers through its shell (the host test covers that path).
test('an app update needs the desktop app; the companion refuses it and hides the menu entry', async t => {
  const c = await start(t, () => ({}));
  const [code, body] = await c.call('/app-update', {});
  assert.equal(code, 409);
  assert.match(body.error, /OMP Control Room app/);
  const [, state] = await c.call('/state?session=');
  assert.equal(state.canAppUpdate, false);
  assert.equal(state.appVersion, '');
});

test('the app update callback answers the dashboard and the state names the app version', async t => {
  const c = await start(t, () => ({ appUpdate: async () => ({ ok: true, state: 'up-to-date', current: '1.9.0' }), appVersion: '1.9.0' }));
  const [, state] = await c.call('/state?session=');
  assert.equal(state.canAppUpdate, true);
  assert.equal(state.appVersion, '1.9.0');
  assert.deepEqual(await c.call('/instance'), [200, { instance: state.instance, appVersion: '1.9.0' }]);
  assert.deepEqual(await c.call('/app-update', {}), [200, { ok: true, state: 'up-to-date', current: '1.9.0' }]);
});
