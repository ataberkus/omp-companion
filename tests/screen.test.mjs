import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, internals } from '../companion/server.mjs';

const { screenCommands } = internals;

test('viewer messages become helper commands; malformed or out-of-range input is clamped or dropped', () => {
  assert.equal(screenCommands({ t: 'move', x: 0.5, y: 2 }), 'm 32768 65535\n');
  assert.equal(screenCommands({ t: 'move', x: '0.5', y: 0 }), '');
  assert.equal(screenCommands({ t: 'button', b: 2, down: true, x: 0, y: 1 }), 'm 0 65535\nb 2 1\n');
  assert.equal(screenCommands({ t: 'button', b: 0, down: false }), 'b 0 0\n');
  assert.equal(screenCommands({ t: 'button', b: 3, down: true }), '');
  assert.equal(screenCommands({ t: 'button', b: 0, down: true, x: 0.5 }), '');
  assert.equal(screenCommands({ t: 'wheel', dy: -99999 }), 'w -2400 0\n');
  assert.equal(screenCommands({ t: 'wheel', dy: 0, dx: 0 }), '');
  assert.equal(screenCommands({ t: 'key', code: 'KeyA', down: true }), 'k 65 0 1\n');
  assert.equal(screenCommands({ t: 'key', code: 'ArrowLeft', down: false }), 'k 37 1 0\n');
  for (const code of ['__proto__', 'constructor', 'toString', 'Nope']) assert.equal(screenCommands({ t: 'key', code, down: true }), '', code);
  assert.equal(screenCommands({ t: 'config', monitor: 99, width: 10, quality: 100 }), 'c 63 320 95\n');
  assert.equal(screenCommands({ t: 'nope' }), '');
  assert.equal(screenCommands(null), '');
});

test('typed text is sent as UTF-16 units; line breaks and tabs press keys, other control characters are dropped', () => {
  assert.equal(screenCommands({ t: 'text', text: 'a\r\nb\tc\x07😀' }), 't 61\nk 13 0 1\nk 13 0 0\nt 62\nk 9 0 1\nk 9 0 0\nt 63 d83d de00\n');
  assert.equal(screenCommands({ t: 'text', text: 'x'.repeat(130) }).split('\n').filter(Boolean).map(l => l.split(' ').length - 1).join(), '64,64,2');
  assert.equal(screenCommands({ t: 'text', text: 'x'.repeat(2001) }), '');
});

// A fake helper: echoes each command line back as a status message and answers a frame credit with one frame.
const FAKE_HELPER = `
const out = (type, payload) => { const b = Buffer.alloc(5 + payload.length); b.writeUInt32LE(1 + payload.length); b[4] = type; payload.copy(b, 5); process.stdout.write(b); };
let rest = '';
process.stdin.on('data', d => { rest += d; let i; while ((i = rest.indexOf('\\n')) >= 0) { const line = rest.slice(0, i); rest = rest.slice(i + 1);
  out(2, Buffer.from(JSON.stringify({ t: 'echo', line })));
  if (line.startsWith('f ')) { const h = Buffer.alloc(12); [0, 0, 2, 2, 2, 2].forEach((v, k) => h.writeUInt16LE(v, k * 2)); out(1, Buffer.concat([h, Buffer.from('jpeg')])); }
  if (line === 'q') process.exit(0); } });
`;

// node:http, not WebSocket/fetch: the checks need exact Host and Origin headers and the refused status codes.
function call(port, path, { method = 'GET', headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, localAddress, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8').on('data', c => { text += c; }).on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: 101 }); });
    req.on('error', reject);
    req.end(body);
  });
}
const upgrade = (port, ticket, headers = {}, localAddress) => call(port, '/api/screen/ws' + (ticket ? '?ticket=' + ticket : ''), {
  localAddress,
  headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers },
});
const AUTH = { Authorization: 'Bearer pw-1234', 'Content-Type': 'application/json' };
const ticketFor = async (port, extra) => { const r = await call(port, '/api/screen/ticket', { method: 'POST', headers: AUTH, body: '{}', ...extra }); assert.equal(r.status, 200, r.body); return JSON.parse(r.body).ticket; };

async function start(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'omp-screen-'));
  const app = await createCompanion({ dataDir, password: 'pw-1234', screenCommand: [process.execPath, ['-e', FAKE_HELPER]], tailscale: async () => null, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, options?.host || '0.0.0.0');
  await once(app.server, 'listening');
  return { app, port: app.server.address().port };
}

