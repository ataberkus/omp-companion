// /loop: OMP runs it only in its terminal UI (interactive-mode.ts handleLoopCommand, setLoopPrompt, pauseLoop,
// #scheduleLoopAutoSubmit, #runLoopIteration, #passesLoopCondition). The companion keeps the same loop state on OMP's own
// helpers (modes/loop-limit.ts, modes/loop-condition.ts, loop.mode / loop.conditionTimeoutMs): the loop prompt is /loop's
// inline prompt or the next prompt the user sends while idle, re-sent 800 ms after each turn once the session is idle,
// within the count/duration budget and the --while/--until gate. Stop pauses it (the TUI's Esc); /loop again, or
// /loop off, disables it; a session switch ends it (except the new session loop.mode = reset starts itself).
import { randomUUID } from 'node:crypto';
import { builtinEntry } from './command-hosts.mjs';

// The TUI's delay before each iteration, so Stop can land between turns.
const DELAY_MS = 800;
const FRESH_NOTE = 'Loop iteration started a fresh OMP session (loop.mode = reset). The previous conversation stays in its own session file.';

export const host = {
 name: 'loop',
 async load({ at, m }) {
  const [limits, conditions] = await Promise.all([at('modes/loop-limit.ts'), at('modes/loop-condition.ts')]);
  const { cfgLoopMode, cfgLoopConditionTimeoutMs } = m.modeSettings;
  if (!cfgLoopMode || !cfgLoopConditionTimeoutMs) throw new Error('OMP defines no loop.mode / loop.conditionTimeoutMs settings');
  const base = builtinEntry(m.builtinRegistry, 'loop');
  const entry = {
   ...base,
   // OMP's text names the terminal's Esc key; the dashboard's Stop does the same.
   description: base.description.replace(/\S+ suspends the ongoing loop; \/loop again to disable\./, 'Stop pauses the ongoing loop; /loop again or /loop off disables it.'),
   subcommands: [
    { name: 'off', description: 'Disable loop mode' },
    { name: '--while', usage: "'<command>' [prompt]", description: 'Run another iteration while the shell command exits 0' },
    { name: '--until', usage: "'<command>' [prompt]", description: 'Run another iteration until the shell command exits 0' },
   ],
  };
  return io => new Loop(io, entry, limits, conditions, { cfgLoopMode, cfgLoopConditionTimeoutMs });
 },
};

