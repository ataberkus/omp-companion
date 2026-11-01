import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const session = (id, extra = {}) => { const at = new Date().toISOString(); return { id, title: id, status: 'paused', cwd: extra.cwd, native: false, messages: [], todos: [], createdAt: at, updatedAt: at, ...extra }; };
async function start(t, sessions, options = {}, projects = () => []) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-sync-'));
  const state = { app: null, dir };
  t.after(async () => { if (state.app) await state.app.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: projects(dir), sessions: sessions(dir), activity: [] }));
  state.open = async () => {
    state.app = await createCompanion({ dataDir: dir, ...options });
    state.app.server.listen(0, '127.0.0.1');
    await once(state.app.server, 'listening');
  };
  state.call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${state.app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  await state.open();
  return state;
}

test('composer drafts sync through the companion: polls carry timestamps only, texts are fetched by key and survive restarts', async t => {
  const c = await start(t, dir => [session('a', { cwd: dir })]);
  const [, saved] = await c.call('/draft', { key: 'session:a', text: 'half a thought' });
  assert.equal(saved.key, 'session:a');
  const [, state] = await c.call('/state?session=a');
  assert.deepEqual(state.drafts, { 'session:a': saved.at }, 'no draft text in polls');
  assert.deepEqual((await c.call('/draft?key=session:a'))[1], { text: 'half a thought', at: saved.at });

  assert.equal((await c.call('/draft', { key: 'bogus', text: 'x' }))[0], 400);
  assert.equal((await c.call('/draft', { key: 'session:a', text: 5 }))[0], 400);

  await c.call('/draft', { key: 'native:C:/x.jsonl', text: 'other view' });
  await c.app.close(); await c.open();
  assert.equal((await c.call('/draft?key=native:C:/x.jsonl'))[1].text, 'other view');
  assert.equal((await c.call('/draft?key=session:a'))[1].text, 'half a thought');

  // Sending (or clearing the box) deletes it everywhere.
  await c.call('/draft', { key: 'session:a', text: '' });
  assert.deepEqual((await c.call('/draft?key=session:a'))[1], { text: '', at: null });
  assert.equal('session:a' in (await c.call('/state'))[1].drafts, false);
});

test('Open in editor: editor links with the line, reveal for Show in folder, relative paths need the session folder', async t => {
  const opened = [];
  const c = await start(t, dir => [session('a', { cwd: dir })], { openExternal: async (target, opts) => { opened.push([target, opts.reveal]); } });
  await mkdir(join(c.dir, 'src dir'));
  const file = join(c.dir, 'src dir', 'a#b.ts');
  await writeFile(file, 'x');

  assert.equal((await c.call('/editor', { editor: 'notepad.exe' }))[0], 400);
  assert.equal((await c.call('/editor', { editor: 'vscode' }))[1].editor, 'vscode');
  const [, r] = await c.call('/open-file', { path: 'src dir/a#b.ts', line: 12, cwd: c.dir });
  assert.equal(r.editor, 'vscode');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], internals.editorUrl('vscode', r.path, 12));
  assert.match(opened[0][0], /^vscode:\/\/file\/.*\/src%20dir\/a%23b\.ts:12$/, 'segments are encoded, the line stays');

  await c.call('/editor', { editor: 'reveal' });
  await c.call('/open-file', { path: file });
  assert.deepEqual(opened[1], [r.path, true]);

  assert.equal((await c.call('/open-file', { path: 'src dir/a#b.ts' }))[0], 400, 'relative without a session folder');
  assert.equal((await c.call('/open-file', { path: join(c.dir, 'src dir') }))[0], 400, 'folders are not opened');
  assert.equal((await c.call('/open-file', { path: join(c.dir, 'missing.ts') }))[0], 404);
  assert.equal(opened.length, 2);
  assert.equal((await c.call('/state'))[1].editor, 'reveal');
});

test('editorUrl keeps Windows drive letters and POSIX roots as editors expect', () => {
  assert.equal(internals.editorUrl('cursor', 'C:\\Work\\my app\\x.ts', 3), 'cursor://file/C:/Work/my%20app/x.ts:3');
  assert.equal(internals.editorUrl('vscode', '/home/me/x.ts'), 'vscode://file/home/me/x.ts');
});

