// `/goal` for OMP builds that do not ship modes/rpc/rpc-goal-slash.ts (released builds so far). Same contract as that
// module (parseRpcGoalSlash, rpcGoalModeState, rpcGoalCommands, runRpcGoalSlash), run on the RpcGoalController every
// OMP build ships. That controller lacks what the patched one adds for prompt hosts, so GoalController supplies it:
// goals auto-continue under goal.continuationModes' "interactive" profile (the shipped controller only reads "rpc"),
// the host's objective prompt is the goal's first turn, and objective replacement and budget changes re-arm continuation.

const GOAL_SLASH = /^\/goal(?:\s+([\s\S]*))?$/;

/** The `/goal` host functions, given OMP's goal settings, its `/goal` command definition and duration formatter. */
export function goalSlashHost({ cfgGoalEnabled, goalCommand, formatCoarseDuration }) {
 const rpcGoalModeState = session => {
  const state = session.getGoalModeState();
  return { available: cfgGoalEnabled.get(session.settings), enabled: state?.enabled === true, goal: state?.goal ? { ...state.goal } : null };
 };
 return {
  /** The `/goal` arguments of a prompt, or undefined when the prompt is not `/goal`. */
  parseRpcGoalSlash(message) {
   if (typeof message !== 'string') return undefined;
   const match = GOAL_SLASH.exec(message.trim());
   return match ? (match[1] ?? '') : undefined;
  },
  rpcGoalModeState,
  /** `/goal` for the command catalog; absent while goal mode is disabled. */
  rpcGoalCommands(session) {
   if (!cfgGoalEnabled.get(session.settings)) return [];
   return [{ name: goalCommand.name, description: goalCommand.description, input: goalCommand.inlineHint ? { hint: goalCommand.inlineHint } : undefined, subcommands: goalCommand.subcommands, source: 'builtin' }];
  },
  /** Runs one `/goal` command. Returns the objective the host submits as the goal's first prompt (`/goal <objective>`, `/goal set`). */
  async runRpcGoalSlash(args, session, controller, ui, planMode) {
   // The TUI's #enterGoalMode also refuses a paused plan session (an active one is refused by the goal controller).
   const planPaused = () => { if (planMode?.paused) throw new Error('Plan mode is paused — run /plan again to fully exit.'); };
   if (session.getVibeModeState?.()?.enabled) throw new Error('Exit vibe mode first.');
   if (!cfgGoalEnabled.get(session.settings)) throw new Error('Goal mode is disabled. Enable it in settings (goal.enabled).');
   const requireUi = () => { if (!ui) throw new Error('This goal command needs a dialog; provide an objective or budget explicitly.'); return ui; };
   const current = () => rpcGoalModeState(session);
   const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
   let sub = match?.[1].toLowerCase(), rest = match?.[2]?.trim() ?? '';
   if (!goalCommand.subcommands?.some(c => c.name === sub)) { rest = args.trim(); sub = undefined; }
   const state = current();
   if (!sub && !rest && state.goal) {
    const choice = await requireUi().select(`Goal: ${state.goal.objective} (${state.goal.status})`, state.enabled ? ['Show details', 'Adjust budget…', 'Pause', 'Drop'] : ['Resume', 'Show details', 'Drop']);
    sub = { 'Show details': 'show', 'Adjust budget…': 'budget', Pause: 'pause', Resume: 'resume', Drop: 'drop' }[choice ?? ''];
    if (!sub) return {};
   }
   if (sub === 'set' || !sub) {
    const { goal, enabled } = current();
    if (goal && !enabled) throw new Error('Resume the current goal first, or drop it before setting a new objective.');
    if (!sub && enabled) throw new Error('Goal mode is already active. Use /goal set to replace it.');
    const objective = rest || (await requireUi().input('Goal objective'))?.trim();
    if (!objective) return {};
    planPaused();
    if (current().enabled) await controller.replace(objective);
    else await controller.handle({ op: 'create', objective }, { hostTurn: true });
    return { objective };
   }
   if (sub !== 'budget' && rest) throw new Error(`/goal ${sub} takes no arguments`);
   switch (sub) {
    case 'show': {
     const goal = current().goal;
     session.emitNotice('info', goal ? [
      `Objective: ${goal.objective}`,
      `Status: ${goal.status}`,
      `Tokens: ${goal.tokensUsed}${goal.tokenBudget === undefined ? ' (no budget)' : ` / ${goal.tokenBudget} (${Math.max(0, goal.tokenBudget - goal.tokensUsed)} left)`}`,
      `Time spent: ${formatCoarseDuration(goal.timeUsedSeconds * 1000)}`,
     ].join('\n') : 'No goal set.', 'goal-mode');
     break;
    }
    case 'pause':
     if (!current().enabled) throw new Error('No active goal to pause.');
     await controller.handle({ op: 'pause' });
     break;
    case 'resume':
     planPaused();
     await controller.handle({ op: 'resume' });
     break;
    case 'drop':
     if (!current().goal) throw new Error('No goal to drop.');
     if (await requireUi().confirm('Drop goal?', 'This removes the goal record. Accumulated usage stays in the session log.')) await controller.handle({ op: 'drop' });
     break;
    case 'budget': {
     const { goal, enabled } = current();
     if (!enabled) throw new Error(goal ? 'Resume the goal before adjusting the budget.' : 'No active goal.');
     const raw = rest || (await requireUi().input('Goal budget (number, `off`, or empty to cancel)', goal?.tokenBudget?.toString()))?.trim();
     if (!raw) break;
     const budget = raw.toLowerCase() === 'off' ? undefined : Number(raw);
     if (budget !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(budget) || budget <= 0)) throw new Error('Goal budget must be a positive integer or `off`.');
     await controller.setBudget(budget);
     break;
    }
   }
   return {};
  },
 };
}

