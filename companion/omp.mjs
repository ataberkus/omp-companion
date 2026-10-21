// OMP runs inside the companion's own process through its SDK: each live session is an AgentSession, built the way
// `omp` builds its own (same CLI flag semantics), and driven with direct calls; its events arrive as plain objects.
// OMP's SDK is TypeScript that needs Bun, so this module only loads OMP when a session starts under Bun.
// The plan, goal, side-question, subagent, prompt-result and settle controllers are OMP's own in-process classes
// (shipped under modes/rpc/); the companion uses them so it behaves exactly like OMP's other hosts. OMP builds without
// the /goal host get the companion's (goal-host.mjs), built on OMP's goal controller.
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GoalController, goalSlashHost } from './goal-host.mjs';
import { RUNTIME_FILES, ompSources } from './omp-sdk.mjs';

export const NOT_RUNNING = 'OMP process is not running.';
const READY_MS = 30000;

// An SDK copy that fails to load (a newer OMP that moved files the companion imports, say) falls back to the next one.
async function loadFirst(sources) {
 if (!process.versions.bun) throw new Error('OMP sessions need the Bun runtime. Start the companion with `node companion/server.mjs` or `bun companion/server.mjs`.');
 for (let i = 0; ; i++) {
  try { return await runtime(sources[i]); }
  catch (e) { if (i === sources.length - 1) throw e; console.error(`OMP in ${sources[i]} could not load (${e.message}); using ${sources[i + 1]}.`); }
 }
}

const runtimes = new Map();
function runtime(src) {
 let r = runtimes.get(src);
 if (!r) { r = loadRuntime(src); runtimes.set(src, r); r.catch(() => runtimes.delete(src)); }
 return r;
}

async function loadRuntime(src) {
 if (!existsSync(path.join(src, 'sdk.ts'))) throw new Error(`OMP's SDK was not found in ${src}. Run npm install, or point OMP_BIN at a checkout's packages/coding-agent/src/cli.ts.`);
 // Like OMP's headless hosts: bash without a PTY (nothing draws a terminal) and no OMP auto-titles (the companion titles sessions).
 process.env.PI_NO_PTY = '1'; process.env.PI_NO_TITLE = '1';
 const at = rel => import(pathToFileURL(path.join(src, rel)).href);
 const optional = rel => existsSync(path.join(src, rel)) ? at(rel) : null;
 const pkg = spec => import(pathToFileURL(Bun.resolveSync(spec, src)).href);
 const names = Object.keys(RUNTIME_FILES);
 const [modules, oauth, tuiTheme, words, plan, goalSlash] = await Promise.all([
  Promise.all(names.map(name => at(RUNTIME_FILES[name]))),
  pkg('@oh-my-pi/pi-ai/oauth'), pkg('@oh-my-pi/pi-tui/theme'), pkg('@oh-my-pi/pi-tui/prompt/word-completion'),
  // Plan-mode and /goal hosting ship only in some OMP builds; state() reports plan mode only when it does.
  optional('modes/rpc/rpc-plan-mode.ts'), optional('modes/rpc/rpc-goal-slash.ts'),
 ]);
 const m = Object.fromEntries(names.map((name, i) => [name, modules[i]]));
 const goal = goalSlash
  ? { goalSlash, goalController: (session, dropped) => new m.goal.RpcGoalController(session, dropped, 'interactive') }
  : await companionGoal(at, pkg, m.goal);
 // One settings tree, credential store and model catalog for every session, as OMP's ACP server shares them;
 // each session gets its project's settings overlay.
 const settings = await m.settingsMod.Settings.init({ cwd: os.homedir() });
 const authStorage = await m.sdk.discoverAuthStorage(undefined, { settings });
 m.authSync.createAuthStorageSettingsSync(settings, authStorage);
 const modelRegistry = new m.registryMod.ModelRegistry(authStorage, undefined, { settings });
 m.discovery.initializeWithSettings(settings);
 await modelRegistry.hydrateCredentialScopedModelCaches();
 modelRegistry.refreshInBackground();
 await tuiTheme.ensureTheme?.();
 settings.startWatching();
 return { ...m, oauth, tuiTheme, words, plan, ...goal, settings, authStorage, modelRegistry };
}

// The companion's /goal host for OMP builds without modes/rpc/rpc-goal-slash.ts. Without the pieces it needs, /goal stays
// unsupported (state() reports no goalMode) instead of keeping sessions from starting.
async function companionGoal(at, pkg, goal) {
 try {
  const [goalSettings, registry, format] = await Promise.all([at('goals/settings.ts'), at('slash-commands/builtin-registry.ts'), pkg('@oh-my-pi/pi-tui/chrome/format')]);
  const goalCommand = registry.BUILTIN_SLASH_COMMAND_DEFS.find(c => c.name === 'goal');
  if (!goalCommand) throw new Error('OMP defines no /goal command');
  return {
   goalSlash: goalSlashHost({ cfgGoalEnabled: goalSettings.cfgGoalEnabled, goalCommand, formatCoarseDuration: format.formatCoarseDuration }),
   goalController: (session, dropped) => new GoalController(goal.RpcGoalController, session, dropped, goalSettings),
  };
 } catch (e) {
  console.error(`Goal mode is unavailable with this OMP build: ${e.message}`);
  return { goalSlash: null, goalController: (session, dropped) => new goal.RpcGoalController(session, dropped) };
 }
}

