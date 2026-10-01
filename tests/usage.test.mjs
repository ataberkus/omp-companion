import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

test('/usage reports remaining provider quota without steering, queueing or replacing the active turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const emit = f => process.stdout.write(JSON.stringify(f) + '\\n');
let model = { provider: 'alpha', id: 'selected' };
emit({ type: 'ready' });
emit({ type: 'available_commands_update', commands: [{ name: 'usage' }] });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  if (c.type === 'set_model') model = { provider: c.provider, id: c.modelId };
  const data = c.type === 'get_state' ? { model, isSettled: false, todoPhases: [] } : {};
  if (c.type === 'prompt') emit({ type: 'agent_start' });
  if (c.type === 'steer') emit({ type: 'command_output', text: 'INCORRECT: quota command reached the agent' });
  emit({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`);
  // Node can act as both the RPC runner and the existing `omp usage --json` CLI.
  await writeFile(join(dir, 'usage'), `const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(__dirname + '/usage-data.json', 'utf8'));
if (data.error) { process.stderr.write(data.error); process.exit(1); }
process.stdout.write(JSON.stringify(data));
`);
  const limit = (id, amount, extra = {}) => ({ id, label: id, scope: {}, amount, ...extra });
  const snapshot = {
    reports: [
      { provider: 'alpha', fetchedAt: Date.parse('2099-01-01T00:00:00Z'), metadata: { email: 'alpha-account', planType: 'Pro' }, limits: [
        limit('five-hour', { unit: 'percent', usedFraction: 0.25 }, { window: { label: '5h', resetsAt: Date.parse('2099-01-01T05:00:00Z') } }),
        limit('weekly', { unit: 'percent', used: 20 }),
        limit('tokens', { unit: 'tokens', used: 2500, limit: 10000 }),
        limit('overage', { unit: 'requests', used: 125, limit: 100 }),
        limit('credits', { unit: 'credits', remaining: 31 }),
        limit('fraction-left', { unit: 'percent', remainingFraction: 0.4 }),
        limit('spend-only', { unit: 'usd', used: 2.5 }),
      ] },
      { provider: 'beta', fetchedAt: Date.parse('2099-01-01T00:00:00Z'), metadata: { email: 'beta-account' }, limits: [limit('daily', { unit: 'percent', usedFraction: 0.9 })] },
    ],
    accountsWithoutUsage: [{ provider: 'alpha', email: 'unreported-account' }],
  };
  const usageFile = join(dir, 'usage-data.json');
  await writeFile(usageFile, JSON.stringify(snapshot));
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Usage', cwd: dir, status: 'paused', native: false, provider: 'alpha', model: 'selected', messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const command = async body => {
    const res = await fetch(base + '/api/sessions/session/command', { method: 'POST', headers, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  await command({ type: 'prompt', message: 'Keep working' });
  await command({ type: 'follow_up', message: 'Future user turn' });
  const session = app.store.sessions[0], promptId = session._promptId;
  const [, first] = await command({ type: 'steer', message: '/usage' });
  assert.equal(first.status, 'running');
  const report = first.messages.at(-1).text;
  assert.match(report, /Usage: alpha\/selected/);
  assert.match(report, /75\.0% remaining · 25\.0% used/);
  assert.match(report, /80\.0% remaining · 20\.0% used/);
  assert.match(report, /7,500 tokens remaining/);
  assert.match(report, /0 requests remaining · 0\.0% remaining · 125\.0% used/);
  assert.match(report, /31 credits remaining/);
  assert.match(report, /40\.0% remaining · 60\.0% used/);
  assert.match(report, /spend-only\n    Remaining quota unavailable · 2\.5 usd used/);
  assert.match(report, /Resets: 2099-01-01T05:00:00\.000Z/);
  assert.match(report, /unreported-account\n  Remaining quota unavailable/);
  assert.doesNotMatch(report, /beta-account/);
  assert.equal(session._promptId, promptId);
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Future user turn']);
  assert.ok(!session.messages.some(m => m.steer === 'pending' && m.text === '/usage'));
  assert.ok(!session.messages.some(m => m.text.includes('INCORRECT')));

  await command({ type: 'set_model', model: 'beta/other' });
  const [, second] = await command({ type: 'follow_up', message: '/usage show' });
  assert.match(second.messages.at(-1).text, /Usage: beta\/other/);
  assert.match(second.messages.at(-1).text, /10\.0% remaining · 90\.0% used/);
  assert.doesNotMatch(second.messages.at(-1).text, /alpha-account/);
  assert.equal(session._promptId, promptId);
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Future user turn']);

  await writeFile(usageFile, JSON.stringify({ reports: [] }));
  const [, unavailable] = await command({ type: 'steer', message: '/usage' });
  assert.match(unavailable.messages.at(-1).text, /Remaining quota unavailable: beta/);
  assert.doesNotMatch(unavailable.messages.at(-1).text, /100\.0% remaining/);
  await writeFile(usageFile, JSON.stringify({ error: 'Provider lookup failed' }));
  const [failure, body] = await command({ type: 'steer', message: '/usage' });
  assert.equal(failure, 502);
  assert.match(body.error, /Provider lookup failed/);
  assert.equal(session.status, 'running');
  assert.equal(session._promptId, promptId);
  assert.deepEqual(session.queuedMessages.map(m => m.text), ['Future user turn']);
});
