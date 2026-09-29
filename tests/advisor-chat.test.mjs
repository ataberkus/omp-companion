import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('advisor controls and notes work in live and saved chat', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-advisor-chat-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
let advisorOn = true;
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], model: { provider: 'test', id: 'test' } };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (c.type === 'prompt' && c.message.startsWith('/advisor ')) {
    if (c.message !== '/advisor status') advisorOn = c.message === '/advisor on';
    // Real OMP replies: '/advisor on|off' -> 'Advisor enabled.' / 'Advisor disabled.'
    const text = c.message !== '/advisor status' ? (advisorOn ? 'Advisor enabled.' : 'Advisor disabled.') : advisorOn ? 'Advisor is enabled (test/advisor). Context: 1,000 / 10,000 tokens (10%). Spend: 5 input, 6 output, $0.0100.' : 'Advisor is disabled.';
    process.stdout.write(JSON.stringify({ type: 'command_output', text }) + '\\n');
    data = { agentInvoked: false };
  } else if (c.type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'custom', customType: 'advisor', display: true, content: '<advisory>Not this markup</advisory>', details: { notes: [{ note: 'Check <boundary>', severity: 'concern', advisor: 'Architecture' }, { note: 'Keep it simple', severity: 'nit' }] } } }) + '\\n');
    data = { agentInvoked: false };
  }
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  const nativeDir = join(dir, 'native');
  const nativeFile = join(nativeDir, 'project', 'history.jsonl');
  const artifacts = nativeFile.replace(/\.jsonl$/, '');
  await mkdir(artifacts, { recursive: true });
  const advice = { customType: 'advisor', display: true, content: '<advisory>Raw XML</advisory>', details: { notes: [{ note: 'Saved finding', severity: 'blocker', advisor: 'Security' }] } };
  await writeFile(nativeFile, [
    { type: 'session', cwd: dir, id: 'native-session', timestamp: now },
    { type: 'custom_message', id: 'shown', timestamp: now, ...advice },
    { type: 'custom_message', id: 'hidden', timestamp: now, ...advice, display: false },
  ].map(JSON.stringify).join('\n') + '\n');
  await writeFile(join(artifacts, '__advisor.security.jsonl'), [JSON.stringify({ type: 'session', cwd: dir, timestamp: now }), JSON.stringify({ type: 'message', timestamp: now, message: { role: 'user', attribution: 'agent', synthetic: true, content: '### Session update' } })].join('\n') + '\n');
  app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };

  const [bad] = await request('/sessions/session/command', { type: 'advisor', action: 'on; run code' });
  assert.equal(bad, 400);
  for (const action of ['on', 'status', 'off']) {
    const [code, session] = await request('/sessions/session/command', { type: 'advisor', action });
    assert.equal(code, 200);
    assert.equal(session.status, 'paused');
    // on/off replies land in chat as status lines; status is read silently into session.advisor for the composer chip.
    if (action !== 'status') assert.ok(session.messages.some(m => m.role === 'system' && m.text === (action === 'on' ? 'Advisor enabled.' : 'Advisor disabled.')));
    assert.ok(!session.messages.some(m => m.text?.startsWith('Advisor is enabled')));
    if (action === 'off') assert.deepEqual(session.advisor?.enabled, false);
    else assert.deepEqual({ enabled: session.advisor?.enabled, model: session.advisor?.model, contextTokens: session.advisor?.contextTokens, contextWindow: session.advisor?.contextWindow, cost: session.advisor?.cost }, { enabled: true, model: 'test/advisor', contextTokens: 1000, contextWindow: 10000, cost: 0.01 });
    assert.equal(session.messages.filter(m => m.role === 'user').length, 0);
  }
  const [promptCode, prompted] = await request('/sessions/session/command', { type: 'prompt', message: 'Review this' });
  assert.equal(promptCode, 200);
  assert.deepEqual(prompted.messages.find(m => m.role === 'advisor')?.notes, [{ note: 'Check <boundary>', severity: 'concern', advisor: 'Architecture' }, { note: 'Keep it simple', severity: 'nit' }]);
  await app.flush();
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.equal(saved.sessions[0].messages.find(m => m.role === 'advisor')?.notes[0].note, 'Check <boundary>');
  const [previewCode, preview] = await request('/omp-sessions/preview?file=' + encodeURIComponent(nativeFile));
  assert.equal(previewCode, 200);
  assert.deepEqual(preview.messages.filter(m => m.role === 'advisor').map(m => m.notes), [advice.details.notes]);
  const [bgCode, bg] = await request('/background?file=' + encodeURIComponent(nativeFile));
  assert.equal(bgCode, 200);
  assert.equal(bg.subagents.find(x => x.name === '__advisor.security')?.advisor, true);
  const [transcriptCode, transcript] = await request('/transcript?file=' + encodeURIComponent(join(artifacts, '__advisor.security.jsonl')));
  assert.equal(transcriptCode, 200);
  assert.equal(transcript.messages[0]?.role, 'advisor-update');
});
