import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, mkdir, access, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
const exists = p => access(p).then(() => true, () => false);
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' });

// A project repo with an isolated session in its own worktree on omp-web/abcd1234, like the companion creates them.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-wt-'));
  const root = join(dir, 'repo'), wt = join(dir, 'wt'), data = join(dir, 'data');
  let app;
  // OMP's agent dir and session store are measured by Disk space scans: this test's own, never the developer's.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  t.after(async () => { if (app) await app.close(); if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir; await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  await mkdir(root); await mkdir(data);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false'); // byte-exact checkouts whatever the machine's git config says
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'gone.txt'), 'bye\n');
  await writeFile(join(root, '.gitignore'), 'ignored.log\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'init');
  const start = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'worktree', 'add', '-b', 'omp-web/abcd1234', wt);
  const at = new Date().toISOString();
  await writeFile(join(data, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', name: 'repo', path: root, createdAt: at }], sessions: [
    { id: 'w', projectId: 'p', title: 'Add feature', cwd: wt, branch: 'omp-web/abcd1234', isolated: true, baseSha: start, status: 'review', native: false, messages: [], todos: [], createdAt: at, updatedAt: at },
    { id: 'plain', projectId: 'p', title: 'Plain', cwd: root, branch: 'main', status: 'review', native: false, messages: [], todos: [], createdAt: at, updatedAt: at },
  ], activity: [] }));
  app = await createCompanion({ dataDir: data, ompSessionsDir: join(dir, 'omp-sessions') });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async (id, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${id}/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  return { root, wt, data, start, command, app: () => app };
}

test('Working tree changes: git diff since the session started plus untracked files, in the line-numbered diff format', async t => {
  const { wt, start, command } = await setup(t);
  await writeFile(join(wt, 'a.txt'), 'one\nTWO\nthree\n');
  await rm(join(wt, 'gone.txt'));
  await writeFile(join(wt, 'new file.txt'), 'hello\nworld\n');
  await writeFile(join(wt, 'ignored.log'), 'noise\n');
  await writeFile(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 3]));

  const [status, r] = await command('w', { type: 'changes_worktree', base: 'start' });
  assert.equal(status, 200);
  assert.equal(r.baseLabel, 'session start');
  assert.equal(r.base, start.slice(0, 12));
  const by = Object.fromEntries(r.files.map(f => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'blob.bin', 'gone.txt', 'new file.txt'].map(f => join(wt, f)).sort(), 'ignored files stay out; paths are absolute');
  assert.equal(by[join(wt, 'a.txt')].op, 'modify');
  assert.equal(by[join(wt, 'a.txt')].diff, ' 1|one\n-2|two\n+2|TWO\n 3|three');
  assert.equal(by[join(wt, 'gone.txt')].op, 'delete');
  assert.equal(by[join(wt, 'gone.txt')].diff, '-1|bye');
  assert.deepEqual([by[join(wt, 'new file.txt')].op, by[join(wt, 'new file.txt')].diff], ['create', '+1|hello\n+2|world']);
  assert.match(by[join(wt, 'blob.bin')].diff, /binary/);

  // Committed work still shows against the session start, but not against HEAD.
  await git(wt, 'add', '-A'); await git(wt, 'commit', '-m', 'work');
  assert.equal((await command('w', { type: 'changes_worktree', base: 'start' }))[1].files.length, 4);
  const head = (await command('w', { type: 'changes_worktree', base: 'head' }))[1];
  assert.deepEqual([head.baseLabel, head.files], ['HEAD', []]);

  // A git diff that spans hunks keeps them apart with a blank line, renumbered per side.
  await writeFile(join(wt, 'a.txt'), Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  await git(wt, 'commit', '-am', 'long');
  await writeFile(join(wt, 'a.txt'), Array.from({ length: 20 }, (_, i) => i === 1 ? 'X' : i === 17 ? 'Y' : `l${i + 1}`).join('\n') + '\n');
  const [hunkA, hunkB] = (await command('w', { type: 'changes_worktree', base: 'head' }))[1].files[0].diff.split('\n\n');
  assert.match(hunkA, /^ 1\|l1\n-2\|l2\n\+2\|X\n/);
  assert.match(hunkB, /-18\|l18\n\+18\|Y\n/);
});

