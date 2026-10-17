import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// Each prompt raises OMP's two approval dialogs (tool wrapper select, computer-control confirm) next to a provider
// safety check and an ordinary question; every reply OMP receives is echoed back as command output.
test('auto-approve answers only approval prompts, and approves waiting ones when turned on', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-auto-approve-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
let round = 0;
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'extension_ui_response') { emit({ type: 'command_output', text: 'reply ' + JSON.stringify(c) }); continue; }
  if (c.type === 'prompt' || c.type === 'steer') {
    round++;
    emit({ type: 'extension_ui_request', id: 'control' + round, method: 'confirm', title: 'Allow foreground computer control?', message: 'Click Save in Notepad' });
    emit({ type: 'extension_ui_request', id: 'tool' + round, method: 'select', title: 'Allow tool: bash\\nCommand: npm test', options: ['Approve', 'Deny'] });
    emit({ type: 'extension_ui_request', id: 'safety' + round, method: 'select', title: 'Allow tool: computer\\nProvider safety checks:\\n1. Sensitive site', options: ['Approve', 'Deny'] });
    emit({ type: 'extension_ui_request', id: 'question' + round, method: 'confirm', title: 'Drop goal?', message: 'This removes the goal record.' });
  }
  if (c.type === 'get_state') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { todoPhases: [], model: { provider: 'test', id: 'test' } } });
  else if (c.type === 'get_subagents') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { subagents: [] } });
  else emit({ type: 'response', id: c.id, success: true, command: c.type, data: c.type === 'prompt' ? { agentInvoked: true } : {} });
}
`);
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Auto', cwd: dir, status: 'paused', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const command = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  const session = app.store.sessions[0];
  const replies = () => session.messages.filter(m => m.text.startsWith('reply ')).map(m => JSON.parse(m.text.slice(6)));
  const pendingIds = () => (session.uiRequests || []).map(q => q.id).sort();
  const until = async (check, what) => {
    for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail(`Timed out waiting for ${what}`);
  };
  // Every approval request that reaches uiRequests is recorded, so "never queued" is checked across the whole run.
  const queued = new Set();
  const watch = setInterval(() => { for (const q of session.uiRequests || []) queued.add(q.id); }, 1);
  t.after(() => clearInterval(watch));

  assert.equal((await command({ type: 'auto_approve', enabled: 'yes' }))[0], 400);
  assert.equal((await command({ type: 'auto_approve', enabled: true }))[0], 200);
  assert.equal((await command({ type: 'prompt', message: 'Round one' }))[0], 200);
  await until(() => pendingIds().length === 2 && replies().length === 2, 'round one');
  assert.deepEqual(replies().sort((a, b) => a.id.localeCompare(b.id)), [
    { type: 'extension_ui_response', id: 'control1', confirmed: true },
    { type: 'extension_ui_response', id: 'tool1', value: 'Approve' },
  ]);
  assert.deepEqual(pendingIds(), ['question1', 'safety1']);
  assert.ok(!queued.has('control1') && !queued.has('tool1'));
  const approved = session.messages.filter(m => m.role === 'system' && m.text.startsWith('Auto-approved: ')).map(m => m.text);
  assert.deepEqual(approved.sort(), ['Auto-approved: Allow foreground computer control?\nClick Save in Notepad', 'Auto-approved: Allow tool: bash\nCommand: npm test']);
  await app.flush();
  assert.equal(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')).sessions[0].autoApprove, true);

  // Off: approval prompts wait for the user like any other question.
  assert.equal((await command({ type: 'auto_approve', enabled: false }))[0], 200);
  for (const id of ['question1', 'safety1']) assert.equal((await command({ type: 'answer', id, cancelled: true }))[0], 200);
  assert.equal((await command({ type: 'steer', message: 'Round two' }))[0], 200);
  await until(() => pendingIds().length === 4, 'round two prompts');
  assert.deepEqual(pendingIds(), ['control2', 'question2', 'safety2', 'tool2']);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!replies().some(r => r.id.endsWith('2')), 'nothing answered round two while off');

  // On again: the waiting approval prompts are answered; the question and the safety check stay.
  assert.equal((await command({ type: 'auto_approve', enabled: true }))[0], 200);
  assert.deepEqual(pendingIds(), ['question2', 'safety2']);
  await until(() => replies().some(r => r.id === 'tool2') && replies().some(r => r.id === 'control2'), 'round two approvals');
  assert.deepEqual(replies().filter(r => r.id.endsWith('2')).sort((a, b) => a.id.localeCompare(b.id)), [
    { type: 'extension_ui_response', id: 'control2', confirmed: true },
    { type: 'extension_ui_response', id: 'tool2', value: 'Approve' },
  ]);
});

// The New session form's Auto-approve checkbox: the session starts with it on, so the first turn's approval is answered.
test('quick-start with autoApprove answers approval prompts from the first turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-auto-start-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'extension_ui_response') { emit({ type: 'command_output', text: 'reply ' + JSON.stringify(c) }); continue; }
  if (c.type === 'prompt') emit({ type: 'extension_ui_request', id: 'tool', method: 'select', title: 'Allow tool: bash\\nCommand: npm test', options: ['Approve', 'Deny'] });
  if (c.type === 'get_state') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { todoPhases: [], model: { provider: 'test', id: 'test' } } });
  else if (c.type === 'get_subagents') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { subagents: [] } });
  else emit({ type: 'response', id: c.id, success: true, command: c.type, data: c.type === 'prompt' ? { agentInvoked: true } : {} });
}
`);
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const start = async body => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/quick-start`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, ...body }) });
    return [res.status, await res.json()];
  };

  assert.equal((await start({ prompt: 'Run the tests', autoApprove: 'yes' }))[0], 400);
  assert.equal(app.store.sessions.length, 0, 'an invalid flag creates no session');

  const [status, created] = await start({ prompt: 'Run the tests', autoApprove: true });
  assert.equal(status, 201);
  assert.equal(created.autoApprove, true);
  const session = app.store.sessions.find(s => s.id === created.id);
  for (let n = 0; n < 200 && !session.messages.some(m => m.text.startsWith('reply ')); n++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(session.messages.filter(m => m.text.startsWith('reply ')).map(m => JSON.parse(m.text.slice(6))), [{ type: 'extension_ui_response', id: 'tool', value: 'Approve' }]);
  assert.deepEqual(session.uiRequests || [], []);
  assert.ok(session.messages.some(m => m.text === 'Auto-approved: Allow tool: bash\nCommand: npm test'));

  // Unchecked: the session starts without auto-approve and the same prompt waits for the user.
  const [, manual] = await start({ prompt: 'Run the tests', autoApprove: false });
  assert.equal(manual.autoApprove, undefined);
  const other = app.store.sessions.find(s => s.id === manual.id);
  for (let n = 0; n < 200 && !other.uiRequests?.length; n++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(other.uiRequests.map(q => q.id), ['tool']);
});
