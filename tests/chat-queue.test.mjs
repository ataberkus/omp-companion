import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };

test('queued follow-ups stay out of live work, can be edited or removed, and dispatch after it settles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-queue-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  const log = join(dir, 'sent.jsonl');
  const release = join(dir, 'release');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { existsSync, appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)}, release = ${JSON.stringify(release)};
let released = false;
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'prompt' || c.type === 'follow_up') appendFileSync(log, JSON.stringify({ type: c.type, message: c.message, images: c.images }) + '\\n');
  if (c.type === 'get_state' && !released && existsSync(release)) {
    released = true;
    process.stdout.write(JSON.stringify({ type: 'prompt_result', status: 'completed', sessionSettled: true }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'session_settled' }) + '\\n');
  }
  const data = c.type === 'get_state' ? { todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : {};
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, command: c.type, success: true, data }) + '\\n');
  if (c.type === 'prompt' && released) {
    process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'prompt_result', status: 'completed', sessionSettled: false }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'session_settled' }) + '\\n');
  }
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`;
  const post = async body => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };

  assert.equal((await post({ type: 'prompt', message: 'Current work' }))[0], 200);
  const [, queued] = await post({ type: 'follow_up', message: 'Original later', images: [image], preview: `data:image/png;base64,${png}` });
  assert.equal(queued.status, 'running');
  assert.equal(queued.queuedMessages.length, 1);
  assert.deepEqual(queued.messages.filter(m => m.role === 'user').map(m => m.text), ['Current work']);
  const id = queued.queuedMessages[0].id;
  const [, more] = await post({ type: 'follow_up', message: 'Cancel this' });
  assert.equal(more.queuedMessages.length, 2);
  const secondId = more.queuedMessages[1].id;
  assert.equal((await post({ type: 'edit_follow_up', id, message: 'Edited for later' }))[1].queuedMessages[0].text, 'Edited for later');
  assert.equal((await post({ type: 'cancel_follow_up', id: secondId }))[1].queuedMessages.length, 1);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  const [, stopped] = await post({ type: 'abort' });
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.queuedMessages.length, 1);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await post({ type: 'hide' }))[0], 400);
  assert.equal((await post({ type: 'complete' }))[0], 400);
  assert.equal((await post({ type: 'prompt', message: 'Resume current work' }))[0], 200);
  assert.equal(app.store.sessions[0].queuedMessages.length, 1);

  await writeFile(release, 'go');
  assert.equal((await post({ type: 'set_model', model: 'test/model' }))[0], 200);
  let sent;
  for (let i = 0; i < 40; i++) {
    sent = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    if (sent.length === 3 && !app.store.sessions[0].queuedMessages.length && app.store.sessions[0].status === 'review') break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(x => x.message), ['Current work', 'Resume current work', 'Edited for later']);
  assert.equal(sent[2].images?.[0]?.data, image.data);
  assert.equal(app.store.sessions[0].queuedMessages.length, 0);
  assert.equal(app.store.sessions[0].status, 'review');
  assert.deepEqual(app.store.sessions[0].messages.filter(m => m.role === 'user').map(m => m.text), ['Current work', 'Resume current work', 'Edited for later']);
  assert.equal((await post({ type: 'edit_follow_up', id, message: 'Too late' }))[0], 400);
});

test('closing while a queued prompt awaits OMP keeps it available for retry', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-close-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs'), release = join(dir, 'release'), sent = join(dir, 'queued-sent');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const release = ${JSON.stringify(release)}, sent = ${JSON.stringify(sent)};
let settled = false;
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'prompt' && c.message === 'Send me later') { writeFileSync(sent, 'received'); continue; }
  if (c.type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'prompt_result', status: 'completed', sessionSettled: false }) + '\\n');
  }
  if (c.type === 'get_state' && !settled && existsSync(release)) {
    settled = true;
    process.stdout.write(JSON.stringify({ type: 'session_settled' }) + '\\n');
  }
  const data = c.type === 'get_state' ? { todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : {};
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, command: c.type, success: true, data }) + '\\n');
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`;
  const post = async body => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json();
  };
  await post({ type: 'prompt', message: 'First turn' });
  await post({ type: 'follow_up', message: 'Send me later' });
  await writeFile(release, 'go');
  await post({ type: 'set_model', model: 'test/model' });
  let received = false;
  for (let i = 0; i < 60; i++) {
    received = await readFile(sent, 'utf8').then(() => true, () => false);
    if (received) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(received, true);
  await app.close();
  await app.flush();
  app = null;
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.equal(saved.sessions[0].queuedMessages?.[0]?.text, 'Send me later');
});