test('Commits: branch, upstream and recent commits of the session folder, with per-commit diffs; non-git folders get a 409', async t => {
  const { root, wt, command, app } = await setup(t);
  await writeFile(join(wt, 'a.txt'), 'one\nTWO\nthree\n');
  await writeFile(join(wt, 'new.txt'), 'hi\n');
  await git(wt, 'add', '.'); await git(wt, 'commit', '-m', 'Work in worktree', '-m', 'Body line.');

  // Isolated session: its worktree's branch; the commit made since the session started is marked.
  const [code, log] = await command('w', { type: 'git_log' });
  assert.equal(code, 200);
  assert.deepEqual([log.branch, log.upstream, log.ahead, log.behind, log.dirty], ['omp-web/abcd1234', '', 0, 0, 0]);
  assert.deepEqual(log.commits.map(c => [c.subject, c.author, c.session, c.merge]), [['Work in worktree', 'Test', true, false], ['init', 'Test', false, false]]);
  assert.match(log.commits[0].sha, /^[0-9a-f]{40}$/);

  const [cc, commit] = await command('w', { type: 'git_commit', sha: log.commits[0].sha });
  assert.equal(cc, 200);
  assert.equal(commit.message, 'Work in worktree\n\nBody line.');
  assert.deepEqual(commit.files.map(f => [f.path, f.op]), [[join(wt, 'a.txt'), 'modify'], [join(wt, 'new.txt'), 'create']]);
  assert.match(commit.files[0].diff, /-2\|two\n\+2\|TWO/);
  // The root commit diffs against nothing: every file is added.
  assert.deepEqual((await command('w', { type: 'git_commit', sha: log.commits[1].sha }))[1].files.map(f => f.op), ['create', 'create', 'create']);

  // Plain session in the project folder: main, which lacks the worktree commit; an upstream gives ahead/behind.
  const remote = join(root, '..', 'remote.git');
  await exec('git', ['init', '--bare', remote]);
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-u', 'origin', 'main');
  await writeFile(join(root, 'local.txt'), 'x\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'local only');
  const plain = (await command('plain', { type: 'git_log' }))[1];
  assert.deepEqual([plain.branch, plain.upstream, plain.ahead, plain.behind], ['main', 'origin/main', 1, 0]);
  assert.deepEqual(plain.commits.map(c => c.subject), ['local only', 'init']);

  // A merge commit shows its diff against the first parent.
  await git(root, 'merge', '--no-ff', '--no-edit', 'omp-web/abcd1234');
  const merge = (await command('plain', { type: 'git_log' }))[1].commits[0];
  assert.equal(merge.merge, true);
  assert.deepEqual((await command('plain', { type: 'git_commit', sha: merge.sha }))[1].files.map(f => f.path), [join(root, 'a.txt'), join(root, 'new.txt')]);

  assert.equal((await command('plain', { type: 'git_commit', sha: 'not a sha' }))[0], 400);
  assert.equal((await command('plain', { type: 'git_commit', sha: 'deadbeefdeadbeef' }))[0], 404);

  const bare = join(root, '..', 'no-git');
  await mkdir(bare);
  app().store.sessions.push({ ...app().store.sessions[1], id: 'nogit', cwd: bare, branch: '' });
  const [nc, ne] = await command('nogit', { type: 'git_log' });
  assert.equal(nc, 409); assert.match(ne.error, /not a Git repository/);
  assert.equal((await command('nogit', { type: 'git_commit', sha: merge.sha }))[0], 409);
});

test('finishing a worktree: merge, squash, rebase and push act on the branch; refusals leave both folders clean; delete removes it', async t => {
  const { root, wt, command, app } = await setup(t);
  const status = async () => (await command('w', { type: 'worktree_status' }))[1];
  assert.equal((await command('plain', { type: 'worktree_status' }))[0], 409, 'only isolated omp-web/ sessions');
  assert.equal((await command('w', { type: 'worktree_finish', action: 'explode' }))[0], 400);

  let st = await status();
  assert.deepEqual([st.branch, st.base, st.ahead, st.behind, st.dirty, st.rootDirty, st.remote], ['omp-web/abcd1234', 'main', 0, 0, 0, 0, '']);
  assert.equal((await command('w', { type: 'worktree_finish', action: 'merge' }))[0], 409, 'nothing to merge');
  assert.equal((await command('w', { type: 'worktree_finish', action: 'merge', commit: true }))[0], 409, 'nothing to merge or commit');

  await writeFile(join(wt, 'feature.txt'), 'feature\n');
  assert.equal((await status()).dirty, 1);
  await git(wt, 'add', '.'); await git(wt, 'commit', '-m', 'Add feature file');
  st = await status();
  assert.deepEqual([st.ahead, st.commits.map(c => c.replace(/^\w+ /, ''))], [1, ['Add feature file']]);

  // A dirty project folder blocks merging; nothing is half-merged.
  await writeFile(join(root, 'a.txt'), 'local edit\n');
  const [code, err] = await command('w', { type: 'worktree_finish', action: 'merge' });
  assert.equal(code, 409); assert.match(err.error, /uncommitted changes/);
  assert.equal(await exists(join(root, 'feature.txt')), false);
  await git(root, 'checkout', '--', 'a.txt');

  // Busy sessions are refused.
  app().store.sessions[0].status = 'running';
  assert.equal((await command('w', { type: 'worktree_finish', action: 'merge' }))[0], 400);
  app().store.sessions[0].status = 'review';

  const merged = (await command('w', { type: 'worktree_finish', action: 'merge' }))[1];
  assert.equal(merged.ahead, 0);
  assert.equal(await readFile(join(root, 'feature.txt'), 'utf8'), 'feature\n');

  // Squash: one commit on main titled after the session.
  await writeFile(join(wt, 'second.txt'), '2\n'); await git(wt, 'add', '.'); await git(wt, 'commit', '-m', 'wip 1');
  await writeFile(join(wt, 'third.txt'), '3\n'); await git(wt, 'add', '.'); await git(wt, 'commit', '-m', 'wip 2');
  assert.equal((await command('w', { type: 'worktree_finish', action: 'squash' }))[0], 200);
  assert.equal(await git(root, 'log', '-1', '--format=%B'), 'Add feature\n\nSquashed from omp-web/abcd1234.');
  assert.equal(await git(root, 'rev-list', '--count', 'HEAD^..HEAD'), '1');
  assert.ok(await exists(join(root, 'third.txt')));

  // Rebase onto main (now ahead of the branch by the squash commit); a conflicting rebase is undone.
  await writeFile(join(root, 'main-only.txt'), 'm\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'main work');
  assert.ok((await status()).behind >= 1);
  assert.equal((await command('w', { type: 'worktree_finish', action: 'rebase' }))[1].behind, 0);
  await writeFile(join(root, 'a.txt'), 'main side\n'); await git(root, 'commit', '-am', 'main a');
  await writeFile(join(wt, 'a.txt'), 'branch side\n'); await git(wt, 'commit', '-am', 'branch a');
  const [rc, re] = await command('w', { type: 'worktree_finish', action: 'rebase' });
  assert.equal(rc, 409); assert.match(re.error, /Rebase failed and was undone/);
  assert.equal(await git(wt, 'status', '--porcelain'), '', 'no rebase left in progress');
  assert.equal(await readFile(join(wt, 'a.txt'), 'utf8'), 'branch side\n');

  // Push to the repository's remote sets the upstream.
  assert.equal((await command('w', { type: 'worktree_finish', action: 'push' }))[0], 409, 'no remote yet');
  const remote = join(root, '..', 'remote.git');
  await exec('git', ['init', '--bare', remote]);
  await git(root, 'remote', 'add', 'origin', remote);
  const pushed = (await command('w', { type: 'worktree_finish', action: 'push' }))[1];
  assert.equal(pushed.upstream, 'origin/omp-web/abcd1234');
  assert.equal(await git(remote, 'rev-parse', 'omp-web/abcd1234'), await git(wt, 'rev-parse', 'HEAD'));

  // Delete: folder and branch gone, session leaves the panel.
  assert.deepEqual((await command('w', { type: 'worktree_finish', action: 'delete' }))[1], { action: 'delete', deleted: true });
  assert.equal(await exists(wt), false);
  assert.equal(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');
  const s = app().store.sessions.find(x => x.id === 'w');
  assert.deepEqual([s.hidden, s.status], [true, 'done']);
});

// Deleting must not depend on git being able to read the worktree: its link to the repository can break (the project
// folder moved, git's record of it pruned, its .git file gone) or the project folder can stop being a repository.
for (const [name, breakIt, problem] of [
  ['the project folder moved', async ({ root, app }) => { const to = join(root, '..', 'moved'); await rename(root, to); app().store.projects[0].path = to; return to; }, /no longer linked/],
  ['git\'s record of the worktree is gone', ({ root }) => rm(join(root, '.git', 'worktrees'), { recursive: true, force: true }), /no longer linked/],
  ['the worktree folder lost its .git file', ({ wt }) => rm(join(wt, '.git'), { force: true }), /no longer linked/],
  ['the project folder is no longer a Git repository', ({ root }) => rm(join(root, '.git'), { recursive: true, force: true }), /no longer a Git repository/],
]) test(`finishing a worktree when ${name}: status reports it in a sentence, delete still removes the folder and session`, async t => {
  const env = await setup(t), { wt, command, app } = env;
  await writeFile(join(wt, 'feature.txt'), 'feature\n');
  const root = await breakIt(env) || env.root;
  const [code, st] = await command('w', { type: 'worktree_status' });
  assert.equal(code, 200);
  assert.match(st.problem, problem); assert.doesNotMatch(st.problem, /fatal:/);
  assert.deepEqual([st.exists, st.dirty], [true, null]);
  for (const action of ['merge', 'rebase', 'push']) {
    const [c, e] = await command('w', { type: 'worktree_finish', action });
    assert.equal(c, 409, action); assert.doesNotMatch(e.error, /fatal:/, action);
  }
  assert.deepEqual((await command('w', { type: 'worktree_finish', action: 'delete' }))[1], { action: 'delete', deleted: true });
  assert.equal(await exists(wt), false);
  if (await exists(join(root, '.git'))) {
    assert.equal(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).length, 1, 'git\'s record pruned');
  }
  const s = app().store.sessions.find(x => x.id === 'w');
  assert.deepEqual([s.hidden, s.status, !!s.worktreeRemoved], [true, 'done', true]);
});

test('finishing a worktree whose folder was deleted by hand: delete drops git\'s leftover record and the branch', async t => {
  const { root, wt, command, app } = await setup(t);
  await rm(wt, { recursive: true, force: true });
  const st = (await command('w', { type: 'worktree_status' }))[1];
  assert.deepEqual([st.exists, st.ahead, st.problem], [false, 0, undefined]);
  assert.deepEqual((await command('w', { type: 'worktree_finish', action: 'delete' }))[1], { action: 'delete', deleted: true });
  assert.equal(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');
  assert.equal((await git(root, 'worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).length, 1);
  assert.equal(app().store.sessions.find(x => x.id === 'w').hidden, true);
});

test('Push to main: merge with commit first commits the worktree\'s uncommitted changes on its branch', async t => {
  const { root, wt, command } = await setup(t);
  await writeFile(join(wt, 'feature.txt'), 'feature\n');
  await writeFile(join(wt, 'a.txt'), 'edited\n');

  // Without commit, uncommitted work is not merged.
  assert.match((await command('w', { type: 'worktree_finish', action: 'merge' }))[1].error, /has no commits that main lacks/);

  // A dirty project folder blocks it before anything is committed.
  await writeFile(join(root, 'a.txt'), 'local edit\n');
  const [code, err] = await command('w', { type: 'worktree_finish', action: 'merge', commit: true });
  assert.equal(code, 409); assert.match(err.error, /uncommitted changes/);
  assert.equal(await git(wt, 'rev-list', '--count', 'main..HEAD'), '0', 'worktree left uncommitted');
  await git(root, 'checkout', '--', 'a.txt');

  const [ok, merged] = await command('w', { type: 'worktree_finish', action: 'merge', commit: true });
  assert.equal(ok, 200);
  assert.deepEqual([merged.ahead, merged.dirty], [0, 0]);
  assert.equal(await git(wt, 'log', '-1', '--format=%s'), 'Add feature');
  assert.equal(await readFile(join(root, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(await git(root, 'branch', '--show-current'), 'main');
});

// Tools › Disk space: /api/storage scans and cleanups run in the background; this starts one and waits until it is done.
const storage = async (app, path = '', body) => {
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/storage${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return [res.status, await res.json()];
};
async function storageRun(app, path, body = {}) {
  const [code, r] = await storage(app, path, body);
  assert.equal(code, 202, r.error);
  let v = r;
  while (v.job) { await new Promise(res => setTimeout(res, 20)); v = (await storage(app))[1]; }
  assert.equal(v.error, '');
  return v;
}

test('Disk space: the scan sizes each worktree, ignored files included, with its git state; cleaning keeps the worktree', async t => {
  const { root, wt, app } = await setup(t);
  await writeFile(join(wt, 'ignored.log'), 'x'.repeat(5000));
  await writeFile(join(wt, 'notes.txt'), 'untracked\n');
  const { worktrees, orphans, scannedAt } = await storageRun(app(), '/scan');
  assert.ok(scannedAt);
  assert.deepEqual(worktrees.map(r => r.id), ['w'], 'only isolated omp-web/ sessions');
  const [r] = worktrees;
  assert.equal(r.tracked, 14 + 4 + 12, 'a.txt, gone.txt, .gitignore');
  assert.ok(r.bytes >= r.tracked + 5000 + 10, `${r.bytes} counts ignored.log and notes.txt`);
  assert.deepEqual([r.exists, r.base, r.branch, r.ahead, r.dirty, r.archived, r.hidden, r.status, r.safe], [true, 'main', 'omp-web/abcd1234', 0, 1, false, false, 'review', false]);
  assert.deepEqual(orphans, []);

  // Cleaning deletes only what .gitignore matches.
  const cleaned = await storageRun(app(), '/clean', { sessions: ['w'] });
  assert.equal(cleaned.results[0].ok, true);
  assert.ok(cleaned.results[0].freed >= 5000);
  assert.equal(await exists(join(wt, 'ignored.log')), false);
  assert.equal(await readFile(join(wt, 'notes.txt'), 'utf8'), 'untracked\n');
  assert.notEqual(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '', 'the branch stays');
  assert.ok(cleaned.worktrees[0].bytes < r.bytes - 4000);
});

test('Disk space: a clean archived worktree is removed; dirty, ahead and running ones are refused unless confirmed', async t => {
  const { root, wt, app } = await setup(t);
  const s = app().store.sessions.find(x => x.id === 'w');
  app().store.archived.push('s:w');
  assert.equal((await storageRun(app(), '/scan')).worktrees[0].safe, true);

  // Uncommitted work: refused without confirm, the folder stays.
  await writeFile(join(wt, 'feature.txt'), 'feature\n');
  let v = await storageRun(app(), '/remove', { sessions: ['w'] });
  assert.equal(v.results[0].ok, false); assert.match(v.results[0].error, /1 uncommitted change/);
  assert.ok(await exists(wt));

  // Commits main lacks: refused too (removal deletes the branch).
  await git(wt, 'add', '.'); await git(wt, 'commit', '-m', 'Add feature');
  v = await storageRun(app(), '/remove', { sessions: ['w'] });
  assert.match(v.results[0].error, /1 commit not in main/);
  assert.notEqual(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');

  // A working session is refused even when confirmed.
  s.status = 'running';
  v = await storageRun(app(), '/remove', { sessions: ['w'], confirm: true });
  assert.match(v.results[0].error, /Wait for OMP to finish/);
  assert.ok(await exists(wt));
  s.status = 'review';
  // Sessions not in their own worktree are never touched.
  v = await storageRun(app(), '/remove', { sessions: ['plain'], confirm: true });
  assert.equal(v.results[0].ok, false);

  // Merged back: nothing is lost, so it goes without confirm.
  await git(root, 'merge', '--no-edit', 'omp-web/abcd1234');
  v = await storageRun(app(), '/remove', { sessions: ['w'] });
  assert.equal(v.results[0].ok, true, v.results[0].error);
  assert.equal(await exists(wt), false);
  assert.equal(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');
  assert.ok(s.worktreeRemoved);
  assert.deepEqual([s.hidden, s.status], [true, 'done']);
  assert.deepEqual((await storageRun(app(), '/scan')).worktrees, []);
});

test('Disk space: removing all archived worktrees takes the safe ones, refuses ones with unmerged work and leaves the rest', async t => {
  const { root, wt, app } = await setup(t);
  // Nothing archived: nothing to remove.
  const [code, r] = await storage(app(), '/remove', { archived: true });
  assert.equal(code, 400); assert.match(r.error, /No archived session has a worktree/);

  // Two more worktrees, never scanned: one archived with uncommitted work, one with unmerged commits, one not archived.
  const extra = {};
  for (const id of ['dirty', 'ahead', 'kept']) {
    extra[id] = join(root, '..', id);
    await git(root, 'worktree', 'add', '-b', `omp-web/${id}`, extra[id]);
    const at = new Date().toISOString();
    app().store.sessions.push({ id, projectId: 'p', title: id, cwd: extra[id], branch: `omp-web/${id}`, isolated: true, status: 'review', native: false, messages: [], todos: [], createdAt: at, updatedAt: at });
  }
  await writeFile(join(extra.dirty, 'wip.txt'), 'wip\n');
  await writeFile(join(extra.ahead, 'b.txt'), 'b\n');
  await git(extra.ahead, 'add', '.'); await git(extra.ahead, 'commit', '-m', 'Unmerged');
  app().store.archived.push('s:w', 's:dirty', 's:ahead');

  const v = await storageRun(app(), '/remove', { archived: true });
  const by = Object.fromEntries(v.results.map(x => [x.key, x]));
  assert.deepEqual(Object.keys(by).sort(), ['ahead', 'dirty', 'w'], 'only archived worktrees are targeted');
  assert.deepEqual([by.w.ok, by.w.freed], [true, 0], 'no scan row, so nothing counted as freed');
  assert.equal(await exists(wt), false);
  assert.equal(await git(root, 'branch', '--list', 'omp-web/abcd1234'), '');
  assert.equal(by.dirty.ok, false); assert.match(by.dirty.error, /1 uncommitted change/);
  assert.equal(by.ahead.ok, false); assert.match(by.ahead.error, /1 commit not in main/);
  for (const d of Object.values(extra)) assert.ok(await exists(d), d);
  assert.notEqual(await git(root, 'branch', '--list', 'omp-web/kept'), '');
});

test('Disk space: the scan also sizes every OMP data location; a missing one is reported, not an error', async t => {
  const { data, app } = await setup(t);
  assert.deepEqual((await storage(app()))[1].locations, [], 'nothing measured before a scan');
  await mkdir(join(data, 'transcripts'), { recursive: true });
  await writeFile(join(data, 'transcripts', 'x.json'), 'x'.repeat(3000));
  await writeFile(join(data, 'stray.bin'), 'y'.repeat(700));
  await storageRun(app(), '/scan');
  const [, v] = await storage(app());
  assert.equal(v.error, '');
  const by = Object.fromEntries(v.locations.map(l => [l.key, l]));
  for (const l of v.locations) assert.equal(typeof l.bytes, 'number', l.key);
  assert.deepEqual([by['data:transcripts'].bytes >= 3000, by['data:transcripts'].missing, by['data:transcripts'].path], [true, false, join(data, 'transcripts')]);
  assert.ok(by['data:worktrees']);
  assert.deepEqual([by['data:exports'].missing, by['data:exports'].bytes], [true, 0], 'never created');
  assert.deepEqual([by['omp:blobs'].missing, by['omp:blobs'].bytes], [true, 0], 'no agent dir at all');
  assert.ok(by['data:other'].bytes >= 700, 'files no other row covers');
  await writeFile(join(data, 'transcripts', 'big.json'), 'z'.repeat(50000));
  await storageRun(app(), '/scan');
  const again = Object.fromEntries((await storage(app()))[1].locations.map(l => [l.key, l]));
  assert.ok(again['data:transcripts'].bytes - by['data:transcripts'].bytes >= 50000);
  assert.ok(again['data:other'].bytes - by['data:other'].bytes < 50000, 'named folders are not counted again as Other');
});

test('Disk space: folders no session uses are listed as orphans and removed with git\'s record pruned; their branch stays', async t => {
  const { root, wt, data, app } = await setup(t);
  const orphan = join(data, 'worktrees', 'gone-session'), stray = join(data, 'worktrees', 'stray');
  await git(root, 'worktree', 'add', '-b', 'omp-web/gone1234', orphan);
  await mkdir(stray); await writeFile(join(stray, 'leftover.bin'), 'y'.repeat(2000));
  // A session whose worktree was removed while Windows held its folder.
  app().store.sessions.find(x => x.id === 'w').worktreeRemoved = new Date().toISOString();

  const { worktrees, orphans } = await storageRun(app(), '/scan');
  assert.deepEqual(worktrees, []);
  const by = Object.fromEntries(orphans.map(o => [o.name, o]));
  assert.deepEqual(Object.keys(by).sort(), ['gone-session', 'stray', 'wt']);
  assert.deepEqual([by['gone-session'].kind, by['gone-session'].branch, by['gone-session'].dirty], ['unknown', 'omp-web/gone1234', 0]);
  // The root comes from git's .git file, which spells the path in long form even when TEMP is an 8.3 short name (RUNNER~1 on CI).
  assert.equal(await realpath(by['gone-session'].root), await realpath(root));
  assert.deepEqual([by.wt.kind, by.wt.sessionId], ['removed', 'w']);
  assert.ok(by.stray.bytes >= 2000);

  // Only folders the scan can list are accepted.
  assert.equal((await storage(app(), '/remove', { orphans: [join(data, 'worktrees', '..')] }))[0], 400);
  assert.equal((await storage(app(), '/remove', { orphans: [root] }))[0], 400);

  await writeFile(join(orphan, 'wip.txt'), 'wip\n');
  let v = await storageRun(app(), '/remove', { orphans: [orphan] });
  assert.match(v.results[0].error, /uncommitted change/);
  v = await storageRun(app(), '/remove', { orphans: orphans.map(o => o.dir), confirm: true });
  assert.deepEqual(v.results.map(r => r.ok), [true, true, true], JSON.stringify(v.results));
  for (const d of [orphan, stray, wt]) assert.equal(await exists(d), false, d);
  assert.doesNotMatch(await git(root, 'worktree', 'list', '--porcelain'), /gone-session|[\\/]wt\b/);
  assert.notEqual(await git(root, 'branch', '--list', 'omp-web/gone1234'), '', 'the branch keeps its commits');
  assert.deepEqual(v.orphans, []);
});
