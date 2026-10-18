import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=' };
const msg = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content, ...extra } });
// Active path u1 → a1 → u2 → a2 → advisor update → a3. u3 is an abandoned branch appended later, off the active path.
const entries = [
  msg('u1', null, 'user', [{ type: 'text', text: 'first' }]),
  msg('a1', 'u1', 'assistant', [{ type: 'text', text: 'one' }]),
  msg('u2', 'a1', 'user', [{ type: 'text', text: 'sec' }, image, { type: 'text', text: 'ond' }]),
  msg('a2', 'u2', 'assistant', [{ type: 'text', text: 'two' }]),
  msg('adv', 'a2', 'user', [{ type: 'text', text: 'advisor note' }], { synthetic: true, attribution: 'agent' }),
  msg('a3', 'adv', 'assistant', [{ type: 'text', text: 'three' }]),
  msg('u3', 'a1', 'user', [{ type: 'text', text: 'abandoned' }]),
];

for (const type of ['edit_last', 'regenerate']) {
  test(`${type} branches to just before the last prompt on OMP's active path`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-rewind-'));
    let app;
    t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
    const log = join(dir, 'commands.log'), original = join(dir, 'original.jsonl'), branched = join(dir, 'branched.jsonl');
    await writeFile(branched, [entries[0], entries[1]].map(e => JSON.stringify(e)).join('\n') + '\n');
    const fake = join(dir, 'omp.mjs');
    await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
let file = ${JSON.stringify(original)};
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (['branch', 'prompt'].includes(c.type)) appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n');
  if (c.type === 'get_state') data = { todoPhases: [], sessionFile: file };
  else if (c.type === 'get_subagents') data = { subagents: [] };
  else if (c.type === 'get_entries') data = { entries: ${JSON.stringify(entries)}, leafId: 'a3' };
  else if (c.type === 'branch') { file = ${JSON.stringify(branched)}; data = { text: 'second', cancelled: false }; }
  else if (c.type === 'prompt') data = { agentInvoked: false };
  out({ type: 'response', id: c.id, success: true, command: c.type, data });
}`);
    const now = new Date().toISOString();
    await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, sessionFile: original, messages: [{ id: 'm', role: 'user', text: 'second', at: now }], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
    app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: [fake] });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) });
    const body = await res.json();
    assert.equal(res.status, 200, body.error);
    const sent = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(sent[0].type, 'branch');
    assert.equal(sent[0].entryId, 'u2');
    const s = app.store.sessions[0];
    assert.equal(s.sessionFile, branched);
    if (type === 'edit_last') {
      assert.equal(sent.length, 1);
      assert.equal(body.text, 'second');
      assert.deepEqual(body.images, [image]);
      assert.equal(s.status, 'paused');
      assert.deepEqual(s.messages.filter(m => m.role !== 'system').map(m => [m.text, m.entryId]), [['first', 'u1'], ['one', undefined]]);
    } else {
      assert.equal(sent.length, 2);
      assert.equal(sent[1].type, 'prompt');
      assert.equal(sent[1].message, 'second');
      assert.deepEqual(sent[1].images, [image]);
      assert.deepEqual(s.messages.filter(m => m.role !== 'system').map(m => m.text), ['first', 'one', 'second']);
    }
  });
}

test('a prompt typed in the panel learns its OMP entry ID from the echoed timestamp, not its text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-bind-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const at = 1792345892589, log = join(dir, 'entries.log');
  // An earlier prompt with the same text sits before it; only the timestamp tells them apart.
  const stored = [msg('old', null, 'user', [{ type: 'text', text: 'same' }], { timestamp: at - 5000 }), msg('r', 'old', 'assistant', [{ type: 'text', text: 'ok' }]), msg('new', 'r', 'user', [{ type: 'text', text: 'same' }], { timestamp: at })];
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], isSettled: true };
  else if (c.type === 'get_subagents') data = { subagents: [] };
  else if (c.type === 'get_entries') { appendFileSync(${JSON.stringify(log)}, JSON.stringify(c) + '\\n'); data = { entries: ${JSON.stringify(stored)}, leafId: 'new' }; }
  out({ type: 'response', id: c.id, success: true, command: c.type, data });
  if (c.type === 'prompt') {
    out({ type: 'agent_start' });
    out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'same' }], timestamp: ${at} } });
    out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
    out({ type: 'prompt_result', id: c.id, status: 'completed', sessionSettled: true });
  }
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'same' }) });
  assert.equal(res.status, 200, (await res.json()).error);
  const user = () => app.store.sessions[0].messages.find(m => m.role === 'user');
  // The background refresh (every 4 s) binds it once OMP reports itself settled.
  for (let i = 0; i < 100 && !user()?.entryId; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(user().entryId, 'new');
  assert.equal(user().ompAt, undefined);
  const reads = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(reads.length, 1, 'one get_entries per bound prompt');
  assert.equal(reads[0].since, undefined);
  assert.equal(app.store.sessions[0]._entryCursor, 'new', 'the next pass reads only newer entries');
});

test('prompts recorded without an entry ID get one from OMP\'s active path once the session is idle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-backfill-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const ts = s => `2026-10-18T10:00:0${s}.000Z`, e = (id, parentId, role, text, s) => ({ ...msg(id, parentId, role, [{ type: 'text', text }]), timestamp: ts(s) });
  // u1 → a1 → u2 → a2 is the active path; x is an abandoned branch off a1.
  const stored = [e('u1', null, 'user', 'first', 1), e('a1', 'u1', 'assistant', 'one', 2), e('x', 'a1', 'user', 'abandoned', 3), e('u2', 'a1', 'user', 'second', 4), e('a2', 'u2', 'assistant', 'two', 6)];
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], isSettled: true };
  else if (c.type === 'get_subagents') data = { subagents: [] };
  else if (c.type === 'get_entries') data = { entries: ${JSON.stringify(stored)}, leafId: 'a2' };
  out({ type: 'response', id: c.id, success: true, command: c.type, data });
}`);
  // As saved by a companion that recorded these prompts without entry IDs, plus a note of its own and a /usage command.
  const saved = [{ id: 'p1', role: 'user', text: 'first', at: ts(1) }, { id: 'r1', role: 'assistant', text: 'one', at: ts(2) }, { id: 'p2', role: 'user', text: 'second', at: ts(4) }, { id: 'n', role: 'system', text: 'Auto-approved: read', at: ts(5) }, { id: 'r2', role: 'assistant', text: 'two', at: ts(6) }, { id: 'p3', role: 'user', text: '/usage', at: ts(7) }];
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: saved, todos: [], createdAt: ts(0), updatedAt: ts(7) }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  // Any command that starts the runner; its first refresh sees OMP settled.
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'tree' }) });
  assert.equal(res.status, 200);
  const s = app.store.sessions[0];
  for (let i = 0; i < 100 && !s.messages.some(m => m.entryId); i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(s.messages.map(m => [m.role, m.text, m.entryId]), [['user', 'first', 'u1'], ['assistant', 'one', undefined], ['user', 'second', 'u2'], ['system', 'Auto-approved: read', undefined], ['assistant', 'two', undefined]]);
});

