import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitLog, gitRun } from '../companion/git.mjs';

// gitLog reads HEAD, branch, upstream, ahead/behind and the dirty count from one `git status --porcelain=v2 --branch`.
// On real repositories in every state the Commits view meets, it must answer what the separate git runs it replaced did.
async function before(s, limit = 50) {
  const cwd = s.cwd, lines = o => o.split('\n').filter(Boolean), opt = { timeout: 15000 };
  const prefix = (await gitRun(cwd, ['rev-parse', '--show-prefix'], { timeout: 10000 })).trim(), top = resolve(cwd, ...prefix.split('/').filter(Boolean).map(() => '..'));
  const head = await gitRun(cwd, ['rev-parse', '--verify', 'HEAD'], { timeout: 10000 }).then(o => o.trim(), () => '');
  const [branch, upstream, dirty] = await Promise.all([gitRun(cwd, ['branch', '--show-current'], opt).then(o => o.trim(), () => ''), head ? gitRun(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opt).then(o => o.trim(), () => '') : '', gitRun(cwd, ['status', '--porcelain'], opt).then(o => lines(o).length, () => null)]);
  let ahead = 0, behind = 0, commits = [];
  if (head) {
    if (upstream) [behind, ahead] = (await gitRun(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], opt)).trim().split(/\s+/).map(Number);
    const mine = new Set(s.baseSha ? await gitRun(cwd, ['rev-list', `${s.baseSha}..HEAD`], opt).then(lines, () => []) : []);
    commits = lines(await gitRun(cwd, ['log', '--no-color', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%s', '-n', String(limit), 'HEAD'], opt)).map(l => { const [sha, short, author, date, parents, subject] = l.split('\x1f'); return { sha, short, author, date, merge: parents.split(' ').length > 1, subject, session: mine.has(sha) }; });
  }
  return { cwd, top, branch, head: head.slice(0, 12), upstream, ahead, behind, dirty, commits, limit };
}

test('gitLog from one status run matches the separate git runs', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-git-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commit = (cwd, name, text = name) => { execFileSync('sh', ['-c', `printf '%s\\n' "$1" > "$2"`, 'sh', text, name], { cwd }); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'Add ' + name); };
  const same = async (label, s, check) => { const got = await gitLog(s); assert.deepEqual(got, await before(s), label); check?.(got); };

  const origin = join(root, 'origin.git'), clone = join(root, 'clone'), other = join(root, 'other');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, other);
  commit(other, 'a.txt'); commit(other, 'b.txt'); git(other, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, clone);
  const base = git(clone, 'rev-parse', 'HEAD');
  await same('in step with its upstream', { cwd: clone }, r => { assert.equal(r.upstream, 'origin/main'); assert.equal(r.dirty, 0); });
  commit(clone, 'c.txt'); commit(clone, 'd.txt');
  commit(other, 'e.txt'); git(other, 'push', '-q', 'origin', 'main'); git(clone, 'fetch', '-q');
  // The tab-named file is staged straight into the index (Windows file names cannot hold a tab, and Git for Windows
  // refuses such index paths unless core.protectNTFS is off): status quotes its path.
  git(clone, 'config', 'core.protectNTFS', 'false');
  await writeFile(join(clone, 'a.txt'), 'changed\n'); await writeFile(join(clone, 'new.txt'), 'untracked\n');
  git(clone, 'update-index', '--add', '--cacheinfo', `100644,${execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, input: 'quoted\n' }).toString().trim()},tab\tname.txt`);
  git(clone, 'mv', 'b.txt', 'renamed.txt');
  await same('ahead, behind and dirty', { cwd: clone, baseSha: base }, r => { assert.deepEqual([r.ahead, r.behind], [2, 1]); assert.equal(r.dirty, 4); assert.deepEqual(r.commits.map(c => c.session), [true, true, false, false]); });
  await mkdir(join(clone, 'sub', 'dir'), { recursive: true });
  await same('from a subfolder', { cwd: join(clone, 'sub', 'dir') }, r => assert.equal(r.top, clone));
  git(clone, 'stash', '-q', '-u');
  git(clone, 'merge', '-q', '--no-edit', 'origin/main');
  await same('a merge commit', { cwd: clone }, r => assert.equal(r.commits[0].merge, true));
  git(clone, 'checkout', '-q', '--detach', 'HEAD~1');
  await same('detached HEAD', { cwd: clone }, r => { assert.equal(r.branch, ''); assert.equal(r.upstream, ''); });
  git(clone, 'checkout', '-q', '-b', 'local');
  await same('a branch without upstream', { cwd: clone }, r => assert.equal(r.upstream, ''));
  git(clone, 'branch', '-q', '--set-upstream-to=main');
  await same('a local branch as upstream', { cwd: clone }, r => assert.equal(r.upstream, 'main'));
  git(clone, 'checkout', '-q', '-b', 'gone'); git(clone, 'push', '-q', '-u', 'origin', 'gone'); git(clone, 'push', '-q', 'origin', '--delete', 'gone');
  await same('an upstream that is gone', { cwd: clone }, r => { assert.equal(r.branch, 'gone'); assert.equal(r.upstream, ''); });

  const empty = join(root, 'empty');
  git(root, 'init', '-q', empty);
  await same('an empty repository', { cwd: empty }, r => { assert.equal(r.head, ''); assert.equal(r.branch, 'main'); assert.deepEqual(r.commits, []); });
  await writeFile(join(empty, 'staged.txt'), 'x\n'); git(empty, 'add', 'staged.txt');
  await same('an empty repository with a staged file', { cwd: empty }, r => assert.equal(r.dirty, 1));

  // A broken index fails `git status`: the branch and commits still show, with dirty unknown.
  const broken = join(root, 'broken');
  git(root, 'init', '-q', broken); commit(broken, 'f.txt');
  await writeFile(join(broken, '.git', 'index'), 'garbage');
  await same('a broken index', { cwd: broken }, r => { assert.equal(r.dirty, null); assert.equal(r.branch, 'main'); assert.equal(r.commits.length, 1); });
});
