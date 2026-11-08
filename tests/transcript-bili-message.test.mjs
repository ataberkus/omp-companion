import test from 'node:test';
import assert from 'node:assert/strict';
import { entryMessages } from '../companion/transcript.mjs';

// billion-context's /acp reports arrive as displayed bili-* custom messages; without a mapping the chat stayed empty.
test('displayed bili-* custom messages become system notes; hidden or foreign ones do not', () => {
 const at = '2026-11-09T00:00:00.000Z';
 const out = entryMessages([
  { type: 'custom_message', id: 'a', timestamp: at, customType: 'bili-acp-status', display: true, content: '  ACP status: 56k / 1M  ' },
  { type: 'custom_message', id: 'b', timestamp: at, customType: 'bili-acp-cache', display: true, content: [{ type: 'text', text: 'cache hit 79%' }] },
  { type: 'custom_message', id: 'c', timestamp: at, customType: 'bili-acp-status', display: false, content: 'hidden' },
  { type: 'custom_message', id: 'd', timestamp: at, customType: 'not-bili', display: true, content: 'other' },
 ]);
 assert.deepEqual(out, [
  { id: 'a', role: 'system', text: 'ACP status: 56k / 1M', at },
  { id: 'b', role: 'system', text: 'cache hit 79%', at },
 ]);
});