class Loop {
 names = ['loop'];
 #io; #entry; #limits; #conditions; #cfg;
 #enabled = false; #paused = false; #prompt; #limit; #condition;
 #timer; #conditionAbort; #inline; #resetting = false; #fresh = false; #disposed = false;
 constructor(io, entry, limits, conditions, cfg) { this.#io = io; this.#entry = entry; this.#limits = limits; this.#conditions = conditions; this.#cfg = cfg; }
 commands() { return [this.#entry]; }

 // handleLoopCommand: /loop while enabled disables it; otherwise parse, enable, and hand any inline prompt back as the
 // first iteration (prompted() then records it as the loop prompt).
 run(parsed) {
  const args = parsed.args.trim();
  // Disabled at the user's input: the TUI's next getUserInput then schedules the goal continuation the loop withheld.
  if (this.#enabled) { this.#disable(); this.#io.goal?.release?.(); return { consumed: true }; }
  if (args === 'off') { this.#io.output('Loop mode is off.'); return { consumed: true }; }
  const p = this.#limits.parseLoopArgs(args);
  if (typeof p === 'string') throw new Error(p);
  this.#enabled = true; this.#paused = false; this.#prompt = undefined;
  this.#limit = this.#limits.createLoopLimitRuntime(p.limit);
  this.#condition = p.condition;
  this.#sync();
  const limitSuffix = p.limit ? ` Limited to ${this.#limits.describeLoopLimit(p.limit)}.` : '';
  const remainingSuffix = this.#limit ? ` ${this.#limits.describeLoopLimitRuntime(this.#limit)}.` : '';
  const conditionSuffix = p.condition ? ` Continuing ${this.#conditions.describeLoopCondition(p.condition)}.` : '';
  const tail = p.prompt ? 'Repeating it after each turn.' : 'Your next prompt will repeat after each turn.';
  this.#io.output(`Loop mode enabled.${limitSuffix}${remainingSuffix}${conditionSuffix} ${tail} Stop pauses the ongoing loop; /loop again or /loop off disables it.`);
  if (!p.prompt) return { consumed: true };
  this.#inline = p.prompt;
  return { prompt: p.prompt };
 }

 // setLoopPrompt: a prompt sent while idle (or /loop's inline prompt, even queued behind a turn) becomes the loop prompt;
 // a message queued during a turn does not, nor does an extension command (a local action that starts no turn).
 prompted(text, { queued }) {
  if (!this.#enabled || typeof text !== 'string') return;
  const inline = text === this.#inline;
  if (inline) this.#inline = undefined;
  if (queued && !inline) return;
  if (text.startsWith('/')) {
   const space = text.indexOf(' ');
   if (this.#io.session.extensionRunner?.getCommand(space === -1 ? text.slice(1) : text.slice(1, space)) !== undefined) return;
  }
  this.#abortCondition();
  this.#prompt = text; this.#paused = false;
  this.#sync();
 }

 observe(event) { if (event.type === 'agent_end') this.#schedule(); }

 // The TUI's Esc while loop mode is on (pauseLoop): the turn is stopped, the loop stays on without a prompt.
 abort() {
  if (!this.#enabled) return;
  this.#prompt = undefined; this.#inline = undefined; this.#paused = true;
  this.#cancel(); this.#abortCondition(); this.#flushFresh();
  this.#sync();
 }

 beforeSwitch() { this.#sessionChanging(); }
 beforeSessionChange() { this.#sessionChanging(); }
 dispose() { this.#disposed = true; this.#cancel(); this.#abortCondition(); }

 state() { return { loop: this.#view() }; }
 // The TUI's #scheduleGoalContinuation returns while loop mode is on (paused included).
 holdsGoalContinuation() { return this.#enabled; }

 #sessionChanging() { if (!this.#resetting) this.#disable('The session changed. Loop mode disabled.'); }

 #view() {
  if (!this.#enabled) return null;
  const state = this.#paused ? 'paused' : this.#prompt ? 'running' : 'waiting';
  const bounds = [
   this.#limit ? this.#limits.describeLoopLimitRuntime(this.#limit) : undefined,
   this.#condition ? this.#conditions.describeLoopCondition(this.#condition) : undefined,
  ].filter(Boolean);
  // getTuiAutocompleteDescription's wording.
  const description = state === 'paused' ? 'Loop: paused' : bounds.length ? `Loop: on (${bounds.join(', ')})` : this.#prompt ? 'Loop: on (repeating prompt)' : 'Loop: on (waiting for next prompt)';
  return this.#io.plain({ state, description, ...(this.#prompt ? { prompt: this.#prompt } : {}), ...(this.#limit ? { limit: this.#limit } : {}), ...(this.#condition ? { condition: this.#condition } : {}) });
 }
 #sync() { if (!this.#disposed) this.#io.emit({ type: 'loop_state', loop: this.#view() }); }
 #disable(message = 'Loop mode disabled.') {
  const was = this.#enabled;
  this.#enabled = false; this.#paused = false; this.#prompt = undefined; this.#inline = undefined; this.#limit = undefined; this.#condition = undefined;
  this.#cancel(); this.#abortCondition(); this.#flushFresh();
  this.#sync();
  if (was && !this.#disposed) this.#io.output(message);
 }

 #schedule() {
  this.#cancel();
  if (!this.#enabled || !this.#prompt || this.#disposed) return;
  const prompt = this.#prompt, action = this.#cfg.cfgLoopMode.get(this.#io.session.settings);
  this.#defer(() => this.#iterate(action, prompt));
 }
 #defer(fn) {
  this.#timer = setTimeout(() => {
   this.#timer = undefined;
   if (!this.#enabled || this.#disposed) return;
   this.#io.track(Promise.resolve().then(fn).catch(e => this.#disable(`Loop iteration failed: ${e instanceof Error ? e.message : e}. Loop mode disabled.`)));
  }, DELAY_MS);
 }
 #cancel() { if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; } }
 #abortCondition() { this.#conditionAbort?.abort(); this.#conditionAbort = undefined; }
 // Busy, or user input accepted but not yet started (the TUI's missing onInputCallback): the repeat waits.
 #blocked() { const s = this.#io.session; return s.isStreaming || s.isCompacting || s.hasPostPromptWork || this.#io.inputPending(); }
 #current(prompt) { return this.#enabled && !this.#disposed && this.#prompt === prompt; }
 #vibe() { return this.#io.session.getVibeModeState?.()?.enabled === true; }

 // #runLoopIteration.
 async #iterate(action, prompt) {
  if (!this.#current(prompt)) return;
  if (this.#blocked()) { this.#defer(() => this.#iterate(action, prompt)); return; }
  if (action === 'reset' && this.#vibe()) { this.#disable('Exit vibe mode before using reset loops. Loop mode disabled.'); return; }
  // An exhausted budget ends the loop before the condition command runs once more for nothing.
  if (this.#limits.isLoopLimitExhausted(this.#limit)) { this.#disable('Loop limit reached. Loop mode disabled.'); return; }
  // The gate runs before the budget is spent, so a halt never burns an iteration that did not run.
  if (this.#condition && !(await this.#passes(prompt))) return;
  if (this.#blocked()) { this.#defer(() => this.#iterate(action, prompt)); return; }
  if (action === 'reset' && this.#vibe()) { this.#disable('Exit vibe mode before using reset loops. Loop mode disabled.'); return; }
  if (!this.#limits.consumeLoopLimitIteration(this.#limit)) { this.#disable('Loop limit reached. Loop mode disabled.'); return; }
  this.#sync();
  if (action === 'compact') await this.#compact();
  else if (action === 'reset') await this.#reset();
  this.#submitWhenReady(prompt);
 }

 // #passesLoopCondition.
 async #passes(prompt) {
  const condition = this.#condition, s = this.#io.session;
  const controller = new AbortController();
  this.#abortCondition();
  this.#conditionAbort = controller;
  let verdict;
  try {
   verdict = await this.#conditions.evaluateLoopCondition(condition, {
    cwd: s.sessionManager.getCwd(), timeoutMs: this.#cfg.cfgLoopConditionTimeoutMs.get(s.settings),
    signal: controller.signal, sessionId: s.sessionManager.getSessionId(),
   });
  } finally { if (this.#conditionAbort === controller) this.#conditionAbort = undefined; }
  // Stop or /loop can land while the command runs.
  if (!this.#current(prompt)) return false;
  if (verdict.kind === 'continue') return true;
  if (verdict.kind === 'aborted') return false;
  this.#disable(verdict.message);
  return false;
 }

 // handleCompactCommand without focus: OMP's /compact, awaited here so the prompt follows the compaction.
 async #compact() {
  const io = this.#io, s = io.session;
  if (s.sessionManager.getEntries().filter(e => e.type === 'message').length < 2) { io.notice('warning', 'Nothing to compact (no messages yet)'); return; }
  const signal = new AbortController().signal;
  await io.rt.builtins.executeAcpBuiltinSlashCommand('/compact', { ...io.commandRuntime(signal), runCommandInBackground: undefined });
 }

 // handleClearCommand: a new session for each iteration; the loop carries over into it. The dashboard shows the fresh
 // transcript with the iteration's prompt (loop_iteration fresh), or reloads it if the loop stops before sending one.
 async #reset() {
  this.#resetting = true;
  let r;
  try { r = await this.#io.queueSessionChange('new_session', {}); }
  finally { this.#resetting = false; }
  if (!r?.cancelled) this.#fresh = true;
 }
 #flushFresh() {
  if (!this.#fresh || this.#disposed) return;
  this.#fresh = false;
  this.#io.emit({ type: 'session_replaced', note: FRESH_NOTE });
 }

 // #submitLoopPromptWhenReady.
 #submitWhenReady(prompt) {
  if (!this.#current(prompt)) return;
  if (this.#limits.isLoopDurationExpired(this.#limit)) { this.#disable('Loop time limit reached. Loop mode disabled.'); return; }
  if (this.#blocked()) { this.#defer(() => this.#submitWhenReady(prompt)); return; }
  const id = randomUUID(), fresh = this.#fresh;
  this.#fresh = false;
  this.#io.emit({ type: 'loop_iteration', id, text: prompt, ...(fresh ? { fresh: true, note: FRESH_NOTE } : {}) });
  // Fire and forget: the prompt queues behind whatever the companion is doing. A rejected prompt parks the loop.
  this.#io.submit(prompt, undefined, id).catch(e => {
   if (this.#prompt === prompt) this.abort();
   this.#io.notice('error', `Loop prompt failed: ${e instanceof Error ? e.message : e}`);
  });
 }
}
