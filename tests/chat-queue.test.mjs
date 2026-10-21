import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const after = fn => setImmediate(fn);

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };

test('queued follow-ups stay out of live work, can be edited or removed, and dispatch after it settles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-queue-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const log = [];
  let release = false, released = false;
  const omp = fakeOmp({
    prompt(c) {
      log.push({ type: 'prompt', message: c.message, images: c.images });
      if (released) after(() => { this.emit({ type: 'agent_start' }); this.emit({ type: 'prompt_result', status: 'completed', sessionSettled: false }); this.emit({ type: 'session_settled' }); });
      return {};
    },
    followUp(c) { log.push({ type: 'follow_up', message: c.message, images: c.images }); return {}; },
    state() {
      if (!released && release) {
        released = true;
        this.emit({ type: 'prompt_result', status: 'completed', sessionSettled: true });
        this.emit({ type: 'session_settled' });
      }
      return { todoPhases: [] };
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
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
  assert.equal(log.length, 1);
  const [, stopped] = await post({ type: 'abort' });
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.queuedMessages.length, 1);
  assert.equal(log.length, 1);
  assert.equal((await post({ type: 'hide' }))[0], 400);
  assert.equal((await post({ type: 'complete' }))[0], 400);
  assert.equal((await post({ type: 'prompt', message: 'Resume current work' }))[0], 200);
  assert.equal(app.store.sessions[0].queuedMessages.length, 1);

  release = true;
  assert.equal((await post({ type: 'set_model', model: 'test/model' }))[0], 200);
  let sent;
  for (let i = 0; i < 40; i++) {
    sent = log;
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
  let release = false, settled = false, received = false;
  const omp = fakeOmp({
    prompt(c) {
      if (c.message === 'Send me later') { received = true; return new Promise(() => {}); }
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'prompt_result', status: 'completed', sessionSettled: false });
      return {};
    },
    state() {
      if (!settled && release) { settled = true; this.emit({ type: 'session_settled' }); }
      return { todoPhases: [] };
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
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
  release = true;
  await post({ type: 'set_model', model: 'test/model' });
  for (let i = 0; i < 60 && !received; i++) await new Promise(r => setTimeout(r, 25));
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
  const log = [];
  const queue = [];
  let delivering;
  const omp = fakeOmp(session => {
    const read = text => { const i = queue.indexOf(text); if (i >= 0) queue.splice(i, 1); session.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } }); };
    return {
      prompt(c) {
        log.push({ type: 'prompt', message: c.message });
        after(() => { this.emit({ type: 'agent_start' }); this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: c.message }] } }); });
        return {};
      },
      steer(c) {
        log.push({ type: 'steer', message: c.message });
        queue.push(c.message);
        if (c.message === 'Read me') after(() => { this.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }); read('Read me'); });
        return {};
      },
      state() { if (delivering) { read(delivering); delivering = undefined; } return { todoPhases: [] }; },
      removeQueued(text, kind) {
        if (text === 'Read during cancel') read(text);
        if (text === 'Taken by OMP') { queue.splice(queue.indexOf(text), 1); delivering = text; }
        if (text === 'Cancel after reordering') read('Earlier pending');
        const index = kind === 'steering' ? queue.indexOf(text) : -1;
        if (index >= 0) queue.splice(index, 1);
        return { removed: index >= 0 };
      },
      abort() { after(() => this.emit({ type: 'prompt_result', status: 'aborted' })); return {}; },
    };
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
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
  assert.equal((await post({ type: 'cancel_steer', id: session().messages.find(m => m.text === 'Read me').id }))[0], 200);
  assert.ok(session().messages.some(m => m.text === 'Read me' && !m.steer), 'late cancellation preserves delivered history');

  const [, queued] = await post({ type: 'follow_up', message: 'Later one' });
  const [, sent] = await post({ type: 'send_follow_up', id: queued.queuedMessages[0].id });
  assert.equal(sent.queuedMessages.length, 0);
  assert.equal(session().messages.find(m => m.text === 'Later one').steer, 'pending');

  const [, idle] = await post({ type: 'abort' });
  await wait(() => session().messages.find(m => m.text === 'Fixed').steer === 'dropped');
  assert.equal(idle.status, 'paused');

  const [, again] = await post({ type: 'follow_up', message: 'While idle' });
  assert.equal(again.queuedMessages?.length || 0, 0, 'idle sessions send follow-ups immediately');
  assert.deepEqual(log.map(x => [x.type, x.message]), [['prompt', 'Work'], ['steer', 'Read me'], ['steer', 'Never read'], ['steer', 'Cancel me'], ['steer', 'Fixed'], ['steer', 'Later one'], ['prompt', 'While idle']]);
  assert.equal((await post({ type: 'send_follow_up', id: 'missing' }))[0], 400);

  await post({ type: 'steer', message: 'Read during cancel' });
  const readId = session().messages.find(m => m.text === 'Read during cancel').id;
  assert.equal((await post({ type: 'cancel_steer', id: readId }))[0], 200);
  assert.ok(session().messages.some(m => m.id === readId && !m.steer));
  assert.equal(session().status, 'running');
  assert.equal((await post({ type: 'edit_steer', id: readId, message: 'Do not resend' }))[0], 400);
  assert.ok(!session().messages.some(m => m.text === 'Do not resend'));

  await post({ type: 'steer', message: 'Taken by OMP' });
  const takenId = session().messages.find(m => m.text === 'Taken by OMP').id;
  const [takenStatus, taken] = await post({ type: 'cancel_steer', id: takenId });
  assert.equal(takenStatus, 200);
  assert.equal(taken.messages.find(m => m.id === takenId).steer, 'received');
  assert.equal(taken._notices.at(-1).level, 'info');
  await post({ type: 'set_model', model: 'test/model' });
  assert.equal(session().messages.at(-1).id, takenId, 'the later echo still places the steer at its delivery boundary');
  assert.equal(session().messages.at(-1).steer, undefined);

  await post({ type: 'steer', message: 'Earlier pending' });
  await post({ type: 'steer', message: 'Cancel after reordering' });
  const cancelId = session().messages.find(m => m.text === 'Cancel after reordering').id;
  assert.equal((await post({ type: 'cancel_steer', id: cancelId }))[0], 200);
  assert.ok(!session().messages.some(m => m.id === cancelId));
  assert.ok(session().messages.some(m => m.text === 'Earlier pending' && !m.steer), 'cancellation must not delete a different delivered message');
  assert.equal((await post({ type: 'cancel_steer', id: cancelId }))[0], 200);
});

