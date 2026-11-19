// OMP allocates a new session's file when the session opens but writes it only with its first stored turn. The
// companion used to hand that not-yet-written path back to OMP as `--resume` on the next runner start (an idle model,
// launch or advisor switch, a crash): OMP then fails with `Session "<file>" not found.`, and a draft session, whose
// marker is restored after the failed send, could never send again. A runner restart must start a fresh session while
// the file is absent and resume it once it is on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const exists = file => readFile(file).then(() => true, () => false);
const isHeader = async file => {
  try {
    const first = JSON.parse((await readFile(file, 'utf8')).split('\n')[0]);
    return first?.type === 'session';
  } catch { return false; }
};
const resumeArg = session => (session.args.includes('--resume') ? session.args[session.args.indexOf('--resume') + 1] : undefined);

// OMP's session manager: opening a session allocates its path, and the file appears with the first stored turn. A
// `--resume` for a path that leads nowhere rejects with the CLI's own error; a malformed header is refused too.
function lazyOmp(dir) {
  let count = 0;
  return fakeOmp(session => {
    const file = join(dir, 'sessions', `session-${++count}.jsonl`);
    return {
      async open() {
        const resume = resumeArg(session);
        if (resume) {
          if (!(await exists(resume))) throw new Error(`Session "${resume}" not found.`);
          if (!(await isHeader(resume))) throw new Error(`Cannot resume session "${resume}": the session header is missing or malformed. The file was not modified.`);
          session.resumed = resume;
        }
        session.file = file;
      },
      async prompt({ message } = {}) {
        await mkdir(join(dir, 'sessions'), { recursive: true });
        await writeFile(file, `${JSON.stringify({ type: 'session', cwd: session.cwd, id: 'x' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: message } })}\n`);
        return { agentInvoked: false };
      },
      state: () => ({ todoPhases: [], sessionFile: session.file }),
    };
  });
}

async function boot(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'omp-draft-file-')));
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  await mkdir(join(dir, 'agent'), { recursive: true });
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(dir, 'agent', 'config.yml'), '');
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [], activity: [] }));
  const omp = lazyOmp(dir);
  const app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'omp-sessions'), ompCommand: process.execPath, omp });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const call = async (path, body) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { dir, call, app, omp };
}

const draft = async (call, dir) => {
  const { body: s } = await call('/quick-start', { path: dir, draft: true, title: 'Draft' });
  assert.equal(s.draft, true);
  return s;
};
const state = async (call, id) => (await call('/state?session=' + id)).body.sessions.find(s => s.id === id);

test('a draft whose session file was never written starts fresh on an idle restart and still sends', async t => {
  const { dir, call, omp } = await boot(t);
  const s = await draft(call, dir);
  assert.equal((await call('/commands?session=' + s.id)).status, 200, 'OMP opens for the draft');
  assert.equal(resumeArg(omp.last), undefined, 'a new session is not opened with --resume');
  const opened = await state(call, s.id);
  assert.equal(opened.draft, true);
  assert.ok(opened.sessionFile, 'OMP reported the path it will write');
  assert.equal(await exists(opened.sessionFile), false, 'OMP writes the file only with the first stored turn');

  // An idle runner restart (a launch change is one of them) must not resume the absent file.
  const restarted = await call(`/sessions/${s.id}/command`, { type: 'launch', launch: { noLsp: true } });
  assert.equal(restarted.status, 200, restarted.body.error || 'runner restart answered');
  assert.equal(omp.sessions.length, 2);
  assert.equal(resumeArg(omp.last), undefined, 'the unwritten path is not resumed');
  const after = await state(call, s.id);
  assert.equal(after.draft, true, 'the session is still the same draft');
  assert.equal(after.error, undefined);
  assert.notEqual(after.sessionFile, opened.sessionFile, 'the fresh OMP session reports its own path');

  // Sending still works, and the first stored turn materializes the file.
  const sent = await call(`/sessions/${s.id}/command`, { type: 'prompt', message: 'go' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.draft, undefined, 'a send turns the draft into a normal session');
  assert.ok(sent.body.messages.some(m => m.role === 'user' && m.text === 'go'));
  assert.equal(await exists(sent.body.sessionFile), true, 'the first turn wrote the session file');

  // Once the file is on disk, a restart resumes it instead of starting another session.
  const resumed = await call(`/sessions/${s.id}/command`, { type: 'launch', launch: { noLsp: true, noPty: true } });
  assert.equal(resumed.status, 200, resumed.body.error || 'runner restart answered');
  assert.equal(omp.sessions.length, 3);
  assert.equal(resumeArg(omp.last), sent.body.sessionFile, 'the written file is resumed');
  assert.ok((await state(call, s.id)).messages.some(m => m.role === 'user' && m.text === 'go'), 'its transcript is kept');
});

test('a session file OMP refuses stays an error, with the draft and its text intact', async t => {
  const { dir, call, omp } = await boot(t);
  const s = await draft(call, dir);
  await call('/commands?session=' + s.id);
  const opened = await state(call, s.id);
  // The file now exists but OMP cannot read it (a truncated header): starting fresh would lose a transcript.
  await writeFile(opened.sessionFile, 'not a session\n');
  omp.last.exit('OMP stopped.');
  const sent = await call(`/sessions/${s.id}/command`, { type: 'prompt', message: 'keep me' });
  assert.equal(sent.status, 200);
  const now = await state(call, s.id);
  assert.equal(now.draft, true, 'the draft marker is restored, so the composer keeps its text');
  assert.match(now.error, /session header is missing or malformed/);
  assert.ok(await exists(opened.sessionFile), 'the unreadable file is left untouched');
  // The stale path is dropped, so the next send starts a fresh session instead of failing forever.
  const again = await call(`/sessions/${s.id}/command`, { type: 'prompt', message: 'keep me' });
  assert.equal(again.status, 200);
  assert.equal(again.body.draft, undefined);
  assert.ok(again.body.messages.some(m => m.role === 'user' && m.text === 'keep me'));
});
