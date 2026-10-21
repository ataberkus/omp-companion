import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// Fake OMP mirrors the real `/session pin` texts (slash-commands/builtin-session.ts); every pin is logged per session.
// Stored accounts are read from a file on each listing, so a test can log in another account between probes.
const ACCOUNTS = { anthropic: ['old@example.com', 'new@example.com (Work)'], google: ['solo@example.com'] };
const accountsOmp = (log, accountsFile) => fakeOmp(() => {
  let model = { provider: 'anthropic', id: 'claude' }, pinned;
  return {
    state: () => ({ todoPhases: [], model }),
    loginProviders: () => ({ providers: [{ id: 'anthropic', name: 'Anthropic', authenticated: true }, { id: 'google', name: 'Google', authenticated: true }, { id: 'openai', name: 'OpenAI', authenticated: false }] }),
    availableModels: () => ({ models: [{ provider: 'anthropic', id: 'claude' }, { provider: 'google', id: 'gemini' }] }),
    setModel(provider, modelId) { model = { provider, id: modelId }; return model; },
    prompt({ message }) {
      const out = text => this.emit({ type: 'command_output', text });
      if (message.startsWith('/session pin')) {
        const list = JSON.parse(readFileSync(accountsFile, 'utf8'))[model.provider], arg = message.slice('/session pin'.length).trim();
        if (!arg) out([`OAuth accounts for ${model.provider}:`, ...list.map((a, i) => `${i + 1}. ${a}${a === pinned ? ' (active)' : ''}`), '', 'Pin one with `/session pin <number|email|account id>`.'].join('\n'));
        else if (list.includes(arg)) { pinned = arg; appendFileSync(log, `${model.provider} ${arg}\n`); out(`Pinned ${arg} to this session for ${model.provider}.`); }
        else out(`No ${model.provider} account matches "${arg}".`);
      } else appendFileSync(log, `prompt ${message} as ${pinned}\n`);
      return { agentInvoked: false };
    },
  };
});

test('chosen provider account is listed, pinned before prompts, and kept across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-accounts-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'pins.log'), accountsFile = join(dir, 'accounts.json');
  await writeFile(log, '');
  await writeFile(accountsFile, JSON.stringify(ACCOUNTS));
  const omp = accountsOmp(log, accountsFile);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  let url;
  const launch = async () => {
    app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), omp });
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
  const accountsFile = join(dir, 'accounts.json');
  await writeFile(accountsFile, JSON.stringify(ACCOUNTS));
  const omp = accountsOmp(join(dir, 'pins.log'), accountsFile);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompSessionsDir: join(dir, 'native'), omp });
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
