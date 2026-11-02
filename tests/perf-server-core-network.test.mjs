import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOriginCheck } from '../companion/network.mjs';

// The MagicDNS check: a request by this PC's Tailscale name waited for `tailscale status` whenever the cached answer was a
// minute old, and one failed lookup refused such requests for a minute. A known answer now serves at once and refreshes
// in the background; a refresh that finds nothing keeps it until the last good lookup is 5 minutes old.
test('the MagicDNS name is checked from a cached lookup refreshed in the background, which outlives a failed refresh for 5 minutes', async t => {
  const realNow = Date.now; let now = 1e12;
  Date.now = () => now; t.after(() => { Date.now = realNow; });
  const lookups = [];
  const tailscale = () => new Promise(resolve => lookups.push(resolve));
  const { checkOrigin } = createOriginCheck({ options: { tailscale, networkInterfaces: () => ({}) }, publicHosts: [], allowedOrigins: new Set() });
  const srv = { address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 4545 }) };
  const ask = () => checkOrigin({ headers: { host: 'my-pc.tail1234.ts.net:4545' } }, srv).then(() => 'ok', e => e.status);
  const flush = async () => { for (let i = 0; i < 20; i++) await null; };
  const settled = async p => { let done = false; p.then(() => { done = true; }); await flush(); return done; };
  const pc = { name: 'my-pc.tail1234.ts.net', ips: ['100.101.102.103'] };

  // Nothing known yet: the first request waits for the lookup, as do those arriving meanwhile (one lookup).
  const first = ask(), second = ask();
  assert.equal(await settled(first), false);
  assert.equal(lookups.length, 1);
  lookups[0](pc);
  assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
  assert.equal(await ask(), 'ok');
  assert.equal(lookups.length, 1, 'cached for a minute');

  // A minute on: answered from the cache at once; one background refresh for any number of requests.
  now += 61000;
  const stale = ask();
  assert.equal(await settled(stale), true, 'the request did not wait for the refresh');
  assert.equal(await stale, 'ok');
  assert.equal(await ask(), 'ok');
  assert.equal(lookups.length, 2);
  // The refresh fails: the last good answer stays (it is under 5 minutes old).
  lookups[1](null); await flush();
  assert.equal(await ask(), 'ok');
  for (let i = 0; i < 3; i++) { now += 61000; assert.equal(await ask(), 'ok'); lookups.at(-1)(null); await flush(); }
  assert.equal(lookups.length, 5);
  // Five minutes after the last good lookup, a failed refresh drops it; until then the old answer serves.
  now += 61000;
  assert.equal(await ask(), 'ok');
  lookups.at(-1)(null); await flush();
  assert.equal(await ask(), 403, 'Tailscale gone for 5 minutes: the name is refused');
  assert.equal(lookups.length, 6);

  // With nothing known, a stale cache is looked up again before answering, as before: Tailscale came back.
  now += 61000;
  const back = ask();
  assert.equal(await settled(back), false);
  lookups.at(-1)(pc);
  assert.equal(await back, 'ok');
  // A refresh that finds another answer replaces it.
  now += 61000;
  assert.equal(await ask(), 'ok');
  lookups.at(-1)({ name: 'renamed.tail1234.ts.net', ips: [] }); await flush();
  assert.equal(await ask(), 403);
  assert.equal(await checkOrigin({ headers: { host: 'renamed.tail1234.ts.net:4545' } }, srv).then(() => 'ok'), 'ok');
  // Requests that match without the name never look it up.
  const before = lookups.length;
  now += 61000;
  assert.equal(await checkOrigin({ headers: { host: '127.0.0.1:4545' } }, srv).then(() => 'ok'), 'ok');
  assert.equal(lookups.length, before);
});
