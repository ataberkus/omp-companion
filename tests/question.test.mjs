import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('interactive questions accept valid answers, reject stale choices, and cancel safely', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-question-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({
    answer(id, c) {
      if (id === 'choice' && c.value === 'Second') this.emit({ type: 'extension_ui_request', id: 'reason', method: 'input', title: 'Why?', placeholder: 'Your reason' });
      else if (id === 'reason' && c.value === 'Because' && !('confirmed' in c)) this.emit({ type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Confirm', message: 'Proceed?' });
      else if (id === 'confirm' && c.confirmed === false) this.emit({ type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'Notes', prefill: 'Draft' });
      else if (id === 'editor' && c.cancelled === true) this.emit({ type: 'command_output', text: 'Question cancelled' });
      else this.emit({ type: 'command_output', text: 'Invalid reply reached OMP' });
    },
    prompt() {
      this.emit({ type: 'extension_ui_request', id: 'choice', method: 'select', title: 'Choose', options: ['First', 'Second'], optionDetails: [{ description: 'A' }, { description: 'B' }], checkedIndices: [1, 5] });
      return { agentInvoked: true };
    },
    state: () => ({ todoPhases: [], model: { provider: 'test', id: 'test' } }),
  });
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
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

test('ask dialogs reach the panel and only well-formed answers reach OMP', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-ask-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp({
    answer(id, c) { this.emit({ type: 'command_output', text: 'ANSWERS ' + JSON.stringify(c.answers) }); },
    prompt() {
      this.emit({ type: 'extension_ui_request', id: 'ask', method: 'ask', questions: [
        { id: 'langs', question: 'Which languages?', header: 'Lang', options: [{ label: 'Alpha', description: 'first' }, { label: 'Beta' }, { label: 'Gamma' }], multi: true },
        { id: 'db', question: 'Database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], recommended: 1 },
      ] });
      return { agentInvoked: true };
    },
    state: () => ({ todoPhases: [], model: { provider: 'test', id: 'test' } }),
  });
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const answer = answers => request('/sessions/session/command', { type: 'answer', id: 'ask', answers });
  assert.equal((await request('/sessions/session/command', { type: 'prompt', message: 'Ask me' }))[0], 200);
  let q;
  for (let n = 0; n < 80 && !q; n++) { q = (await request('/state'))[1].sessions[0].uiRequests?.find(x => x.id === 'ask'); if (!q) await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(q, 'ask dialog was not shown');
  assert.equal(q.method, 'ask');
  assert.deepEqual(q.questions.map(x => [x.id, x.multi, x.recommended]), [['langs', true, undefined], ['db', false, 1]]);
  assert.equal(q.questions[0].options[0].description, 'first');
  const langs = { id: 'langs', selectedOptions: ['Alpha', 'Gamma'] };
  for (const bad of [
    [langs],
    [langs, { id: 'db', selectedOptions: [] }],
    [langs, { id: 'db', selectedOptions: ['MySQL'] }],
    [langs, { id: 'db', selectedOptions: ['SQLite', 'Postgres'] }],
    [langs, { id: 'db', selectedOptions: ['SQLite'], customInput: 'Redis' }],
    [{ id: 'langs', selectedOptions: ['Alpha', 'Alpha'] }, { id: 'db', selectedOptions: ['SQLite'] }],
    [{ id: 'db', selectedOptions: ['SQLite'] }, langs],
  ]) assert.equal((await answer(bad))[0], 400, JSON.stringify(bad));
  assert.equal((await answer([{ ...langs, customInput: '  Delta ' }, { id: 'db', selectedOptions: [], customInput: 'Redis' }]))[0], 200);
  assert.deepEqual((await request('/state'))[1].sessions[0].uiRequests, []);
  const sent = () => app.store.sessions[0].messages.find(m => m.text?.startsWith('ANSWERS '));
  for (let n = 0; n < 80 && !sent(); n++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(JSON.parse(sent().text.slice(8)), [{ id: 'langs', selectedOptions: ['Alpha', 'Gamma'], customInput: 'Delta' }, { id: 'db', selectedOptions: [], customInput: 'Redis' }]);
  assert.equal(app.store.sessions[0].messages.filter(m => m.text?.startsWith('ANSWERS ')).length, 1);
});
