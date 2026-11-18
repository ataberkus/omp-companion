import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// The Antigravity CLI reports a failed request as reply text, which OMP finishes with stopReason "stop".
const QUOTA = '\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n\n⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n';

for (const [name, provider, text, status] of [
  ['an Antigravity CLI failure reply is a session error', 'antigravity-cli', QUOTA, 'error'],
  ['a reply quoting the failure among other text is an answer', 'antigravity-cli', `The log said:\n${QUOTA}`, 'review'],
  ['other providers keep the same text as an answer', 'anthropic', QUOTA, 'review'],
]) test(name, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-agy-error-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp(s => ({
    state: () => ({ todoPhases: [] }),
    prompt(c) {
      setImmediate(() => {
        s.emit({ type: 'agent_start' });
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', provider, model: 'gemini-4-hydrogen' } });
        s.emit({ type: 'agent_end', messages: [] });
        s.emit({ type: 'prompt_result', id: c.id, status: 'completed', sessionSettled: true });
        s.emit({ type: 'session_settled' });
      });
      return { agentInvoked: true };
    },
  }));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], tokens: 0 }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'Work' }) });
  assert.equal(res.status, 200);
  const session = app.store.sessions[0];
  for (let n = 0; n < 200 && session.status === 'running'; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(session.status, status);
  if (status === 'error') assert.equal(session.error, 'Antigravity CLI: API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).');
  else assert.equal(session.error, undefined);
});
