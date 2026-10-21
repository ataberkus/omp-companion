import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

test('automatic compaction is visible while active and only reports real outcomes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-compaction-'));
  let app;
  t.after(async () => { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); });
  let compacting = false;
  const begin = function () { compacting = true; this.emit({ type: 'auto_compaction_start', reason: 'threshold' }); return {}; };
  const omp = fakeOmp({
    state: () => ({ todoPhases: [], model: { provider: 'test', id: 'test' }, isCompacting: compacting }),
    prompt: begin,
    steer({ message }) {
      if (message === 'begin') return begin.call(this);
      if (message === 'retry') this.emit({ type: 'auto_compaction_end', willRetry: true, errorMessage: 'transient' });
      else if (['finish', 'fail', 'skip'].includes(message)) {
        compacting = false;
        this.emit({ type: 'auto_compaction_end', ...(message === 'fail' ? { errorMessage: 'limit reached' } : message === 'skip' ? { skipped: true } : { result: { summary: 'done' } }) });
      }
      return {};
    },
  });
  const at = new Date().toISOString();
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'project', path: dir, name: 'Project' }], sessions: [{ id: 'session', projectId: 'project', title: 'Chat', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages: [], todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  app = await createCompanion({ dataDir: dir, omp });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const command = async (type, message) => {
    const res = await fetch(url + '/api/sessions/session/command', { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, message }) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const system = s => s.messages.filter(m => m.role === 'system').map(m => m.text);

  let s = await command('prompt', 'go');
  assert.equal(s._compacting, true);
  assert.equal(system(s).length, 0);

  s = await command('steer', 'retry');
  assert.equal(s._compacting, true);
  assert.ok(!system(s).some(m => /context compacted/i.test(m)));

  s = await command('steer', 'finish');
  assert.equal(s._compacting, false);
  assert.ok(system(s).some(m => /context compacted/i.test(m)));
  const successes = system(s).filter(m => /context compacted/i.test(m)).length;

  s = await command('steer', 'begin');
  assert.equal(s._compacting, true);
  s = await command('steer', 'fail');
  assert.equal(s._compacting, false);
  assert.ok(system(s).some(m => /compaction failed.*limit reached/i.test(m)));

  s = await command('steer', 'begin');
  s = await command('steer', 'skip');
  assert.equal(s._compacting, false);
  assert.equal(system(s).filter(m => /context compacted/i.test(m)).length, successes);

  await app.flush();
  const saved = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved.sessions[0], '_compacting'), false);
});
