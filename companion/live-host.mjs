// /live: OMP's TUI (modes/controllers/live-command-controller.ts) toggles a Codex realtime voice call (live/controller.ts:
// the computer's microphone and speakers through native AudioCapture, a CodexLiveTransport WebRTC call on the user's
// openai-codex login) whose delegated requests run as ordinary turns of this session. The companion drives it through
// RpcLiveBridge, the piece OMP's RPC host uses for live_start/live_mute/live_stop, so the audio is that of the machine
// running the companion, not the browser's. The TUI's visualizer becomes a widget (phase, speech heard so far); final
// transcripts and delegated requests go into the chat. Stop, closing the session and any session change end the call
// (in the TUI the visualizer holds the keyboard, so a session only changes under it through a switch, which ends it).
import { builtinEntry } from './command-hosts.mjs';

export const host = {
 name: 'live',
 async load({ at, m }) {
  const [{ RpcLiveBridge }, messages] = await Promise.all([at('modes/rpc/rpc-live.ts'), at('session/messages.ts')]);
  const entry = {
   ...builtinEntry(m.builtinRegistry, 'live'), input: { hint: '[start|stop|mute|unmute]' },
   subcommands: [
    { name: 'start', description: 'Start a live voice call' }, { name: 'stop', description: 'End the live voice call' },
    { name: 'mute', description: 'Mute the microphone' }, { name: 'unmute', description: 'Unmute the microphone' },
   ],
  };
  return io => new LiveCommand(io, entry, RpcLiveBridge, messages.LIVE_DELEGATION_MESSAGE_TYPE);
 },
};

class LiveCommand {
 names = ['live'];
 #io; #entry; #bridge; #delegation;
 // #on: from /live until its call ends; late frames of an ended call never redraw the widget.
 #on = false; #starting = false; #phase; #heard = {};
 constructor(io, entry, RpcLiveBridge, delegation) {
  this.#io = io; this.#entry = entry; this.#delegation = delegation;
  this.#bridge = new RpcLiveBridge(io.session, frame => this.#frame(frame));
 }
 commands() { return [this.#entry]; }

 async run(parsed) {
  const action = parsed.args.trim().toLowerCase();
  const active = this.#bridge.active;
  if (action === 'start' || (!action && !active)) return this.#start();
  if (action === 'stop' || !action) {
   if (!active) throw new Error('No live session is active.');
   await this.#bridge.stop();
   return;
  }
  if (action === 'mute' || action === 'unmute') {
   const { muted } = this.#bridge.setMuted(action === 'mute');
   this.#io.output(muted ? 'Live microphone muted; the call stays connected.' : 'Live microphone unmuted.');
   return;
  }
  throw new Error('Usage: /live [start|stop|mute|unmute]');
 }

 async #start() {
  if (this.#bridge.active) throw new Error('A live session is already active. Use /live stop to end it.');
  this.#on = true; this.#starting = true; this.#heard = {};
  try {
   const { voice } = await this.#bridge.start();
   this.#io.output(`Live voice call started (voice ${voice}) on the microphone and speakers of the computer running the companion. Speak to talk; it asks this session's agent to do the work. /live mute, /live unmute, and /live or Stop ends the call.`);
  } catch (e) {
   this.#clear();
   throw new Error(`Live voice could not start: ${e instanceof Error ? e.message : e}`);
  } finally { this.#starting = false; }
 }

 #frame(f) {
  if (f.type === 'live_phase') { this.#phase = f.phase; this.#render(); }
  else if (f.type === 'live_transcript') {
   this.#heard[f.role] = f.final ? undefined : f.text;
   if (f.final) this.#io.output(f.role === 'user' ? `🎙 You (live): ${f.text}` : f.text);
   this.#render();
  } else if (f.type === 'live_end') {
   this.#clear();
   // A failed start is reported by /live itself.
   if (!this.#starting) this.#io.notice(f.error ? 'error' : 'info', f.error ? `Live voice call ended: ${f.error}` : 'Live voice call ended.');
  }
 }

 #render() {
  if (!this.#on) return;
  const lines = [`🎙 Live voice — ${this.#phase ?? 'connecting'} · microphone and speakers of the companion's computer`];
  if (this.#heard.user) lines.push(`You: ${this.#heard.user}`);
  if (this.#heard.assistant) lines.push(`Live: ${this.#heard.assistant}`);
  lines.push('/live mute · /live unmute · /live or Stop ends the call');
  this.#io.ui.setWidget('live', lines);
 }
 #clear() {
  if (!this.#on) return;
  this.#on = false; this.#phase = undefined; this.#heard = {};
  this.#io.ui.setWidget('live', undefined);
 }

 // What the live call asked the agent to do, as the TUI shows the delegation message in its chat.
 observe(event) {
  const msg = event.type === 'message_end' ? event.message : undefined;
  if (msg?.role === 'custom' && msg.customType === this.#delegation && typeof msg.content === 'string') this.#io.output(`🎙 Live asked the agent: ${msg.content}`);
 }

 #end() { return this.#bridge.stop().catch(e => console.error('Live voice cleanup failed:', e)); }
 abort() { void this.#end(); }
 beforeSessionChange() { return this.#end(); }
 beforeSwitch() { return this.#end(); }
 dispose() { return this.#end(); }
}
