import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryMessages, importMessages, readTail } from '../companion/transcript.mjs';

// importMessages reads a short tail first and the rest of the 12 MB only when that yields fewer than `limit` messages.
// On generated files (over 12 MB, between the two tails, short; dense and sparse ends, context resets, tool
// results whose calls lie further up, repeated tool ids, multi-byte text, an unterminated last line) it must return what
// parsing the whole 12 MB tail returns, and store the same images.
const before = async (file, limit, stash) => { const frames = []; for (const line of (await readTail(file, 12 * 1024 * 1024)).split('\n')) { try { frames.push(JSON.parse(line)); } catch {} } return entryMessages(frames, limit, stash); };
const recorder = () => { const stored = []; return { stored, stash: images => images.map(i => { stored.push(i.blob); return { mimeType: i.mimeType, id: i.blob + '.png' }; }) }; };

function session(sections, seed) {
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, pick = n => Math.floor(rnd() * n);
  const lines = [JSON.stringify({ type: 'session', id: 's', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z' })];
  let n = 0;
  const open = [];
  const at = () => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  const answer = (c, size) => {
    const image = pick(4) === 0 ? [{ type: 'image', mimeType: 'image/png', data: 'blob:sha256:' + String(n).padStart(64, '0') }] : [];
    lines.push(JSON.stringify({ type: 'message', id: 'r' + n + c.id, timestamp: at(), message: { role: 'toolResult', toolCallId: c.id, toolName: c.name, isError: pick(8) === 0, content: [{ type: 'text', text: 'out 😀 '.repeat(Math.ceil(pick(size) / 7)) }, ...image] } }));
  };
  for (const { count, result, resets = 0, reset } of sections) for (let k = 0; k < count; k++) {
    n++;
    const kind = pick(10);
    if ((reset && k === 0) || (resets && pick(Math.round(count / resets)) === 0)) lines.push(JSON.stringify({ type: 'reset_boundary', id: 'z' + n, timestamp: at() }));
    else if (kind < 2) lines.push(JSON.stringify({ type: 'message', id: 'u' + n, timestamp: at(), message: { role: 'user', content: `Ask ${n} ü€😀 ` + 'q'.repeat(pick(400)) } }));
    else if (kind < 8) {
      // Repeated ids, as some providers number calls per turn; most are answered at once, a few much later.
      const calls = Array.from({ length: pick(4) }, () => ({ type: 'toolCall', id: 'call_' + pick(40), name: pick(2) ? 'read' : 'bash', arguments: { path: '/w/f' + n, command: 'ls ' + 'é'.repeat(pick(50)) } }));
      lines.push(JSON.stringify({ type: 'message', id: 'a' + n, timestamp: at(), message: { role: 'assistant', provider: 'p', model: 'm', timestamp: n, content: [...(pick(2) ? [{ type: 'thinking', thinking: 'Hmm 😀 '.repeat(pick(200)) }] : []), ...(pick(3) ? [{ type: 'text', text: 'Reply ' + n + ' ' + 'ж'.repeat(pick(300)) }] : []), ...calls] } }));
      for (const c of calls) if (pick(10)) answer(c, result); else open.push(c);
    } else if (kind < 9 && open.length) answer(open.splice(pick(open.length), 1)[0], result);
    else lines.push(JSON.stringify({ type: 'message', id: 'b' + n, timestamp: at(), message: { role: 'bashExecution', command: 'make ' + n, output: 'ok', exitCode: pick(3) } }));
  }
  return lines.join('\n') + '\n';
}

test('a short tail first gives the messages and images the whole 12 MB tail gives', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-import-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    'over 12 MB, sparse then a dense end': session([{ count: 900, result: 20000 }, { count: 3000, result: 300 }], 1),
    'over 12 MB, a sparse end': session([{ count: 3000, result: 300 }, { count: 350, result: 60000 }], 2),
    'under 12 MB, a sparse end': session([{ count: 1000, result: 300 }, { count: 200, result: 40000 }], 6),
    'context resets': session([{ count: 2000, result: 3000, resets: 4 }], 3),
    'a reset in the short tail': session([{ count: 1800, result: 6000 }, { count: 60, result: 200, reset: true }], 4),
    'short': session([{ count: 200, result: 500 }], 5),
  };
  files['unterminated last line'] = files['context resets'] + '{"type":"message","id":"cut","message":{"role":"user","content":"never fin';
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name.replace(/\W+/g, '-') + '.jsonl');
    await writeFile(file, text);
    for (const limit of [1, 150, 600, 2000]) {
      const a = recorder(), b = recorder();
      const got = await importMessages(file, limit, a.stash), want = await before(file, limit, b.stash);
      assert.deepEqual(got, want, `${name}, limit ${limit}`);
      assert.deepEqual(a.stored.sort(), b.stored.sort(), `${name}, limit ${limit}: images`);
      assert.deepEqual(await importMessages(file, limit), await before(file, limit), `${name}, limit ${limit}, no stash`);
    }
  }
});
