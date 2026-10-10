import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('subagent reasoning is visible before transcript saves and survives registry refresh without duplicate thoughts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-subagent-reasoning-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const sessions = join(dir, 'sessions'), parent = join(sessions, 'project', 'parent.jsonl');
  const child = join(sessions, 'project', 'parent', 'Child.jsonl');
  await mkdir(join(sessions, 'project', 'parent'), { recursive: true });
  const at = new Date().toISOString();
  const header = JSON.stringify({ type: 'session', id: 'parent', cwd: dir, timestamp: at }) + '\n';
  await writeFile(parent, header);
  await writeFile(child, header + JSON.stringify({ type: 'message', id: 'user', timestamp: at, message: { role: 'user', content: 'Find the cause' } }) + '\n');
  const old = new Date(Date.now() - 15 * 60 * 1000);
  await utimes(child, old, old);
  const thinking = ('Compare the ownership boundary before editing.\n' + 'Keep the stream separate from saved history. '.repeat(12)).trim();
  const next = 'Inspect the next turn without carrying the old partial thought.';
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
const file = ${JSON.stringify(child)};
let level = 'off', running = false, text = ${JSON.stringify(thinking)}, turn = 0, stamp = Date.now();
const meta = { id: 'Child', index: 0, agent: 'task', sessionFile: file, parentToolCallId: 'task1' };
const child = { ...meta, status: 'running', description: 'Find the cause', progress: { id: 'Child', status: 'running', lastIntent: 'Reading ownership code', toolCount: 3 } };
const message = () => ({ role: 'assistant', content: [{ type: 'thinking', thinking: text }], timestamp: stamp });
const emit = event => { if (level === 'events') out({ type: 'subagent_event', payload: { id: 'Child', event } }); };
const persist = () => appendFileSync(file, JSON.stringify({ type: 'message', id: 'saved-' + turn++, timestamp: new Date().toISOString(), message: message() }) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'set_subagent_subscription') level = c.level;
  if (c.type === 'get_state') data = { sessionFile: ${JSON.stringify(parent)}, todoPhases: [] };
  if (c.type === 'get_subagents') data = { subagents: running ? [child] : [] };
  if (c.type === 'prompt') {
    running = true;
    out({ type: 'agent_start' });
    out({ type: 'subagent_lifecycle', payload: { ...meta, status: 'started' } });
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: stamp } });
    emit({ type: 'message_update', message: message(), assistantMessageEvent: { type: 'thinking_delta', delta: text, contentIndex: 0 } });
  }
  if (c.type === 'steer' && c.message === 'persist') persist();
  if (c.type === 'steer' && c.message === 'end') emit({ type: 'message_end', message: message() });
  if (c.type === 'steer' && c.message === 'next') {
    text = ${JSON.stringify(next)}; stamp++;
    emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: stamp } });
    emit({ type: 'message_update', message: message(), assistantMessageEvent: { type: 'thinking_delta', delta: text, contentIndex: 0 } });
  }
  if (c.type === 'steer' && c.message === 'finish') {
    persist(); emit({ type: 'message_end', message: message() }); running = false;
    out({ type: 'subagent_lifecycle', payload: { ...meta, status: 'completed' } });
  }
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`);
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'Project' }], sessions: [{ id: 's', projectId: 'p', title: 'Parent', status: 'paused', cwd: dir, sessionFile: parent, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: sessions, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.status, 200);
    return res.json();
  };
  const command = body => request('/sessions/s/command', body);
  const transcript = () => request('/transcript?file=' + encodeURIComponent(child));
  const thoughts = data => data.messages.filter(m => m.role === 'thinking').map(m => m.text);

  await command({ type: 'prompt', message: 'go' });
  assert.equal((await request('/background?file=' + encodeURIComponent(parent))).agents[0].thinking, thinking);
  let live = await transcript();
  assert.deepEqual(thoughts(live), [thinking]);
  assert.equal(live.active, true, 'an old file remains active while reasoning streams');
  const liveId = live.messages.find(m => m.role === 'thinking').id;
  await command({ type: 'pref', key: 'autoRetry', value: false });
  live = await transcript();
  assert.deepEqual(thoughts(live), [thinking], 'registry snapshots do not discard the stream');
  assert.equal(live.messages.find(m => m.role === 'thinking').id, liveId);
  assert.ok(!app.store.sessions[0].messages.some(m => m.role === 'thinking'), 'child thoughts stay out of the parent chat');
  await command({ type: 'steer', message: 'persist' });
  assert.deepEqual(thoughts(await transcript()), [thinking], 'a saved snapshot is not duplicated before message_end arrives');
  await command({ type: 'steer', message: 'end' });
  assert.deepEqual(thoughts(await transcript()), [thinking], 'saved thought replaces its live version');
  await command({ type: 'steer', message: 'next' });
  assert.deepEqual(thoughts(await transcript()), [thinking, next]);
  await command({ type: 'steer', message: 'finish' });
  const finished = await transcript();
  assert.deepEqual(thoughts(finished), [thinking, next]);
  assert.equal(finished.active, false, 'completion does not leave a live thought or Active badge');
});

test('background reports the reasoning level each subagent last ran with, and none when unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-subagent-level-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const sessions = join(dir, 'sessions'), parent = join(sessions, 'project', 'parent.jsonl'), sub = join(sessions, 'project', 'parent');
  await mkdir(sub, { recursive: true });
  const at = new Date().toISOString();
  const lines = (...f) => [{ type: 'session', id: 'x', cwd: dir, timestamp: at }, ...f].map(x => JSON.stringify(x)).join('\n') + '\n';
  const init = model => ({ type: 'session_init', resolvedModel: model });
  const reply = effort => ({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5-5', content: [], ...(effort ? { requestControls: { effort: { topLevel: effort, tail: effort } } } : {}) } });
  await writeFile(parent, lines());
  await writeFile(join(sub, 'Auto.jsonl'), lines(init('anthropic/claude-opus-5-5:auto'), reply('high')));
  await writeFile(join(sub, 'Suffix.jsonl'), lines(init('anthropic/claude-sonnet-5-5:medium'), reply()));
  await writeFile(join(sub, 'Changed.jsonl'), lines(init('anthropic/claude-opus-5-5:low'), reply('low'), { type: 'thinking_level_change', thinkingLevel: 'xhigh' }));
  await writeFile(join(sub, 'Unknown.jsonl'), lines(init('anthropic/claude-opus-5-5:auto'), reply()));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: sessions, ompCommand: process.execPath, ompArgs: ['-e', ''] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/background?file=${encodeURIComponent(parent)}`, { headers: { Authorization: 'Bearer ' + app.token } });
  const levels = Object.fromEntries((await res.json()).subagents.map(x => [x.name, x.thinking]));
  assert.deepEqual(levels, { Auto: 'high', Suffix: 'medium', Changed: 'xhigh', Unknown: '' });
});
