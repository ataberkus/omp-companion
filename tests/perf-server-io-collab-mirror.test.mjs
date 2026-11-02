import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// server.mjs first: collab-host.mjs and command-hosts.mjs import each other.
import { createCompanion } from '../companion/server.mjs';
import { host } from '../companion/collab-host.mjs';
import { fakeOmp } from './fake-omp.mjs';

// A collab guest mirrors the host's events into its session. A message_update carries the whole partial message (twice),
// which the guest no longer copies per delta; the deltas must still reach the transcript as they did.
async function mirror() {
  let ctx;
  class CollabController { constructor(c) { ctx = c; } resumeAfterGuest() {} autoStart() {} startupComplete() {} }
  const modules = { 'collab/controller.ts': { CollabController }, 'collab/guest.ts': { COLLAB_GUEST_ALLOWED_COMMANDS: {} }, 'collab/registry.ts': {}, 'session/session-manager.ts': {} };
  const env = { at: async p => modules[p] ?? {}, pkg: async () => ({}), m: { builtinRegistry: { BUILTIN_SLASH_COMMANDS_INTERNAL: ['collab', 'join', 'leave'].map(name => ({ name, description: name })) }, slashParse: {} } };
  const emitted = [];
  (await host.load(env))({ emit: f => emitted.push(f), plain: v => JSON.parse(JSON.stringify(v)), notice() {}, ui: {} });
  return { emitted, dispatch: event => ctx.eventController.dispatchSessionEvent(event) };
}

test('a collab guest mirrors streamed deltas without their partial message', async t => {
  const { emitted, dispatch } = await mirror();
  const partial = { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(50000) }, { type: 'text', text: 'y'.repeat(50000) }] };
  const deltas = [['thinking_delta', 'Let me '], ['thinking_delta', 'think.'], ['text_delta', 'Hello'], ['text_delta', ' there']];
  await dispatch({ type: 'agent_start' });
  await dispatch({ type: 'message_start', message: partial });
  for (const [type, delta] of deltas) await dispatch({ type: 'message_update', message: partial, assistantMessageEvent: { type, delta, partial, contentIndex: 0 } });
  const updates = emitted.filter(f => f.type === 'message_update');
  assert.deepEqual(updates, deltas.map(([type, delta]) => ({ type: 'message_update', assistantMessageEvent: { type, delta }, mirrored: true })));
  assert.deepEqual(emitted.find(f => f.type === 'message_start'), { type: 'message_start', message: partial, mirrored: true }, 'other events are mirrored whole');

  const dir = await mkdtemp(join(tmpdir(), 'omp-collab-mirror-'));
  let fake;
  const omp = fakeOmp(f => { fake = f; return { prompt: () => ({ agentInvoked: true }) }; });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'P' }], sessions: [{ id: 's', projectId: 'p', title: 'Chat', status: 'review', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/s/command`, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'go' }) });
  for (const f of emitted) fake.emit(f);
  const s = app.store.sessions[0];
  assert.deepEqual(s.messages.slice(-2).map(m => [m.role, m.text]), [['thinking', 'Let me think.'], ['assistant', 'Hello there']]);
});