test('steers stay pending until OMP reads them, and queued messages can be sent now', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-steer-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs'), log = join(dir, 'sent.jsonl');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (['prompt', 'steer'].includes(c.type)) appendFileSync(log, JSON.stringify({ type: c.type, message: c.message }) + '\\n');
  const data = c.type === 'get_state' ? { todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : c.type === 'remove_queued_message' ? { removed: c.queue === 'steering' } : {};
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
  if (c.type === 'prompt') { out({ type: 'agent_start' }); out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: c.message }] } }); }
  if (c.type === 'steer' && c.message === 'Read me') {
    out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
    out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Read me' }] } });
  }
  if (c.type === 'abort') out({ type: 'prompt_result', status: 'aborted' });
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`;
  const post = async body => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const session = () => app.store.sessions[0];
  const wait = async fn => { for (let i = 0; i < 40 && !fn(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(fn()); };

  await post({ type: 'prompt', message: 'Work' });
  await post({ type: 'steer', message: 'Read me' });
  // OMP read the steer after a tool started, so it moves below that tool and is no longer pending.
  await wait(() => session().messages.at(-1)?.text === 'Read me' && !session().messages.at(-1).steer);
  assert.equal(session().messages.at(-2).role, 'tool');

  await post({ type: 'steer', message: 'Never read' });
  assert.equal(session().messages.find(m => m.text === 'Never read').steer, 'pending');

  await post({ type: 'steer', message: 'Cancel me' });
  await post({ type: 'cancel_steer', id: session().messages.find(m => m.text === 'Cancel me').id });
  assert.ok(!session().messages.some(m => m.text === 'Cancel me'));
  await post({ type: 'edit_steer', id: session().messages.find(m => m.text === 'Never read').id, message: 'Fixed' });
  assert.ok(!session().messages.some(m => m.text === 'Never read'));
  assert.equal(session().messages.find(m => m.text === 'Fixed').steer, 'pending');
  assert.equal((await post({ type: 'cancel_steer', id: session().messages.find(m => m.text === 'Read me').id }))[0], 400);

  const [, queued] = await post({ type: 'follow_up', message: 'Later one' });
  const [, sent] = await post({ type: 'send_follow_up', id: queued.queuedMessages[0].id });
  assert.equal(sent.queuedMessages.length, 0);
  assert.equal(session().messages.find(m => m.text === 'Later one').steer, 'pending');

  const [, idle] = await post({ type: 'abort' });
  await wait(() => session().messages.find(m => m.text === 'Fixed').steer === 'dropped');
  assert.equal(idle.status, 'paused');

  const [, again] = await post({ type: 'follow_up', message: 'While idle' });
  assert.equal(again.queuedMessages?.length || 0, 0, 'idle sessions send follow-ups immediately');
  const sentLog = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(sentLog.map(x => [x.type, x.message]), [['prompt', 'Work'], ['steer', 'Read me'], ['steer', 'Never read'], ['steer', 'Cancel me'], ['steer', 'Fixed'], ['steer', 'Later one'], ['prompt', 'While idle']]);
  assert.equal((await post({ type: 'send_follow_up', id: 'missing' }))[0], 400);
});

test('a stopped run\'s late prompt_result does not pause the next prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-abort-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  // Like OMP: prompt_result is keyed by the prompt's id and can land after the abort reply and the next prompt.
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
let first;
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const data = c.type === 'get_state' ? { todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : {};
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
  if (c.type === 'prompt') { out({ type: 'agent_start' }); if (first) out({ type: 'prompt_result', id: first, status: 'aborted' }); else first = c.id; }
}`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const post = body => fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  await post({ type: 'prompt', message: 'Work' });
  assert.equal((await post({ type: 'abort' })).status, 'paused');
  await post({ type: 'prompt', message: 'Continue' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(app.store.sessions[0].status, 'running');
});