/**
 * OMP's shipped RpcGoalController with the patched controller's interface: continuationMode (the "interactive" profile),
 * handle(command, { hostTurn }), replace(objective), setBudget(budget), and hostTurnDone() once the host's prompt is
 * admitted or abandoned. The controller sees the session through a view whose settings map the profile onto the "rpc"
 * entry it reads, and which reports the host's pending objective prompt as an admitted submission so the controller's
 * own continuation never races it. `held()` true withholds continuation, as the TUI's #scheduleGoalContinuation does while
 * loop mode is on: the controller then reads a profile with no continuation mode.
 */
export class GoalController {
 #inner; #session; #cfgGoalEnabled; #hostTurn = false; #guidedTools;
 constructor(RpcGoalController, session, onContinuationDropped, { cfgGoalEnabled, cfgGoalContinuationModes }, continuationMode = 'interactive', held = () => false) {
  this.#session = session;
  this.#cfgGoalEnabled = cfgGoalEnabled;
  const settings = session.settings.overlay(), withheld = session.settings.overlay();
  const follow = modes => cfgGoalContinuationModes.override(settings, modes.includes(continuationMode) ? ['rpc'] : []);
  follow(cfgGoalContinuationModes.get(session));
  cfgGoalContinuationModes.listen(session, follow);
  cfgGoalContinuationModes.override(withheld, []);
  const view = new Proxy(session, {
   get: (target, key) => {
    if (key === 'settings') return held() ? withheld : settings;
    if (key === 'hasAdmittedSubmission') return this.#hostTurn || target.hasAdmittedSubmission;
    // A goal the /guided-goal interview creates ends by restoring the tools from before the interview enabled `goal`.
    if (key === 'getEnabledToolNames' && this.#guidedTools) { const tools = this.#guidedTools; return () => [...tools]; }
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
   },
  });
  this.#inner = new RpcGoalController(view, onContinuationDropped);
 }
 get continuationPending() { return this.#inner.continuationPending; }
 stopForHostAbort() { this.#inner.stopForHostAbort(); }
 settled() { return this.#inner.settled(); }
 beginSessionChange() { return this.#inner.beginSessionChange(); }
 endSessionChange(options) { return this.#inner.endSessionChange(options); }
 reconcile(options) { return this.#inner.reconcile(options); }
 observe(event) {
  // The host's objective prompt started: from here the session itself reports the turn.
  if (event.type === 'agent_start') this.#hostTurn = false;
  this.#inner.observe(event);
  if (event.type === 'goal_updated' && event.state) this.#guidedTools = undefined;
 }
 /** /guided-goal enabled `goal` for its interview: `previousTools` is the set a goal it creates restores (undefined: none). */
 guide(previousTools) { this.#guidedTools = previousTools; }
 hostTurnDone() { this.#hostTurn = false; }
 /** `hostTurn`: the host prompts with the objective right after `create`, so the goal must not start its own turn first. */
 async handle(command, { hostTurn = false } = {}) {
  if (hostTurn) this.#hostTurn = true;
  try { return await this.#inner.handle(command); }
  catch (e) { if (hostTurn) this.#hostTurn = false; throw e; }
 }
 /** `/goal set` while a goal runs: replaces its objective; the host prompts with it next. */
 async replace(objective) {
  await this.#inner.settled();
  const s = this.#session;
  if (!this.#cfgGoalEnabled.get(s.settings)) throw new Error('Goal mode is disabled (goal.enabled).');
  if (s.getPlanModeState()?.enabled) throw new Error('Exit plan mode before starting a goal.');
  if (!s.getGoalModeState()?.enabled) throw new Error('No active goal to replace.');
  this.#hostTurn = true;
  try {
   s.setGoalModeState(await s.goalRuntime.replaceGoal({ objective }));
   if (s.isStreaming) await s.sendGoalModeContext({ deliverAs: 'steer' });
  } catch (e) { this.#hostTurn = false; throw e; }
  return this.#inner.handle({ op: 'get' });
 }
 /** Sets or clears (undefined) the active goal's token budget; a goal the old budget stopped continues. */
 async setBudget(tokenBudget) {
  await this.#inner.settled();
  const s = this.#session;
  if (!s.getGoalModeState()?.enabled) throw new Error('No active goal.');
  await s.goalRuntime.onBudgetMutated(tokenBudget);
  this.#rearm();
  return this.#inner.handle({ op: 'get' });
 }
 /** A host's hold ended at user input (the TUI's next getUserInput schedules continuation): an idle goal continues. */
 release() { this.#rearm(); }
 // The shipped controller re-arms and schedules continuation only when a turn ends, so an idle session gets the end of
 // a non-goal turn, as the interactive host re-arms after a budget change.
 #rearm() {
  const s = this.#session;
  if (!s.isStreaming && !s.hasAdmittedSubmission && !this.#inner.continuationPending && s.getGoalModeState()?.mode === 'active') this.#inner.observe({ type: 'agent_end', messages: [] });
 }
}
