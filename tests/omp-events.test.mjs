import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('protocol v2 chunks, extension UI, retries, shell commands and branching reach the dashboard state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-events-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const branched = join(dir, 'branched.jsonl');
  await writeFile(branched, JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: 'first question' } }) + '\n'
    + JSON.stringify({ type: 'message', id: 'b1', message: { role: 'bashExecution', command: 'ls', output: 'a.txt', exitCode: 0 } }) + '\n');
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
let v2 = false, file = ${JSON.stringify(join(dir, 'original.jsonl'))}, bashDone;
// Frames above 64 bytes go out as rpc_chunk sequences once v2 is negotiated.
const emit = frame => {
  const bytes = Buffer.from(JSON.stringify(frame));
  if (!v2 || bytes.length < 64) return out(frame);
  const size = Math.ceil(bytes.length / 3), chunkId = 'c' + Math.random();
  for (let i = 0; i < 3; i++) out({ type: 'rpc_chunk', chunkId, index: i, count: 3, byteLength: bytes.length, data: bytes.subarray(i * size, (i + 1) * size).toString('base64') });
};
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
const reply = (c, data) => emit({ type: 'response', id: c.id, command: c.type, success: true, data });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'negotiate_protocol') { out({ type: 'response', id: c.id, command: c.type, success: true, data: { protocolVersion: 2 } }); v2 = true; emit({ type: 'available_commands_update', commands: [{ name: 'review', description: 'Review changes', source: 'builtin' }] }); continue; }
  if (c.type === 'get_state') reply(c, { todoPhases: [], sessionFile: file, fastModeEnabled: true, fastModeActive: true, steeringMode: 'all', interruptMode: 'wait', autoCompactionEnabled: false });
  else if (c.type === 'get_subagents') reply(c, { subagents: [] });
  else if (c.type === 'prompt') {
    reply(c, { agentInvoked: true });
    emit({ type: 'agent_start' });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(5000) } });
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'make' } });
    emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'building…' }] } });
    emit({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Hook says hi', notifyType: 'info' });
    emit({ type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'lint', statusText: 'lint ok' });
    emit({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'plan', widgetLines: ['step 1'] });
    emit({ type: 'extension_ui_request', id: 'e1', method: 'set_editor_text', text: 'prefilled' });
    emit({ type: 'extension_ui_request', id: 'o1', method: 'open_url', url: 'https://example.com/auth?x=1' });
    emit({ type: 'extension_ui_request', id: 'o2', method: 'open_url', url: 'javascript:alert(1)' });
    emit({ type: 'extension_error', extensionPath: '/x/broken-ext.ts', event: 'tool_call', error: 'boom' });
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' });
  }
  else if (c.type === 'bash') bashDone = () => reply(c, { output: 'hello', exitCode: 0, cancelled: false });
  else if (c.type === 'abort_bash') { reply(c); bashDone?.(); }
  else if (c.type === 'get_branch_messages') reply(c, { messages: [{ entryId: 'u1', text: 'first question' }] });
  else if (c.type === 'branch') { file = ${JSON.stringify(branched)}; reply(c, { text: 'first question', cancelled: false }); }
  else if (c.type === 'set_fast_mode') out({ type: 'response', id: c.id, command: c.type, success: false, error: 'Fast mode is unavailable for the current model.' });
  else reply(c, {});
}
`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const command = body => request('/sessions/session/command', body);
  const s = app.store.sessions[0];
  const until = async (check, what) => { for (let n = 0; n < 120; n++) { if (check()) return; await new Promise(r => setTimeout(r, 25)); } assert.fail(`Timed out waiting for ${what}`); };

  assert.equal((await command({ type: 'prompt', message: 'go' }))[0], 200);
  await until(() => s._retry, 'retry state');
  assert.equal(s.messages.find(m => m.role === 'assistant')?.text.length, 5000, 'chunked frame reassembled');
  assert.equal(s.messages.find(m => m.id === 'tool-t1').tool.result, 'building…');
  assert.deepEqual(s._status, { lint: 'lint ok' });
  assert.deepEqual(s._widgets, { plan: ['step 1'] });
  assert.equal(s._editorText.text, 'prefilled');
  assert.equal(s._openUrl.url, 'https://example.com/auth?x=1', 'non-http links are ignored');
  assert.deepEqual(s._notices.map(n => n.level), ['info', 'error']);
  assert.ok(s.messages.some(m => m.role === 'system' && m.text.includes('broken-ext.ts') && m.text.includes('boom')));
  assert.ok(!s.messages.some(m => m.role === 'system' && m.text.includes('Hook says hi')), 'info notices stay out of the chat');
  assert.deepEqual(s.modes, { steering: 'all', interrupt: 'wait' });

  // A pref OMP rejects is reported and not remembered for restarts.
  const [bad, rejected] = await command({ type: 'pref', key: 'fast', value: true });
  assert.equal(bad, 400);
  assert.match(rejected.error, /unavailable/);
  assert.equal(s.prefs?.fast, undefined);
  assert.equal((await command({ type: 'pref', key: 'interruptMode', value: 'sideways' }))[0], 400);
  assert.equal((await command({ type: 'pref', key: 'autoRetry', value: false }))[0], 200);
  assert.equal(s.prefs.autoRetry, false);

  // Shell commands return immediately and can be stopped while they run.
  s.status = 'review';
  assert.equal((await command({ type: 'bash', command: 'sleep 100' }))[0], 200);
  assert.ok(s._bash);
  assert.equal((await command({ type: 'bash', command: 'ls' }))[0], 400, 'one shell command at a time');
  assert.equal((await command({ type: 'abort_bash' }))[0], 200);
  await until(() => !s._bash, 'shell command to finish');
  const shell = s.messages.find(m => m.tool?.user);
  assert.equal(shell.tool.status, 'done');
  assert.equal(shell.tool.result, 'hello');

  // Branching swaps in the new session file's transcript, including user shell commands.
  assert.deepEqual((await command({ type: 'branch_messages' }))[1].messages, [{ entryId: 'u1', text: 'first question' }]);
  const [, result] = await command({ type: 'branch', entryId: 'u1' });
  assert.equal(result.text, 'first question');
  assert.equal(s.sessionFile, branched);
  assert.deepEqual(s.messages.filter(m => m.role !== 'system').map(m => m.tool ? `$ ${m.tool.result}` : m.text), ['first question', '$ a.txt']);
});