/**
 * The companion's OMP: `start` opens one session. `entry` is OMP_BIN: a checkout's cli.ts selects that checkout's SDK;
 * otherwise sessions load the newest OMP SDK installed under `dataDir` by syncOmpSdk, else the bundled one.
 */
export function ompHost(entry, { dataDir } = {}) {
 // Chosen once per process, so sessions never mix two OMP copies (an SDK installed meanwhile counts from the next start).
 let loaded;
 const load = () => loaded ??= loadFirst(ompSources(entry, dataDir)).catch(e => { loaded = undefined; throw e; });
 return {
  // Loads OMP ahead of the first session so opening one does not pay for the import.
  warm() { if (process.versions.bun) load().catch(() => {}); },
  /** Returns the session at once; `ready` settles when it can take commands. */
  start({ cwd, args, onEvent, onExit }) { return new OmpSession(load, cwd, args, onEvent, onExit); },
 };
}

// Ghost-text query like OMP's TUI editor: only at the end of a line.
function wordQueryAt(words, text, cursor) {
 if (cursor < text.length && text[cursor] !== '\n') return undefined;
 const lines = text.split('\n');
 let line = 0, start = 0;
 while (start + lines[line].length < cursor) start += lines[line++].length + 1;
 return words.wordCompletionQuery(lines, line, cursor - start);
}
// Results are copies, so the companion never holds (or mutates) OMP's live objects.
const plain = v => v === undefined || v === null ? v ?? null : JSON.parse(JSON.stringify(v));
const message = e => e instanceof Error ? e.message : String(e);

class OmpSession {
 alive = true; stopping = false; startedAt = Date.now();
 #onEvent; #onExit; #rt; #session; #opened = false; #opening; #closed; #closeDone; #dead; #exitError; #shutdown = false; #tail = Promise.resolve(); #tasks = new Set(); #disposing = false; #exited = false;
 #pending; #ui; #gate; #predictor; #btw; #goal; #results; #settle; #scheduled; #subagents; #plan; #tracker; #persistFailure;