test('two active sessions in the same folder editing the same file are flagged on both; worktrees, finished and hidden sessions are not', async t => {
  const edit = (p, at = 1) => ({ id: 'm' + Math.random(), role: 'tool', text: 'edit', at: new Date(at).toISOString(), tool: { name: 'edit', files: [{ path: p, op: 'modify', diff: '+1|x' }] } });
  const c = await start(t, dir => [
    session('a', { cwd: dir, status: 'running', messages: [edit('src/a.js'), edit('only-a.js')] }),
    session('b', { cwd: dir, status: 'review', messages: [edit(join(dir, 'src', 'a.js'))] }),
    session('iso', { cwd: dir, status: 'running', isolated: true, messages: [edit('src/a.js')] }),
    session('old', { cwd: dir, status: 'done', messages: [edit('src/a.js')] }),
    session('gone', { cwd: dir, status: 'running', hidden: true, messages: [edit('src/a.js')] }),
  ]);
  // Loading turns running sessions into paused ones (no OMP yet); these three are live again.
  for (const s of c.app.store.sessions) if (['a', 'iso', 'gone'].includes(s.id)) s.status = 'running';
  const by = Object.fromEntries((await c.call('/state'))[1].sessions.map(s => [s.id, s._overlaps]));
  assert.deepEqual(by.a, [{ id: 'b', title: 'b', files: [join(c.dir, 'src', 'a.js')], count: 1 }]);
  assert.deepEqual(by.b.map(o => o.id), ['a']);
  assert.equal(by.iso ?? by.old ?? by.gone, undefined);

  // Once one of them is done the warning goes away.
  c.app.store.sessions.find(s => s.id === 'b').status = 'done';
  assert.equal((await c.call('/state'))[1].sessions.find(s => s.id === 'a')._overlaps, undefined);
});

// Polls refresh every project's branch (at most every 15 s), read from the repository's HEAD file: starting git for
// 30-odd projects at once stalled the companion for a quarter second each time. These .git folders hold nothing but a
// HEAD, which git itself would not take for a repository, so every name below comes from HEAD alone.
test('polls name each project\'s branch from its HEAD file: branches, detached commits, linked worktrees and subfolders', async t => {
  const folders = ['p1', 'p2', 'p3', join('p1', 'sub', 'deep'), 'plain'];
  const c = await start(t, dir => [session('s', { cwd: join(dir, 'p1'), projectId: 'p1' })], {}, dir => folders.map((f, i) => ({ id: ['p1', 'p2', 'p3', 'p4', 'p5'][i], path: join(dir, f), name: f })));
  for (const f of folders) await mkdir(join(c.dir, f), { recursive: true });
  await mkdir(join(c.dir, 'p1', '.git')); await writeFile(join(c.dir, 'p1', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  await mkdir(join(c.dir, 'p2', '.git')); await writeFile(join(c.dir, 'p2', '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  await mkdir(join(c.dir, 'gitdirs', 'p3'), { recursive: true }); await writeFile(join(c.dir, 'gitdirs', 'p3', 'HEAD'), 'ref: refs/heads/omp-web/abc\n');
  await writeFile(join(c.dir, 'p3', '.git'), 'gitdir: ../gitdirs/p3\n');
  let st;
  for (let i = 0; i < 100; i++) { st = (await c.call('/state'))[1]; if (st.projects.every(p => p.branch)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.deepEqual(st.projects.map(p => [p.id, p.branch]), [['p1', 'feature/x'], ['p2', 'detached'], ['p3', 'omp-web/abc'], ['p4', 'feature/x'], ['p5', 'workspace']]);
  assert.equal(st.sessions[0].branch, 'feature/x', 'sessions working in the project folder carry its branch');
});

test('a session that settles, fails or asks a question is reported once through onAttention', async t => {
  const events = [];
  const omp = fakeOmp({
    state: () => ({ todoPhases: [] }),
    prompt({ id, message }) {
      queueMicrotask(() => {
        this.emit({ type: 'agent_start' });
        if (message === 'ask') this.emit({ type: 'extension_ui_request', id: 'q1', method: 'confirm', title: 'Delete the cache?' });
        else if (message === 'fail') this.emit({ type: 'prompt_result', id, status: 'error', error: { message: 'Rate limited' } });
        else { this.emit({ type: 'prompt_result', id, status: 'completed', sessionSettled: true }); this.emit({ type: 'session_settled' }); }
      });
      return {};
    },
  });
  const c = await start(t, dir => [session('s', { cwd: dir, title: 'Docs' })], { omp, onAttention: e => events.push(e) });
  const wait = async n => { for (let i = 0; i < 300 && events.length < n; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(events.length, n); };

  const prompt = async message => assert.equal((await c.call('/sessions/s/command', { type: 'prompt', message }))[0], 200);
  await prompt('done?');
  await wait(1);
  assert.deepEqual(events[0], { id: 's', title: 'Docs', kind: 'review', detail: '' });
  await prompt('fail');
  await wait(2);
  assert.deepEqual([events[1].kind, events[1].detail], ['error', 'Rate limited']);

  // Removed from the panel: nobody is told.
  c.app.store.sessions[0].hidden = true;
  await prompt('done?');
  for (let i = 0; i < 100 && c.app.store.sessions[0].status !== 'review'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(events.length, 2);
  c.app.store.sessions[0].hidden = false;

  await prompt('ask');
  await wait(3);
  assert.deepEqual([events[2].kind, events[2].detail], ['question', 'Delete the cache?']);
});
