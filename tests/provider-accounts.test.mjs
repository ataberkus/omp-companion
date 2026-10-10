import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// Fake OMP mirrors the real `/session pin` texts (slash-commands/builtin-session.ts); every pin is logged per process.
// Stored accounts are read from a file on each listing, so a test can log in another account between probes.
const ACCOUNTS = { anthropic: ['old@example.com', 'new@example.com (Work)'], google: ['solo@example.com'] };
const fakeOmp = (log, accountsFile) => `import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
let model = { provider: 'anthropic', id: 'claude' }, pinned;
const out = text => process.stdout.write(JSON.stringify({ type: 'command_output', text }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], model };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (c.type === 'get_login_providers') data = { providers: [{ id: 'anthropic', name: 'Anthropic', authenticated: true }, { id: 'google', name: 'Google', authenticated: true }, { id: 'openai', name: 'OpenAI', authenticated: false }] };
  if (c.type === 'get_available_models') data = { models: [{ provider: 'anthropic', id: 'claude' }, { provider: 'google', id: 'gemini' }] };
  if (c.type === 'set_model') { model = { provider: c.provider, id: c.modelId }; data = model; }
  if (c.type === 'prompt' && c.message.startsWith('/session pin')) {
    const list = JSON.parse(readFileSync(${JSON.stringify(accountsFile)}, 'utf8'))[model.provider], arg = c.message.slice('/session pin'.length).trim();
    if (!arg) out(['OAuth accounts for ' + model.provider + ':', ...list.map((a, i) => (i + 1) + '. ' + a + (a === pinned ? ' (active)' : '')), '', 'Pin one with \`/session pin <number|email|account id>\`.'].join('\\n'));
    else if (list.includes(arg)) { pinned = arg; appendFileSync(${JSON.stringify(log)}, model.provider + ' ' + arg + '\\n'); out('Pinned ' + arg + ' to this session for ' + model.provider + '.'); }
    else out('No ' + model.provider + ' account matches "' + arg + '".');
    data = { agentInvoked: false };
  } else if (c.type === 'prompt') {
    appendFileSync(${JSON.stringify(log)}, 'prompt ' + c.message + ' as ' + pinned + '\\n');
    data = { agentInvoked: false };
  }
  process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`;

test('chosen provider account is listed, pinned before prompts, and kept across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-accounts-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'pins.log'), fake = join(dir, 'omp.mjs'), accountsFile = join(dir, 'accounts.json');
  await writeFile(log, '');
  await writeFile(accountsFile, JSON.stringify(ACCOUNTS));
  await writeFile(fake, fakeOmp(log, accountsFile));
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  let url;
  const launch = async () => {
    app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: [fake] });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    url = `http://127.0.0.1:${app.server.address().port}/api`;
  };
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const pins = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  await launch();

  // Without a choice OMP keeps routing on its own: no pin is sent.
  await request('/sessions/session/command', { type: 'prompt', message: 'first' });
  assert.deepEqual(await pins(), ['prompt first as undefined']);

  const [listCode, listed] = await request('/accounts');
  assert.equal(listCode, 200);
  assert.deepEqual(listed.providers, [
    { id: 'anthropic', name: 'Anthropic', accounts: ['old@example.com', 'new@example.com (Work)'], selected: null },
    { id: 'google', name: 'Google', accounts: ['solo@example.com'], selected: null },
  ]);
  assert.equal((await request('/accounts', { provider: 'anthropic', account: 'a\nb' }))[0], 400);

  const [chooseCode] = await request('/accounts', { provider: 'anthropic', account: 'old@example.com' });
  assert.equal(chooseCode, 200);
  const [, after] = await request('/sessions/session/command', { type: 'prompt', message: 'second' });
  await request('/sessions/session/command', { type: 'prompt', message: 'third' });
  assert.deepEqual((await pins()).slice(1), ['anthropic old@example.com', 'prompt second as old@example.com', 'prompt third as old@example.com']);
  assert.ok(!after.messages.some(m => /Pinned|OAuth accounts/.test(m.text)), 'pin output stays out of the chat');
  assert.equal((await request('/accounts'))[1].providers[0].selected, 'old@example.com');

  // A changed choice re-pins the live session before its next message.
  await request('/accounts', { provider: 'anthropic', account: 'new@example.com (Work)' });
  await request('/sessions/session/command', { type: 'prompt', message: 'fourth' });
  assert.deepEqual((await pins()).slice(4), ['anthropic new@example.com (Work)', 'prompt fourth as new@example.com (Work)']);

  // Restart: the choice is read back from workspace.json and applied to the new OMP process.
  await app.close(); app = undefined;
  await launch();
  await request('/sessions/session/command', { type: 'prompt', message: 'fifth' });
  assert.deepEqual((await pins()).slice(6), ['anthropic new@example.com (Work)', 'prompt fifth as new@example.com (Work)']);

  // An account that is gone yields a warning instead of a silent fallback.
  await request('/accounts', { provider: 'anthropic', account: 'gone@example.com' });
  const [, warned] = await request('/sessions/session/command', { type: 'prompt', message: 'sixth' });
  assert.ok(warned.messages.some(m => m.role === 'system' && m.text.includes('Could not switch anthropic to gone@example.com: No anthropic account matches')));
});

test('account list is served from cache, refreshed in the background, and re-read after a login', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-accounts-cache-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs'), accountsFile = join(dir, 'accounts.json');
  await writeFile(accountsFile, JSON.stringify(ACCOUNTS));
  await writeFile(fake, fakeOmp(join(dir, 'pins.log'), accountsFile));
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return [res.status, await res.json()];
  };
  const anthropic = async () => (await request('/accounts'))[1].providers.find(p => p.id === 'anthropic').accounts;
  const added = [...ACCOUNTS.anthropic, 'third@example.com'];

  assert.deepEqual(await anthropic(), ACCOUNTS.anthropic);
  // An account added outside the companion (e.g. `omp login` in a terminal): the cached list answers at once,
  // and the background refresh that read started brings the new account into a later read.
  await writeFile(accountsFile, JSON.stringify({ ...ACCOUNTS, anthropic: added }));
  assert.deepEqual(await anthropic(), ACCOUNTS.anthropic);
  let seen;
  for (let i = 0; i < 100 && (seen = await anthropic()).length !== added.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(seen, added);

  // A login through the companion drops the cache, so the next read waits for a fresh list instead of showing the old one.
  const after = [...added, 'fourth@example.com'];
  await writeFile(accountsFile, JSON.stringify({ ...ACCOUNTS, anthropic: after }));
  await request('/sessions/session/command', { type: 'login', provider: 'anthropic' });
  for (let i = 0; i < 100 && !(await request('/state'))[1].sessions[0]._notices?.some(n => n.text === 'Logged in to anthropic.'); i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(await anthropic(), after);
});