test('screen sharing is off unless turned on, and turning it on still takes the token', async t => {
  const { app, port } = await start(t, { screen: false });
  const state = await call(port, '/api/screen', { headers: AUTH });
  assert.deepEqual(JSON.parse(state.body), { supported: true, enabled: false, desktop: false, viewer: null });
  const off = await call(port, '/api/screen/ticket', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(off.status, 409);
  assert.match(off.body, /OMP_WEB_SCREEN=1/);
  assert.equal(app.setScreen(true), true);
  assert.equal((await call(port, '/api/screen')).status, 401);
  assert.equal((await call(port, '/api/screen/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await call(port, '/api/screen/ticket', { method: 'POST', headers: { ...AUTH, Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  assert.match(await ticketFor(port), /^[0-9a-f]{64}$/);
  // Off again: tickets handed out before are void.
  const ticket = await ticketFor(port);
  app.setScreen(false);
  app.setScreen(true);
  assert.equal((await upgrade(port, ticket)).status, 401);
});

test('the WebSocket needs a fresh ticket from the same address and passes the same Host/Origin checks as the API', async t => {
  const { port } = await start(t, { screen: true });
  assert.equal((await upgrade(port, '')).status, 401);
  assert.equal((await upgrade(port, 'ab'.repeat(32))).status, 401);
  assert.equal((await upgrade(port, await ticketFor(port), { Host: `evil.example:${port}` })).status, 403);
  assert.equal((await upgrade(port, await ticketFor(port), { Origin: 'http://evil.example' })).status, 403);
  // Another device can't use a ticket it saw: it is bound to the address that asked for it.
  assert.equal((await upgrade(port, await ticketFor(port), {}, '127.0.0.2')).status, 401);
  const ticket = await ticketFor(port);
  assert.equal((await upgrade(port, ticket, { Origin: `http://127.0.0.1:${port}` })).status, 101);
  assert.equal((await upgrade(port, ticket)).status, 401);
  assert.equal((await call(port, '/api/screen/elsewhere', { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })).status, 404);
});

test('a viewer gets frames for its acks, drives the helper, and is cut off when sharing is turned off', async t => {
  const seen = [];
  const { app, port } = await start(t, { screen: true, onScreen: v => seen.push(v) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws?ticket=${await ticketFor(port)}`);
  ws.binaryType = 'arraybuffer';
  const lines = [], frames = [];
  let wake;
  ws.onmessage = e => { if (typeof e.data === 'string') lines.push(JSON.parse(e.data).line); else frames.push(new Uint8Array(e.data)); wake?.(); };
  const until = async ok => { const end = Date.now() + 5000; while (!ok()) { if (Date.now() > end) throw new Error('timed out; got ' + JSON.stringify(lines)); await new Promise(r => { wake = r; setTimeout(r, 100); }); } };
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'config', monitor: -1, width: 1280, quality: 60 }));
  ws.send(JSON.stringify({ t: 'key', code: 'KeyA', down: true }));
  ws.send(JSON.stringify({ t: 'key', code: 'Nope', down: true }));
  ws.send(JSON.stringify({ t: 'ack' }));
  await until(() => lines.includes('f 1'));
  assert.deepEqual(lines, ['c -1 1280 60', 'f 2', 'k 65 0 1', 'f 1']);
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]], [1, 0, 0, 0, 0, 2, 0, 2, 0, 2, 0, 2, 0, ...Buffer.from('jpeg')]);
  assert.deepEqual(seen, [{ address: '127.0.0.1' }]);
  const viewer = JSON.parse((await call(port, '/api/screen', { headers: AUTH })).body).viewer;
  assert.equal(viewer.address, '127.0.0.1');
  const closed = once(ws, 'close');
  app.setScreen(false);
  const [ev] = await closed;
  assert.equal(ev.code, 4002);
  assert.deepEqual(seen, [{ address: '127.0.0.1' }, null]);
});

// The PC's notifications follow onScreen: a takeover must not report "nobody is viewing" between the two viewers.
test('a second viewer replaces the first without a viewer-gone report in between', async t => {
  const seen = [];
  const { port } = await start(t, { screen: true, onScreen: v => seen.push(v) });
  const first = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws?ticket=${await ticketFor(port)}`);
  await once(first, 'open');
  const closed = once(first, 'close');
  const second = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws?ticket=${await ticketFor(port)}`);
  await once(second, 'open');
  const [ev] = await closed;
  assert.equal(ev.code, 4001);
  assert.deepEqual(seen, [{ address: '127.0.0.1' }, { address: '127.0.0.1' }]);
  assert.match(ev.reason, /Another device/);
  second.close();
});

test('this PC\'s MagicDNS name passes Host/Origin only when the server listens on the tailnet', async t => {
  const tailscale = async () => ({ name: 'my-pc.tail1234.ts.net', ips: ['100.101.102.103'] });
  const wild = await start(t, { tailscale });
  const name = `my-pc.tail1234.ts.net:${wild.port}`;
  assert.equal((await call(wild.port, '/api/state', { headers: { ...AUTH, Host: name, Origin: `http://${name}` } })).status, 200);
  assert.equal((await call(wild.port, '/api/state', { headers: { ...AUTH, Host: `other.tail1234.ts.net:${wild.port}` } })).status, 403);
  const local = await start(t, { tailscale, host: '127.0.0.1' });
  assert.equal((await call(local.port, '/api/state', { headers: { ...AUTH, Host: `my-pc.tail1234.ts.net:${local.port}` } })).status, 403);
});
