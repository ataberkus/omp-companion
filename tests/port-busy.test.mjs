import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { portBusy } from '../companion/server.mjs';

// A wildcard listener must count as busy: on Windows 127.0.0.1:N can still be bound beside it,
// so only a connect probe stops a second companion from sharing workspace.json.
test('portBusy sees a 0.0.0.0 listener and reports the port free once it closes', async () => {
  const holder = createServer().listen(0, '0.0.0.0');
  await once(holder, 'listening');
  const { port } = holder.address();
  assert.equal(await portBusy(port), true);
  holder.close();
  await once(holder, 'close');
  assert.equal(await portBusy(port), false);
});
