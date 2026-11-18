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

const LAST = 'Antigravity CLI: API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota). Antigravity rejects this client\u2019s system prompt at the account tier: sign in to Google models with an API key, or choose another provider for this session.';
const LOOP = 'Thinking loop detected: the model repeated near-identical content.';
const text = t => ({ type: 'text', text: t });

// [name, provider, content, stopReason, OMP's terminal result, status, error]
for (const [name, provider, content, stopReason, result, status, error] of [
  ['an Antigravity CLI failure reply is a session error', 'antigravity-cli', [text(QUOTA)], 'stop', 'completed', 'error', LAST],
  ['a failure reply beside a thinking block (a reasoning level) is still a session error', 'antigravity-cli', [{ type: 'thinking', thinking: 'Planning.' }, text(QUOTA)], 'stop', 'completed', 'error', LAST],
  ['a failure reply OMP ended in error (its loop detector) reports the CLI\'s reason', 'antigravity-cli', [text(QUOTA)], 'error', 'error', 'error', LAST],
  ['a reply quoting the failure among other text is an answer', 'antigravity-cli', [text(`The log said:\n${QUOTA}`)], 'stop', 'completed', 'review', undefined],
  ['a failure line beside a tool call is not a failure', 'antigravity-cli', [text(QUOTA), { type: 'toolCall', id: 't', name: 'read', arguments: {} }], 'stop', 'completed', 'review', undefined],
  ['other providers keep the same text as an answer', 'anthropic', [text(QUOTA)], 'stop', 'completed', 'review', undefined],
]) test(name, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-agy-error-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const omp = fakeOmp(s => ({
    state: () => ({ todoPhases: [] }),
    prompt(c) {
      setImmediate(() => {
        s.emit({ type: 'agent_start' });
        s.emit({ type: 'message_end', message: { role: 'assistant', content, stopReason, ...(stopReason === 'error' ? { errorMessage: LOOP } : {}), provider, model: 'gemini-4-hydrogen' } });
        s.emit({ type: 'agent_end', messages: [] });
        s.emit(result === 'error' ? { type: 'prompt_result', id: c.id, status: 'error', error: { message: LOOP } } : { type: 'prompt_result', id: c.id, status: 'completed', sessionSettled: true });
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
  assert.equal(session.error, error);
});

// A session whose model is OMP's own default is started before anything knows its provider. When that default resolves to
// an Antigravity model, the process lacks the Antigravity launch (its own prompt, the built-in tool set) and every request
// would come back 429: the turn starts on a restarted, correctly launched process instead.
test('a session that came up on an Antigravity model is relaunched with its profile before the turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-agy-launch-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const host = fakeOmp(ss => ({
    state: () => ({ todoPhases: [], model: { id: 'gemini-4-hydrogen', provider: 'antigravity-cli' } }),
    prompt(c) {
      setImmediate(() => {
        ss.emit({ type: 'agent_start' });
        ss.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', provider: 'antigravity-cli', model: 'gemini-4-hydrogen' } });
        ss.emit({ type: 'agent_end', messages: [] });
        ss.emit({ type: 'prompt_result', id: c.id, status: 'completed', sessionSettled: true });
        ss.emit({ type: 'session_settled' });
      });
      return { agentInvoked: true };
    },
  }));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [{ id: 'session', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], tokens: 0 }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp: host });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/session/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'Work' }) });
  assert.equal(res.status, 200);
  const session = app.store.sessions[0];
  // The suite runs many files at once: wait for the relaunch itself, then for the turn, not for a fixed slice of time.
  for (let n = 0; n < 600 && host.sessions.length < 2; n++) await new Promise(r => setTimeout(r, 25));
  for (let n = 0; n < 600 && session.status === 'running'; n++) await new Promise(r => setTimeout(r, 25));
  assert.equal(host.sessions.length, 2, 'the first process is replaced');
  assert.equal(host.sessions[0].alive, false);
  assert.ok(host.sessions[1].args.some(a => a.startsWith('--system-prompt=You are an autonomous coding agent')));
  assert.ok(host.sessions[1].args.some(a => a.startsWith('--tools=read,write,edit,bash,grep,glob')));
  assert.equal(session.status, 'review');
  assert.equal(session.error, undefined);
});
