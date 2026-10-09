import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// OMP's RPC mode never auto-titles; the companion asks for /rename and adopts session_info_update.
test('prompt-derived titles are replaced by the title OMP generates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-title-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const log = join(dir, 'commands.log');
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1] });
const reply = (c, data) => out({ type: 'response', id: c.id, command: c.type, success: true, data });
let renames = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, c.type + ':' + (c.message ?? c.name ?? '') + '\\n');
  if (c.type === 'get_state') reply(c, { todoPhases: [] });
  else if (c.type === 'get_subagents') reply(c, { subagents: [] });
  else if (c.type === 'prompt' && c.message === '/rename') {
    reply(c, { agentInvoked: false });
    // The first one is cancelled by Stop mid-generation: OMP prints nothing.
    if (++renames === 1) continue;
    out({ type: 'session_info_update', sessionId: 'x', title: 'Chat Tab Completion' });
    out({ type: 'command_output', text: 'Session renamed to Chat Tab Completion.' });
  } else if (c.type === 'prompt') {
    reply(c, { agentInvoked: true });
    out({ type: 'agent_start' });
    out({ type: 'message_start', message: { role: 'assistant', content: [] } });
    out({ type: 'message_start', message: { role: 'assistant', content: [] } });
    out({ type: 'session_settled' });
  } else reply(c, {});
}
`);
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/quick-start`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, prompt: 'can we add intellisense tab completion for writing to chat box with us' }) });
  assert.equal(res.status, 201);
  const s = app.store.sessions[0];
  const sent = async () => (await readFile(log, 'utf8')).split('\n');
  for (let n = 0; n < 120 && !(await sent()).includes('prompt:/rename'); n++) await new Promise(r => setTimeout(r, 25));
  assert.equal(s.autoTitle, true, 'silent /rename leaves the session untitled');
  const second = await fetch(`http://127.0.0.1:${app.server.address().port}/api/sessions/${s.id}/command`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'go on' }) });
  assert.equal(second.status, 200);
  for (let n = 0; n < 120 && (s.title !== 'Chat Tab Completion' || s._titling); n++) await new Promise(r => setTimeout(r, 25));
  assert.equal(s.title, 'Chat Tab Completion', 'next run retries the title');
  assert.equal(s.autoTitle, undefined);
  assert.ok(!s.messages.some(m => m.text?.includes('Session renamed')), 'rename chatter stays out of the chat');
  const log2 = await sent();
  assert.ok(!log2.some(l => l.startsWith('set_session_name:')), 'placeholder title is not pinned as a user title');
  assert.equal(log2.filter(l => l === 'prompt:/rename').length, 2, 'one /rename per run');
});
