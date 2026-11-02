// Two polls out at once with the same since (a poll and the refresh after a send): the companion answers the later-sent
// one first (before an append) and the earlier-sent one after it; the earlier-sent reply lands first (under 1 KB it is
// written at once, the other one waits for gzip; or a phone's link reorders them). Both are applied (each has the highest
// seq when it lands). The second carries no order, so mergeTx kept the order of the transcript the first had moved on,
// labelled with the older rev; the next edit, of the order of that rev, then fits in length and IDs and shows a message
// twice and another one not at all, until something refetches the transcript whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, flush, session, reply, query } from './frontend-network-harness.mjs';
import { createSync } from '../companion/sync.mjs';
import { createMessages } from '../companion/messages.mjs';

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
function companion(sessions) {
  const store = { sessions, activity: [] }, sync = createSync({ store });
  const c = { store, sent: [], ...createMessages({ options: {}, store, scheduleSave() {} }) };
  c.respond = url => {
    if (!url.startsWith('/api/state')) return;
    const q = query(url), viewed = sessions.find(s => s.id === q.session);
    const sx = sync.storeDelta({ projects: [], archived: [] }, q.store ?? '');
    const tx = viewed && sync.transcriptDelta(viewed, q.since ?? '', q.od === '1');
    const t = viewed && (tx?.delta ? tx.tx : { ...(tx?.tx || { session: viewed.id }), messages: viewed.messages });
    c.sent.push(!t ? 'none' : t.messages ? 'whole' : t.orderEdit ? 'edit' : t.order ? 'order' : 'delta');
    return { raw: `{"sx":${sx}${t ? `,"tx":${JSON.stringify(t)}` : ''}}` };
  };
  c.full = async hash => { const page = boot({ hash, respond: url => url.startsWith('/api/state') ? { body: { projects: [], archived: [], sessions: structuredClone(store.sessions) } } : undefined }); await flush(); return page.thread(); };
  return c;
}
const transcript = (id, n) => Array.from({ length: n }, (_, i) => reply(`${id}-${i}`, `reply ${i} in ${id}`, i));
const count = (html, text) => html.split(text).length - 1;

test('a poll answered first but landing second leaves the order of its own rev, so the next edit fits it', async () => {
  const s1 = session('s1', transcript('s1', 600), { status: 'running' }), c = companion([s1]);
  // Per /api/state request while holding: compute when `processed` opens, land when `landed` opens.
  let hold = false; const reqs = [];
  const app = boot({ respond: async url => {
    if (!hold || !url.startsWith('/api/state')) return c.respond(url);
    const r = { processed: gate(), landed: gate() }; reqs.push(r);
    await r.processed.p; const out = c.respond(url); await r.landed.p; return out;
  } });
  await flush();
  hold = true;
  const a = app.loops().at(-1).fn(); await flush();
  const b = app.loops().at(-1).fn(); await flush();
  const [qa, qb] = app.states().slice(-2).map(x => query(x.url));
  assert.equal(qa.since, qb.since); assert.equal(qa.od, '1');
  // The companion answers B (sent second) first, before the reply n1 is added, and A after it.
  reqs[1].processed.open(); await flush();
  c.append(s1, 'assistant', 'first new reply', 'n1');
  reqs[0].processed.open(); await flush();
  assert.deepEqual(c.sent.slice(-2), ['delta', 'edit']);
  // A lands first, then B: both are applied (seq order).
  reqs[0].landed.open(); await flush(); reqs[1].landed.open(); await a; await b; await flush();
  hold = false;
  c.append(s1, 'assistant', 'second new reply', 'n2');
  await app.poll();
  assert.equal(c.sent.at(-1), 'edit', 'the next poll gets an edit');
  const shown = app.thread(), fresh = await c.full();
  assert.equal(count(shown, 'first new reply'), 1, 'n1 shown once');
  assert.equal(shown, fresh, 'reads like a full load');
});

// The same race moves held back under content too: B (answered first) lands after A, then C, sent from what A left, lands
// on what B left. Merged into the transcript held then, C's changes (none after A's rev) leave B's older text of a message
// labelled with A's rev, which no later poll sends again. Merged into the one C was sent with, the text is the companion's.
test('a reply merges into the transcript its poll was sent with, not one an older reply left meanwhile', async () => {
  const s1 = session('s1', transcript('s1', 30), { status: 'running' }), c = companion([s1]);
  let hold = false; const reqs = [];
  const app = boot({ respond: async url => {
    if (!hold || !url.startsWith('/api/state')) return c.respond(url);
    const r = { processed: gate(), landed: gate() }; reqs.push(r);
    await r.processed.p; const out = c.respond(url); await r.landed.p; return out;
  } });
  await flush();
  hold = true;
  const a = app.loops().at(-1).fn(); await flush();
  const b = app.loops().at(-1).fn(); await flush();
  const m = s1.messages[29];
  m.text = 'streaming: half'; reqs[1].processed.open(); await flush();
  m.text = 'streaming: whole reply'; reqs[0].processed.open(); await flush();
  reqs[0].landed.open(); await a; await flush();
  const cPoll = app.loops().at(-1).fn(); await flush();
  reqs[1].landed.open(); await b; await flush();
  reqs[2].processed.open(); await flush(); reqs[2].landed.open(); await cPoll; await flush();
  hold = false;
  await app.poll(); await app.poll();
  assert.doesNotMatch(app.thread(), /streaming: half/, 'the older text is not left in place');
  assert.equal(app.thread(), await c.full(), 'reads like a full load');
});
