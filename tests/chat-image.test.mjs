import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/e1YAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const preview = `data:image/png;base64,${png}`;
// A header-only PNG claiming 1568×1568 pixels: ≈1,534 estimated tokens, never forwarded to OMP.
const big = (() => { const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(b); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(1568, 16); b.writeUInt32BE(1568, 20); return { type: 'image', mimeType: 'image/png', data: b.toString('base64') }; })();

test('image-only, steered and resumed chat messages reach OMP while invalid images are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-image-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  let data = {};
  if (c.type === 'get_state') data = { todoPhases: [], model: { provider: 'test', id: 'test' } };
  if (c.type === 'get_subagents') data = { subagents: [] };
  if (typeof c.message === 'string' && c.message.startsWith('/advisor')) { appendFileSync(${JSON.stringify(join(dir, 'advisor.log'))}, c.message + '\\n'); process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data: {} }) + '\\n'); continue; }
  if (['prompt', 'steer', 'follow_up'].includes(c.type)) {
    const accepted = c.images?.length >= 1 && c.images.every(i => i.type === 'image' && i.mimeType === 'image/png' && i.data === '${png}' && !('name' in i) && !('filename' in i)) && (c.message === '' || c.message === 'With text');
    process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: accepted, command: c.type, data: { agentInvoked: false }, error: accepted ? undefined : 'Image was not forwarded to OMP' }) + '\\n');
  } else process.stdout.write(JSON.stringify({ type: 'response', id: c.id, success: true, command: c.type, data }) + '\\n');
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }, { id: 'tight', projectId: 'project', title: 'Tight', status: 'paused', cwd: dir, model: 'OMP default', native: false, contextWindow: 5000, contextTokens: 1000, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
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
  const [resumeStatus, resumed] = await post('/omp-sessions/resume', { file: nativeFile, message: '', advisor: true, images: [image], preview });
  assert.equal(resumeStatus, 201);
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.messages.find(m => m.role === 'user' && m.imagePreview)?.imagePreview, preview);
  assert.ok(resumed.messages.some(m => m.hasImage && !m.imagePreview && m.text === 'Image attached'));
  assert.match(await readFile(join(dir, 'advisor.log'), 'utf8'), /^\/advisor on$/m);
  // New session from home with an image-only prompt also shows the preview.
  const [quickStatus, quick] = await post('/quick-start', { path: dir, prompt: '', images: [image], preview });
  assert.equal(quickStatus, 201);
  assert.equal(quick.messages.find(m => m.role === 'user')?.imagePreview, preview);
  // Several images in one message all reach OMP, each with its own preview; the advisor choice applies before the prompt.
  const [multiStatus, multi] = await post('/quick-start', { path: dir, prompt: '', advisor: false, images: [image, image, image], preview: [preview, preview, preview] });
  assert.equal(multiStatus, 201);
  assert.notEqual(multi.status, 'error');
  assert.deepEqual(multi.messages.find(m => m.role === 'user')?.imagePreview, [preview, preview, preview]);
  assert.match(await readFile(join(dir, 'advisor.log'), 'utf8'), /^\/advisor off$/m);
  // No fixed image count: seven small images fit the 4,000 tokens left in "tight"…
  const [manyStatus, many] = await post('/sessions/tight/command', { type: 'prompt', message: 'With text', images: Array(7).fill(image) });
  assert.equal(manyStatus, 200);
  assert.notEqual(many.status, 'error');
  // …but three ~1,534-token images don't, and nothing reaches OMP or the transcript.
  const before = many.messages.length;
  const [fullStatus, full] = await post('/sessions/tight/command', { type: 'prompt', message: 'With text', images: [big, big, big] });
  assert.equal(fullStatus, 400);
  assert.match(full.error, /Not enough context left.*3 images ≈ 4,602.*only 4,000 of 5,000 tokens remain/);
  assert.equal(app.store.sessions.find(s => s.id === 'tight').messages.length, before);
  // Unknown context window (OMP default model): images are limited only by upload size.
  const [unknownStatus, unknown] = await post('/sessions/session/command', { type: 'follow_up', message: 'With text', images: Array(7).fill(image) });
  assert.equal(unknownStatus, 200);
  assert.notEqual(unknown.status, 'error');
  await app.flush();
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.equal(saved.sessions.find(s => s.id === resumed.id).messages.find(m => m.role === 'user' && m.imagePreview)?.imagePreview, preview);
});

