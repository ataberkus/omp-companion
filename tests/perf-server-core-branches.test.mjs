import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const within = (promise, ms, what) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${what} did not finish within ${ms} ms`); })]);

// A project folder on an unreachable share hangs its HEAD read. Each 15 s branch round used to ask again regardless, and the
// hung reads filled the fs thread pool (4 threads), which also serves saves, static files and the gzip of every reply.
// A FIFO stands in for that share: reading it waits for a writer. The other project keeps its 15 s refresh.
test('a project whose branch lookup hangs is not asked again until it settles; the others still refresh every round', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-branches-'));
  const head = join(dir, 'stuck', '.git', 'HEAD');
  let app;
  const realNow = Date.now; let skew = 0;
  t.after(async () => {
    Date.now = realNow;
    // Let any read still waiting go (a writer opening the FIFO), then put a plain HEAD in its place.
    await new Promise(r => execFile('sh', ['-c', 'printf "ref: refs/heads/main\\n" > "$1"', 'sh', head], { timeout: 2000 }, r));
    await rm(head, { force: true }); await writeFile(head, 'ref: refs/heads/main\n');
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const p of ['stuck', 'fine']) await mkdir(join(dir, p, '.git'), { recursive: true });
  execFileSync('mkfifo', [head]);
  await writeFile(join(dir, 'fine', '.git', 'HEAD'), 'ref: refs/heads/b0\n');
  const at = new Date(0).toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'stuck', path: join(dir, 'stuck'), name: 'stuck' }, { id: 'fine', path: join(dir, 'fine'), name: 'fine' }], sessions: [{ id: 's', projectId: 'fine', title: 's', status: 'paused', cwd: join(dir, 'fine'), native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const state = async () => (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`, { headers: { Authorization: 'Bearer ' + app.token } })).json();
  Date.now = () => realNow() + skew;
  for (let round = 1; round <= 6; round++) {
    skew += 16000;
    await writeFile(join(dir, 'fine', '.git', 'HEAD'), `ref: refs/heads/b${round}\n`);
    let st = await within(state(), 4000, `poll ${round}`);
    for (let i = 0; i < 100 && st.projects[1].branch !== `b${round}`; i++) { await sleep(20); st = await within(state(), 4000, `poll ${round}`); }
    assert.equal(st.projects[1].branch, `b${round}`, `round ${round} refreshed the reachable project`);
    assert.equal(st.sessions[0].branch, `b${round}`);
  }
  // Six rounds later the pool still has threads: one hung read, not six.
  assert.equal(await within(readFile(join(dir, 'workspace.json'), 'utf8').then(() => 'read'), 3000, 'a file read'), 'read');
  // Once the share answers, its project gets its branch, and the next round asks it again.
  await new Promise((resolve, reject) => execFile('sh', ['-c', 'printf "ref: refs/heads/main\\n" > "$1"', 'sh', head], { timeout: 3000 }, e => e ? reject(e) : resolve()));
  let st = await state();
  for (let i = 0; i < 100 && st.projects[0].branch !== 'main'; i++) { await sleep(20); st = await state(); }
  assert.equal(st.projects[0].branch, 'main');
  await rm(head); await writeFile(head, 'ref: refs/heads/other\n');
  skew += 16000;
  st = await state();
  for (let i = 0; i < 100 && st.projects[0].branch !== 'other'; i++) { await sleep(20); st = await state(); }
  assert.equal(st.projects[0].branch, 'other');
});

// Hiding (or removing) the workspace whose share hangs used to let close() finish once the next round ran without it.
// Tracking each project's lookup across rounds kept close() waiting for that hung lookup until the share answered.
test('close() does not wait for a hung branch lookup of a workspace hidden or removed before the last round', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  for (const how of ['hide', 'remove']) {
    const dir = await mkdtemp(join(tmpdir(), 'omp-branches-'));
    const head = join(dir, 'stuck', '.git', 'HEAD');
    const realNow = Date.now; let skew = 0, closed;
    t.after(async () => {
      Date.now = realNow;
      await new Promise(r => execFile('sh', ['-c', 'printf "ref: refs/heads/main\\n" > "$1"', 'sh', head], { timeout: 2000 }, r));
      await closed; await rm(dir, { recursive: true, force: true });
    });
    for (const p of ['stuck', 'fine']) await mkdir(join(dir, p, '.git'), { recursive: true });
    execFileSync('mkfifo', [head]);
    await writeFile(join(dir, 'fine', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'stuck', path: join(dir, 'stuck'), name: 'stuck' }, { id: 'fine', path: join(dir, 'fine'), name: 'fine' }], sessions: [], activity: [] }));
    const app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const api = (p, body) => fetch(`http://127.0.0.1:${app.server.address().port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
    Date.now = () => realNow() + skew;
    skew += 16000; await api('/state'); await sleep(100); // its lookup starts and hangs
    if (how === 'hide') await api('/projects/update', { id: 'stuck', hidden: true }); else app.store.projects.splice(0, 1);
    skew += 16000; await api('/state'); await sleep(100); // the next round runs without it
    closed = app.close();
    await within(closed, 4000, `close() after ${how}`);
  }
});
