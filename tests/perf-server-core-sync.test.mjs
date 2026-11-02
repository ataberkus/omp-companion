import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSync } from '../companion/sync.mjs';

// companion/sync.mjs as it was when each poll serialized every message and summary to compare them; the structural
// comparison must give exactly its replies.
function createSyncBefore(ctx) {
  const { store } = ctx;
  const txSync = new Map();
  function transcriptDelta(s, since) {
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
  }
  const storeSync = { epoch: randomBytes(6).toString('base64url'), rev: 0, top: '', topRev: 0, order: [], orderRev: 0, entries: new Map() };
  function storeDelta(top, since) {
    const c = storeSync, next = c.rev + 1, entries = new Map(), order = []; let changed = false;
    for (const s of store.sessions) {
      if (entries.has(s.id)) return null;
      const json = JSON.stringify({ ...s, messages: undefined, _btw: undefined }), prev = c.entries.get(s.id);
      if (prev?.json === json) entries.set(s.id, prev); else { entries.set(s.id, { json, rev: next }); changed = true; }
      order.push(s.id);
    }
    const topJson = JSON.stringify(top); if (topJson !== c.top) { c.top = topJson; c.topRev = next; changed = true; }
    if (order.length !== c.order.length || order.some((id, i) => id !== c.order[i])) { c.order = order; c.orderRev = next; changed = true; }
    if (changed) c.rev = next;
    c.entries = entries;
    const held = /^([\w-]{1,32})\.(\d{1,15})$/.exec(since || ''), rev = held?.[1] === c.epoch ? Number(held[2]) : -1, all = !(rev >= 0 && rev <= c.rev), out = [];
    for (const e of entries.values()) if (all || e.rev > rev) out.push(e.json);
    return `{"epoch":"${c.epoch}","rev":${c.rev}${all || c.topRev > rev ? `,"top":${c.top}` : ''}${all || c.orderRev > rev ? `,"order":${JSON.stringify(c.order)}` : ''},"changed":[${out.join(',')}]}`;
  }
  return { transcriptDelta, storeDelta };
}

// JSON.parse makes "__proto__" an own key; a copy that set it as the prototype instead never compared equal, so that
// message went out again, under a new rev, on every poll.
test('a message holding a "__proto__" key is unchanged on the next poll', () => {
  const s = { id: 's', messages: JSON.parse('[{"id":"a","role":"tool","tool":{"name":"write","args":{"__proto__":{"x":1},"path":"p"}}},{"id":"b","role":"tool","tool":{"args":{"__proto__":5}}}]') };
  const sync = createSync({ store: { sessions: [s] } });
  const first = sync.transcriptDelta(s, '');
  const second = sync.transcriptDelta(s, `${first.tx.epoch}.${first.tx.rev}`);
  assert.equal(second.tx.rev, first.tx.rev);
  assert.deepEqual(second.tx.changed, []);
  s.messages[0].tool.args.__proto__.x = 2;
  const third = sync.transcriptDelta(s, `${first.tx.epoch}.${first.tx.rev}`);
  assert.deepEqual(third.tx.changed.map(m => m.id), ['a'], 'a change inside it still goes out');
});

// Values JSON treats specially: unchanged polls keep their rev under both comparisons.
test('special values keep the revs the serializing comparison gave', () => {
  const cases = {
    plain: () => [{ id: 'a', role: 'user', text: 'hi' }],
    'integer-like keys': () => [{ id: 'a', meta: { 2: 'x', 1: 'y', b: 1 } }],
    'sparse array': () => [{ id: 'a', list: [, 1, , 2] }],
    'skipped values': () => [{ id: 'a', u: undefined, f() {}, y: Symbol('y'), list: [undefined, () => 1, NaN, -0, Infinity] }],
    'Date leaf': () => [{ id: 'a', at: new Date(5) }],
    'boxed string': () => [{ id: 'a', t: new String('ab') }],
    'Map value': () => [{ id: 'a', m: new Map([[1, 2]]) }],
    'null prototype': () => [Object.assign(Object.create(null), { id: 'a', x: { y: 1 } })],
  };
  for (const [name, make] of Object.entries(cases)) {
    const revs = [createSyncBefore, createSync].map(create => {
      const s = { id: 's', messages: make() }, sync = create({ store: { sessions: [s] } }), out = [];
      let since = '';
      for (let i = 0; i < 3; i++) { const r = sync.transcriptDelta(s, since); out.push([r.tx.rev, r.delta ? r.tx.changed.length : null]); since = `${r.tx.epoch}.${r.tx.rev}`; }
      return out;
    });
    assert.deepEqual(revs[1], revs[0], name);
    assert.deepEqual(revs[0], [[1, null], [1, 0], [1, 0]], name);
  }
});

