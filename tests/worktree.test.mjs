import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
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
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
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
  app = await createCompanion({ dataDir: data });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async (id, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${id}/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  return { root, wt, start, command, app: () => app };
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

test('finishing a worktree: merge, squash, rebase and push act on the branch; refusals leave both folders clean; delete removes it', async t => {
  const { root, wt, command, app } = await setup(t);
  const status = async () => (await command('w', { type: 'worktree_status' }))[1];
  assert.equal((await command('plain', { type: 'worktree_status' }))[0], 409, 'only isolated omp-web/ sessions');
  assert.equal((await command('w', { type: 'worktree_finish', action: 'explode' }))[0], 400);

  let st = await status();
  assert.deepEqual([st.branch, st.base, st.ahead, st.behind, st.dirty, st.rootDirty, st.remote], ['omp-web/abcd1234', 'main', 0, 0, 0, 0, '']);
  assert.equal((await command('w', { type: 'worktree_finish', action: 'merge' }))[0], 409, 'nothing to merge');

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