test('a steer sent mid-thought waits below the live turn and leaves its thought whole', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-steer-think-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // Live steering: the streaming message keeps thinking after OMP takes the steer, runs its tool, and the steer is echoed
  // only at the next turn boundary.
  let steer, stage = 0;
  const omp = fakeOmp(session => {
    const think = delta => session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } });
    return {
      prompt() { after(() => { this.emit({ type: 'agent_start' }); this.emit({ type: 'message_start', message: { role: 'assistant', content: [] } }); think('Analyzing. '); }); return {}; },
      steer(c) { steer = c.message; after(() => think('Still analyzing.')); return {}; },
      cycleModel() {
        after(() => {
          if (stage++ === 0) {
            this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Analyzing. Still analyzing.' }] } });
            this.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
          } else {
            this.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] } });
            this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: steer }] } });
            this.emit({ type: 'message_start', message: { role: 'assistant', content: [] } }); think('Following the steer.');
          }
        });
        return {};
      },
      state: () => ({ todoPhases: [] }),
    };
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`;
  const post = body => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const shape = () => app.store.sessions[0].messages.map(m => m.role === 'thinking' ? 'thinking:' + m.text : m.role + (m.steer ? ':' + m.steer : ''));
  const wait = async want => { for (let i = 0; i < 40 && JSON.stringify(shape()) !== JSON.stringify(want); i++) await new Promise(r => setTimeout(r, 25)); assert.deepEqual(shape(), want); };

  await post({ type: 'prompt', message: 'Work' });
  await post({ type: 'steer', message: 'Done when: pushed' });
  await wait(['user', 'thinking:Analyzing. Still analyzing.', 'user:pending']);
  await post({ type: 'cycle_model' });
  await wait(['user', 'thinking:Analyzing. Still analyzing.', 'tool', 'user:pending']);
  await post({ type: 'cycle_model' });
  await wait(['user', 'thinking:Analyzing. Still analyzing.', 'tool', 'user', 'thinking:Following the steer.']);
});

test('a stopped run\'s late prompt_result does not pause the next prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-abort-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // Like OMP: prompt_result is keyed by the prompt's id and can land after the abort reply and the next prompt.
  let first;
  const omp = fakeOmp({
    prompt(c) {
      after(() => { this.emit({ type: 'agent_start' }); if (first) this.emit({ type: 'prompt_result', id: first, status: 'aborted' }); else first = c.id; });
      return {};
    },
    state: () => ({ todoPhases: [] }),
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const post = body => fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  await post({ type: 'prompt', message: 'Work' });
  assert.equal((await post({ type: 'abort' })).status, 'paused');
  await post({ type: 'prompt', message: 'Continue' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(app.store.sessions[0].status, 'running');
});

// Header-only PNG claiming 1568×1568 pixels: ≈1,534 estimated tokens each.
const big = (() => { const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(b); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(1568, 16); b.writeUInt32BE(1568, 20); return { type: 'image', mimeType: 'image/png', data: b.toString('base64') }; })();

test('queued follow-ups that only fit the context one at a time are sent separately; one that no longer fits stays queued', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-queue-ctx-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // Each session runs in its own folder; releasing it completes its current turn, after which every prompt completes at once.
  const logs = new Map(), releases = new Set();
  const omp = fakeOmp(session => {
    let released = false;
    const id = session.cwd.split(/[\\/]/).at(-1);
    return {
      prompt(c) {
        if (!logs.has(id)) logs.set(id, []);
        logs.get(id).push({ message: c.message, images: c.images?.length || 0 });
        if (released) after(() => { this.emit({ type: 'agent_start' }); this.emit({ type: 'prompt_result', status: 'completed', sessionSettled: false }); this.emit({ type: 'session_settled' }); });
        return {};
      },
      state() {
        if (!released && releases.has(id)) {
          released = true;
          this.emit({ type: 'prompt_result', status: 'completed', sessionSettled: true });
          this.emit({ type: 'session_settled' });
        }
        return { todoPhases: [] };
      },
    };
  });
  const at = new Date().toISOString();
  // 4,000 tokens left: two big images (≈3,068) fit, four (≈6,136) don't.
  const session = id => ({ id, projectId: id, title: id, status: 'paused', cwd: join(dir, id), model: 'OMP default', native: false, contextWindow: 5000, contextTokens: 1000, prefs: { followUpMode: 'all' }, messages: [], todos: [], createdAt: at, updatedAt: at });
  for (const id of ['split', 'stuck']) await mkdir(join(dir, id));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: ['split', 'stuck'].map(id => ({ id, path: join(dir, id), name: id })), sessions: [session('split'), session('stuck')], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const post = async (id, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${id}/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const sent = async id => logs.get(id) || [];
  const settle = async (id, done) => {
    releases.add(id);
    assert.equal((await post(id, { type: 'set_model', model: 'test/model' }))[0], 200);
    for (let i = 0; i < 80 && !await done(); i++) await new Promise(r => setTimeout(r, 25));
  };

  // "Send all together": each follow-up fits on its own, both together don't, so they go out as two prompts.
  await post('split', { type: 'prompt', message: 'Work' });
  assert.equal((await post('split', { type: 'follow_up', message: 'First', images: [big, big] }))[1].queuedMessages.length, 1);
  assert.equal((await post('split', { type: 'follow_up', message: 'Second', images: [big, big] }))[1].queuedMessages.length, 2);
  const split = app.store.sessions.find(s => s.id === 'split');
  await settle('split', async () => !split.queuedMessages.length && split.status === 'review');
  assert.deepEqual(await sent('split'), [{ message: 'Work', images: 0 }, { message: 'First', images: 2 }, { message: 'Second', images: 2 }]);

  // The context filled up while the follow-up waited: it, and the one behind it, stay queued with their images.
  await post('stuck', { type: 'prompt', message: 'Work' });
  await post('stuck', { type: 'follow_up', message: 'Too big now', images: [big] });
  await post('stuck', { type: 'follow_up', message: 'Behind it' });
  const stuck = app.store.sessions.find(s => s.id === 'stuck');
  const queuedId = stuck.queuedMessages[0].id;
  stuck.contextTokens = 4500;
  await settle('stuck', async () => stuck.status !== 'running');
  assert.deepEqual(await sent('stuck'), [{ message: 'Work', images: 0 }]);
  assert.notEqual(stuck.status, 'running');
  assert.deepEqual(stuck.queuedMessages.map(q => q.text), ['Too big now', 'Behind it']);
  await access(join(dir, 'queued-images', queuedId + '.json'));
  assert.ok(stuck.messages.some(m => m.role === 'system' && /next queued message was not sent.*Not enough context left/.test(m.text)));
  assert.ok(!stuck.messages.some(m => m.text === 'Too big now'));
});
