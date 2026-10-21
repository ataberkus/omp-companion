// /vibe and /guided-goal: OMP runs them only in its terminal UI (InteractiveMode.handleVibeModeCommand and
// handleGuidedGoalCommand). The companion runs the same session calls: vibe mode's tool swap, director context, worker
// registry scope and journal entry, its reconcile across session switches (InteractiveMode#reconcileModeFromSession's
// vibe part, on OMP's switch reconcilers), and the guided-goal interview kickoff. Goal mode itself stays with the
// session's goal controller (io.goal).
import { builtinEntry } from './command-hosts.mjs';

export const host = {
 name: 'vibe, /guided-goal',
 async load({ at, pkg, text, m }) {
  const [vibe, goalSettings, resolver, utils, core, interview] = await Promise.all([
   at('vibe/runtime.ts'), at('goals/settings.ts'), at('config/model-resolver.ts'), pkg('@oh-my-pi/pi-utils'), pkg('@oh-my-pi/pi-agent-core'),
   text('prompts/goals/guided-goal-interview.md'),
  ]);
  const sdk = {
   registry: vibe.VibeSessionRegistry.global(), cfgGoalEnabled: goalSettings.cfgGoalEnabled, formatModelString: resolver.formatModelString,
   render: values => utils.prompt.render(interview, values), AgentBusyError: core.AgentBusyError,
   entries: { vibe: builtinEntry(m.builtinRegistry, 'vibe'), guided: builtinEntry(m.builtinRegistry, 'guided-goal') },
  };
  return async io => {
   const h = new ModeCommands(io, sdk);
   await h.reconcile().catch(e => io.notice('error', `Vibe mode could not be restored: ${e instanceof Error ? e.message : e}`));
   return h;
  };
 },
};

const sameScope = (a, b) => a && a.ownerId === b.ownerId && a.parentSessionId === b.parentSessionId && a.parentSessionFile === b.parentSessionFile;
// The pre-vibe tool names a session journaled with its vibe mode_change (InteractiveMode readPersistedToolNames).
const persistedTools = v => Array.isArray(v) && v.every(n => typeof n === 'string') ? v : undefined;

