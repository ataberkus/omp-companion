// OMP's session list loads alongside /state, conditionally (ETag). A list that arrives is shown even when its refresh
// drops its /state reply (a delta that no longer fits), or every later load would be a 304 for a list never shown; and
// only the refresh that started the load waits for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, flush, session, store, reply, query, at } from './frontend-network-harness.mjs';

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const listing = n => ({ dir: '/omp', sessions: Array.from({ length: n }, (_, i) => ({ file: `/omp/cli${i}.jsonl`, title: 'CLI run ' + i, cwd: '/project', updatedAt: at(-50 - i), preview: 'x' })) });

// /state with transcript deltas as companion/sync.mjs answers since=<epoch>.<rev> (same epoch => changes only).
function stateServer(ids) {
  const tx = Object.fromEntries(ids.map(id => [id, { epoch: 'E' + id, rev: 1, msgs: [{ ...reply(id + '.1', 'opening reply in ' + id), rev: 1 }] }]));
  const strip = ({ rev, ...m }) => m, log = [];
  return { tx, log, respond(url) {
    const { session: v, since = '' } = query(url), t = tx[v], [ep, rv] = since.split('.'), delta = !!t && ep === t.epoch;
    log.push(v + ':' + (delta ? 'delta' : 'whole'));
    const sessions = ids.map(id => session(id, id === v && !delta ? tx[id].msgs.map(strip) : undefined));
    return { body: { ...store(sessions), ...(t ? { tx: delta ? { session: v, epoch: t.epoch, rev: t.rev, order: t.msgs.map(m => m.id), changed: t.msgs.filter(m => m.rev > +rv).map(strip) } : { session: v, epoch: t.epoch, rev: t.rev } } : {}) } };
  } };
}
// /omp-sessions as routes/history.mjs tagged() answers it: ETag = digest of the body, 304 on a matching If-None-Match.
function listServer() {
  const L = { data: listing(1), inm: [], hold: null };
  L.respond = async call => { L.inm.push(call.inm ?? null); if (L.hold) await L.hold.p; const tag = '"L' + L.data.sessions.length + '"'; return call.inm === tag ? { status: 304 } : { body: L.data, headers: { ETag: tag } }; };
  return L;
}

async function switchAround({ width, path }) {
  const st = stateServer(['s1', ...path]), L = listServer(), held = [];
  let holdState = false;
  const app = boot({ size: { width, height: 844 }, respond: async (url, call) => {
    if (url.startsWith('/api/state')) { if (holdState) { const g = gate(); held.push(g); await g.p; } return st.respond(url); }
    if (url.startsWith('/api/omp-sessions')) return L.respond(call);
  } });
  await flush();
  assert.match(app.list(), /CLI run 0/);
  assert.doesNotMatch(app.list(), /CLI run 1/);
  // A slow link: the user taps through other sessions before their transcripts arrive, then back to s1.
  holdState = true;
  for (const id of path) await app.go('#/s/' + id);
  await app.advance(21000); // the listing is due on the next refresh
  L.data = listing(2); // a new run shows up in OMP's history meanwhile (started from the CLI)
  await app.go('#/s/s1'); // route() does not refresh: S.store still holds s1's messages (s2's and s3's replies are out)
  const poll = app.loops().at(-1).fn(); // the next poll starts the listing; it asks for s1's changes since the rev held for it
  await flush();
  holdState = false;
  for (const g of held.splice(0)) { g.open(); await flush(); }
  await poll; await flush(30);
  const right = /CLI run 1/.test(app.list());
  for (let i = 0; i < 3; i++) { await app.advance(21000); await app.poll(); }
  const later = /CLI run 1/.test(app.list());
  return { right, later, state: st.log.join(' '), inm: L.inm };
}

test('session list, phone (txPrev cap 1): s1 -> s2 -> s3 -> s1 while replies are slow; the listing that lands with the failed delta is kept in the sidebar', async () => {
  const r = await switchAround({ width: 390, path: ['s2', 's3'] });
  assert.ok(r.later, 'the new OMP history entry shows in the sidebar');
});

test('session list, desktop (txPrev cap 2): s1 -> s2 -> s3 -> s4 -> s1 while replies are slow', async () => {
  const r = await switchAround({ width: 1360, path: ['s2', 's3', 's4'] });
  assert.ok(r.later, 'the new OMP history entry shows in the sidebar');
});

test('opening another session while a poll\'s listing is still loading renders on its own /state reply', async () => {
  const st = stateServer(['s1', 's2']), L = listServer();
  const app = boot({ respond: async (url, call) => {
    if (url.startsWith('/api/state')) return st.respond(url);
    if (url.startsWith('/api/omp-sessions')) return L.respond(call);
  } });
  await flush();
  assert.match(app.thread(), /opening reply in s1/);
  await app.advance(21000);
  L.hold = gate();
  const poll = app.loops().at(-1).fn(); // this poll starts the listing; the companion (or link) is slow with it
  await flush();
  await app.go('#/s/s2');
  await flush(30);
  const now = /opening reply in s2/.test(app.thread());
  await app.advance(10000);
  const t10 = /opening reply in s2/.test(app.thread());
  L.hold.open(); await poll; await flush(30);
  const after = /opening reply in s2/.test(app.thread());
  assert.ok(now, 's2 renders on its own /state reply');
});

test('the refresh after Enter does not wait for an in-flight listing (composer not held busy)', async () => {
  const st = stateServer(['s1']), L = listServer();
  let sent = 0;
  const app = boot({ respond: async (url, call) => {
    if (url.startsWith('/api/state')) { if (sent === 1) { sent++; const t = st.tx.s1; t.rev++; t.msgs.push({ ...reply('s1.' + t.rev, 'answer to the prompt', 5), rev: t.rev }); } return st.respond(url); }
    if (url.startsWith('/api/omp-sessions')) return L.respond(call);
    if (/\/command/.test(url)) { sent = 1; return { body: { ...session('s1'), messages: undefined, status: 'running', queuedMessages: [] } }; }
  } });
  await flush();
  await app.advance(21000);
  L.hold = gate();
  const poll = app.loops().at(-1).fn();
  await flush();
  await app.type('please answer');
  await flush(30);
  const shown = /answer to the prompt/.test(app.thread());
  L.hold.open(); await poll; await flush(30);
  assert.ok(shown);
});
