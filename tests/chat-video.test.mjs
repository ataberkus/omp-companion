import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';
import { videoExt } from '../companion/videos.mjs';

// The first box of an MP4 (ftyp, brand isom) and of a QuickTime movie (ftyp, brand "qt  "), plus some payload.
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(200_000, 7)]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1'), Buffer.alloc(64, 1)]);

test('videoExt names the container from its first bytes', () => {
  assert.equal(videoExt(mp4), 'mp4');
  assert.equal(videoExt(mov), 'mov');
  assert.equal(videoExt(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm', 'latin1')])), 'webm');
  assert.equal(videoExt(Buffer.from('RIFF\0\0\0\0AVI LIST', 'latin1')), 'avi');
  assert.equal(videoExt(Buffer.from('%PDF-1.4 not a video', 'latin1')), null);
});

test('POST /api/video stores the raw upload by content and answers its path; other files and bad tokens are refused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-chat-video-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp: fakeOmp({}) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/video`;
  const upload = (name, body, token = app.token) => fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' }, body });

  const res = await upload('My clip/1.mp4', mp4);
  assert.equal(res.status, 200);
  const v = await res.json(), id = createHash('sha256').update(mp4).digest('hex');
  assert.deepEqual({ id: v.id, name: v.name, bytes: v.bytes }, { id, name: 'My clip_1.mp4', bytes: mp4.length });
  assert.equal(v.path, join(dir, 'attachments', id + '.mp4'));
  assert.equal(v.ref, `Attached video: My clip_1.mp4 (195 KB) — ${v.path}`);
  assert.ok((await readFile(v.path)).equals(mp4), 'stored byte for byte');

  // The same video again is the same file; no temporary uploads are left behind.
  assert.equal((await (await upload('again.mp4', mp4)).json()).path, v.path);
  assert.equal((await upload('notes.mp4', Buffer.from('%PDF-1.4 renamed'))).status, 415);
  assert.equal((await upload('clip.mp4', mp4, 'wrong')).status, 401);
  assert.deepEqual(await readdir(join(dir, 'attachments')), [id + '.mp4']);
});
