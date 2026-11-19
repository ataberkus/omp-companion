import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// Opening a session (a quick-start or a resume with nothing typed) must not start OMP's model work: a helper request at
// that moment would run on a role the user never chose, for work the user never asked for. The sessions below are all
// on a non-Claude model, so any helper that silently fell back to OMP's default role would show up as a model call here.

const now = () => new Date().toISOString();

async function boot(t, { omp, sessions = [] }) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-open-'));
  const nativeDir = join(dir, 'native');
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions, activity: [] }));
  const app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, nativeDir, app, request };
}

const session = (over = {}) => ({ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: process.cwd(), provider: 'opencode-go', model: 'muse-spark-1.3-contributor', native: false, messages: [], todos: [], createdAt: now(), updatedAt: now(), ...over });
const fake = () => fakeOmp({ state: () => ({ isSettled: true, todoPhases: [], model: { provider: 'opencode-go', id: 'muse-spark-1.3-contributor' } }) });

test('a quick-start or resume with nothing typed starts no OMP, and its options apply before the first prompt', async t => {
  const omp = fake();
  const { dir, nativeDir, request } = await boot(t, { omp });
  const file = join(nativeDir, 'project', 'history.jsonl');
  await mkdir(join(nativeDir, 'project'), { recursive: true });
  await writeFile(file, [JSON.stringify({ type: 'session', cwd: dir, id: 'native', timestamp: now() }), JSON.stringify({ type: 'title', title: 'History' })].join('\n') + '\n');

  // Resume with a message: no. Resume with none: imported, and OMP stays closed.
  const [resumeStatus] = await request('/omp-sessions/resume', { file, message: '', advisor: true });
  assert.equal(resumeStatus, 201);
  assert.equal(omp.sessions.length, 0, 'resuming a session with no message starts no OMP');

  const [quickStatus, quick] = await request('/quick-start', { path: dir, prompt: '', advisor: true, fast: true });
  assert.equal(quickStatus, 201);
  assert.equal(omp.sessions.length, 0, 'a quick-start with no prompt starts no OMP');
  assert.equal(quick.advisor?.enabled, true, 'the advisor choice is kept for the first prompt');
  const session = quick;

  // The first real prompt starts OMP: the advisor and fast mode are applied before it, and the title is asked for after it.
  const [promptStatus] = await request(`/sessions/${session.id}/command`, { type: 'prompt', message: 'go' });
  assert.equal(promptStatus, 200);
  assert.equal(omp.sessions.length, 1);
  const prompts = omp.sent('prompt').map(([c]) => c.message);
  assert.equal(prompts[0], '/advisor on', 'the advisor choice precedes the first prompt');
  assert.ok(prompts.indexOf('/advisor on') < prompts.indexOf('go'));
  assert.equal(prompts.at(-1), '/rename', 'the title is asked for only after the user\'s prompt');
  assert.deepEqual(omp.sent('setPref'), [['fast', true]]);
});

test('an assistant message no user prompt caused never asks for a title', async t => {
  const omp = fake();
  const { dir, request } = await boot(t, { omp });
  const [status, created] = await request('/quick-start', { path: dir, prompt: '' });
  assert.equal(status, 201);
  assert.equal(created.autoTitle, true, 'the untitled session will be titled from its first prompt');
  // Opening the session's OMP (the dashboard's slash-command preload) replays no work of the user's.
  await request('/commands?session=' + encodeURIComponent(created.id));
  assert.equal(omp.sessions.length, 1);
  const fakeSession = omp.last;
  fakeSession.emit({ type: 'agent_start' });
  fakeSession.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  fakeSession.emit({ type: 'session_settled' });
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(omp.sent('prompt').map(([c]) => c.message).filter(m => m === '/rename'), [], 'no /rename from an assistant message alone');

  await request(`/sessions/${created.id}/command`, { type: 'prompt', message: 'name this' });
  assert.deepEqual(omp.sent('prompt').map(([c]) => c.message).filter(m => m === '/rename'), ['/rename'], 'the user\'s prompt asks once');
});

