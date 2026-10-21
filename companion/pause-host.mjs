// /pause: OMP's TUI runs runPauseScreen (pi-tui overlays/pause-screen.ts), which engages pi-agent-core's agentPauseGate
// and holds a fullscreen screen until a resume key. The gate is process-global and every companion session runs in this
// process, so here /pause freezes the agents of ALL sessions (main agents, subagents, advisors) at their next model or
// tool call; nothing is aborted and running calls finish. A Resume dialog stands in for the pause screen (any answer
// resumes), every session shows a widget while the gate is engaged, and Stop or closing a session that holds a Resume
// dialog resumes too, so nothing stays frozen without a control. Pausing one session alone needs a per-session gate in
// OMP: agent-loop.ts polls only the process-wide `agentPauseGate` singleton (pi-agent-core src/pause.ts).
import { builtinEntry } from './command-hosts.mjs';

export const host = {
 name: 'pause',
 async load({ pkg, m }) {
  const [{ agentPauseGate }, { formatCoarseDuration }] = await Promise.all([pkg('@oh-my-pi/pi-agent-core'), pkg('@oh-my-pi/pi-tui/chrome/format')]);
  if (typeof agentPauseGate?.pause !== 'function') throw new Error('OMP ships no agentPauseGate');
  const entry = builtinEntry(m.builtinRegistry, 'pause');
  const hold = new PauseHold(agentPauseGate, formatCoarseDuration);
  return io => new PauseCommand(io, entry, hold);
 },
};

const RESUME = 'Resume all agents';

// The gate and the sessions that show it; one per SDK copy, shared by every session the copy runs.
class PauseHold {
 sessions = new Set();
 /** Sessions holding a Resume dialog → the controller that closes it. */
 holders = new Map();
 constructor(gate, duration) {
  this.gate = gate; this.duration = duration;
  gate.onChange(() => { for (const s of this.sessions) s.render(); });
 }
 /** Releases the gate for every session; returns the hold in ms (undefined when it was not engaged). */
 resume() {
  const dialogs = [...this.holders.values()];
  this.holders.clear();
  for (const c of dialogs) c.abort();
  return this.gate.resume();
 }
}

class PauseCommand {
 names = ['pause'];
 #io; #entry; #hold;
 constructor(io, entry, hold) {
  this.#io = io; this.#entry = entry; this.#hold = hold;
  hold.sessions.add(this);
  if (hold.gate.paused) this.render();
 }
 commands() { return [this.#entry]; }

 async run(parsed) {
  if (parsed.args.trim()) throw new Error('/pause takes no arguments.');
  const hold = this.#hold, { output } = this.#io;
  if (hold.holders.has(this)) { output('Agents are already paused. Choose “Resume all agents” in the dialog to continue.'); return; }
  const engaged = hold.gate.pause();
  // Not awaited: the Resume dialog stays up while the dashboard keeps working (Stop, answers, other sessions).
  this.#openResume();
  output(engaged
   ? 'Paused every agent in this companion — all sessions, their subagents and advisors — at their next step. Running calls finish; nothing new starts, and messages you send wait until you resume. Choose “Resume all agents” (or press Stop) to continue.'
   : 'Agents in this companion are already paused from another session. Choose “Resume all agents” here to resume every session.');
 }

 #openResume() {
  const hold = this.#hold, dialog = new AbortController();
  hold.holders.set(this, dialog);
  this.render();
  void this.#io.ui.select('All agents are paused', [{ label: RESUME, description: 'Every session in this companion continues where it stopped.' }], { signal: dialog.signal })
   .catch(() => {})
   .then(() => { if (!dialog.signal.aborted) this.#resume(); });
 }

 #resume() {
  if (!this.#hold.holders.has(this)) return;
  const held = this.#hold.resume();
  if (held !== undefined) this.#io.notice('info', `Resumed after ${this.#hold.duration(held)} — agents in every session are running again.`);
 }

 /** The pause widget for this session (cleared once the gate is released). */
 render() {
  const { gate, holders } = this.#hold;
  if (!gate.paused) { this.#io.ui.setWidget('pause', undefined); return; }
  const since = new Date(gate.pausedAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  this.#io.ui.setWidget('pause', [
   `⏸ Paused since ${since}: every agent in this companion (all sessions, subagents, advisors) holds at its next step.`,
   'Running calls finish; nothing new starts, and queued or new messages wait until you resume.',
   holders.has(this) ? 'Choose “Resume all agents” in the dialog (or press Stop) to continue.'
    : 'Resume from the dialog in the session that paused, or run /pause here for a Resume dialog.',
  ]);
 }

 // Stop, closing the session or OMP's shutdown: a Resume dialog that goes away takes the pause with it.
 abort() { this.#resume(); }
 dispose() {
  this.#hold.sessions.delete(this);
  this.#resume();
 }
}
