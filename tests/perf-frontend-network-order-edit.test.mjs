// The dashboard against companion/sync.mjs itself: once it holds a transcript its polls send od=1, a changed order
// arrives as an edit of the order held (tx.orderEdit), and the merged transcript reads exactly like a full load. An edit
// that does not fit what was held refetches the transcript whole, as any delta that does not fit does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, flush, session, reply, query } from './frontend-network-harness.mjs';
import { createSync } from '../companion/sync.mjs';
import { createMessages } from '../companion/messages.mjs';

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
// /api/state as companion/routes/sessions.mjs answers a dashboard's poll (session, since, od, store), on the real sync,
// with the companion's own transcript writers. sent: what each reply's tx carried; tamper: rewrites the next one's tx.
function companion(sessions) {
  const store = { sessions, activity: [] }, sync = createSync({ store });
  const c = { store, sent: [], tamper: null, ...createMessages({ options: {}, store, scheduleSave() {} }) };
  c.respond = url => {
    if (!url.startsWith('/api/state')) return;
    const q = query(url), viewed = sessions.find(s => s.id === q.session);
    const sx = sync.storeDelta({ projects: [], archived: [] }, q.store ?? '');
    const tx = viewed && sync.transcriptDelta(viewed, q.since ?? '', q.od === '1');
    let t = viewed && (tx?.delta ? tx.tx : { ...(tx?.tx || { session: viewed.id }), messages: viewed.messages });
    if (t && c.tamper) { t = c.tamper(structuredClone(t)); c.tamper = null; }
    c.sent.push(!t ? 'none' : t.messages ? 'whole' : t.orderEdit ? 'edit' : t.order ? 'order' : 'delta');
    return { raw: `{"sx":${sx}${t ? `,"tx":${JSON.stringify(t)}` : ''}}` };
  };
  // A fresh page's first load of the same store (whole, from a companion of before deltas): what the merged one must show.
  c.full = async hash => { const page = boot({ hash, respond: url => url.startsWith('/api/state') ? { body: { projects: [], archived: [], sessions: structuredClone(store.sessions) } } : undefined }); await flush(); return page.thread(); };
  return c;
}
const transcript = (id, n) => Array.from({ length: n }, (_, i) => reply(`${id}-${i}`, `reply ${i} in ${id}`, i));

test('once a transcript is held, polls send od=1; appends, steers, a cancelled steer and the 600 cap arrive as edits and read like a full load', async () => {
  const s1 = session('s1', transcript('s1', 598), { status: 'running' }), c = companion([s1, session('s2', transcript('s2', 3))]);
  const app = boot({ respond: c.respond });
  await flush();
  assert.deepEqual(query(app.states()[0].url), { session: 's1', since: '', store: '' }, 'nothing held yet: no od');
  assert.deepEqual(c.sent, ['whole']);
  let steer;
  const steps = [
    ['an append', () => c.append(s1, 'assistant', 'a new reply', 'n1')],
    ['two more: the cap drops the oldest', () => { c.append(s1, 'thinking', 'considering', 'n2'); c.append(s1, 'assistant', 'and more', 'n3'); }],
    ['a steer', () => { steer = c.append(s1, 'user', 'look at the docs too', 'st1'); steer.steer = 'pending'; }],
    ['the turn goes on before the unread steer', () => { c.append(s1, 'tool', 'Done · read', 'tool-n4'); c.append(s1, 'assistant', 'still going', 'n5'); }],
    ['the steer cancelled', () => s1.messages.splice(s1.messages.indexOf(steer), 1)],
  ];
  for (const [label, step] of steps) {
    step();
    const n = c.sent.length;
    await app.poll();
    assert.equal(query(app.states().at(-1).url).od, '1', `${label}: od=1`);
    assert.deepEqual(c.sent.slice(n), ['edit'], `${label}: an edit, no refetch`);
    assert.equal(app.thread(), await c.full(), `${label}: reads like a full load`);
  }
  assert.deepEqual([s1.messages.length, s1.messages[0].id], [599, 's1-4'], 'the cap dropped the four oldest');
  // A reorder goes out as the whole order, which the page takes as before.
  s1.messages.reverse();
  await app.poll();
  assert.equal(c.sent.at(-1), 'order');
  assert.equal(app.thread(), await c.full());
});

