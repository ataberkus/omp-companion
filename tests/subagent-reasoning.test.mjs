import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
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

test('background gives running and task-linked subagents the model and level from their own transcripts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-subagent-live-level-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const sessions = join(dir, 'sessions'), parent = join(sessions, 'project', 'parent.jsonl'), sub = join(sessions, 'project', 'parent');
  await mkdir(sub, { recursive: true });
  const at = new Date().toISOString();
  const lines = (...f) => [{ type: 'session', id: 'x', cwd: dir, timestamp: at }, ...f].map(x => JSON.stringify(x)).join('\n') + '\n';
  const init = model => ({ type: 'session_init', resolvedModel: model });
  const reply = effort => ({ type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-5-5', content: [], ...(effort ? { requestControls: { effort: { topLevel: effort, tail: effort } } } : {}) } });
  await writeFile(parent, lines());
  await writeFile(join(sub, 'Spawned.jsonl'), lines(init('anthropic/claude-sonnet-5-5:auto'), { type: 'message', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', content: [], requestControls: { effort: { topLevel: 'low' } } } }));
  await writeFile(join(sub, 'Scout.jsonl'), lines({ type: 'model_change', model: 'anthropic/claude-opus-5-5' }, init('anthropic/claude-opus-5-5:auto'), reply('high')));
  await writeFile(join(sub, 'Fresh.jsonl'), lines({ type: 'model_change', model: 'anthropic/claude-opus-5-5' }, init('anthropic/claude-opus-5-5:auto')));
  const entry = id => ({ id, agent: 'scout', status: 'running', description: 'Audit ' + id, sessionFile: join(sub, id + '.jsonl'), progress: { id, status: 'running' } });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  out({ type: 'response', id: c.id, command: c.type, success: true, data: c.type === 'get_state' ? { sessionFile: ${JSON.stringify(parent)}, todoPhases: [] } : c.type === 'get_subagents' ? { subagents: ${JSON.stringify([entry('Scout'), entry('Fresh')])} } : {} });
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
  await request('/sessions/s/command', { type: 'prompt', message: 'go' });
  // An async `task` spawn by the running OMP process that the parent transcript has not seen finish.
  const now = new Date().toISOString();
  await writeFile(parent, lines(
    { type: 'message', timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'task', arguments: { tasks: [{ name: 'Spawned', task: 'Write Spawned' }] } }] } },
    { type: 'message', timestamp: now, message: { role: 'toolResult', toolCallId: 'c1', toolName: 'task', details: { results: [], progress: [{ index: 0, id: 'Spawned', agent: 'task', status: 'pending' }], async: { state: 'running', jobId: 'Spawned', type: 'task' } } } }));
  const bg = await request('/background?file=' + encodeURIComponent(parent));
  assert.deepEqual(bg.agents.map(a => [a.id, a.model, a.thinkingLevel]), [['Scout', 'anthropic/claude-opus-5-5', 'high'], ['Fresh', 'anthropic/claude-opus-5-5', '']]);
  assert.deepEqual(bg.tasks.map(j => [j.id, j.status, j.model, j.thinking]), [['Spawned', 'running', 'anthropic/claude-sonnet-5-5', 'low']]);
  assert.deepEqual(bg.subagents, [], 'linked transcripts are not listed again as finished subagents');
});

// Shapes copied from a real OMP transcript: async `task` spawn, then `wait` snapshots keyed by task name.
test('background marks async subagents finished when the transcript completes them or their OMP process is gone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-subagent-jobs-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const sessions = join(dir, 'sessions'), parent = join(sessions, 'project', 'parent.jsonl');
  await mkdir(join(sessions, 'project'), { recursive: true });
  const at = ms => new Date(ms).toISOString();
  const spawn = (call, name, ms) => [
    { type: 'message', timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'toolCall', id: call, name: 'task', arguments: { i: 'Authoring tasks', tasks: [{ name, task: 'Write ' + name }] } }] } },
    { type: 'message', timestamp: at(ms + 1), message: { role: 'toolResult', toolCallId: call, toolName: 'task', details: { results: [], totalDurationMs: 1, progress: [{ index: 0, id: name, agent: 'task', status: 'pending' }], async: { state: 'running', jobId: name, type: 'task' } } } }];
  const snapshot = (call, ms, jobs) => ({ type: 'message', timestamp: at(ms), message: { role: 'toolResult', toolCallId: call, toolName: 'wait', details: { op: 'wait', jobs: jobs.map(([id, status]) => ({ id, type: 'task', status, label: id, durationMs: 1000 })) } } });
  const t0 = Date.now() - 3 * 3600e3;
  // Killed: its OMP process exited before reporting back, so no completion is ever recorded.
  const lines = [{ type: 'session', id: 'parent', cwd: dir, timestamp: at(t0) }, ...spawn('c1', 'Killed', t0),
    ...spawn('c2', 'Finished', t0 + 60e3), snapshot('w1', t0 + 70e3, [['Finished', 'running']]), snapshot('w2', t0 + 80e3, [['Finished', 'completed']])];
  const write = list => writeFile(parent, list.map(x => JSON.stringify(x)).join('\n') + '\n');
  await write(lines);
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  out({ type: 'response', id: c.id, command: c.type, success: true, data: c.type === 'get_state' ? { sessionFile: ${JSON.stringify(parent)}, todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : {} });
}
`);
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'Project' }], sessions: [{ id: 's', projectId: 'p', title: 'Parent', status: 'paused', cwd: dir, sessionFile: parent, messages: [], todos: [], createdAt: at(t0), updatedAt: at(t0) }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: sessions, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.status, 200);
    return res.json();
  };
  await request('/sessions/s/command', { type: 'prompt', message: 'cont' });
  // The resumed OMP process spawns a new subagent that is still working.
  await write([...lines, ...spawn('c3', 'Working', Date.now())]);
  const bg = await request('/background?file=' + encodeURIComponent(parent));
  assert.equal(bg.live, true);
  const status = Object.fromEntries(bg.tasks.map(j => [j.id, j.status]));
  assert.deepEqual(status, { Killed: 'stale', Finished: 'done', Working: 'running' });
  assert.ok(bg.tasks.find(j => j.id === 'Finished').finishedAt, 'a finished job stops its timer');
  // OMP exits (crash, stop): its jobs die with it, although the transcript was just written.
  process.kill(Number(await readFile(join(dir, 'pid'), 'utf8')));
  let stopped;
  for (let i = 0; i < 50 && (stopped = await request('/background?file=' + encodeURIComponent(parent))).live; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(stopped.live, false);
  assert.deepEqual(Object.fromEntries(stopped.tasks.map(j => [j.id, j.status])), { Killed: 'stale', Finished: 'done', Working: 'stale' });
});
