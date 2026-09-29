import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const preview = `data:image/png;base64,${png}`;

test('image-only, steered and resumed chat messages reach OMP while invalid images are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-image-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], model: { provider: 'test', id: 'test' } };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (['prompt', 'steer', 'follow_up'].includes(c.type)) {
    const accepted = c.images?.length === 1 && c.images[0].type === 'image' && c.images[0].mimeType === 'image/png' && c.images[0].data === '${png}' && !('name' in c.images[0]) && !('filename' in c.images[0]) && (c.message === '' || c.message === 'With text');
    process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: accepted, command: c.type, data: { agentInvoked: false }, error: accepted ? undefined : 'Image was not forwarded to OMP' }) + '\\n');
  } else process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  const nativeDir = join(dir, 'native');
  const nativeFile = join(nativeDir, 'project', 'history.jsonl');
  await mkdir(join(nativeDir, 'project'), { recursive: true });
  await writeFile(nativeFile, [JSON.stringify({ type: 'session', cwd: dir, id: 'native-session', timestamp: now }), JSON.stringify({ type: 'title', title: 'History' }), JSON.stringify({ type: 'message', timestamp: now, message: { role: 'user', content: [image] } })].join('\n') + '\n');
  app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(url + '/api' + path, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };

  for (const invalid of [{ ...image, mimeType: 'image/svg+xml' }, { ...image, data: 'not-base64' }]) {
    const [status] = await post('/sessions/session/command', { type: 'prompt', message: '', images: [invalid], preview });
    assert.equal(status, 400);
    assert.equal(app.store.sessions[0].messages.length, 0);
  }
  const [status, session] = await post('/sessions/session/command', { type: 'prompt', message: '', images: [image], preview });
  assert.equal(status, 200);
  assert.equal(session.status, 'review');
  assert.equal(session.messages.find(m => m.role === 'user')?.imagePreview, preview);
  assert.equal(session.messages.find(m => m.role === 'user')?.text, 'Image attached');

  const [steerStatus, steered] = await post('/sessions/session/command', { type: 'steer', message: 'With text', images: [image], preview });
  assert.equal(steerStatus, 200);
  assert.notEqual(steered.status, 'error');
  const [resumeStatus, resumed] = await post('/omp-sessions/resume', { file: nativeFile, message: '', images: [image], preview });
  assert.equal(resumeStatus, 201);
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.messages.find(m => m.role === 'user' && m.imagePreview)?.imagePreview, preview);
  assert.ok(resumed.messages.some(m => m.hasImage && !m.imagePreview && m.text === 'Image attached'));
  // New session from home with an image-only prompt also shows the preview.
  const [quickStatus, quick] = await post('/quick-start', { path: dir, prompt: '', images: [image], preview });
  assert.equal(quickStatus, 201);
  assert.equal(quick.messages.find(m => m.role === 'user')?.imagePreview, preview);
  await app.flush();
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.equal(saved.sessions.find(s => s.id === resumed.id).messages.find(m => m.role === 'user' && m.imagePreview)?.imagePreview, preview);
});
