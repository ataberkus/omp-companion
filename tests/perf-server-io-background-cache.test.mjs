import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../companion/history.mjs';
import { createSpend } from '../companion/spend.mjs';

// background() keeps subagent heads and results between calls, and transcriptCost sums only what was appended since its
// last read. After every change to the files, a long-lived instance must answer exactly what a fresh one does, and each
// cost must be the old whole-file sum (same float: costs add in file order).
const instance = sessionsDir => { const ctx = { options: { ompSessionsDir: sessionsDir }, store: { sessions: [] } }; Object.assign(ctx, createSpend({ execOmp: async () => ({}) })); return createHistory(ctx); };
const wholeFileCost = async f => { let c = 0; for (const l of (await readFile(f, 'utf8')).split('\n')) { if (!l.includes('"cost"')) continue; try { c += JSON.parse(l).message?.usage?.cost?.total || 0; } catch {} } return c; };
const byName = bg => ({ ...bg, subagents: [...bg.subagents].sort((a, b) => a.name.localeCompare(b.name)) });
const costLine = (v, text = 'ü€😀 reply') => JSON.stringify({ type: 'message', id: 'c' + v, message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'openai', model: 'gpt-' + v, usage: { cost: { total: v } } } });
const transcript = (name, costs) => [JSON.stringify({ type: 'session', id: name, cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z' }), JSON.stringify({ type: 'message', message: { role: 'user', content: 'Task for ' + name } }), ...costs.map(v => costLine(v))].join('\n') + '\n';

test('background() caches and incremental costs match a fresh read after every change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-bg-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions'), file = join(sessions, '--w--', 'parent.jsonl'), sub = file.replace(/\.jsonl$/, '');
  await mkdir(sub, { recursive: true });
  await writeFile(file, transcript('parent', []));
  const names = ['a', 'b', 'c', 'd'], f = n => join(sub, n + '.jsonl'), md = n => join(sub, n + '.md');
  for (const [i, n] of names.entries()) { await writeFile(f(n), transcript(n, [0.1, 0.2, 0.3].map(v => v * (i + 1)))); await writeFile(md(n), `Result of ${n}`); }
  const cached = instance(sessions);
  let clock = Date.now() / 1000 - 3600;
  const touch = p => utimes(p, ++clock, clock);
  const check = async label => {
    for (const run of [1, 2]) {
      const got = byName(await cached.background(file, Infinity, [])), want = byName(await instance(sessions).background(file, Infinity, []));
      assert.deepEqual(got, want, `${label} (call ${run})`);
      for (const s of got.subagents) assert.equal(s.cost, await wholeFileCost(s.file), `${label}: cost of ${s.name}`);
    }
  };
  await check('initial');
  const steps = [
    ['whole lines appended', () => appendFile(f('a'), [0.1, 0.2, 0.3].map(v => costLine(v)).join('\n') + '\n')],
    ['a partial line', () => appendFile(f('a'), costLine(0.7).slice(0, 40))],
    ['the partial line completed', () => appendFile(f('a'), costLine(0.7).slice(40) + '\n')],
    ['a line cut inside a 4-byte character', async () => { const b = Buffer.from(costLine(0.9, '😀😀😀')); await appendFile(f('a'), b.subarray(0, b.indexOf(Buffer.from('😀')) + 2)); }],
    ['that line finished', async () => { const b = Buffer.from(costLine(0.9, '😀😀😀')); await appendFile(f('a'), Buffer.concat([b.subarray(b.indexOf(Buffer.from('😀')) + 2), Buffer.from('\n')])); }],
    ['an unterminated line that parses', () => appendFile(f('a'), costLine(1.5))],
    ['then its newline and more', () => appendFile(f('a'), '\n' + costLine(2.5) + '\n')],
    ['a file truncated', async () => truncate(f('b'), Math.floor((await stat(f('b'))).size / 2))],
    ['and appended to', () => appendFile(f('b'), '\n' + costLine(0.05) + '\n')],
    ['rewritten in place, same size, new first bytes', async () => { const t = await readFile(f('c'), 'utf8'); await writeFile(f('c'), t.replace('"id":"c"', '"id":"x"').replace('"total":0.30000000000000004', '"total":0.40000000000000004')); await touch(f('c')); }],
    ['replaced by a longer file with the same first bytes', async () => { await writeFile(f('d') + '.tmp', transcript('d', [0.5, 0.25, 0.125, 0.0625])); await rename(f('d') + '.tmp', f('d')); await touch(f('d')); }],
    ['a result rewritten at the same size', async () => { await writeFile(md('b'), 'Result of B'); await touch(md('b')); }],
    ['a result removed', () => rm(md('a'))],
    ['a subagent added', async () => { await writeFile(f('e'), transcript('e', [1, 2])); await writeFile(md('e'), 'Result of e'); }],
    ['a subagent removed', () => rm(f('c'))],
    ['a removed subagent back with another head', () => writeFile(f('c'), transcript('c2', [3]))],
  ];
  for (const [label, change] of steps) { await change(); await check(label); }
});
