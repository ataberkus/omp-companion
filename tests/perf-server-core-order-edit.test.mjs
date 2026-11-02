// Order edits (od=1, companion/sync.mjs transcriptDelta): a changed message order goes out as an edit of the order the
// dashboard holds, which app.js applies with its editOrder (taken from the source here); without od, replies are exactly
// what they were. Transcripts are changed with the companion's own writers (messages.mjs append/place/dropSteers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSync } from '../companion/sync.mjs';
import { createMessages } from '../companion/messages.mjs';
import { createCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

const source = await readFile(new URL('../local-dist/app.js', import.meta.url), 'utf8');
const editOrder = new Function(source.match(/\n {2}function editOrder\([\s\S]*?\r?\n {2}\}\r?\n/)[0] + 'return editOrder;')();

// transcriptDelta as it was before order edits (serializing to compare, which gives the same revs: see
// perf-server-core-sync.test.mjs).
function transcriptDeltaBefore() {
  const txSync = new Map();
  return (s, since) => {
    const list = s.messages || [], ids = new Set();
    for (const m of list) { if (typeof m?.id !== 'string' || ids.has(m.id)) { txSync.delete(s.id); return null; } ids.add(m.id); }
    const c = txSync.get(s.id) || { epoch: randomBytes(6).toString('base64url'), rev: 0, orderRev: 0, order: [], entries: new Map() };
    txSync.delete(s.id); txSync.set(s.id, c); if (txSync.size > 8) txSync.delete(txSync.keys().next().value);
    const entries = new Map(), next = c.rev + 1; let changed = false, reordered = list.length !== c.order.length;
    for (let i = 0; i < list.length; i++) {
      const m = list[i], json = JSON.stringify(m), prev = c.entries.get(m.id);
      if (prev?.json === json) entries.set(m.id, prev); else { entries.set(m.id, { json, rev: next }); changed = true; }
      if (c.order[i] !== m.id) reordered = true;
    }
    if (changed || reordered) c.rev = next;
    if (reordered) { c.orderRev = next; c.order = [...ids]; }
    c.entries = entries;
    const held = /^([\w-]{1,32})\.(\d{1,15})$/.exec(since || ''), rev = held?.[1] === c.epoch ? Number(held[2]) : -1;
    if (!(rev >= 0 && rev <= c.rev)) return { delta: false, tx: { session: s.id, epoch: c.epoch, rev: c.rev } };
    return { delta: true, tx: { session: s.id, epoch: c.epoch, rev: c.rev, ...(c.orderRev > rev ? { order: c.order } : {}), changed: list.filter(m => entries.get(m.id).rev > rev) } };
  };
}

const msg = (id, role = 'assistant', extra = {}) => ({ id, role, text: 'text of ' + id, at: new Date(Date.UTC(2026, 0, 1)).toISOString(), ...extra });
const ids = s => s.messages.map(m => m.id);
function setup(n) {
  const s = { id: 's', messages: Array.from({ length: n }, (_, i) => msg('m' + i)) }, store = { sessions: [s], activity: [] };
  return { s, sync: createSync({ store }), ...createMessages({ options: {}, store, scheduleSave() {} }) };
}
// A dashboard as app.js keeps one: the epoch and rev it holds and its transcript's IDs. A whole transcript replaces them
// (sent without an epoch when IDs repeat: nothing held then), an edit applies to them, an order replaces them. Every ID
// of the new order must be held or among the changed messages, as mergeTx resolves them.
function dashboard(sync, s, od = true) {
  const d = { held: null, poll(rev) {
    const r = sync.transcriptDelta(s, d.held ? `${d.held.epoch}.${rev ?? d.held.rev}` : '', od);
    if (!r) { d.held = null; return r; }
    let next = d.held?.ids;
    if (!r.delta) next = ids(s);
    else if (r.tx.orderEdit) { next = editOrder(d.held.ids, r.tx.orderEdit); assert.ok(next, 'the edit fits the order held'); }
    else if (r.tx.order) next = [...r.tx.order];
    if (r.delta) { const known = new Set([...d.held.ids, ...r.tx.changed.map(m => m.id)]); assert.ok(next.every(id => known.has(id)), 'every ID resolves'); }
    d.held = { epoch: r.tx.epoch, rev: r.tx.rev, ids: next };
    return r;
  } };
  return d;
}

test('a changed order goes out as an edit: appends, the 600 cap, inserts before unread steers, a cancelled steer, a steer read out of turn', () => {
  const { s, sync, append, place } = setup(600), d = dashboard(sync, s);
  assert.equal(d.poll().delta, false, 'the first poll gets the whole transcript');
  const step = (expected, label) => { const r = d.poll(); assert.equal(r.tx.order, undefined, label); assert.deepEqual(r.tx.orderEdit, expected, label); assert.deepEqual(d.held.ids, ids(s), label); return r; };
  append(s, 'assistant', 'a reply', 'n1');
  const r = step({ drop: 1, at: 599, del: 0, add: ['n1'], n: 600 }, 'one message added: the cap drops the oldest');
  assert.ok(JSON.stringify(r.tx.orderEdit).length * 50 < JSON.stringify(ids(s)).length, 'far smaller than the order');
  append(s, 'thinking', 'hmm', 'n2'); append(s, 'tool', 'Done', 'tool-n3'); append(s, 'assistant', 'more', 'n4');
  step({ drop: 3, at: 597, del: 0, add: ['n2', 'tool-n3', 'n4'], n: 600 }, 'three between polls');
  const st = append(s, 'user', 'look at the tests too', 'st1'); st.steer = 'pending';
  step({ drop: 1, at: 599, del: 0, add: ['st1'], n: 600 }, 'a steer');
  append(s, 'assistant', 'still on it', 'n5'); append(s, 'tool', 'Done', 'tool-n6');
  step({ drop: 2, at: 597, del: 0, add: ['n5', 'tool-n6'], n: 600 }, 'the turn goes on before the unread steer');
  assert.equal(s.messages.at(-1).id, 'st1');
  s.messages.splice(s.messages.indexOf(st), 1);
  step({ drop: 0, at: 599, del: 1, add: [], n: 599 }, 'the steer cancelled');
  const a = append(s, 'user', 'first steer', 'st2'), b = append(s, 'user', 'second steer', 'st3'); a.steer = b.steer = 'pending';
  d.poll();
  const [read] = s.messages.splice(s.messages.indexOf(b), 1); delete read.steer; place(s, read);
  assert.deepEqual(ids(s).slice(-2), ['st3', 'st2']);
  step({ drop: 0, at: 598, del: 2, add: ['st3', 'st2'], n: 600 }, 'OMP read the second steer first: it moves up');
  // A transcript under the cap only grows.
  const small = setup(40), e = dashboard(small.sync, small.s);
  e.poll(); small.append(small.s, 'assistant', 'hi', 'x1');
  assert.deepEqual(e.poll().tx.orderEdit, { drop: 0, at: 40, del: 0, add: ['x1'], n: 41 });
});

test('the order goes out whole for a reset, a reorder that moves many, a big change, an order older than the history, and without od', () => {
  const { s, sync, append } = setup(40), d = dashboard(sync, s), plain = dashboard(sync, s, false);
  d.poll(); plain.poll();
  const whole = label => { const r = d.poll(); assert.equal(r.tx.orderEdit, undefined, label); assert.deepEqual(r.tx.order, ids(s), label); assert.deepEqual(d.held.ids, ids(s), label); };
  s.messages.reverse(); whole('reversed');
  s.messages = []; append(s, 'system', 'Started a new session.', 'fresh'); whole('a reset (/new)');
  for (let i = 0; i < 39; i++) append(s, 'assistant', 'reply ' + i, 'r' + i);
  whole('39 messages added to 1');
  for (let i = 0; i < 14; i++) append(s, 'assistant', 'reply', 'q' + i);
  whole('14 added to 40: a quarter of the new order or more');
  for (let i = 0; i < 13; i++) append(s, 'assistant', 'reply', 'p' + i);
  const r = d.poll(); assert.deepEqual(r.tx.orderEdit?.add.length, 13, '13 added to 54: an edit');
  // A swap near the end is a small edit, not a reorder that goes out whole.
  const n = s.messages.length; [s.messages[n - 2], s.messages[n - 1]] = [s.messages[n - 1], s.messages[n - 2]];
  assert.deepEqual(d.poll().tx.orderEdit, { drop: 0, at: n - 2, del: 2, add: ids(s).slice(-2), n });
  // Without od: the order, every time.
  const r2 = plain.poll(); assert.equal(r2.tx.orderEdit, undefined); assert.deepEqual(r2.tx.order, ids(s));
  // History: 24 order changes are kept (on a 600-message session, so that 23 added stay under a quarter). A dashboard
  // that holds the order from 23 changes ago gets an edit; from 24, the order.
  const h = setup(600), other = dashboard(h.sync, h.s), late = dashboard(h.sync, h.s), later = dashboard(h.sync, h.s);
  other.poll(); late.poll(); later.poll();
  h.append(h.s, 'assistant', 'x', 'h0'); other.poll(); const lateRev = late.held.rev; later.poll();
  for (let i = 1; i < 24; i++) { h.append(h.s, 'assistant', 'x', 'h' + i); other.poll(); }
  assert.ok(later.poll().tx.orderEdit, 'the order held 23 changes ago is still kept');
  assert.equal(late.held.rev, lateRev);
  const old = late.poll(); assert.equal(old.tx.orderEdit, undefined, '24 changes ago: no longer kept'); assert.deepEqual(late.held.ids, ids(h.s));
});

// A page in the background polls every 8 s (app.js loop), a visible one on a working session every 1.2 s. Each visible
// dashboard's poll records the order it sees, so while 2 or 3 of them watch a streaming session a hidden page falls
// 13-20 orders behind between its polls (seen in Chromium: with 8 kept it got the whole order). Steps of 0.4 s, a
// message every step at the 600 cap: the hidden page's polls are all edits.
test('a hidden page beside visible dashboards on a streaming session still gets edits', () => {
  const { s, sync, append } = setup(600), visible = [dashboard(sync, s), dashboard(sync, s), dashboard(sync, s)], hidden = dashboard(sync, s);
  for (const d of [...visible, hidden]) d.poll();
  const got = { edit: 0, order: 0 };
  for (let step = 1; step <= 200; step++) {
    append(s, step % 3 ? 'assistant' : 'tool', 'x', 'live' + step);
    visible.forEach((d, i) => { if (step % 3 === i) d.poll(); });
    if (step % 20 === 0) { const r = hidden.poll(); got[r.tx.orderEdit ? 'edit' : 'order']++; assert.deepEqual(hidden.held.ids, ids(s)); }
  }
  assert.deepEqual(got, { edit: 10, order: 0 });
});

test('dashboards at different revs each get an edit of the order they hold', () => {
  const { s, sync, append } = setup(600), D = [dashboard(sync, s), dashboard(sync, s), dashboard(sync, s)];
  for (const d of D) d.poll();
  let edits = 0, n = 0;
  for (let step = 1; step <= 40; step++) {
    append(s, 'assistant', 'reply ' + step, 'a' + step);
    if (step % 3 === 0) { const st = append(s, 'user', 'steer ' + step, 'st' + step); st.steer = 'pending'; }
    if (step % 5 === 0) append(s, 'tool', 'Done', 'tool-' + step);
    // Every 1st, 2nd and 4th step: 1 to 6 order changes since each one's last poll.
    D.forEach((d, i) => { if (step % [1, 2, 4][i] === 0) { const r = d.poll(); n++; if (r.tx.orderEdit) edits++; assert.ok(r.tx.orderEdit || r.tx.order, `step ${step}: the order changed`); assert.deepEqual(d.held.ids, ids(s), `dashboard ${i}, step ${step}`); } });
  }
  assert.equal(edits, n, 'every one an edit');
  // Several dashboards at one rev get the same edit.
  const [a, b] = [dashboard(sync, s), dashboard(sync, s)]; a.poll(); b.held = { ...a.held };
  append(s, 'assistant', 'one more', 'last');
  assert.deepEqual(a.poll().tx.orderEdit, b.poll().tx.orderEdit);
});

test('epochs: another epoch or a future rev gets the whole transcript; repeated IDs and an evicted entry start a new epoch', () => {
  const { s, sync, append } = setup(30), d = dashboard(sync, s);
  d.poll(); const { epoch, rev } = d.held;
  append(s, 'assistant', 'x', 'x1');
  assert.equal(sync.transcriptDelta(s, `other.${rev}`, true).delta, false, 'another epoch');
  assert.equal(sync.transcriptDelta(s, `${epoch}.${rev + 5}`, true).delta, false, 'a rev the companion never gave');
  assert.ok(d.poll().tx.orderEdit, 'the held rev still gets an edit');
  s.messages.push({ ...s.messages[0] });
  assert.equal(d.poll(), null, 'repeated IDs: the transcript goes whole, with no epoch');
  s.messages.pop(); append(s, 'assistant', 'y', 'y1');
  const stale = sync.transcriptDelta(s, `${epoch}.${rev}`, true);
  assert.equal(stale.delta, false, 'the old epoch is gone');
  assert.notEqual(stale.tx.epoch, epoch);
  d.poll(); append(s, 'assistant', 'z', 'z1');
  assert.ok(d.poll().tx.orderEdit, 'edits resume in the new epoch');
  // Nine other viewed sessions evict this one's entry (8 kept): the next poll starts a new epoch.
  for (let i = 0; i < 9; i++) sync.transcriptDelta({ id: 'o' + i, messages: [msg('o' + i)] }, '', true);
  const held = d.held; append(s, 'assistant', 'w', 'w1');
  assert.equal(d.poll().delta, false);
  assert.notEqual(d.held.epoch, held.epoch);
});

test('without od, replies are byte for byte what they were before order edits', () => {
  const { s, sync, append, place } = setup(598), before = transcriptDeltaBefore();
  let sinceA = '', sinceB = '', epochs = null;
  const check = label => {
    const a = before(s, sinceA), b = sync.transcriptDelta(s, sinceB);
    if (!a || !b) { assert.equal(b, a, label); sinceA = sinceB = ''; return; }
    assert.equal(JSON.stringify(b).split(b.tx.epoch).join('E'), JSON.stringify(a).split(a.tx.epoch).join('E'), label);
    sinceA = `${a.tx.epoch}.${a.tx.rev}`; sinceB = `${b.tx.epoch}.${b.tx.rev}`; epochs = [a.tx.epoch, b.tx.epoch];
  };
  check('first');
  const steps = [
    () => append(s, 'assistant', 'a', 'a1'), () => { append(s, 'tool', 'b', 'tool-b'); append(s, 'assistant', 'c', 'c1'); append(s, 'assistant', 'd', 'd1'); },
    () => { const st = append(s, 'user', 'steer', 'st'); st.steer = 'pending'; append(s, 'assistant', 'e', 'e1'); },
    () => { const [m] = s.messages.splice(s.messages.findIndex(m => m.id === 'st'), 1); delete m.steer; place(s, m); },
    () => s.messages.splice(10, 1), () => s.messages.reverse(), () => { s.messages = []; append(s, 'system', 'fresh', 'f'); },
    () => { s.messages.at(-1).text += '!'; }, () => s.messages.push({ ...s.messages[0] }), () => s.messages.pop(), () => append(s, 'assistant', 'g', 'g1'),
  ];
  for (const [i, step] of steps.entries()) { step(); check(`step ${i}`); check(`step ${i}, again`); }
  assert.ok(epochs);
});

// Random order changes through the companion's writers, polled by dashboards at random times (some without od, one that
// often stays away longer than the history, one that sometimes drops what it holds). After every poll each one holds
// the companion's order; an od reply is the plain one with the order as an edit; a plain one is the old implementation's.
test('randomized: dashboards polling at random times always hold the companion\'s order', t => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }, pick = a => a[Math.floor(rnd() * a.length)];
  const { s, sync, append, place, dropSteers } = setup(590), before = transcriptDeltaBefore();
  let n = 0;
  const unread = () => s.messages.filter(m => m.steer === 'pending' || m.steer === 'received');
  const ops = [
    [30, () => append(s, pick(['assistant', 'thinking', 'tool', 'system']), 'text', 'r' + n++)],
    [8, () => { const m = append(s, 'user', 'steer', 'u' + n++); if (rnd() < 0.7) m.steer = 'pending'; }],
    [10, () => { const m = pick(s.messages); if (m) m.text += '.'; }],
    [5, () => { const m = pick(unread()); if (m) s.messages.splice(s.messages.indexOf(m), 1); }],
    [5, () => { const m = pick(unread()); if (m) { s.messages.splice(s.messages.indexOf(m), 1); delete m.steer; place(s, m); } }],
    [2, () => dropSteers(s)],
    [1, () => { s.messages = [...s.messages].sort((a, b) => (a.role === 'system') - (b.role === 'system')); }],
    [1, () => { s.messages = []; append(s, 'system', 'fresh', 'f' + n++); }],
    [3, () => { if (s.messages.length) s.messages.splice(Math.floor(rnd() * s.messages.length), 1); }],
    [2, () => { s.messages = s.messages.slice(-Math.floor(300 + rnd() * 300)); }],
    [1, () => { for (let i = 0, k = 1 + Math.floor(rnd() * 200); i < k; i++) append(s, 'assistant', 'burst', 'b' + n++); }],
    [1, () => { const m = pick(s.messages); if (m) s.messages.push({ ...m }); }],
    [3, () => { s.messages = [...new Map(s.messages.map(m => [m.id, m])).values()]; }],
    [2, () => { const i = Math.floor(rnd() * s.messages.length), j = Math.floor(rnd() * s.messages.length); if (s.messages.length) [s.messages[i], s.messages[j]] = [s.messages[j], s.messages[i]]; }],
  ], total = ops.reduce((a, [w]) => a + w, 0);
  const op = () => { let r = rnd() * total; for (const [w, f] of ops) if ((r -= w) < 0) return f(); };
  // Each dashboard: how often it polls, od, and its held state for both implementations (A: before, B: now).
  const D = [{ p: 0.9, od: true }, { p: 0.5, od: true }, { p: 0.3, od: false }, { p: 0.08, od: true }, { p: 0.4, od: true, drop: 0.03 }].map(d => ({ ...d, a: '', b: '', ids: null }));
  const count = { edit: 0, order: 0, whole: 0, null: 0, plain: 0 };
  for (let i = 0; i < 2500; i++) {
    for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) op();
    for (const [j, d] of D.entries()) {
      if (rnd() > d.p) continue;
      if (d.drop && rnd() < d.drop) { d.a = d.b = ''; d.ids = null; }
      const a = before(s, d.a), b = sync.transcriptDelta(s, d.b, d.od), label = `poll ${i}, dashboard ${j}`;
      if (!a || !b) { assert.equal(b, a, label); d.a = d.b = ''; d.ids = null; count.null++; continue; }
      if (!b.delta) { d.ids = ids(s); count.whole++; }
      else {
        const known = new Set([...d.ids, ...b.tx.changed.map(m => m.id)]);
        if (b.tx.orderEdit) { assert.ok(d.od, label); d.ids = editOrder(d.ids, b.tx.orderEdit); assert.ok(d.ids, `${label}: the edit fits`); assert.deepEqual(d.ids, a.tx.order, `${label}: the order the plain reply sends`); count.edit++; }
        else if (b.tx.order) { d.ids = [...b.tx.order]; count.order++; }
        assert.ok(d.ids.every(id => known.has(id)), `${label}: every ID resolves`);
      }
      assert.deepEqual(d.ids, ids(s), `${label}: holds the companion's order`);
      const plain = { ...b, tx: { ...b.tx } }; if (plain.tx.orderEdit) { delete plain.tx.orderEdit; plain.tx = { session: plain.tx.session, epoch: plain.tx.epoch, rev: plain.tx.rev, order: a.tx.order, changed: plain.tx.changed }; }
      assert.equal(JSON.stringify(plain).split(b.tx.epoch).join('E'), JSON.stringify(a).split(a.tx.epoch).join('E'), `${label}: the old reply, but for the order's form`);
      if (!d.od) count.plain++;
      d.a = `${a.tx.epoch}.${a.tx.rev}`; d.b = `${b.tx.epoch}.${b.tx.rev}`;
    }
  }
  t.diagnostic(JSON.stringify(count));
  assert.ok(count.edit > 1500 && count.order > 100 && count.whole > 20 && count.null > 5 && count.plain > 500, JSON.stringify(count));
});

