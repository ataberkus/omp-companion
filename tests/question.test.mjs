import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('interactive questions accept valid answers, reject stale choices, and cancel safely', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-question-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
emit({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'extension_ui_response') {
    if (c.id === 'choice' && c.value === 'Second') emit({ type: 'extension_ui_request', id: 'reason', method: 'input', title: 'Why?', placeholder: 'Your reason' });
    else if (c.id === 'reason' && c.value === 'Because' && !('confirmed' in c)) emit({ type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Confirm', message: 'Proceed?' });
    else if (c.id === 'confirm' && c.confirmed === false) emit({ type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'Notes', prefill: 'Draft' });
    else if (c.id === 'editor' && c.cancelled === true) emit({ type: 'command_output', text: 'Question cancelled' });
    else emit({ type: 'command_output', text: 'Invalid reply reached OMP' });
    continue;
  }
  if (c.type === 'prompt') emit({ type: 'extension_ui_request', id: 'choice', method: 'select', title: 'Choose', options: ['First', 'Second'], optionDetails: [{ description: 'A' }, { description: 'B' }], checkedIndices: [1, 5] });
  if (c.type === 'get_state') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { todoPhases: [], model: { provider: 'test', id: 'test' } } });
  else if (c.type === 'get_subagents') emit({ type: 'response', id: c.id, success: true, command: c.type, data: { subagents: [] } });
  else emit({ type: 'response', id: c.id, success: true, command: c.type, data: c.type === 'prompt' ? { agentInvoked: true } : {} });
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
  const pending = async id => {
    for (let n = 0; n < 80; n++) {
      const [, state] = await request('/state');
      const q = state.sessions[0].uiRequests?.find(q => q.id === id);
      if (q) return q;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Question ${id} was not shown`);
  };
  const command = body => request('/sessions/session/command', body);
  const [start] = await command({ type: 'prompt', message: 'Ask me' });
  assert.equal(start, 200);
  const choice = await pending('choice');
  assert.deepEqual(choice.optionDetails, [{ description: 'A' }, { description: 'B' }]);
  assert.deepEqual(choice.checked, [1]);
  const [invalid] = await command({ type: 'answer', id: 'choice', value: 'Not an option' });
  assert.equal(invalid, 400);
  assert.equal((await pending('choice')).title, 'Choose');
  assert.equal((await command({ type: 'answer', id: 'choice', value: 'Second' }))[0], 200);
  assert.equal((await pending('reason')).placeholder, 'Your reason');
  assert.equal((await command({ type: 'answer', id: 'choice', value: 'First' }))[0], 400);
  assert.equal((await command({ type: 'answer', id: 'reason', value: 'Because' }))[0], 200);
  assert.equal((await pending('confirm')).message, 'Proceed?');
  assert.equal((await command({ type: 'answer', id: 'confirm', confirmed: false }))[0], 200);
  assert.equal((await pending('editor')).prefill, 'Draft');
  assert.equal((await command({ type: 'answer', id: 'editor', cancelled: true }))[0], 200);
  const [, state] = await request('/state');
  assert.deepEqual(state.sessions[0].uiRequests, []);
  for (let n = 0; n < 80 && !app.store.sessions[0].messages.some(m => m.text === 'Question cancelled'); n++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(app.store.sessions[0].messages.some(m => m.text === 'Question cancelled'));
  assert.ok(!app.store.sessions[0].messages.some(m => m.text === 'Invalid reply reached OMP'));
});
