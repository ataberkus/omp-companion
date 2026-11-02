import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanJobs } from '../companion/transcript.mjs';

// scanJobs keeps the 32 files it scanned last and forgets each tool call once its result is read. A file scanned in
// pieces, evicted and rescanned from the start, gives the jobs a single scan of a fresh module gives; jobs are named from
// their own call even when a provider repeats tool-call ids across turns.
let fresh = 0;
const once = async file => (await import(new URL(`../companion/transcript.mjs?fresh=${++fresh}`, import.meta.url))).scanJobs(file);
const line = f => JSON.stringify(f) + '\n';
const at = s => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const taskCall = (id, s, tasks) => line({ type: 'message', id: 'a' + s, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'task', intent: 'Delegating ' + s, arguments: { tasks } }] } });
const taskResult = (id, s, ids, extra = {}) => line({ type: 'message', id: 'r' + s, timestamp: at(s), message: { role: 'toolResult', toolCallId: id, toolName: 'task', content: [{ type: 'text', text: 'done' }], details: { progress: ids.map(p => ({ id: p, agent: 'task' })), results: ids.map(p => ({ id: p, output: 'Output of ' + p, durationMs: 5 })) }, ...extra } });
const bashCall = (id, s) => line({ type: 'message', id: 'b' + s, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'npm test', async: true, i: 'Run the tests' } }] } });
const bashResult = (id, s, job) => line({ type: 'message', id: 'br' + s, timestamp: at(s), message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: 'started' }], details: { async: { jobId: job, type: 'bash' } } } });
const asyncDone = (s, job) => line({ type: 'custom_message', customType: 'async-result', timestamp: at(s), content: `<system-notice>── Job ${job} done\nall passed</system-notice>`, details: { jobs: [{ jobId: job, status: 'completed', durationMs: 9 }] } });

test('job scans: incremental, evicted and repeated tool-call ids give the same jobs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-job-scans-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  // A call read in one scan and its result in the next.
  await writeFile(file, line({ type: 'session', id: 's', timestamp: at(0) }) + taskCall('call_0', 1, [{ name: 'x', description: 'Explore', task: 'Look around' }]) + bashCall('call_1', 2));
  assert.deepEqual(await scanJobs(file), []);
  await appendFile(file, taskResult('call_0', 3, ['x']) + bashResult('call_1', 4, 'job-1'));
  // The provider reuses call_0 on the next turn; then a synthetic result for it on another branch, with no progress.
  await appendFile(file, taskCall('call_0', 5, [{ name: 'y', description: 'Write it', task: 'Write the code' }]) + taskResult('call_0', 6, ['y']) + taskResult('call_0', 7, [], { isError: true }) + asyncDone(8, 'job-1'));
  const jobs = await scanJobs(file);
  assert.deepEqual(jobs, await once(file));
  assert.deepEqual(jobs.map(j => [j.id, j.type, j.title, j.task || j.command, j.intent, j.startedAt, j.status]), [
    ['x', 'task', 'Explore', 'Look around', 'Delegating 1', at(1), 'done'],
    ['job-1', 'bash', 'Run the tests', 'npm test', 'Run the tests', at(2), 'done'],
    ['y', 'task', 'Write it', 'Write the code', 'Delegating 5', at(5), 'done'],
  ]);

  // Scanning 32 other files evicts this one; the next scan reads it from the start.
  for (let i = 0; i < 32; i++) { const other = join(dir, `other-${i}.jsonl`); await writeFile(other, taskCall('c', 1, [{ name: 'o' + i }]) + taskResult('c', 2, ['o' + i])); assert.equal((await scanJobs(other)).length, 1); }
  await appendFile(file, bashCall('call_2', 9) + bashResult('call_2', 10, 'job-2'));
  const rescanned = await scanJobs(file);
  assert.deepEqual(rescanned, await once(file));
  assert.deepEqual(rescanned.slice(0, 3), jobs);
  assert.deepEqual(rescanned.map(j => j.id), ['x', 'job-1', 'y', 'job-2']);
});

test('job scans: two overlapping scans of one file apply its new lines once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-job-scans-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, line({ type: 'session', id: 's', timestamp: at(0) }));
  assert.deepEqual(await scanJobs(file), []);
  // Both scans start from the same offset; before the fix both advanced it, so the next lines were read from past them.
  await appendFile(file, bashCall('call_1', 1) + bashResult('call_1', 2, 'job-1'));
  const [a, b] = await Promise.all([scanJobs(file), scanJobs(file)]);
  assert.deepEqual(a.map(j => j.id), ['job-1']);
  assert.deepEqual(b.map(j => j.id), ['job-1']);
  await appendFile(file, bashCall('call_2', 3) + bashResult('call_2', 4, 'job-2') + asyncDone(5, 'job-1'));
  const after = await scanJobs(file);
  assert.deepEqual(after, await once(file));
  assert.deepEqual(after.map(j => [j.id, j.status]), [['job-1', 'done'], ['job-2', 'running']]);
});
