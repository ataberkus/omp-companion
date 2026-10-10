import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

// workspace.json holds every session's transcript (tens of MB in real use); the 4 s background refresh of an idle
// live session must not rewrite it.
test('an idle live session does not rewrite workspace.json on background refresh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-idle-save-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
out({ type: 'ready', protocolVersion: 1 });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const data = c.type === 'get_state' ? { todoPhases: [], isSettled: true } : c.type === 'get_subagents' ? { subagents: [] } : {};
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
}
`);
  const at = new Date().toISOString();
  const file = join(dir, 'workspace.json');
  await writeFile(file, JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/commands?session=session`, { headers: { Authorization: 'Bearer ' + app.token } });
  assert.equal(res.status, 200);
  // Let the first refresh (advisor status probe, model fields) settle, then watch two more refresh ticks.
  await new Promise(r => setTimeout(r, 4500));
  await app.flush();
  const before = (await stat(file)).mtimeMs;
  await new Promise(r => setTimeout(r, 8500));
  await app.flush();
  assert.equal((await stat(file)).mtimeMs, before);
});
