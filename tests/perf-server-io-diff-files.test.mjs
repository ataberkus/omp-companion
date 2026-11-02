import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDiffFiles } from '../companion/git.mjs';

// gitDiffFiles stops formatting a file's lines past perFile and skips files past the budget. On real and generated diffs,
// over and under both limits, it must return what formatting every line did.
const unquoteGitPath = p => /^".*"$/.test(p) ? p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t').replace(/\\n/g, '\n') : p;
function before(out, { budget = 2 * 1024 * 1024, perFile = 200 * 1024 } = {}) {
  const files = [];
  for (const chunk of String(out || '').split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n'); let from = '', to = '', op = 'modify'; const body = []; let o = 0, n = 0, inHunk = false, binary = false;
    for (const l of lines.slice(1)) {
      if (!inHunk) {
        if (l.startsWith('new file mode')) op = 'create'; else if (l.startsWith('deleted file mode')) op = 'delete';
        else if (l.startsWith('--- ')) from = l.slice(4); else if (l.startsWith('+++ ')) to = l.slice(4);
        else if (l.startsWith('Binary files ')) binary = true;
      }
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { if (body.length) body.push(''); o = +h[1]; n = +h[2]; inHunk = true; continue; }
      if (!inHunk) continue;
      if (l.startsWith(' ')) { body.push(` ${o}|${l.slice(1)}`); o++; n++; }
      else if (l.startsWith('-')) { body.push(`-${o}|${l.slice(1)}`); o++; }
      else if (l.startsWith('+')) { body.push(`+${n}|${l.slice(1)}`); n++; }
    }
    const side = to && to !== '/dev/null' ? to : from; let p = unquoteGitPath(side.replace(/\t$/, '')).replace(/^[ab]\//, '');
    if (!p) { const m = lines[0].match(/^a\/(.*) b\/(.*)$/); p = m ? m[2] : lines[0]; }
    let diff = binary ? '… (binary file)' : body.join('\n');
    if (diff.length > perFile) diff = diff.slice(0, perFile) + '\n… (diff truncated)';
    if (budget <= 0) { files.push({ path: p, op, diff: '… (diff omitted: too many changes)' }); continue; }
    budget -= diff.length; files.push({ path: p, op, diff });
  }
  return files;
}

test('gitDiffFiles matches formatting every line, over and under its limits', async t => {
  // A real working-tree diff: edits in several hunks, new, deleted, binary, renamed-as-delete+add, quoted names, no final newline.
  const dir = await mkdtemp(join(tmpdir(), 'omp-diff-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
  const git = (...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, maxBuffer: 64 << 20 }).toString();
  git('init', '-q');
  const many = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join('\n') + '\n';
  await writeFile(join(dir, 'code.js'), many(400, i => `line ${i} ü😀`));
  await writeFile(join(dir, 'gone.txt'), 'bye\n');
  await writeFile(join(dir, 'old name.txt'), 'moved\n');
  await writeFile(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(join(dir, 'lock.json'), many(20000, i => `  "dep-${i}": "1.${i}.0",`));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  await writeFile(join(dir, 'code.js'), many(400, i => i % 37 ? `line ${i} ü😀` : `changed ${i}`) + 'no newline');
  await rm(join(dir, 'gone.txt')); await rm(join(dir, 'old name.txt'));
  await writeFile(join(dir, 'new\tname "q".txt'), 'hello\n');
  await writeFile(join(dir, 'image.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
  await writeFile(join(dir, 'lock.json'), many(20000, i => `  "dep-${i}": "1.${i}.1",`));
  git('add', '-A');
  const real = git('-c', 'core.quotepath=off', 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3');
  const big = before(real).find(f => f.path === 'lock.json');
  assert.ok(big.diff.endsWith('… (diff truncated)'), 'the lockfile is past perFile');
  for (const limits of [undefined, { perFile: 2000 }, { budget: 3000 }, { budget: 3000, perFile: 500 }, { budget: 0 }, { perFile: 0 }]) assert.deepEqual(gitDiffFiles(real, limits), before(real, limits), JSON.stringify(limits));

  // Generated diffs at small limits, so every boundary (a file's text reaching perFile exactly, the budget running out
  // mid-file, empty hunks, stray lines) comes up.
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, pick = k => Math.floor(rnd() * k);
  for (let round = 0; round < 300; round++) {
    const files = Array.from({ length: 1 + pick(6) }, (_, f) => {
      const head = [`a/f${f} b/f${f}`, ...(pick(5) ? [] : [pick(2) ? 'new file mode 100644' : 'deleted file mode 100644']), 'index 1..2 100644', ...(pick(9) ? [`--- a/f${f}`, `+++ b/f${f}`] : [`Binary files a/f${f} and b/f${f} differ`])];
      const hunks = Array.from({ length: pick(4) }, () => [`@@ -${1 + pick(90)},${pick(9)} +${1 + pick(90)},${pick(9)} @@${pick(2) ? ' fn()' : ''}`, ...Array.from({ length: pick(30) }, () => ['+', '-', ' ', '\\', '', '@'][pick(6)] + 'x😀'.repeat(pick(12)))]);
      return [...head, ...hunks.flat()].join('\n');
    });
    const out = files.map(f => 'diff --git ' + f).join('\n') + (pick(2) ? '\n' : '');
    const limits = { budget: pick(800) - 50, perFile: pick(300) };
    assert.deepEqual(gitDiffFiles(out, limits), before(out, limits), `round ${round}`);
  }
});
