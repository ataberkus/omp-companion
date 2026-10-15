import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// A fake OMP that speaks the btw / subagent RPC like rpc-btw.ts: btw_record before the response, deltas after it.
const FAKE = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
const records = new Map();
let n = 0;
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify(c) + '\\n');
  let data = {};
  if (c.type === 'get_state') data = { model: { provider: 'test', id: 'test' }, todoPhases: [] };
  // Exits shortly after a cancel, so the test can check what happens once OMP is gone.
  if (c.type === 'cancel_subagent') { data = { cancelled: c.subagentId === 'Sub-1' }; setTimeout(() => process.exit(0), 300); }
  if (c.type === 'get_subagents') data = { subagents: [{ id: 'Sub-1', agent: 'task', description: 'Fix parser', status: 'running' }] };
  if (c.type === 'get_btw_history') data = { records: [...records.values()].reverse() };
  if (c.type === 'btw_cancel') data = { cancelled: false };
  if (c.type === 'btw') {
    const turn = { question: c.question, answer: '', status: 'running', createdAt: Date.now() };
    let r = c.recordId && records.get(c.recordId);
    if (r) r.followUps.push(turn); else { r = { id: 'btw-' + ++n, ...turn, followUps: [] }; records.set(r.id, r); }
    emit({ type: 'btw_record', record: r });
    emit({ type: 'response', id: c.id, command: c.type, success: true, data: { record: r } });
    const t = r.followUps.at(-1) || r;
    emit({ type: 'btw_delta', recordId: r.id, delta: 'Answer to ' });
    t.answer = 'Answer to ' + c.question; t.status = 'complete';
    emit({ type: 'btw_record', record: r });
    continue;
  }
  emit({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-btw-'));
  const log = join(dir, 'rpc.log');
  let app;
  t.after(async () => { if (app) await app.close(); delete process.env.FAKE_LOG; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'omp.mjs'), FAKE);
  await writeFile(log, '');
  process.env.FAKE_LOG = log;
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Side', cwd: dir, status: 'review', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [join(dir, 'omp.mjs')] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const command = body => call('/sessions/session/command', body);
  const sent = async type => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.type === type);
  return { app: () => app, call, command, sent };
}

const until = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}`); };

test('/btw typed in the composer becomes a side question: streamed answer, follow-ups, history, never a transcript message', async t => {
  const { app, call, command, sent } = await setup(t);
  const s = app().store.sessions[0];

  const [status, first] = await command({ type: 'prompt', message: '/btw what does parse() return?' });
  assert.equal(status, 200);
  assert.equal(first.record.question, 'what does parse() return?');
  await until(() => s._btw?.[0]?.status === 'complete', 'the answer');
  assert.equal(s._btw[0].answer, 'Answer to what does parse() return?');
  assert.equal((await sent('prompt')).length, 0, 'nothing reached the conversation');
  assert.ok(!s.messages.some(m => m.role === 'user'));

  // A follow-up stays in the same topic.
  assert.equal((await command({ type: 'btw', question: 'and on error?', recordId: first.record.id }))[0], 200);
  await until(() => s._btw[0].followUps[0]?.status === 'complete', 'the follow-up answer');
  assert.equal(s._btw.length, 1);
  assert.equal(s._btw[0].followUps[0].answer, 'Answer to and on error?');

  // Only the viewed session carries answers in polls.
  const other = (await call('/state?session=nope'))[1].sessions[0];
  assert.equal(other._btw, undefined);
  assert.equal((await call('/state?session=session'))[1].sessions[0]._btw[0].id, first.record.id);

  s._btw = [];
  const [, hist] = await command({ type: 'btw_history' });
  assert.deepEqual(hist.records.map(r => r.id), [first.record.id]);

  assert.equal((await command({ type: 'steer', message: '/btw', images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }))[0], 400, 'images are refused');
  assert.equal((await command({ type: 'btw', question: '' }))[0], 400);
});

test('subagents of the session can be stopped and steered; other ids and a stopped OMP are refused', async t => {
  const { app, command, sent } = await setup(t);
  const s = app().store.sessions[0];

  assert.equal((await command({ type: 'subagent_cancel', id: 'Sub-1' }))[0], 404, 'unknown before OMP reported it');
  await command({ type: 'btw_history' }); // starts OMP, which reports its subagents on refresh
  await until(() => s.subagentList?.some(a => a.id === 'Sub-1'), 'the subagent list');

  const [, steered] = await command({ type: 'subagent_steer', id: 'Sub-1', message: 'Use the existing lexer.' });
  assert.deepEqual(steered, { steered: true });
  assert.deepEqual((await sent('steer_subagent')).map(c => [c.subagentId, c.message]), [['Sub-1', 'Use the existing lexer.']]);
  assert.equal((await command({ type: 'subagent_steer', id: 'Sub-1', message: '' }))[0], 400);

  assert.deepEqual((await command({ type: 'subagent_cancel', id: 'Sub-1' }))[1], { cancelled: true });
  assert.equal((await command({ type: 'subagent_cancel', id: 'Other' }))[0], 404);
  assert.equal((await sent('cancel_subagent')).length, 1);

  // OMP exited: the subagent is still listed, but nothing can reach it.
  let last;
  for (let i = 0; i < 100 && last !== 409; i++) { [last] = await command({ type: 'subagent_steer', id: 'Sub-1', message: 'x' }); if (last !== 409) await new Promise(r => setTimeout(r, 20)); }
  assert.equal(last, 409);
});
