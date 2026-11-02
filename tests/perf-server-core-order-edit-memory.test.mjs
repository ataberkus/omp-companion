// The order history (companion/sync.mjs, c.orders) keeps orders an edit can still be made from. After resets (/new, a
// switched OMP session: all new IDs) the orders kept before them are let go: 8 of them held 4,800 IDs no message has,
// ~2 MB with the companion's randomUUID IDs (~500 B each), per viewed session. Edits from the orders still kept go on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createSync } from '../companion/sync.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const heap = () => { for (let i = 0; i < 4; i++) gc(); return process.memoryUsage().heapUsed; };
const msg = () => ({ id: randomUUID(), role: 'assistant', text: 'reply', at: '2026-01-01T00:00:00.000Z' });

test('resets let go of the orders kept before them; edits go on from the ones kept since', () => {
  const store = { sessions: [] }, sync = createSync({ store }), s = { id: 'a', messages: [] };
  store.sessions.push(s);
  const h0 = heap();
  for (let i = 0; i < 20; i++) { s.messages = Array.from({ length: 600 }, msg); sync.transcriptDelta(s, ''); }
  const held = heap() - h0;
  // The current transcript (600 messages and their snapshots) is held either way: ~0.6 MB; the 7 orders kept before
  // the last reset added ~2 MB more.
  assert.ok(held < 1.2 * 1024 * 1024, `held ${Math.round(held / 1024)} KB`);
  // Streaming after the last reset: a dashboard at each of the last 7 order changes gets an edit.
  const revs = [];
  for (let i = 0; i < 8; i++) { s.messages = [...s.messages, msg()].slice(-600); const r = sync.transcriptDelta(s, ''); revs.push(`${r.tx.epoch}.${r.tx.rev}`); }
  s.messages = [...s.messages, msg()].slice(-600);
  for (const since of revs.slice(1)) assert.ok(sync.transcriptDelta(s, since, true).tx.orderEdit, since);
  // An order held from before the reset gets the whole order, as before.
  const r = sync.transcriptDelta(s, revs[0].replace(/\.\d+$/, '.1'), true);
  assert.deepEqual([r.tx.orderEdit, r.tx.order?.length], [undefined, 600]);
});