test('with no OMP running, viewing the session takes the entry IDs from its session file and active path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-backfill-file-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const ts = s => `2026-10-18T10:00:0${s}.000Z`, e = (id, parentId, role, text, s) => ({ ...msg(id, parentId, role, [{ type: 'text', text }]), timestamp: ts(s) });
  // x is abandoned: OMP resumes from the last entry, a2, whose path skips it.
  const file = join(dir, 'session.jsonl');
  await writeFile(file, [{ type: 'session', id: 'sess', timestamp: ts(0) }, e('u1', null, 'user', 'first', 1), e('a1', 'u1', 'assistant', 'one', 2), e('x', 'a1', 'user', 'abandoned', 3), e('u2', 'a1', 'user', 'second', 4), e('a2', 'u2', 'assistant', 'two', 6)].map(f => JSON.stringify(f)).join('\n') + '\n');
  const saved = [{ id: 'p1', role: 'user', text: 'first', at: ts(1) }, { id: 'r1', role: 'assistant', text: 'one', at: ts(2) }, { id: 'p2', role: 'user', text: 'second', at: ts(4) }, { id: 'r2', role: 'assistant', text: 'two', at: ts(6) }];
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: true, sessionFile: file, messages: saved, todos: [], createdAt: ts(0), updatedAt: ts(6) }], activity: [] }));
  // An OMP that would fail if started: the file alone must be enough.
  app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: ['-e', 'process.exit(3)'] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const poll = () => fetch(`http://127.0.0.1:${app.server.address().port}/api/state?session=session`, { headers: { Authorization: `Bearer ${app.token}` } }).then(r => r.json());
  let s;
  for (let i = 0; i < 50; i++) { s = (await poll()).sessions[0]; if (s.messages.some(m => m.entryId)) break; await new Promise(r => setTimeout(r, 100)); }
  assert.deepEqual(s.messages.map(m => [m.text, m.entryId]), [['first', 'u1'], ['one', undefined], ['second', 'u2'], ['two', undefined]]);
});
