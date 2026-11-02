import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const at = new Date(0).toISOString();
const session = (id, status) => ({ id, projectId: 'p', title: id, status, cwd: '/w', model: 'OMP default', native: false, todos: [], createdAt: at, updatedAt: at });
const edit = (id, p) => ({ id, role: 'tool', text: 'edit', at, tool: { name: 'edit', status: 'done', files: [{ path: p, op: 'modify', diff: '+1|x' }] } });
const sha1 = bytes => createHash('sha1').update(bytes).digest('base64');
async function dataDir(t, sessions, transcripts, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: '/w', name: 'P' }], sessions, activity: [], ...extra }));
  await mkdir(join(dir, 'transcripts'));
  for (const [id, text] of Object.entries(transcripts)) await writeFile(join(dir, 'transcripts', id + '.json'), text);
  return dir;
}
async function open(t, dir) {
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  let closed; const close = app.close; app.close = () => closed ??= close(); t.after(app.close);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  app.call = async path => (await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { headers: { Authorization: `Bearer ${app.token}` } })).json();
  app.held = id => !Object.getOwnPropertyDescriptor(app.store.sessions.find(s => s.id === id), 'messages').get;
  return app;
}

// Startup parsed every transcript only to check it (most of a start with 100+ MB of them). workspace.json now records each
// transcript's digest as written; a file that still matches is that valid JSON and is not parsed again. Review sessions
// are, since the overlap check needs their edit records without reading them later.
test('workspace.json records each transcript\'s digest, startup parses only files that differ from it (and review sessions), and /api/state never carries it', async t => {
  const dir = await dataDir(t, [session('a', 'paused'), session('r', 'review'), session('s', 'review')], {
    a: JSON.stringify([{ id: 'a1', role: 'user', text: 'in a', at }]),
    r: JSON.stringify([edit('r1', 'x.js')]),
    s: JSON.stringify([edit('s1', 'x.js')]),
  });
  let app = await open(t, dir);
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.deepEqual(saved.transcriptDigests, Object.fromEntries(await Promise.all(['a', 'r', 's'].map(async id => [id, sha1(await readFile(join(dir, 'transcripts', id + '.json')))]))));
  assert.equal('transcriptDigests' in (await app.call('/state')), false);
  assert.equal('transcriptDigests' in (await app.call('/state?session=a&since=&store=')).sx.top, false);
  await app.close();

  // Digest-matched files are not parsed again: here a forged digest for bytes that are not JSON shows which ones startup
  // parses. A paused session's file is trusted until something reads it; a review session's is parsed (and stops startup).
  const bad = '[{"id":';
  const forge = async ids => { const w = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')); for (const id of ids) { await writeFile(join(dir, 'transcripts', id + '.json'), bad); w.transcriptDigests[id] = sha1(bad); } await writeFile(join(dir, 'workspace.json'), JSON.stringify(w)); };
  await forge(['a']);
  app = await open(t, dir);
  assert.throws(() => app.store.sessions.find(s => s.id === 'a').messages, /Cannot read the transcript of session a/);
  // The review sessions' edit records came from parsing them: flagged on the first poll, nothing read.
  const st = await app.call('/state?session=none&since=&store=');
  assert.deepEqual(st.sx.changed.map(s => [s.id, s._overlaps?.map(o => o.id)]), [['a', undefined], ['r', ['s']], ['s', ['r']]]);
  assert.deepEqual(['r', 's'].map(app.held), [false, false]);
  await app.close();
  await forge(['r']);
  await assert.rejects(createCompanion({ dataDir: dir, omp: fakeOmp() }), /Cannot read the transcript of session r/);

  // A file that no longer matches its digest is parsed as before.
  await writeFile(join(dir, 'transcripts', 'r.json'), JSON.stringify([edit('r1', 'x.js')]));
  await writeFile(join(dir, 'transcripts', 'a.json'), '[{"id":"a1",');
  await assert.rejects(createCompanion({ dataDir: dir, omp: fakeOmp() }), /Cannot read the transcript of session a/);
});

// Every start rewrote (and flushed) workspace.json, though after a clean quit the loaded store saves to the same bytes.
test('a start whose store loads unchanged leaves workspace.json alone; one that changes it on load saves it', async t => {
  const dir = await dataDir(t, [session('a', 'paused'), session('b', 'running')], { a: '[]', b: JSON.stringify([edit('b1', 'x.js')]) });
  const file = join(dir, 'workspace.json'), id = async () => { const s = await stat(file); return `${s.ino}:${s.mtimeMs}`; };
  let before = await id(), app = await open(t, dir);
  assert.notEqual(await id(), before, 'the running session loads paused, and that is saved');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[1].status, 'paused');
  await app.close();
  before = await id();
  const text = await readFile(file, 'utf8');
  app = await open(t, dir);
  assert.equal(await id(), before, 'nothing changed: not rewritten');
  app.store.sessions[0].title = 'renamed';
  await app.close();
  assert.notEqual(await readFile(file, 'utf8'), text);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions[0].title, 'renamed');
});
