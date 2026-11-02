import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanJobs } from '../companion/transcript.mjs';

// A scan whose fs.open is slow while another scan of the same file, with a newer stat, reads and applies its lines first:
// the slow one must not size its read from the moved offset (a negative length threw a RangeError, failing the poll).
const fsp = createRequire(import.meta.url)('node:fs/promises'), open = fsp.open;
let gate;
fsp.open = async (...a) => { const g = gate; gate = undefined; const fh = await open(...a); if (g) await g; return fh; };
syncBuiltinESMExports();
const line = f => JSON.stringify(f) + '\n';
const bash = (id, job) => line({ type: 'message', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'npm test', async: true } }] } })
  + line({ type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [], details: { async: { jobId: job, type: 'bash' } } } });

// Bun does not route its fs/promises through the patched builtin, so the gate never closes there: Node only.
test('job scans: a scan slow to open the file, overtaken by a newer one, gives the jobs', { skip: !!process.versions.bun }, async t => {
  t.after(() => { fsp.open = open; syncBuiltinESMExports(); });
  const dir = await mkdtemp(join(tmpdir(), 'omp-job-scans-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, bash('c1', 'job-1'));
  assert.deepEqual((await scanJobs(file)).map(j => j.id), ['job-1']);
  await appendFile(file, bash('c2', 'job-2'));
  let release; gate = new Promise(r => release = r);
  const slow = scanJobs(file);
  while (gate) await new Promise(r => setImmediate(r));
  await appendFile(file, bash('c3', 'job-3'));
  assert.deepEqual((await scanJobs(file)).map(j => j.id), ['job-1', 'job-2', 'job-3']);
  release();
  assert.deepEqual((await slow).map(j => j.id), ['job-1', 'job-2', 'job-3']);
  assert.deepEqual((await scanJobs(file)).map(j => j.id), ['job-1', 'job-2', 'job-3']);
});