class ModeCommands {
 names = ['vibe', 'guided-goal'];
 #io; #sdk; #enabled = false; #previousTools; #scope; #suspendedForSwitch = false;
 constructor(io, sdk) { this.#io = io; this.#sdk = sdk; }

 commands() {
  const { vibe, guided } = this.#sdk.entries;
  return this.#sdk.cfgGoalEnabled.get(this.#io.session.settings) ? [vibe, guided] : [vibe];
 }
 state() { return { vibeMode: { enabled: this.#enabled } }; }

 run(parsed, { images }) {
  return parsed.name === 'vibe' ? this.#vibe(parsed.args.trim(), images) : this.#guidedGoal(parsed.args.trim(), images);
 }

 // InteractiveMode#vibeParentSession: the session vibe workers belong to.
 #parent() {
  const s = this.#io.session, manager = s.sessionManager, format = this.#sdk.formatModelString;
  return {
   getAgentId: () => s.getAgentId() ?? null, getSessionId: () => manager.getSessionId(), getSessionFile: () => manager.getSessionFile() ?? null,
   sessionManager: manager, asyncJobManager: s.asyncJobManager, settings: s.settings,
   getActiveModelString: () => s.model ? format(s.model) : undefined,
  };
 }
 #status() { this.#io.ui.setStatus('vibe', this.#enabled ? 'Vibe mode: you direct worker sessions (/vibe to exit)' : undefined); }
 // InteractiveMode#warnPlanModeBlocks: active and paused plan mode both block (the paused state lives in the plan host).
 #planBlocks() {
  const plan = this.#io.planMode;
  if (plan?.paused) throw new Error('Plan mode is paused — run /plan again to fully exit.');
  if (plan?.enabled || this.#io.session.getPlanModeState()?.enabled) throw new Error('Exit plan mode first.');
 }

 async #vibe(prompt, images) {
  const s = this.#io.session;
  if (this.#enabled) { await this.#exit(); return { consumed: true }; }
  this.#planBlocks();
  const goal = s.getGoalModeState();
  if (goal?.enabled || goal?.goal?.status === 'paused') throw new Error('Exit goal mode first.');
  await this.#enter();
  if (!prompt) return { consumed: true };
  // The prompt is vibe mode's first turn; while a turn runs it steers that turn, as in the TUI.
  if (s.isStreaming) { await s.prompt(prompt, { streamingBehavior: 'steer', images: images?.length ? images : undefined }); return { consumed: true }; }
  return { prompt };
 }

 // InteractiveMode#enterVibeMode. `silent`: restored on resume or switch, where the status indicator is the only notice.
 async #enter({ persistModeChange = true, previousTools, silent = false } = {}) {
  if (this.#enabled) return;
  const s = this.#io.session, registry = this.#sdk.registry, scope = registry.ownerScope(this.#parent());
  registry.activateScope(scope);
  const previous = previousTools ?? s.getEnabledToolNames();
  await s.activateVibeTools(this.#baseTools());
  this.#previousTools = previous; this.#scope = scope; this.#enabled = true;
  s.setVibeModeState({ enabled: true });
  if (s.isStreaming) await s.sendVibeModeContext({ deliverAs: 'steer' });
  this.#status();
  if (persistModeChange) s.sessionManager.appendModeChange('vibe', { previousTools: previous });
  if (!silent) this.#io.output('Vibe mode enabled. You direct fast/good worker sessions; toolset is read + optional parent Todo + vibe tools.');
 }
 #baseTools() { return this.#io.session.hasBuiltInTool('todo') ? ['read', 'todo'] : ['read']; }

 // InteractiveMode#exitVibeMode: workers are killed (and journaled) so none outlives the mode that directs them.
 async #exit() {
  const s = this.#io.session, registry = this.#sdk.registry;
  let killed = 0;
  await s.runModeExitTeardown(async () => {
   if (s.isStreaming) await s.abort();
   killed = await registry.killAll(this.#parent(), this.#scope);
   await s.deactivateVibeTools(this.#previousTools ?? []);
   s.setVibeModeState(undefined);
  });
  this.#enabled = false; this.#previousTools = undefined; this.#scope = undefined;
  this.#status();
  this.#io.output(killed > 0 ? `Vibe mode disabled. Killed ${killed} worker session${killed === 1 ? '' : 's'}.` : 'Vibe mode disabled.');
 }

 /** Vibe mode as the current session records it (InteractiveMode#reconcileModeFromSession), at start and after switches. */
 async reconcile() {
  const suspended = this.#suspendedForSwitch;
  this.#suspendedForSwitch = false;
  const s = this.#io.session, registry = this.#sdk.registry, parent = this.#parent();
  const context = s.sessionManager.buildSessionContext();
  const preserve = this.#enabled && context.mode === 'vibe' && sameScope(this.#scope, registry.ownerScope(parent));
  const lostToTeardown = this.#enabled && !preserve;
  if (lostToTeardown) {
   // The switch already restored the target's tools: strip only the vibe tools, keep the target's set.
   const scope = this.#scope;
   await s.removeVibeToolsPreservingActive();
   s.setVibeModeState(undefined);
   this.#enabled = false; this.#previousTools = undefined; this.#scope = undefined;
   if (scope && !suspended) await registry.suspendScope(scope, s.asyncJobManager);
   this.#status();
  }
  await registry.rehydrate(parent);
  if (context.mode === 'vibe' && !preserve) {
   await this.#enter({ persistModeChange: false, silent: true, previousTools: lostToTeardown ? persistedTools(context.modeData?.previousTools) : undefined });
  }
 }
 // OMP's session-switch reconcilers: workers are detached (not killed) before the switch, then the mode is reconciled.
 async beforeSwitch() {
  if (!this.#enabled || !this.#scope) return;
  await this.#sdk.registry.suspendScope(this.#scope, this.#io.session.asyncJobManager);
  this.#suspendedForSwitch = true;
 }
 afterSwitch() {
  this.#io.goal.guide?.(undefined);
  return this.reconcile();
 }
 // The goal controller reconciles after the switch and may restore the previous session's pre-goal tools over the vibe set.
 afterSessionChange() {
  if (!this.#enabled) return;
  this.#io.session.activateVibeTools(this.#baseTools()).catch(e => this.#io.notice('error', `Vibe mode could not restore its tools: ${e.message}`));
 }

 // InteractiveMode.handleGuidedGoalCommand: a hidden kickoff has the agent interview the user, then create the goal with
 // the `goal` tool, which turns goal mode on.
 async #guidedGoal(rough, images) {
  const s = this.#io.session, { AgentBusyError } = this.#sdk;
  this.#planBlocks();
  if (this.#enabled) throw new Error('Exit vibe mode first.');
  if (!this.#sdk.cfgGoalEnabled.get(s.settings)) throw new Error('Goal mode is disabled. Enable it in settings (goal.enabled).');
  const goal = s.getGoalModeState();
  if (goal?.enabled) throw new Error('Goal mode is already active. Use /goal to manage it, or /goal drop to start over.');
  if (goal?.goal?.status === 'paused') throw new Error('Resume the current goal first, or drop it before setting a new objective.');
  const enabled = s.getEnabledToolNames();
  this.#io.goal.guide?.(enabled.filter(n => n !== 'goal'));
  if (!enabled.includes('goal')) await s.setActiveToolsByName([...enabled, 'goal']);
  const kickoff = this.#sdk.render({ initial: rough || undefined });
  const imgs = images?.length ? images : undefined;
  // Queued behind a running turn instead of aborting it.
  if (s.isStreaming) { await s.followUp(kickoff, imgs, { synthetic: true }); return { consumed: true }; }
  let admitted = false, onAdmitted;
  const admission = new Promise(resolve => { onAdmitted = resolve; });
  const turn = s.prompt(kickoff, { synthetic: true, ...(imgs ? { images: imgs } : {}), onPromptAdmitted: () => { admitted = true; onAdmitted(); } });
  try { await Promise.race([admission, turn]); }
  catch (e) {
   if (!(e instanceof AgentBusyError)) throw e;
   await s.followUp(kickoff, imgs, { synthetic: true });
   return { consumed: true };
  }
  if (!admitted) return { consumed: true };
  // The interview turn runs on; its failure reaches the user like any other turn's.
  turn.catch(e => this.#io.notice('error', `/guided-goal: ${e instanceof Error ? e.message : e}`));
  return { consumed: true, agentInvoked: true };
 }
}
