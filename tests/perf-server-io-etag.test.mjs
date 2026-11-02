import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

// The session list, a session's background jobs and a subagent's transcript carry an ETag: polled again with it, an
// unchanged reply is a bodiless 304, and any change to the files gives a 200 with a new tag.
const line = f => JSON.stringify(f) + '\n';
const transcript = (id, text) => line({ type: 'session', id, cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z' }) + line({ type: 'message', id: id + '-u', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: text } });

test('polled history replies answer 304 while unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-history-etag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessions = join(dir, 'sessions'), file = join(sessions, '--w--', 'parent.jsonl'), sub = join(sessions, '--w--', 'parent', 'agent.jsonl');
  await mkdir(join(sessions, '--w--', 'parent'), { recursive: true });
  await writeFile(file, transcript('parent', 'Hello'));
  await writeFile(sub, transcript('agent', 'Subtask'));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [], sessions: [], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp(), ompSessionsDir: sessions });
  t.after(() => app.close());
  // Written while the listing is warming up: the first request must still see it.
  await writeFile(join(sessions, '--w--', 'later.jsonl'), transcript('later', 'Written after start'));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const get = (p, tag) => fetch(base + p, { headers: { Authorization: 'Bearer ' + app.token, ...(tag ? { 'If-None-Match': tag } : {}) } });
  const conditional = async (p, check, change) => {
    const first = await get(p);
    assert.equal(first.status, 200, p);
    const tag = first.headers.get('etag');
    assert.match(tag, /^"[\w-]{12}"$/);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    check(await first.json());
    const again = await get(p, tag);
    assert.equal(again.status, 304, p);
    assert.equal(again.headers.get('etag'), tag);
    assert.equal(await again.text(), '');
    assert.equal((await get(p, '"other"')).status, 200, 'a stale tag gets the body');
    await change();
    const changed = await get(p, tag);
    assert.equal(changed.status, 200, `${p} after a change`);
    assert.notEqual(changed.headers.get('etag'), tag);
    return changed.json();
  };

  const listed = await conditional('/omp-sessions', body => {
    assert.equal(body.dir, sessions);
    assert.deepEqual(body.sessions.map(s => s.id).sort(), ['later', 'parent']);
  }, () => appendFile(file, line({ type: 'message', id: 'p2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'More' } })));
  assert.equal(listed.sessions.find(s => s.id === 'parent').size, (await stat(file)).size);

  const bg = await conditional('/background?file=' + encodeURIComponent(file), body => {
    assert.deepEqual(body.subagents.map(s => [s.name, s.preview]), [['agent', 'Subtask']]);
    assert.equal(body.live, false);
  }, () => writeFile(join(sessions, '--w--', 'parent', 'agent.md'), 'Done.'));
  assert.equal(bg.subagents[0].result, 'Done.');

  const tx = await conditional('/transcript?file=' + encodeURIComponent(sub), body => {
    assert.deepEqual(body.messages.map(m => [m.role, m.text]), [['user', 'Subtask']]);
  }, () => appendFile(sub, line({ type: 'message', id: 'a2', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] } })));
  assert.deepEqual(tx.messages.map(m => [m.role, m.text]), [['user', 'Subtask'], ['assistant', 'On it']]);
});
