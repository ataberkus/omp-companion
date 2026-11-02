import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../companion/sync.mjs';

// Full replies reuse a summary's JSON while it is unchanged; they must still equal the summaries as they are now.
test('full store replies carry every summary as it is now, before and after changes', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, title: 't' + i, status: 'paused', todos: [{ text: 'a' }], messages: [{ id: 'm' }], _btw: [1] }));
  const sync = createSync({ store: { sessions } }), now = () => sessions.map(s => JSON.parse(JSON.stringify({ ...s, messages: undefined, _btw: undefined })));
  let since = '';
  for (let round = 0; round < 6; round++) {
    const full = JSON.parse(sync.storeDelta({ a: round }, ''));
    assert.deepEqual(full.changed, now());
    const delta = JSON.parse(sync.storeDelta({ a: round }, since));
    if (since) assert.deepEqual(delta.changed, round % 2 ? now().filter(s => s.id === 's1' || s.id === 's3') : now().filter(s => s.id === 's1'));
    since = `${delta.epoch}.${delta.rev}`;
    sessions[1].title = 'r' + round; sessions[1].todos[0].text = 'b' + round; if (round % 2 === 0) sessions[3].status = 'running' + round;
  }
});
