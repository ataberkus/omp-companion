import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { cliCatalog } from '../companion/cli-tools.mjs';
import { fakeOmp } from './fake-omp.mjs';

// GET /api/cli?revs=1: every Tools job carries a revision that moves with each change, a job the poll names at its
// current revision comes back as {id, rev, unchanged: true}, and catalog=0 leaves the tools out. Without revs=1 the
// reply is the catalog and the jobs as they were.
test('Tools jobs carry revisions for polls that ask for them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-cli-revs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A .ts entry runs as `bun omp.ts …` (the companion's OMP-source path): a shebang script without an extension does not
  // run on Windows, where only .exe/.com files spawn without a shell.
  const cli = join(dir, 'omp.ts'), go = join(dir, 'go');
  // Prints a line, then the second one and exits once the test creates `go`.
  await writeFile(cli, `const fs = require('node:fs');
console.log('first');
const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(wait); console.log('second'); } }, 20);
`);
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp(), ompCommand: cli });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`, H = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const get = async p => { const r = await fetch(base + p, { headers: H }); assert.equal(r.status, 200); return r.json(); };
  const res = await fetch(base + '/cli', { method: 'POST', headers: H, body: JSON.stringify({ tool: 'stats', action: 'summary' }) });
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal('rev' in started, false, 'the run reply is unchanged');
  const until = async (p, ok) => { for (let i = 0; i < 200; i++) { const r = await get(p); if (ok(r)) return r; await new Promise(r => setTimeout(r, 20)); } throw new Error('timed out'); };

  const first = await until('/cli?revs=1&catalog=0', r => r.jobs[0]?.output.includes('first'));
  assert.equal('tools' in first, false);
  const [job] = first.jobs;
  assert.ok(Number.isInteger(job.rev) && job.rev > 0);
  assert.deepEqual(Object.keys(job).sort(), [...Object.keys(started), 'rev'].sort());
  const plain = await get('/cli');
  const catalog = JSON.parse(JSON.stringify(cliCatalog()));
  assert.deepEqual(plain.tools, catalog);
  assert.deepEqual(plain.jobs, [{ ...job, rev: undefined }].map(j => JSON.parse(JSON.stringify(j))), 'without revs=1 the jobs are sent as before');
  assert.deepEqual((await get(`/cli?revs=1&catalog=0&have=other.1,${job.id}.${job.rev}`)).jobs, [{ id: job.id, rev: job.rev, unchanged: true }]);
  assert.deepEqual((await get(`/cli?revs=1&have=${job.id}.${job.rev - 1}`)).jobs, [job], 'an older revision gets the job');
  assert.deepEqual((await get(`/cli?revs=1&have=${job.id}.${job.rev}`)).tools, catalog);

  await writeFile(go, '');
  const done = await until(`/cli?revs=1&catalog=0&have=${job.id}.${job.rev}`, r => r.jobs[0]?.status === 'done');
  const [finished] = done.jobs;
  assert.ok(finished.rev > job.rev);
  assert.equal(finished.output, 'first\nsecond');
  assert.equal(finished.exitCode, 0);
  assert.deepEqual((await get(`/cli?revs=1&catalog=0&have=${job.id}.${finished.rev}`)).jobs, [{ id: job.id, rev: finished.rev, unchanged: true }]);
});