test('/api/state sends the edit with od=1, and the order without it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-order-edit-'));
  const at = new Date().toISOString(), messages = Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, role: 'assistant', text: 'reply ' + i, at }));
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({ projects: [{ id: 'p', path: dir, name: 'P' }], sessions: [{ id: 'a', projectId: 'p', title: 'a', status: 'paused', cwd: dir, model: 'OMP default', native: false, messages, todos: [], createdAt: at, updatedAt: at }], activity: [] }));
  const app = await createCompanion({ dataDir: dir, omp: fakeOmp() });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const get = async q => (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state?${q}`, { headers: { Authorization: 'Bearer ' + app.token } })).json();
  const first = await get('session=a&since=&store=&od=1'), since = `${first.tx.epoch}.${first.tx.rev}`;
  assert.equal(first.tx.messages.length, 40, 'nothing held: the whole transcript');
  app.store.sessions[0].messages.push({ id: 'n1', role: 'assistant', text: 'new', at });
  const edit = await get(`session=a&since=${since}&store=&od=1`), plain = await get(`session=a&since=${since}&store=`);
  assert.deepEqual(edit.tx.orderEdit, { drop: 0, at: 40, del: 0, add: ['n1'], n: 41 });
  assert.equal(edit.tx.order, undefined);
  assert.deepEqual(plain.tx.order, [...messages.map(m => m.id), 'n1']);
  assert.equal(plain.tx.orderEdit, undefined);
  const legacy = await get(`session=a&since=${since}&od=1`);
  assert.deepEqual(legacy.tx.orderEdit, edit.tx.orderEdit, 'a poll without store too');
});