test('images in tool results are kept live and from the transcript, served by ID, and never stored in workspace.json', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-tool-image-'));
  let app;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => { if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDir; if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  // A PNG with a marker no other image here has, so finding its base64 in workspace.json would mean it was stored there.
  const marked = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('tool-image-marker-0001')]).toString('base64');
  const content = [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', mimeType: 'image/png', data: marked },
    { type: 'image', mimeType: 'image/svg+xml', data: png }, { type: 'image', mimeType: 'image/jpeg', data: png }];
  const fake = join(dir, 'omp.mjs');
  await writeFile(fake, `import { createInterface } from 'node:readline';
const out = f => process.stdout.write(JSON.stringify(f) + '\\n');
out({ type: 'ready' });
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  const data = c.type === 'get_state' ? { todoPhases: [] } : c.type === 'get_subagents' ? { subagents: [] } : c.type === 'prompt' ? { agentInvoked: true } : {};
  out({ type: 'response', id: c.id, command: c.type, success: true, data });
  if (c.type === 'prompt') {
    out({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { path: 'shot.png' } });
    out({ type: 'tool_execution_end', toolCallId: 'r1', toolName: 'read', result: { content: ${JSON.stringify(content)} } });
  }
}`);
  const now = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project', branch: 'main' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: now, updatedAt: now }], activity: [] }));
  // OMP's session file keeps tool images in its blob store, by SHA-256: one still there, one swept.
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  const hash = createHash('sha256').update(Buffer.from(marked, 'base64')).digest('hex');
  await mkdir(join(dir, 'agent', 'blobs'), { recursive: true });
  await writeFile(join(dir, 'agent', 'blobs', hash), Buffer.from(marked, 'base64'));
  const ref = h => [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', mimeType: 'image/png', data: 'blob:sha256:' + h }];
  const nativeDir = join(dir, 'native');
  const nativeFile = join(nativeDir, 'project', 'history.jsonl');
  await mkdir(join(nativeDir, 'project'), { recursive: true });
  await writeFile(nativeFile, [
    { type: 'session', cwd: dir, id: 'native-session', timestamp: now },
    { type: 'message', id: 'u1', timestamp: now, message: { role: 'user', content: 'Look at it' } },
    { type: 'message', id: 'a1', timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r2', name: 'read', arguments: { path: 'shot.png' } }, { type: 'toolCall', id: 'r3', name: 'read', arguments: { path: 'gone.png' } }] } },
    { type: 'message', id: 't1', timestamp: now, message: { role: 'toolResult', toolCallId: 'r2', content: ref(hash) } },
    { type: 'message', id: 't2', timestamp: now, message: { role: 'toolResult', toolCallId: 'r3', content: ref('f'.repeat(64)) } },
  ].map(f => JSON.stringify(f)).join('\n') + '\n');
  app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, ompCommand: process.execPath, ompArgs: [fake] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.token}` };
  const image = async (id, headers = auth) => { const res = await fetch(`${url}/api/tool-image?id=${encodeURIComponent(id)}`, { headers }); return [res.status, res.headers.get('content-type'), Buffer.from(await res.arrayBuffer())]; };
  // Only the valid PNG survives: an SVG and a PNG claiming to be a JPEG fail the chat-image checks.
  const expectOne = images => { assert.equal(images?.length, 1); assert.equal(images[0].mimeType, 'image/png'); assert.match(images[0].id, /^[0-9a-f]{64}\.png$/); assert.equal(images[0].data, undefined); return images[0].id; };

  const res = await fetch(`${url}/api/sessions/session/command`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'Read it' }) });
  assert.equal(res.status, 200);
  const live = () => app.store.sessions[0].messages.find(m => m.id === 'tool-r1');
  for (let i = 0; i < 100 && live()?.tool?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(live().tool.result, 'Read image file [image/png]');
  const id = expectOne(live().tool.images);
  const [status, type, bytes] = await image(id);
  assert.equal(status, 200);
  assert.equal(type, 'image/png');
  assert.equal(bytes.toString('base64'), marked);
  assert.equal((await image(id, {}))[0], 401);
  assert.equal((await image('../workspace.json'))[0], 400);
  assert.equal((await image('0'.repeat(64) + '.png'))[0], 404);

  // Reloaded from OMP's transcript: copied from OMP's blob store under the same content-addressed ID.
  await rm(join(dir, 'tool-images'), { recursive: true, force: true });
  const preview = await (await fetch(`${url}/api/omp-sessions/preview?file=${encodeURIComponent(nativeFile)}`, { headers: auth })).json();
  assert.equal(expectOne(preview.messages.find(m => m.id === 'tool-r2')?.tool?.images), id);
  assert.equal((await image(id))[2].toString('base64'), marked);
  await rm(join(dir, 'tool-images'), { recursive: true, force: true });
  assert.equal((await image(id))[2].toString('base64'), marked, 'a pruned image is still served while OMP keeps its blob');
  assert.equal((await image(expectOne(preview.messages.find(m => m.id === 'tool-r3')?.tool?.images)))[0], 404, 'a swept blob is reported as no longer stored');
  await app.flush();
  assert.ok(!(await readFile(join(dir, 'workspace.json'), 'utf8')).includes(marked));
});

test('stored tool images stay within the configured cap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-tool-image-cap-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const nativeDir = join(dir, 'native');
  const nativeFile = join(nativeDir, 'project', 'history.jsonl');
  await mkdir(join(nativeDir, 'project'), { recursive: true });
  const shot = n => Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(1000, n)]);
  const frames = [{ type: 'session', cwd: dir, id: 'native-session', timestamp: now }];
  for (const n of [1, 2, 3]) frames.push(
    { type: 'message', id: 'a' + n, timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r' + n, name: 'read', arguments: { path: n + '.png' } }] } },
    { type: 'message', id: 't' + n, timestamp: now, message: { role: 'toolResult', toolCallId: 'r' + n, content: [{ type: 'image', mimeType: 'image/png', data: shot(n).toString('base64') }] } });
  await writeFile(nativeFile, frames.map(f => JSON.stringify(f)).join('\n') + '\n');
  const cap = Math.floor(shot(1).length * 1.5);
  app = await createCompanion({ dataDir: dir, ompSessionsDir: nativeDir, ompCommand: process.execPath, ompArgs: ['-e', ''], toolImageCap: cap });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const preview = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/omp-sessions/preview?file=${encodeURIComponent(nativeFile)}`, { headers: { Authorization: `Bearer ${app.token}` } })).json();
  assert.equal(preview.messages.filter(m => m.tool?.images?.length).length, 3);
  const folder = join(dir, 'tool-images');
  let names = [];
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); names = await readdir(folder); if (names.length === 1) break; }
  assert.equal(names.length, 1);
  assert.ok((await stat(join(folder, names[0]))).size <= cap);
});
