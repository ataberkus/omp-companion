// OMP keeps one agent registry and one IRC bus per process (AgentRegistry.global(), IrcBus.global()) and assumes they serve a
// single top-level session: a broadcast reaches every live agent in the process, and agent↔agent traffic is shown on the
// agent registered as "Main" (IrcBus#relayToMainUi). The companion runs many sessions in one process, each a top-level agent
// `companion:<session id>` (omp.mjs #open) whose subagents link to it through parentId. scopeIrc partitions both by that
// tree, so one session's agents never reach, wake or show up in another session:
// - a broadcast only lists the sender's own tree (listVisibleTo);
// - a message between two registered agents of different trees fails as if the recipient were unknown;
// - agent↔agent traffic inside a tree is shown on that tree's top-level session, as OMP shows it on "Main".
const installed = new WeakSet();

/** The top-level agent `id` descends from through parentId links (itself when it has no parent). */
export function treeRoot(registry, id) {
 const seen = new Set();
 let current = id;
 for (let ref = registry.get(current); ref?.parentId !== undefined && !seen.has(current); ref = registry.get(current)) {
  seen.add(current);
  current = ref.parentId;
 }
 return current;
}

// OMP's relay record (IrcBus#relayToMainUi), so the dashboard renders it as before.
const relayRecord = message => ({
 role: 'custom',
 customType: 'irc:relay',
 content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
 display: true,
 details: { from: message.from, to: message.to, body: message.body },
 attribution: 'agent',
 timestamp: Date.now(),
});

/** Partitions OMP's process-global registry and bus by agent tree; installs once per registry/bus. */
export function scopeIrc(registry, bus, mainAgentId) {
 if (!installed.has(registry)) {
  installed.add(registry);
  const listVisibleTo = registry.listVisibleTo;
  registry.listVisibleTo = function (id) {
   const root = treeRoot(this, id);
   return listVisibleTo.call(this, id).filter(ref => treeRoot(this, ref.id) === root);
  };
 }
 if (installed.has(bus)) return;
 installed.add(bus);
 const send = bus.send;
 bus.send = async function (msg, opts) {
  const root = treeRoot(registry, msg.to);
  // Unregistered senders (OMP's /cleanse follow-ups come from "Main") keep OMP's routing.
  if (registry.get(msg.from) && registry.get(msg.to) && treeRoot(registry, msg.from) !== root) {
   return { to: msg.to, outcome: 'failed', error: `Unknown agent "${msg.to}" — check the subagent roster or read history:// for known peers.` };
  }
  const receipt = await send.call(this, msg, opts);
  // OMP relays to "Main" itself, and the top-level agent shows messages it sends or receives on its own. A broadcast leg
  // is not relayed when the broadcast also reaches the top-level agent, which then shows it (OMP's suppressRelay).
  if (receipt.outcome === 'failed' || opts?.suppressRelay || root === mainAgentId) return receipt;
  if ([msg.from, msg.to].some(id => id === root || id === mainAgentId)) return receipt;
  if (msg.broadcast && registry.listVisibleTo(msg.from).some(ref => ref.id === root)) return receipt;
  try { registry.get(root)?.session?.emitIrcRelayObservation?.(relayRecord(msg)); }
  catch (e) { console.error('Companion IRC relay failed:', e); }
  return receipt;
 };
}