test('an automatic prompt (a restart or a resend) never asks for a title', async t => {
  const omp = fake();
  const { request } = await boot(t, { omp, sessions: [session({ id: 'restart', autoTitle: true }), session({ id: 'user', autoTitle: true })] });
  await request('/sessions/restart/command', { type: 'prompt', message: 'Continue where you left off; the companion was restarted.', resume: true });
  assert.ok(!omp.last.calls.some(c => c.method === 'prompt' && c.args[0]?.message === '/rename'), 'a companion resume of its own turn is not a user prompt');
  await request('/sessions/user/command', { type: 'prompt', message: 'real ask' });
  assert.ok(omp.last.calls.some(c => c.method === 'prompt' && c.args[0]?.message === '/rename'), 'a prompt the user sent asks once');
});

test('a failed automatic title is a notice that names the work, not a reply in the chat', async t => {
  const refusal = 'Refusal (cyber): Cyber safeguards flagged this message.';
  const omp = fakeOmp({
    state: () => ({ isSettled: true, todoPhases: [], model: { provider: 'opencode-go', id: 'muse-spark-1.3-contributor' } }),
    prompt(c) {
      if (c.message === '/rename') { setImmediate(() => this.emit({ type: 'command_output', text: `Rename failed: ${refusal}` })); return { agentInvoked: false }; }
      return { agentInvoked: true };
    },
  });
  const { dir, request } = await boot(t, { omp });
  const [status, created] = await request('/quick-start', { path: dir, prompt: 'do the thing' });
  assert.equal(status, 201);
  const s = created;
  for (let n = 0; n < 200 && !s._notices?.some(n => n.text.startsWith('Automatic title:')); n++) await new Promise(r => setTimeout(r, 10));
  const notice = s._notices?.find(n => n.text.startsWith('Automatic title:'));
  assert.ok(notice, 'the failure is reported');
  assert.match(notice.text, /^Automatic title: Refusal \(cyber\)/);
  assert.ok(!s.messages.some(m => m.role === 'assistant' && m.text.includes('Refusal (cyber)')), 'the title model\'s error never reads as the session\'s own reply');
  assert.ok(s.messages.some(m => m.role === 'system' && m.text.startsWith('Automatic title:')), 'the warning stays in the chat, attributed to the title');
  assert.equal(s.autoTitle, true, 'the next prompt may try the title again');
});

test('the session\'s model is on the command line; a native resume keeps the model in its file', async t => {
  const omp = fake();
  const { dir, nativeDir, request } = await boot(t, { omp, sessions: [session()] });
  await request('/sessions/session/command', { type: 'prompt', message: 'go' });
  const args = omp.last.args;
  assert.ok(args.includes('--model'), 'a session with its own model starts on it, not on OMP\'s default');
  assert.equal(args[args.indexOf('--model') + 1], 'opencode-go/muse-spark-1.3-contributor');

  const file = join(nativeDir, 'project', 'history.jsonl');
  await mkdir(join(nativeDir, 'project'), { recursive: true });
  await writeFile(file, [JSON.stringify({ type: 'session', cwd: dir, id: 'native', timestamp: now() }), JSON.stringify({ type: 'title', title: 'History' }), JSON.stringify({ type: 'model_change', timestamp: now(), model: 'opencode-go/muse-spark-1.3-contributor' })].join('\n') + '\n');
  const [, resumed] = await request('/omp-sessions/resume', { file, message: 'carry on' });
  const resumedArgs = omp.last.args;
  assert.ok(resumedArgs.includes('--resume'), 'the resumed session continues its own file');
  assert.ok(!resumedArgs.includes('--model'), 'its file\'s model is not overridden');
});

test('ghost text on an empty draft asks OMP for nothing', async t => {
  const omp = fake();
  const { request } = await boot(t, { omp, sessions: [session()] });
  await request('/sessions/session/command', { type: 'prompt', message: 'go' });
  const [status, body] = await request('/sessions/session/command', { type: 'predict_word', text: '', cursor: 0 });
  assert.equal(status, 200);
  assert.deepEqual(body, { suffix: null });
  assert.deepEqual(omp.sent('predictWord'), [], 'no engine or provider work for an empty draft');
});