// Differential fuzz: both implementations on one store under random mutations (in-place edits, added and removed keys,
// undefined, NaN, Dates, "__proto__" keys, key-order changes, reorders, replaced arrays, repeated IDs), polled with held,
// stale, future and unknown revs. Replies must be identical but for the random epochs.
test('transcript and store deltas match the serializing comparison over randomized polls', () => {
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }, pick = a => a[Math.floor(rnd() * a.length)];
  const words = 'the of and to in code file function return value error test build session tool result change line'.split(' ');
  const text = n => Array.from({ length: n }, () => pick(words)).join(' ');
  let ids = 0;
  const message = () => {
    const id = 'm' + ids++, r = rnd();
    if (r < 0.3) return { id, role: pick(['user', 'assistant', 'thinking']), text: text(20), at: new Date(1e12 + ids).toISOString() };
    return { id: 'tool-' + id, role: 'tool', text: 'Done', tool: { name: pick(['edit', 'bash', 'read']), args: JSON.parse(pick(['{"path":"a.js"}', '{"command":"ls","i":"list"}', '{"__proto__":{"p":1},"path":"b.js"}'])), status: 'done', result: text(30), ...(rnd() < 0.4 ? { files: [{ path: 'a.js', op: 'modify', diff: '+1|x' }] } : {}) } };
  };
  const session = i => ({ id: 's' + i, projectId: 'p', title: text(4), status: pick(['review', 'running', 'done']), cwd: '/w', createdAt: 'c', updatedAt: 'u' + i, tokens: i, cost: rnd(), todos: rnd() < 0.5 ? [{ name: 'p', tasks: [{ content: text(3), status: 'pending' }] }] : [], advisor: { enabled: false } });
  const store = { projects: [{ id: 'p', name: 'P' }], sessions: Array.from({ length: 30 }, (_, i) => session(i)) };
  for (const s of store.sessions.slice(0, 5)) s.messages = Array.from({ length: 40 }, message);
  for (const s of store.sessions.slice(5)) Object.defineProperty(s, 'messages', { get() { throw new Error('a summary read the transcript'); }, set(v) { Object.defineProperty(s, 'messages', { value: v, writable: true, enumerable: true, configurable: true }); }, enumerable: false, configurable: true });
  const A = createSyncBefore({ store }), B = createSync({ store });
  const vals = () => pick([undefined, null, NaN, Infinity, 0, -0, 1, 'x', '', 'yyyyy', [], [undefined, 1], { a: 1 }, { b: undefined }, () => 1, true, false, new Date(0), JSON.parse('{"__proto__":{"q":1}}')]);
  const listed = s => Object.getOwnPropertyDescriptor(s, 'messages')?.enumerable;
  function mutate() {
    const s = pick(store.sessions), m = listed(s) && s.messages.length ? pick(s.messages) : null, k = rnd();
    if (k < 0.15 && m) m.text = (m.text || '') + 'z';
    else if (k < 0.25 && m) m[pick(['extra', 'steer', 'entryId', 'text'])] = vals();
    else if (k < 0.32 && m) delete m[pick(['extra', 'steer', 'entryId', 'model'])];
    else if (k < 0.38 && m?.tool) m.tool.files = rnd() < 0.5 ? [{ path: 'a', diff: 'b' }] : undefined;
    else if (k < 0.41 && m?.tool) Object.defineProperty(m.tool.args, '__proto__', { value: rnd() < 0.5 ? { p: vals() } : vals(), enumerable: true, writable: true, configurable: true });
    else if (k < 0.43 && m?.tool) m.tool.result += '';
    else if (k < 0.48 && listed(s)) s.messages.push(message());
    else if (k < 0.52 && listed(s) && s.messages.length > 2) { const [x] = s.messages.splice(0, 1); s.messages.push(x); }
    else if (k < 0.55 && listed(s)) s.messages = s.messages.slice(-30);
    else if (k < 0.57 && listed(s) && s.messages.length > 1) s.messages.push({ ...s.messages[0] });
    else if (k < 0.58 && listed(s) && s.messages.length > 1) s.messages.pop();
    else if (k < 0.7) s[pick(['status', 'updatedAt', '_overlaps', 'title', 'tokens', '_btw', 'newField', 'todos'])] = vals();
    else if (k < 0.75) delete s[pick(['newField', '_overlaps', 'error', 'advisor', '_btw'])];
    else if (k < 0.78) { const v = s._overlaps; delete s._overlaps; if (v !== undefined) s._overlaps = v; }
    else if (k < 0.8) store.sessions.push(session(store.sessions.length + ids++));
    else if (k < 0.81) store.sessions.reverse();
    else if (k < 0.815) store.sessions.push(store.sessions[0]);
    else if (k < 0.82 && store.sessions.length > 30) store.sessions.splice(-1, 1);
    else if (k < 0.85) s.todos = [{ name: 'p', tasks: [{ content: 'c', status: pick(['pending', 'completed']) }] }];
    else if (k < 0.87 && m) m.nested = { list: [1, { q: vals() }] };
    else if (k < 0.89 && !listed(s)) s.messages = Array.from({ length: 5 }, message);
    else if (k < 0.9) Object.defineProperty(s, '__proto__', { value: { at: vals() }, enumerable: true, writable: true, configurable: true });
    if (rnd() < 0.05) store.sessions = [...new Map(store.sessions.map(x => [x.id, x])).values()];
    for (const x of store.sessions) if (listed(x) && rnd() < 0.05) x.messages = [...new Map(x.messages.map(y => [y.id, y])).values()];
  }
  const norm = (str, epoch) => str.split(epoch).join('EPOCH');
  const top = { projects: store.projects, ui: { x: 1 } };
  const held = new Map();
  let last = null, checks = 0, deltas = 0;
  for (let i = 0; i < 3000; i++) {
    for (let n = 1 + Math.floor(rnd() * 4); n > 0; n--) mutate();
    if (rnd() < 0.05) top.ui = { x: vals() };
    const kind = rnd(), rev = last ? (kind < 0.6 ? last.a.rev : kind < 0.8 ? Math.max(0, last.a.rev - Math.floor(rnd() * 3)) : last.a.rev + 5) : 0;
    const oa = A.storeDelta(top, kind < 0.95 && last ? `${last.a.epoch}.${rev}` : ''), ob = B.storeDelta(top, kind < 0.95 && last ? `${last.b.epoch}.${rev}` : '');
    assert.equal(ob === null, oa === null, `storeDelta null at poll ${i}`);
    if (oa !== null) { const pa = JSON.parse(oa), pb = JSON.parse(ob); assert.equal(norm(ob, pb.epoch), norm(oa, pa.epoch), `storeDelta at poll ${i}`); last = { a: pa, b: pb }; checks++; }
    for (const s of store.sessions.filter(x => listed(x) && x.messages.length).slice(0, 3)) {
      const h = held.get(s.id), k = rnd(), r = h && (k < 0.7 ? h.rev : Math.max(0, h.rev - 1));
      const xa = A.transcriptDelta(s, h && k < 0.9 ? `${h.a}.${r}` : ''), xb = B.transcriptDelta(s, h && k < 0.9 ? `${h.b}.${r}` : '');
      assert.equal(xb === null, xa === null, `transcriptDelta null at poll ${i}`);
      if (xa === null) { held.delete(s.id); continue; }
      assert.equal(norm(JSON.stringify(xb), xb.tx.epoch), norm(JSON.stringify(xa), xa.tx.epoch), `transcriptDelta at poll ${i}`);
      held.set(s.id, { a: xa.tx.epoch, b: xb.tx.epoch, rev: xa.tx.rev }); checks++; if (xa.delta) deltas++;
    }
  }
  assert.ok(checks > 8000 && deltas > 4000, `enough compared replies (${checks}, ${deltas} deltas)`);
});