test('an edit that does not fit the order held refetches the whole transcript at once', async () => {
  const s1 = session('s1', transcript('s1', 40)), c = companion([s1]);
  const app = boot({ respond: c.respond });
  await flush();
  // Nothing works: a poll renders only when it brings something, and an edit alone (a message removed) does.
  s1.messages.splice(20, 1);
  await app.poll();
  assert.equal(c.sent.at(-1), 'edit');
  assert.doesNotMatch(app.thread(), /reply 20 in s1/, 'the removed message is gone');
  assert.equal(app.thread(), await c.full());
  const cases = [
    ['another length', e => ({ ...e, n: e.n + 1 })],
    ['out of bounds', e => ({ ...e, at: e.at + 5 })],
    ['an ID it never got', e => ({ ...e, add: ['ghost'] })],
    ['a count that is no number', e => ({ ...e, drop: '0' })],
    ['a negative count', e => ({ ...e, drop: -1, at: e.at + 1 })],
    ['no list of IDs', e => ({ ...e, add: 'n' })],
  ];
  for (const [label, wrong] of cases) {
    c.append(s1, 'assistant', 'reply for ' + label, 'r-' + label);
    c.tamper = t => ({ ...t, orderEdit: wrong(t.orderEdit) });
    const n = c.sent.length;
    await app.poll();
    assert.deepEqual(c.sent.slice(n), ['edit', 'whole'], `${label}: refetched whole right away`);
    assert.equal(query(app.states().at(-1).url).since, '', label);
    assert.equal(app.thread(), await c.full(), label);
  }
  c.append(s1, 'assistant', 'after the refetch', 'last');
  await app.poll();
  assert.equal(c.sent.at(-1), 'edit', 'edits resume from the refetched transcript');
  assert.equal(app.thread(), await c.full());
});

test('switching back to a session viewed before (S.txPrev) gets an edit of the order held for it', async () => {
  const s1 = session('s1', transcript('s1', 600), { status: 'running' }), s2 = session('s2', transcript('s2', 10)), c = companion([s1, s2]);
  const app = boot({ respond: c.respond });
  await flush();
  const held = query(app.states().at(-1).url);
  await app.poll();
  const since = query(app.states().at(-1).url).since;
  assert.match(since, /\.\d+$/);
  await app.go('#/s/s2');
  // s1 goes on while s2 is viewed here; another dashboard viewing s1 has the companion record each order change.
  const other = boot({ respond: c.respond });
  await flush();
  for (let i = 0; i < 4; i++) { c.append(s1, 'assistant', 'while away ' + i, 'away' + i); await other.poll(); }
  const st = c.append(s1, 'user', 'a steer', 'st'); st.steer = 'pending'; c.append(s1, 'tool', 'Done', 'tool-away');
  const n = c.sent.length;
  await app.go('#/s/s1');
  assert.deepEqual(query(app.states().at(-1).url), { session: 's1', since, od: '1', store: query(app.states().at(-1).url).store }, 'asked with the rev held from the earlier view');
  assert.deepEqual(c.sent.slice(n), ['edit'], 'an edit across six order changes, not the order or the whole transcript');
  assert.equal(app.thread(), await c.full());
  assert.equal(held.since, '');
  c.append(s1, 'assistant', 'back again', 'back');
  await app.poll();
  assert.equal(c.sent.at(-1), 'edit');
  assert.equal(app.thread(), await c.full());
});

// Two polls out at once with the same rev (a poll, and the refresh after a send): the older lands first and moves the
// held transcript on; the newer one's edit is of the order both were sent with. Applied to the order the first left
// (600 messages, the cap dropping one per append) it would fit in length and show n1 twice.
test('a poll that lands after another applies its edit to the order it was sent with', async () => {
  const s1 = session('s1', transcript('s1', 600), { status: 'running' }), c = companion([s1]), gates = [];
  let hold = false;
  const app = boot({ respond: async url => { const r = c.respond(url); if (hold && url.startsWith('/api/state')) { const g = gate(); gates.push(g); await g.p; } return r; } });
  await flush();
  hold = true;
  c.append(s1, 'assistant', 'first', 'n1');
  const a = app.loops().at(-1).fn(); await flush();
  c.append(s1, 'assistant', 'second', 'n2');
  const b = app.loops().at(-1).fn(); await flush();
  const [qa, qb] = app.states().slice(-2).map(x => query(x.url));
  assert.equal(qa.since, qb.since, 'both sent with the rev held');
  assert.deepEqual(c.sent.slice(-2), ['edit', 'edit']);
  hold = false;
  gates[0].open(); await flush(); gates[1].open(); await a; await b; await flush();
  assert.equal(c.sent.length, 3, 'no refetch');
  assert.equal(app.thread(), await c.full());
  c.append(s1, 'assistant', 'third', 'n3');
  await app.poll();
  assert.equal(c.sent.at(-1), 'edit');
  assert.equal(app.thread(), await c.full());
});
