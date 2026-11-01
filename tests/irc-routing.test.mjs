import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeIrc, treeRoot } from '../companion/irc-scope.mjs';

const MAIN = 'Main';

// OMP's AgentRegistry and IrcBus as far as IRC routing goes (registry/agent-registry.ts, irc/bus.ts): one of each per
// process, recipients resolved by id, agent↔agent traffic relayed to the session registered as "Main".
class Registry {
 #refs = new Map();
 register(ref) { this.#refs.set(ref.id, { status: 'running', kind: 'sub', ...ref }); }
 get(id) { return this.#refs.get(id); }
 list() { return [...this.#refs.values()]; }
 listVisibleTo(id) { return this.list().filter(ref => ref.id !== id && ref.kind !== 'advisor' && (ref.status === 'running' || ref.status === 'idle')); }
}
class Bus {
 constructor(registry) { this.registry = registry; }
 async send(msg, opts) {
  const session = this.registry.get(msg.to)?.session;
  if (!session) return { to: msg.to, outcome: 'failed', error: 'unknown' };
  session.deliverIrcMessage(msg);
  if (!opts?.suppressRelay && msg.to !== MAIN && msg.from !== MAIN) this.registry.get(MAIN)?.session?.emitIrcRelayObservation({ customType: 'irc:relay', content: `[IRC \`${msg.from}\` → \`${msg.to}\`]\n\n${msg.body}` });
  return { to: msg.to, outcome: 'injected' };
 }
}
// A session's transcript: what reached its model (deliveries) and what its chat shows (irc_message events).
function session() {
 const s = { delivered: [], shown: [] };
 s.deliverIrcMessage = msg => { s.delivered.push(msg); s.shown.push(`[IRC in] ${msg.from}: ${msg.body}`); };
 s.emitIrcRelayObservation = record => { s.shown.push(record.content); };
 return s;
}
// OMP's irc tool (irc/messaging.ts executeSend): "all" goes to every agent the registry lists as visible to the sender.
async function ircSend(bus, registry, from, to, body) {
 const targets = to === 'all' ? registry.listVisibleTo(from).map(r => r.id) : [to];
 return Promise.all(targets.map(t => bus.send({ from, to: t, body, ...(to === 'all' ? { broadcast: true } : {}) }, { suppressRelay: to === 'all' && targets.includes(MAIN) })));
}

// Two companion sessions in one process, as omp.mjs opens them: top-level agents companion:<id>, each with two subagents.
function twoSessions() {
 const registry = new Registry(), bus = new Bus(registry);
 scopeIrc(registry, bus, MAIN);
 const a = session(), b = session(), subs = Object.fromEntries(['LuaVisMap', 'AimMap', 'Otoyol', 'Kopru'].map(id => [id, session()]));
 registry.register({ id: 'companion:a', kind: 'main', session: a });
 registry.register({ id: 'companion:b', kind: 'main', session: b });
 for (const id of ['LuaVisMap', 'AimMap']) registry.register({ id, parentId: 'companion:a', session: subs[id] });
 for (const id of ['Otoyol', 'Kopru']) registry.register({ id, parentId: 'companion:b', session: subs[id] });
 return { registry, bus, a, b, subs };
}

test('subagent IRC traffic shows only in its own session', async () => {
 const { registry, bus, a, b, subs } = twoSessions();
 const [receipt] = await ircSend(bus, registry, 'LuaVisMap', 'AimMap', 'Quick Q');
 assert.equal(receipt.outcome, 'injected');
 assert.deepEqual(subs.AimMap.delivered.map(m => m.body), ['Quick Q']);
 assert.deepEqual(a.shown, ['[IRC `LuaVisMap` → `AimMap`]\n\nQuick Q']);
 assert.deepEqual(b.shown, []);
 assert.deepEqual(b.delivered, []);
});

test('a broadcast reaches only the sender session agents', async () => {
 const { registry, bus, a, b, subs } = twoSessions();
 const receipts = await ircSend(bus, registry, 'LuaVisMap', 'all', 'hello');
 assert.deepEqual(receipts.map(r => r.to).sort(), ['AimMap', 'companion:a']);
 assert.deepEqual(a.delivered.map(m => m.body), ['hello']);
 // The session's own agent got the broadcast itself, so the leg to AimMap is not relayed again.
 assert.deepEqual(a.shown, ['[IRC in] LuaVisMap: hello']);
 assert.deepEqual([b, subs.Otoyol, subs.Kopru].map(s => s.delivered.length + s.shown.length), [0, 0, 0]);
});

test('an agent cannot message or wake another session', async () => {
 const { registry, bus, b, subs } = twoSessions();
 for (const to of ['Otoyol', 'companion:b']) {
  const [receipt] = await ircSend(bus, registry, 'LuaVisMap', to, 'psst');
  assert.equal(receipt.outcome, 'failed');
  assert.match(receipt.error, /Unknown agent/);
 }
 assert.deepEqual([b, subs.Otoyol].map(s => s.delivered.length + s.shown.length), [0, 0]);
});

test('messages to and from a session own agent are delivered and not relayed twice', async () => {
 const { registry, bus, a, b, subs } = twoSessions();
 await ircSend(bus, registry, 'AimMap', 'companion:a', 'done');
 await ircSend(bus, registry, 'companion:a', 'LuaVisMap', 'next');
 assert.deepEqual(a.delivered.map(m => m.body), ['done']);
 assert.deepEqual(a.shown, ['[IRC in] AimMap: done']);
 assert.deepEqual(subs.LuaVisMap.delivered.map(m => m.body), ['next']);
 assert.deepEqual(b.shown, []);
});

test('nested subagents belong to their top-level session', () => {
 const { registry } = twoSessions();
 registry.register({ id: 'Deep', parentId: 'AimMap' });
 assert.equal(treeRoot(registry, 'Deep'), 'companion:a');
 assert.equal(treeRoot(registry, 'Kopru'), 'companion:b');
});
