import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../companion/sync.mjs';

// A boxed number or boolean has no keys of its own: copied as {} it compared equal to any other, so a change of its
// JSON (5 -> 6) never went out. Such values are compared by their JSON.
test('a boxed value whose JSON changes goes out, in the transcript and in the session list', () => {
  for (const [a, b] of [[new Number(5), new Number(6)], [new Boolean(false), new Boolean(true)], [new Set([1]), new Number(1)]]) {
    const s = { id: 's', v: a, messages: [{ id: 'm', v: a }] }, sync = createSync({ store: { sessions: [s] } });
    const tx = sync.transcriptDelta(s, ''), sx = JSON.parse(sync.storeDelta({}, ''));
    s.v = b; s.messages[0].v = b;
    assert.deepEqual(sync.transcriptDelta(s, `${tx.tx.epoch}.${tx.tx.rev}`).tx.changed.map(m => m.id), ['m']);
    assert.deepEqual(JSON.parse(sync.storeDelta({}, `${sx.epoch}.${sx.rev}`)).changed.map(x => x.v), [JSON.parse(JSON.stringify(b))]);
  }
});

// The comparison recurses; deep values are compared by their JSON, so a poll handles any depth JSON.stringify does
// (Node: ~4,100 levels; the walk alone overflowed at ~3,100).
test('a message nested 3,500 deep polls without throwing, and a change deep inside it goes out', () => {
  let leaf = { x: 1 }, v = leaf; for (let i = 0; i < 3500; i++) v = { k: v };
  const s = { id: 's', messages: [{ id: 'm', role: 'tool', args: v }, { id: 'n', role: 'user', text: 'hi' }] }, sync = createSync({ store: { sessions: [s] } });
  const first = sync.transcriptDelta(s, '');
  const idle = sync.transcriptDelta(s, `${first.tx.epoch}.${first.tx.rev}`);
  assert.deepEqual(idle.tx.changed, []);
  leaf.x = 2;
  assert.deepEqual(sync.transcriptDelta(s, `${idle.tx.epoch}.${idle.tx.rev}`).tx.changed.map(m => m.id), ['m']);
});