 constructor(load, cwd, args, onEvent, onExit) {
  this.#onEvent = onEvent; this.#onExit = onExit;
  this.#closed = new Promise(resolve => { this.#closeDone = resolve; });
  this.#dead = new Promise((_, reject) => { this.#exitError = reject; });
  this.#dead.catch(() => {});
  let timer;
  // Like a stuck OMP process that was killed: the runner is being stopped, not crashing.
  const late = new Promise((_, reject) => { timer = setTimeout(() => { this.stopping = true; reject(new Error('OMP did not become ready within 30 seconds. Check your OMP installation.')); }, READY_MS); });
  const opening = this.#opening = (async () => this.#open(await load(), cwd, args))();
  this.ready = Promise.race([opening, late, this.#dead]).finally(() => clearTimeout(timer));
  this.ready.catch(e => {
   this.#exit(e);
   // A session that finishes opening after its deadline is closed straight away.
   opening.then(() => this.#dispose(e), () => this.#closeDone());
  });
 }
 /** Settles once the session is disposed and onExit has run. */
 get closed() { return this.#closed; }

 #emit(frame) { if (this.#disposing && frame.type !== 'notice') return; try { this.#onEvent(frame); } catch (e) { console.error('Companion event handler failed:', e); } }
 #exit(error) {
  this.alive = false; this.#exitError(error);
  if (this.#exited) return;
  this.#exited = true;
  try { this.#onExit(error, this.stopping); } catch (e) { console.error(e); }
 }

 async #open(rt, cwd, args) {
  this.#rt = rt;
  const { main, cliArgs, sdk, bus } = rt;
  const parsed = cliArgs.parseArgs(args);
  parsed.cwd = cwd;
  const settings = await rt.settings.cloneForCwd(cwd);
  // The launch flags runRootCommand applies to its settings, on this session's copy only.
  if (parsed.approvalMode) rt.toolSettings.cfgToolsApprovalMode.override(settings, parsed.approvalMode);
  for (const setting of rt.configRegistry.all()) if (setting.definition.protocolDefault?.includes('rpc')) setting.pinDefault(settings);
  if (parsed.smol || parsed.slow || parsed.plan) settings.overrideModelRoles({ smol: parsed.smol, slow: parsed.slow, plan: parsed.plan });
  const scoped = await main.resolveScopedModels(parsed, rt.modelRegistry, settings);
  main.normalizeContinueSessionArgs(parsed, args);
  const sessionManager = await main.createSessionManager(parsed, cwd, settings, async () => 'unavailable', { nativeFlagOwnership: 'preliminary' });
  if (typeof parsed.resume === 'string' && !sessionManager) throw new Error('Resume cancelled: session was not moved.');
  const options = await main.buildSessionOptions(parsed, scoped, sessionManager, rt.modelRegistry, settings);
  const eventBus = new bus.EventBus(), subagentEventBus = new bus.EventBus();
  Object.assign(options, {
   cwd, settings, authStorage: rt.authStorage, modelRegistry: rt.modelRegistry, hasUI: true, allowSessionModelFallback: false, settingsApproval: false,
   tuiTranscript: false, autoTitle: false, eventBus, subagentEventBus, deferRetryFallbackValidation: true,
   ...(sessionManager ? { agentId: `companion:${sessionManager.getSessionId()}` } : {}),
  });
  const { session, setToolUIContext, modelFallbackMessage } = await sdk.createAgentSession(options);
  this.#session = session;
  try {
   session.validateRetryFallbackChains();
   cliArgs.validateToolNames(parsed.tools, session.getAllToolNames());
   if (!session.model) throw new Error(rt.modelRegistry.getError()?.message || modelFallbackMessage || 'No models available.');
   await this.#host(rt, session, subagentEventBus, setToolUIContext);
   // Stopped while OMP was still building the session.
   if (this.#disposing) throw new Error('OMP stopped.');
  } catch (e) { await session.dispose().catch(() => {}); throw e; }
  this.#opened = true;
 }

 // runRpcMode's setup, minus the stdio protocol.
 async #host(rt, session, subagentEventBus, setToolUIContext) {
  const out = f => this.#emit(f);
  const { rpc } = rt;
  this.#pending = new rpc.RpcPendingExtensionRequests();
  this.#ui = this.#uiContext(rt);
  this.#tracker = new rt.results.RpcExtensionUserMessageTracker();
  this.#predictor = new rpc.RpcWordPredictor();
  this.#btw = new rt.btw.RpcBtwController(session, out);
  this.#goal = rt.goalController(session, () => void this.#settle.check());
  const scheduled = rt.settle.watchedScheduledTurnProbe(() => this.#goal.continuationPending, () => this.#settle);
  this.#results = new rt.results.RpcPromptResults(session, out, scheduled);
  this.#settle = new rt.settle.RpcSessionSettleWatcher(session, out, scheduled);
  this.#scheduled = scheduled;
  this.#subagents = new rt.subagents.RpcSubagentRegistry(subagentEventBus, out);
  this.#subagents.setSubscriptionLevel('events');
  this.#gate = new rpc.RpcUserInputGate();
  setToolUIContext?.(this.#ui, true);
  await rt.runtimeInit.initializeExtensions(session, {
   mode: 'rpc',
   wrapSessionChange: async (change, { detachesRun }) => {
    await this.#btw.close(); await this.#goal.beginSessionChange();
    let result;
    try { result = await change(); return result; }
    finally {
     await this.#goal.endSessionChange({ detachedRun: detachesRun && result?.cancelled !== true });
     if (result && !result.cancelled) { if (detachesRun) this.#results.abortOpen(); void this.#settle.check(); }
    }
   },
   reportSendError: (action, err) => out({ type: 'notice', level: 'error', message: `${action}: ${err.message}` }),
   reportRuntimeError: err => out({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error }),
   onShutdown: () => { this.#shutdown = true; this.#maybeShutdown(); },
   trackAgentInvokingMessage: task => this.#tracker.trackAgentMessageTask(task),
   uiContext: this.#ui,
  });
  if (rt.plan) { this.#plan = new rt.plan.RpcPlanMode(session, out); await this.#plan.reconcile(); }
  session.subscribe(event => {
   out(event);
   // Goal first: a continuation decided at this agent_end must be scheduled before either report reads settlement.
   this.#goal.observe(event); this.#plan?.observe(event); this.#results.observe(event); this.#settle.observe(event);
  });
  await this.#goal.reconcile(); await this.#goal.settled();
  rpc.registerRpcPersistenceSurface(session, out, e => { this.#persistFailure = e; });
  session.subscribeCommandMetadataChanged(() => void this.#publishCommands());
  await this.#publishCommands();
 }

 #uiContext(rt) {
  const { rpc } = rt, pending = this.#pending, out = f => this.#emit(f);
  const fire = request => out({ type: 'extension_ui_request', id: randomUUID(), ...request });
  return {
   supportsEditor: true,
   get askDialog() { return (questions, options) => rpc.requestRpcAskDialog(pending, out, questions, options); },
   select: (title, options, dialog) => rpc.requestRpcSelect(pending, out, title, options, dialog),
   confirm: (title, msg, dialog) => rpc.requestRpcDialog(pending, out, dialog, false, { method: 'confirm', title, message: msg, timeout: dialog?.timeout }, r => {
    if (r.cancelled) { if (r.timedOut) dialog?.onTimeout?.(); return false; }
    return 'confirmed' in r ? r.confirmed : false;
   }),
   input: (title, placeholder, dialog) => rpc.requestRpcDialog(pending, out, dialog, undefined, { method: 'input', title, placeholder, timeout: dialog?.timeout }, r => {
    if (r.cancelled) { if (r.timedOut) dialog?.onTimeout?.(); return undefined; }
    return 'value' in r ? r.value : undefined;
   }),
   editor: (title, prefill, dialog, editorOptions) => rpc.requestRpcEditor(pending, out, title, prefill, dialog, editorOptions),
   notify: (msg, type) => fire({ method: 'notify', message: msg, notifyType: type }),
   setStatus: (key, text) => fire({ method: 'setStatus', statusKey: key, statusText: text }),
   setWidget: (key, content, options) => { if (content === undefined || Array.isArray(content)) fire({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement }); },
   setEditorText: text => fire({ method: 'set_editor_text', text }),
   pasteToEditor: text => fire({ method: 'set_editor_text', text }),
   getEditorText: () => '',
   onTerminalInput: () => () => {},
   setWorkingMessage() {}, setFooter() {}, setHeader() {}, setTitle() {}, addAutocompleteProvider() {}, setToolsExpanded() {}, setEditorComponent() {},
   getToolsExpanded: () => false, getEditorComponent: () => undefined,
   custom: async () => undefined,
   get theme() { return rt.tuiTheme.theme; },
   getAllThemes: async () => [], getTheme: async () => undefined,
   setTheme: async () => ({ success: false, error: 'Theme switching is not supported in the companion.' }),
  };
 }

 // A dialog answer: { value } | { confirmed } | { answers } | { cancelled: true }.
 answer(id, reply) {
  if (!this.alive || !this.#pending) throw new Error(NOT_RUNNING);
  this.#pending.get(id)?.resolve({ type: 'extension_ui_response', id, ...reply });
 }

 // `type` names the operation in timeout errors; 0 waits as long as OMP needs (bash, login, handoff).
 async #call(type, timeout, work) {
  await this.ready;
  if (!this.alive) throw new Error(NOT_RUNNING);
  let timer;
  const limit = timeout ? new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`OMP timed out while processing ${type}.`)), timeout); }) : null;
  try { return await Promise.race([work(), this.#dead, ...(limit ? [limit] : [])]); }
  finally { clearTimeout(timer); }
 }
 // Ordinary commands run one at a time in call order, as OMP's own hosts serialize them.
 #serial(type, timeout, work) {
  const run = this.#tail.then(work, work);
  this.#tail = run.then(() => this.#maybeShutdown(), () => this.#maybeShutdown());
  return this.#call(type, timeout, () => run);
 }
 #track(task) { this.#tasks.add(task); task.finally(() => { this.#tasks.delete(task); this.#maybeShutdown(); }).catch(() => {}); return task; }

 async #commands() {
  const s = this.#session, rt = this.#rt;
  const list = await rt.available.buildAvailableSlashCommands(s);
  if (!this.#plan && !rt.goalSlash) return list;
  const own = new Set([...(this.#plan ? ['plan', 'plan-review'] : []), ...(rt.goalSlash ? ['goal'] : [])]);
  return [...(this.#plan?.commands() ?? []), ...(rt.goalSlash?.rpcGoalCommands(s) ?? []), ...list.filter(c => !own.has(c.name))];
 }
 async #publishCommands() { if (this.alive) this.#emit({ type: 'available_commands_update', commands: plain(await this.#commands()) }); }
 async #reloadPlugins() {
  const cwd = this.#session.sessionManager.getCwd(), h = this.#rt.discoveryHelpers;
  const project = await h.resolveActiveProjectRegistryPath(cwd);
  h.clearPluginRootsAndCaches(project ? [project] : undefined);
  await this.#session.refreshSkillsAndCommands();
  await this.#publishCommands();
 }

 // runRpcMode's ordered user input: extension input hooks, then skills, then OMP's built-in slash commands, then the model.
 #input(kind, command, ticket) {
  const s = this.#session, sessionId = s.sessionId;
  return this.#gate.enqueue(async () => {
   const current = () => this.#gate.isCurrent(command) && !this.#shutdown && s.sessionId === sessionId;
   if (!current()) return 'cancelled';
   let text = command.message, images = command.images;
   if (s.extensionRunner?.hasHandlers('input')) {
    const r = await s.extensionRunner.emitInput(text, images, 'rpc');
    if (!current()) return 'cancelled';
    if (r.handled) return 'local';
    if (r.text !== undefined) text = r.text;
    if (r.images !== undefined) images = r.images;
   }
   if (!current()) return 'cancelled';
   if (!text.trim() && !images?.length) return 'local';
   if (kind !== 'steer' && kind !== 'follow_up') await this.#plan?.beforePrompt();
   if (!current()) return 'cancelled';
   if (kind === 'steer') { await s.steer(text, images); return 'admitted'; }
   if (kind === 'follow_up') { await s.followUp(text, images); return 'admitted'; }
   if (kind === 'prompt') {
    const skill = await this.#rt.rpc.dispatchRpcSkillPrompt({ ticket, session: s, message: text, streamingBehavior: command.streamingBehavior, results: this.#results, onError: this.#lateError(command.id, kind), extensionUserMessageTracker: this.#tracker, images, isCurrent: current });
    if (skill === 'cancelled') return 'cancelled';
    if (skill) return 'admitted';
    const builtin = await this.#rt.builtins.executeAcpBuiltinSlashCommand(text, {
     session: s, sessionManager: s.sessionManager, settings: s.settings, cwd: s.sessionManager.getCwd(),
     output: t => this.#emit({ type: 'command_output', text: t }),
     refreshCommands: () => this.#publishCommands(),
     reloadPlugins: () => this.#reloadPlugins(),
     runCommandInBackground: task => this.#track(task()),
     notifyTitleChanged: async () => this.#emit({ type: 'session_info_update', title: s.sessionName, sessionId: s.sessionId }),
     notifyConfigChanged: async () => { await this.#plan?.refreshPlanModelRole?.(); this.#emit({ type: 'config_update', model: plain(s.model), thinkingLevel: s.thinkingLevel }); },
    });
    if (!current()) return 'cancelled';
    if (builtin !== false) {
     if (!('prompt' in builtin)) {
      if (builtin.agentInvoked === true) {
       void s.waitForIdle().then(() => this.#results.settle(ticket), e => this.#results.fail(ticket, message(e)));
       return 'builtin-agent';
      }
      return 'local';
     }
     text = builtin.prompt;
    }
   }
   if (!current() || !ticket) return 'cancelled';
   await this.#rt.results.watchAndReportPromptResult({
    ticket, results: this.#results, onError: this.#lateError(command.id, kind), extensionUserMessageTracker: this.#tracker,
    startPrompt: onPromptAdmitted => s.prompt(text, { images, ...(kind === 'prompt' ? { streamingBehavior: command.streamingBehavior } : {}), onPromptAdmitted }),
   });
   return 'admitted';
  });
 }
 // A prompt that fails after it was accepted (say, the provider rejected it).
 #lateError(id, command) { return e => this.#emit({ type: 'prompt_error', id, command, error: message(e) }); }
 #accept(type, extra = {}) { const command = { type, ...extra }; this.#gate.accept(command); return command; }

 /** Sends a message as a new turn (or, while one runs, as `streamingBehavior` says). Slash commands run here too. */
 prompt({ id = randomUUID(), message: text, images, streamingBehavior }, timeout = 30000) {
  const command = this.#accept('prompt', { id, message: text, images, streamingBehavior });
  return this.#serial('prompt', timeout, async () => {
   const ticket = this.#results.begin(id);
   try {
    const goalArgs = this.#rt.goalSlash?.parseRpcGoalSlash(text);
    if (goalArgs !== undefined) {
     try {
      const { objective } = await this.#rt.goalSlash.runRpcGoalSlash(goalArgs, this.#session, this.#goal, this.#ui);
      if (objective === undefined) { this.#results.discard(ticket); return { agentInvoked: false }; }
      command.message = objective;
      const outcome = await this.#input('prompt', command, ticket);
      if (outcome === 'local') { this.#results.discard(ticket); return { agentInvoked: false }; }
      if (outcome === 'cancelled') this.#results.settle(ticket);
      return { agentInvoked: outcome !== 'cancelled' };
     } finally { this.#goal.hostTurnDone?.(); }
    }
    const planSlash = this.#plan && typeof text === 'string' ? text.trim().match(/^\/(plan|plan-review)(?:\s+(.*))?$/) : null;
    if (planSlash) {
     if (planSlash[1] === 'plan-review') { if (planSlash[2]?.trim()) throw new Error('/plan-review takes no arguments'); await this.#plan.review(); }
     else {
      const option = planSlash[2]?.trim();
      if (option && !['on', 'off', 'parallel', 'iterative'].includes(option)) throw new Error('Usage: /plan [on|off|parallel|iterative]');
      await this.#plan.setMode(option ? option !== 'off' : !this.#plan.state.enabled && !this.#plan.state.paused, option === 'parallel' || option === 'iterative' ? option : undefined);
     }
     this.#results.discard(ticket); return { agentInvoked: false };
    }
    const outcome = await this.#input('prompt', command, ticket);
    if (outcome === 'local') { this.#results.discard(ticket); return { agentInvoked: false }; }
    if (outcome === 'builtin-agent') return { agentInvoked: true };
    if (outcome === 'cancelled') this.#results.settle(ticket);
    return {};
   } catch (e) { this.#results.discard(ticket); throw e; }
  });
 }
 steer({ message: text, images }) { const c = this.#accept('steer', { message: text, images }); return this.#serial('steer', 30000, async () => { await this.#input('steer', c); }); }
 followUp({ message: text, images }) { const c = this.#accept('follow_up', { message: text, images }); return this.#serial('follow_up', 30000, async () => { await this.#input('follow_up', c); }); }
 /** Stop & send: aborts the turn, then starts this message. */
 interrupt({ id = randomUUID(), message: text, images }) {
  const command = this.#accept('abort_and_prompt', { id, message: text, images });
  return this.#serial('abort_and_prompt', 30000, async () => {
   this.#plan?.cancel(); this.#goal.stopForHostAbort();
   await this.#session.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL });
   await this.#plan?.settle();
   const ticket = this.#results.begin(id);
   void this.#input('abort_and_prompt', command, ticket).then(
    outcome => { if (outcome === 'cancelled') this.#results.settle(ticket); else if (outcome === 'local') this.#results.completeLocal(ticket); },
    e => { this.#lateError(id, 'abort_and_prompt')(e); this.#results.fail(ticket, message(e)); });
  });
 }
 abort() {
  this.#accept('abort');
  return this.#call('abort', 30000, async () => {
   this.#plan?.cancel(); this.#goal.stopForHostAbort();
   await this.#session.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL });
  });
 }
 removeQueued(text, queue) {
  return this.#serial('remove_queued_message', 30000, async () => {
   const removed = this.#session.takeQueuedMessage(text, queue);
   return { removed: removed !== undefined, ...(removed?.images ? { images: plain(removed.images) } : {}) };
  });
 }

 state() {
  return this.#serial('get_state', 30000, async () => {
   await this.#goal.settled();
   const s = this.#session, q = s.getQueuedMessages();
   return plain({
    model: s.model, thinkingLevel: s.thinkingLevel, isStreaming: s.isStreaming, isCompacting: s.isCompacting,
    steeringMode: s.steeringMode, followUpMode: s.followUpMode, interruptMode: s.interruptMode,
    sessionFile: s.sessionFile, sessionId: s.sessionId, sessionName: s.sessionName, autoCompactionEnabled: s.autoCompactionEnabled,
    queuedMessageCount: s.queuedMessageCount, hasPendingAsyncWork: s.hasPendingAsyncWork(),
    isSettled: this.#rt.settle.isRpcSessionSettled(s, this.#scheduled),
    queuedMessages: { steering: [...q.steering], followUp: [...q.followUp], liveSteered: q.liveSteered },
    todoPhases: s.getTodoPhases(), fastModeEnabled: s.isFastModeEnabled(), fastModeActive: s.isFastModeActive(),
    tokensPerSecond: this.#rt.tokenRate.calculateTokensPerSecond(s.messages, s.isStreaming),
    usageLimit: s.getUsageLimitState?.(), messageCount: s.messages.length, contextUsage: s.getContextUsage(),
    ...(this.#plan ? { planMode: this.#plan.state, planReview: this.#plan.proposal } : {}),
    // Images on /skill: commands reach the skill prompt (dispatchRpcSkillPrompt takes them).
    skillImages: true,
    ...(this.#rt.goalSlash ? { goalMode: this.#rt.goalSlash.rpcGoalModeState(s) } : {}),
    goal: s.getGoalModeState() ?? null,
   });
  });
 }
 commands() { return this.#serial('get_available_commands', 30000, async () => plain(await this.#commands())); }
 entries(since) {
  return this.#serial('get_entries', 30000, async () => {
   const m = this.#session.sessionManager;
   try { return plain(this.#rt.compat.selectRpcEntries(m.getEntries(), m.getLeafId(), since)); }
   catch (e) { throw Object.assign(new Error(message(e)), { code: 'unknown_since' }); }
  });
 }
 tree() { return this.#serial('get_tree', 30000, async () => { const m = this.#session.sessionManager; return plain({ tree: m.getTree(), leafId: m.getLeafId() }); }); }
 subagents() { return this.#serial('get_subagents', 30000, async () => plain({ subagents: this.#subagents.getSubagents() })); }
 lastAssistantText() { return this.#serial('get_last_assistant_text', 30000, async () => ({ text: this.#session.getLastAssistantText() })); }
 sessionStats() { return this.#serial('get_session_stats', 30000, async () => plain(this.#session.getSessionStats())); }
 branchMessages() { return this.#serial('get_branch_messages', 30000, async () => plain({ messages: this.#session.getUserMessagesForBranching() })); }
 exportHtml(outputPath) { return this.#serial('export_html', 120000, async () => ({ path: await this.#session.exportToHtml(outputPath) })); }
 setTodos(phases) {
  return this.#serial('set_todos', 30000, async () => {
   const s = this.#session;
   s.setTodoPhases(phases);
   const todoPhases = s.getTodoPhases();
   s.sessionManager.appendCustomEntry(this.#rt.todo.USER_TODO_EDIT_CUSTOM_TYPE, { phases: todoPhases });
   return plain({ todoPhases });
  });
 }
 setSessionName(name) {
  return this.#serial('set_session_name', 30000, async () => {
   const trimmed = String(name).trim();
   if (!trimmed || !(await this.#session.setSessionName(trimmed, 'user'))) throw new Error('Session name cannot be empty');
  });
 }

 #planIdle() { if (this.#plan?.busy) throw new Error('Plan approval is being prepared'); }
 async #findModel(provider, modelId) {
  const s = this.#session, find = () => s.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
  const model = find(); if (model) return model;
  await s.modelRegistry.awaitBackgroundRefresh();
  return find();
 }
 setModel(provider, modelId) {
  return this.#serial('set_model', 30000, async () => {
   this.#planIdle();
   const model = await this.#findModel(provider, modelId);
   if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
   await this.#session.setModel(model);
   return plain(model);
  });
 }
 cycleModel() { return this.#serial('cycle_model', 30000, async () => { this.#planIdle(); return plain(await this.#session.cycleModel()); }); }
 availableModels() { return this.#serial('get_available_models', 60000, async () => { await this.#session.modelRegistry.awaitBackgroundRefresh(); return plain({ models: this.#session.getAvailableModels() }); }); }
 setThinking(level) { return this.#serial('set_thinking_level', 30000, async () => { this.#planIdle(); this.#session.setThinkingLevel(level); }); }
 cycleThinking() { return this.#serial('cycle_thinking_level', 30000, async () => { this.#planIdle(); const level = this.#session.cycleThinkingLevel(); return level ? { level } : null; }); }
 /** The dashboard's per-session toggles. */
 setPref(key, value) {
  return this.#serial(PREF_COMMANDS[key] ?? 'set_pref', 30000, async () => {
   const s = this.#session;
   if (key === 'fast') { if (!s.setFastMode(value) && value) throw new Error('Fast mode is unavailable for the current model.'); }
   else if (key === 'autoCompaction') s.setAutoCompactionEnabled(value);
   else if (key === 'autoRetry') s.setAutoRetryEnabled(value);
   else if (key === 'steeringMode' || key === 'followUpMode' || key === 'interruptMode') this.#rt.rpc.applyRpcQueueModeCommand(s, { type: PREF_COMMANDS[key], mode: value });
   else throw new Error(`Unknown session setting: ${key}`);
  });
 }
 compact(customInstructions) { return this.#serial('compact', 0, async () => { this.#planIdle(); return plain(await this.#session.compact(customInstructions)); }); }
 // Outside the command queue, so abortBash can stop it.
 bash(command) {
  return this.#call('bash', 0, () => this.#track((async () => {
   if (this.#plan && (this.#plan.state.enabled || this.#plan.busy)) throw new Error('User bash commands are unavailable during native read-only planning');
   return plain(await this.#session.executeBash(command));
  })()));
 }
 abortBash() { return this.#call('abort_bash', 30000, async () => { this.#session.abortBash(); }); }
 handoff(customInstructions) {
  return this.#serial('handoff', 0, async () => {
   if (this.#session.isStreaming) throw new Error('Cannot hand off while a response is in progress');
   const r = await this.#session.handoff(customInstructions);
   return r ? { savedPath: r.savedPath } : null;
  });
 }

 // New, switched and branched sessions: the same quiesce/reattach OMP's hosts run around a session change.
 #change(type, extra, timeout) {
  const command = this.#accept(type, extra);
  return this.#serial(type, timeout, async () => {
   await this.#plan?.beforeSessionChange();
   let result;
   try {
    await this.#btw.close(); await this.#goal.beginSessionChange();
    try { result = await this.#rt.rpc.handleRpcSessionChange(this.#session, command, this.#subagents, undefined); }
    finally { await this.#goal.endSessionChange({ detachedRun: type !== 'branch' && result?.data.cancelled !== true }); await this.#goal.settled(); }
   } finally { await this.#plan?.reconcile(); }
   if (!result.data.cancelled) {
    this.#gate.commitSessionChange(command);
    if (type !== 'branch') this.#results.abortOpen();
    void this.#settle.check();
    await this.#publishCommands();
   }
   return plain(result.data);
  });
 }
 newSession() { return this.#change('new_session', {}, 60000); }
 switchSession(sessionPath) { return this.#change('switch_session', { sessionPath }, 60000); }
 branch(entryId) { return this.#change('branch', { entryId }, 30000); }

 loginProviders() {
  return this.#serial('get_login_providers', 30000, async () => {
   const keys = this.#session.modelRegistry.authStorage.keys;
   return { providers: this.#rt.oauth.getOAuthProviders().map(p => ({ id: p.id, name: p.name, available: p.available, authenticated: keys.source(p.storeCredentialsAs ?? p.id) !== undefined })) };
  });
 }
 /** OAuth login: the browser link arrives as an open_url request, pasted codes as input dialogs. */
 login(providerId) {
  return this.#serial('login', 0, async () => {
   const known = this.#rt.oauth.getOAuthProviders().find(p => p.id === providerId);
   if (!known) throw new Error(`Unknown OAuth provider: ${providerId}`);
   let authShown = false;
   await this.#session.modelRegistry.authStorage.oauth.login(providerId, {
    onAuth: info => { authShown = true; this.#emit({ type: 'extension_ui_request', id: randomUUID(), method: 'open_url', url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }); },
    onProgress: m => this.#ui.notify(m, 'info'),
    onPrompt: async p => {
     if (p.secret) throw new Error(`Provider '${providerId}' requires secret input, which the companion cannot collect. Use the terminal UI to log in.`);
     if (!authShown) throw new Error(`Provider '${providerId}' requires interactive prompts which the companion cannot answer. Use the terminal UI to log in.`);
     return (await this.#ui.input(p.message, p.placeholder, { timeout: 600000 })) ?? '';
    },
   });
   await this.#session.modelRegistry.refreshProvider(known.storeCredentialsAs ?? known.id, 'online');
   return { providerId };
  });
 }

 btw(question, recordId) { return this.#serial('btw', 60000, async () => plain({ record: await this.#btw.ask(question, recordId) })); }
 btwCancel(recordId) { return this.#call('btw_cancel', 30000, async () => ({ cancelled: this.#btw.cancel(recordId) })); }
 btwHistory() { return this.#serial('get_btw_history', 30000, async () => plain({ records: await this.#btw.history() })); }
 cancelSubagent(subagentId) { return this.#serial('cancel_subagent', 30000, async () => ({ cancelled: await this.#rt.rpc.handleRpcCancelSubagent(this.#subagents, subagentId) })); }
 steerSubagent(subagentId, text) {
  return this.#serial('steer_subagent', 60000, async () => {
   const failure = await this.#rt.rpc.handleRpcSteerSubagent(this.#subagents, subagentId, text);
   if (failure) throw new Error(failure);
  });
 }
 predictWord(text, cursor) {
  return this.#call('predict_word', 155000, async () => {
   const method = this.#rt.modeSettings.cfgSpellingAutocomplete.get(this.#session.settings);
   return { suffix: await this.#predictor.predict(method, text, cursor) };
  });
 }
 predictFeedback(text, cursor, suggestion, accepted) {
  return this.#call('predict_word_feedback', 30000, async () => {
   const method = this.#rt.modeSettings.cfgSpellingAutocomplete.get(this.#session.settings);
   if (method === 'off') return;
   const query = wordQueryAt(this.#rt.words, text, cursor);
   if (query) this.#rt.predict.textPredictionBackend(method).feedback(query.before, query.prefix, suggestion, accepted);
  });
 }

 #needPlan() { if (!this.#plan) throw new Error('This OMP build has no plan-mode host.'); return this.#plan; }
 setPlanMode(enabled, workflow) { return this.#serial('set_plan_mode', 30000, async () => plain({ planMode: await this.#needPlan().setMode(enabled, workflow) })); }
 reviewPlan() { return this.#serial('review_plan', 30000, async () => plain({ proposal: await this.#needPlan().review() })); }
 /** Errors keep OMP's code (stale_proposal). The approved plan then runs in the background. */
 approvePlan(request) {
  return this.#serial('approve_plan', 30000, async () => {
   const run = await this.#needPlan().acceptApproval({ type: 'approve_plan', ...request });
   this.#track(new Promise(resolve => setImmediate(resolve)).then(run).catch(e => this.#emit({ type: 'notice', level: 'error', source: 'plan-mode', message: message(e) })));
   return { proposalId: request.proposalId, action: request.action };
  });
 }

 // An extension called pi.shutdown(): close once no command or background task still owes a result.
 #maybeShutdown() {
  if (!this.#shutdown || !this.alive || this.#tasks.size) return;
  void this.#tail.then(() => { if (this.alive && !this.#tasks.size) void this.#dispose(new Error('OMP exited (0).')); });
 }
 /** Stops the session; `closed` settles when OMP has released it. */
 kill() {
  if (this.stopping && this.#disposing) return this.#closed;
  this.stopping = true;
  return this.#dispose(new Error('OMP stopped.'));
 }
 async #dispose(error) {
  if (this.#disposing) return this.#closed;
  this.#disposing = true;
  this.#plan?.cancel();
  this.#pending?.rejectAll('The companion stopped this OMP session before the dialog was answered.');
  this.alive = false; this.#exitError(error);
  // A session still opening disposes itself once it sees #disposing (see #open).
  if (!this.#opened) await this.#opening.catch(() => {});
  const s = this.#opened ? this.#session : undefined;
  try {
   if (s) {
    await this.#btw.close().catch(e => console.error('OMP side question:', message(e)));
    await s.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL }).catch(() => {});
    this.#subagents.dispose();
    await s.dispose();
   }
  } catch (e) { error = this.#persistFailure && e === this.#persistFailure ? new Error(`OMP could not save the session: ${message(e)}`) : e instanceof Error ? e : new Error(String(e)); }
  finally { this.#exit(error); this.#closeDone(); }
  return this.#closed;
 }
}

const PREF_COMMANDS = { fast: 'set_fast_mode', autoCompaction: 'set_auto_compaction', autoRetry: 'set_auto_retry', steeringMode: 'set_steering_mode', followUpMode: 'set_follow_up_mode', interruptMode: 'set_interrupt_mode' };
