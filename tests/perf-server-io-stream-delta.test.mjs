import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { createMessages } from '../companion/messages.mjs';
import { fakeOmp } from './fake-omp.mjs';

// Streamed thinking/text deltas look their message up from the end of the transcript (runner.mjs streamDelta). Each
// scenario runs the same deltas through the companion and through the front-to-back lookup it replaced, applied with the
// real append() and the same message ids, and the transcripts must match.
const { append } = createMessages({ options: {}, store: { activity: [] }, scheduleSave() {} });
const before = (s, role, id, delta) => { const m = s.messages.find(m => m.id === id); append(s, role, (m?.text || '') + delta, id); };
const KEYS = { thinking_delta: ['thinking', '_thinkId'], text_delta: ['assistant', '_streamId'] };
const view = messages => messages.map(({ at, ...m }) => m);
const mu = (type, delta) => ({ type: 'message_update', assistantMessageEvent: { type, delta } });
const many = (k, f) => Array.from({ length: k }, (_, i) => f(i));
const filler = k => many(k, i => ({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(i % 50), at: '2026-01-01T00:00:00.000Z' }));

async function companion(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-stream-delta-'));
  let fake;
  const omp = fakeOmp(f => { fake = f; return { prompt: () => ({ agentInvoked: true }), state: () => ({ isSettled: false, isStreaming: true }) }; });
  const at = '2026-01-01T00:00:00.000Z';
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'P' }], sessions: [{ id: 's', projectId: 'p', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/s/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'go' }) });
  assert.equal(res.status, 200);
  return { app, fake, s: app.store.sessions.find(x => x.id === 's') };
}

const scenarios = {
  basic: [null, [...many(30, i => mu('thinking_delta', 'th' + i)), ...many(30, i => mu('text_delta', 'tx' + i))]],
  'empty and undefined deltas': [null, [mu('thinking_delta', ''), mu('thinking_delta', undefined), mu('text_delta', ''), mu('text_delta', 'a'), mu('text_delta', ''), mu('text_delta', undefined), mu('thinking_delta', 'b')]],
  'the 600-message cap, thinking and text interleaved': [s => { s.messages = filler(600); }, many(50, i => mu(i % 3 ? 'text_delta' : 'thinking_delta', 'd' + i))],
  'unread steers stay last': [s => { s.messages = [...filler(10), { id: 'st1', role: 'user', text: 'steer', steer: 'pending', at: 'x' }, { id: 'st2', role: 'user', text: 'steer2', steer: 'received', at: 'x' }]; }, many(20, i => mu(i % 2 ? 'text_delta' : 'thinking_delta', 'd' + i))],
  'text past 100K characters': [null, many(30, i => mu('text_delta', String.fromCharCode(97 + i % 26).repeat(5000)))],
  'the streamed message trimmed away by the cap': [s => { s.messages = filler(599); }, [mu('text_delta', 'first'), s => { s.messages = [...s.messages, ...filler(5).map((m, i) => ({ ...m, id: 'push' + i }))].slice(-600); }, ...many(5, i => mu('text_delta', 'more' + i))]],
};

for (const [name, [prep, frames]] of Object.entries(scenarios)) test(`streamed deltas: ${name}`, async t => {
  const { fake, s } = await companion(t);
  fake.emit({ type: 'agent_start' });
  prep?.(s);
  const ref = { messages: structuredClone(s.messages) };
  for (const f of frames) {
    if (typeof f === 'function') { f(s); f(ref); continue; }
    fake.emit(f);
    const [role, key] = KEYS[f.assistantMessageEvent.type];
    before(ref, role, s[key], f.assistantMessageEvent.delta);
  }
  assert.deepEqual(view(s.messages), view(ref.messages));
});

// Stored histories repeat provider tool-call ids (entryMessages keeps every one): a live call's start, progress and end
// must all land on the message append() picked, the first with that id, or the live one would stay running.
test('tool frames with a repeated tool-call id all update the same message', async t => {
  const { fake, s } = await companion(t);
  const rec = n => ({ id: 'tool-call_0', role: 'tool', text: 'Done · bash  ' + n, tool: { name: 'bash', intent: n, args: '{}', status: 'done', result: 'old ' + n }, at: 'x' });
  fake.emit({ type: 'agent_start' });
  s.messages = [rec('turn1'), { id: 'a', role: 'assistant', text: 'x', at: 'x' }, rec('turn2'), { id: 'b', role: 'assistant', text: 'y', at: 'x' }];
  fake.emit({ type: 'tool_execution_start', toolCallId: 'call_0', toolName: 'bash', args: { command: 'make' }, intent: 'turn3' });
  const live = s.messages.filter(m => m.role === 'tool').map(m => m.tool);
  assert.deepEqual(live.map(t => [t.intent, t.status]), [['turn3', 'running'], ['turn2', 'done']]);
  fake.emit({ type: 'tool_execution_update', toolCallId: 'call_0', partialResult: { content: [{ type: 'text', text: 'live output' }] } });
  assert.equal(live[0].result, 'live output');
  fake.emit({ type: 'tool_execution_end', toolCallId: 'call_0', toolName: 'bash', result: { content: [{ type: 'text', text: 'new result' }] }, isError: false });
  assert.deepEqual(s.messages.filter(m => m.role === 'tool').map(m => [m.tool.intent, m.tool.status, m.tool.result]), [['turn3', 'done', 'new result'], ['turn2', 'done', 'old turn2']]);
});
