// OMP runs inside the companion's own process through its SDK: each live session is an AgentSession, built the way
// `omp` builds its own (same CLI flag semantics), and driven with direct calls; its events arrive as plain objects.
// OMP's SDK is TypeScript that needs Bun, so this module only loads OMP when a session starts under Bun.
// The plan, goal, side-question, subagent, prompt-result and settle controllers are OMP's own in-process classes
// (shipped under modes/rpc/); the companion uses them so it behaves exactly like OMP's other hosts. OMP builds without
// the /goal or plan-mode hosts get the companion's (goal-host.mjs, plan-host.mjs), built on OMP's goal controller and the
// TUI's plan-mode pieces; built-ins OMP ships only for its terminal UI run on the companion's hosts (command-hosts.mjs).
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GoalController, goalSlashHost } from './goal-host.mjs';
import { loadPlanMode } from './plan-host.mjs';
import { loadCommandHosts, unhostedMessage } from './command-hosts.mjs';
import { RUNTIME_FILES, ompSources } from './omp-sdk.mjs';
import { loadCustomUI, customUI } from './custom-ui.mjs';

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
 // No OMP auto-titles (the companion titles sessions), as in OMP's headless hosts.
 process.env.PI_NO_TITLE = '1';
 const at = rel => import(pathToFileURL(path.join(src, rel)).href);
 const optional = rel => existsSync(path.join(src, rel)) ? at(rel) : null;
 const pkg = spec => import(pathToFileURL(Bun.resolveSync(spec, src)).href);
 const names = Object.keys(RUNTIME_FILES);
 const [modules, oauth, tuiTheme, words, forkPlan, goalSlash, mcpReauth] = await Promise.all([
  Promise.all(names.map(name => at(RUNTIME_FILES[name]))),
  pkg('@oh-my-pi/pi-ai/oauth'), pkg('@oh-my-pi/pi-tui/theme'), pkg('@oh-my-pi/pi-tui/prompt/word-completion'),
  // Plan-mode and /goal hosting ship only in some OMP builds; state() reports plan mode only when it does.
  optional('modes/rpc/rpc-plan-mode.ts'), optional('modes/rpc/rpc-goal-slash.ts'),
  // OMP 18.12.6+: `/mcp reauth` reconnects the server in the running session.
  optional('mcp/oauth-reauth.ts'),
 ]);
 const m = Object.fromEntries(names.map((name, i) => [name, modules[i]]));
 // Builds without OMP's RPC plan mode get the companion's (plan-host.mjs); without its pieces plan mode stays unsupported.
 const plan = forkPlan ?? await loadPlanMode({ at, pkg, text: rel => Bun.file(path.join(src, rel)).text() })
  .catch(e => { console.error(`Plan mode is unavailable with this OMP build: ${e.message}`); return null; });
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
 const commandHosts = await loadCommandHosts({ at, optional, pkg, text: rel => Bun.file(path.join(src, rel)).text(), m });
 // ctx.ui.custom (custom-ui.mjs) draws extension panels and the bash tool's `pty: true` terminal in the dashboard. Without
 // it, custom() resolves undefined as in OMP's RPC host, and bash runs without a PTY as OMP's headless hosts do.
 const custom = await loadCustomUI(pkg).catch(e => { console.error(`Custom extension UI is unavailable with this OMP build: ${e.message}`); return null; });
 if (!custom) process.env.PI_NO_PTY = '1';
 return { ...m, oauth, tuiTheme, words, plan, ...goal, mcpReauth, commandHosts, custom, settings, authStorage, modelRegistry };
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
   goalController: (session, dropped, held) => new GoalController(goal.RpcGoalController, session, dropped, goalSettings, 'interactive', held),
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
 // Hosted built-ins (command-hosts.mjs), the session's MCP manager and event buses, and the abort controllers of built-in
 // commands still running (OMP 18.12.6 RPC semantics: host abort and shutdown tear them down).
 #hosted = []; #unhosted = new Set(); #mcp; #buses; #builtinAborts = new Set(); #inputs = new Set();
 // Components open through ctx.ui.custom (custom-ui.mjs).
 #custom;

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
  const { session, setToolUIContext, modelFallbackMessage, mcpManager } = await sdk.createAgentSession(options);
  this.#session = session; this.#mcp = mcpManager; this.#buses = { eventBus, subagentEventBus };
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
  // Hosts can withhold goal continuation (/loop, as the TUI does while loop mode is on); OMP's own controller (fork builds) cannot.
  this.#goal = rt.goalController(session, () => void this.#settle.check(), () => this.#hosted.some(h => h.holdsGoalContinuation?.()));
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
    this.#guard('session');
    await this.#btw.close(); await this.#goal.beginSessionChange();
    for (const h of this.#hosted) await h.beforeSessionChange?.();
    let result;
    try { result = await change(); return result; }
    finally {
     await this.#goal.endSessionChange({ detachedRun: detachesRun && result?.cancelled !== true });
     if (result && !result.cancelled) { if (detachesRun) this.#results.abortOpen(); void this.#settle.check(); this.#eachHost(h => h.afterSessionChange?.()); }
    }
   },
   reportSendError: (action, err) => out({ type: 'notice', level: 'error', message: `${action}: ${err.message}` }),
   reportRuntimeError: err => out({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error }),
   onShutdown: () => { this.#shutdown = true; this.#maybeShutdown(); },
   trackAgentInvokingMessage: task => this.#tracker.trackAgentMessageTask(task),
   uiContext: this.#ui,
  });
  if (rt.plan) { this.#plan = new rt.plan.RpcPlanMode(session, out); await this.#plan.reconcile(); }
  for (const h of rt.commandHosts) {
   try { const x = await h.create(this.#hostIO()); if (x) this.#hosted.push(x); }
   catch (e) { console.error(`/${h.name} is unavailable in this session: ${message(e)}`); }
  }
  // OMP's single-slot switch reconcilers (the TUI's live stop, vibe quiesce and mode reconcile), fanned out to hosts:
  // they fire inside every session switch, new session and branch, whoever started it.
  session.setSessionBeforeSwitchReconciler?.(async () => { for (const h of this.#hosted) await h.beforeSwitch?.(); });
  session.setSessionSwitchReconciler?.(async () => { for (const h of this.#hosted) await Promise.resolve(h.afterSwitch?.()).catch(e => console.error('Companion command host failed:', e)); });
  session.subscribe(event => {
   out(event);
   // Goal first: a continuation decided at this agent_end must be scheduled before either report reads settlement.
   this.#goal.observe(event); this.#plan?.observe(event); this.#results.observe(event); this.#settle.observe(event);
   for (const h of this.#hosted) { try { h.observe?.(event); } catch (e) { console.error('Companion command host failed:', e); } }
  });
  await this.#goal.reconcile(); await this.#goal.settled();
  rpc.registerRpcPersistenceSurface(session, out, e => { this.#persistFailure = e; });
  session.subscribeCommandMetadataChanged(() => void this.#publishCommands());
  await this.#publishCommands();
 }

 #uiContext(rt) {
  const { rpc } = rt, pending = this.#pending, out = f => this.#emit(f);
  const fire = request => out({ type: 'extension_ui_request', id: randomUUID(), ...request });
  const custom = this.#custom = rt.custom ? customUI(rt.custom, () => rt.tuiTheme.theme, out) : null;
  // A host may race a dialog against another answerer (a collab host's guests, as OMP's TUI does): its raceUi returns
  // the first answer, the loser cancelled; `local(signal)` shows the dashboard's dialog bound to that signal.
  const raced = (method, args, dialog, local) => {
   for (const h of this.#hosted) { const r = h.raceUi?.(method, args, dialog?.signal, signal => local({ ...dialog, signal })); if (r) return r; }
   return local(dialog);
  };
  return {
   supportsEditor: true,
   get askDialog() { return (questions, options) => raced('askDialog', { questions }, options, d => rpc.requestRpcAskDialog(pending, out, questions, d)); },
   select: (title, options, dialog) => raced('select', { title, options, dialog }, dialog, d => rpc.requestRpcSelect(pending, out, title, options, d)),
   confirm: (title, msg, dialog) => rpc.requestRpcDialog(pending, out, dialog, false, { method: 'confirm', title, message: msg, timeout: dialog?.timeout }, r => {
    if (r.cancelled) { if (r.timedOut) dialog?.onTimeout?.(); return false; }
    return 'confirmed' in r ? r.confirmed : false;
   }),
   input: (title, placeholder, dialog) => rpc.requestRpcDialog(pending, out, dialog, undefined, { method: 'input', title, placeholder, timeout: dialog?.timeout }, r => {
    if (r.cancelled) { if (r.timedOut) dialog?.onTimeout?.(); return undefined; }
    return 'value' in r ? r.value : undefined;
   }),
   editor: (title, prefill, dialog, editorOptions) => raced('editor', { title, prefill }, dialog, d => rpc.requestRpcEditor(pending, out, title, prefill, d, editorOptions)),
   notify: (msg, type) => fire({ method: 'notify', message: msg, notifyType: type }),
   setStatus: (key, text) => fire({ method: 'setStatus', statusKey: key, statusText: text }),
   setWidget: (key, content, options) => { if (content === undefined || Array.isArray(content)) fire({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement }); },
   setEditorText: text => fire({ method: 'set_editor_text', text }),
   pasteToEditor: text => fire({ method: 'set_editor_text', text }),
   getEditorText: () => '',
   onTerminalInput: () => () => {},
   setWorkingMessage() {}, setFooter() {}, setHeader() {}, setTitle() {}, addAutocompleteProvider() {}, setToolsExpanded() {}, setEditorComponent() {},
   getToolsExpanded: () => false, getEditorComponent: () => undefined,
   custom: custom ? (factory, options) => custom.show(factory, options) : async () => undefined,
   get theme() { return rt.tuiTheme.theme; },
   getAllThemes: async () => [], getTheme: async () => undefined,
   setTheme: async () => ({ success: false, error: 'Theme switching is not supported in the companion.' }),
  };
 }

 // A dialog answer: { value } | { confirmed } | { answers } | { cancelled: true }; a custom component's: { input } | { resize } | { cancelled: true }.
 answer(id, reply) {
  if (!this.alive || !this.#pending) throw new Error(NOT_RUNNING);
  if (this.#custom?.has(id)) return this.#custom.reply(id, reply);
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
  const hosted = this.#hosted.flatMap(h => h.commands());
  const own = new Set([...(this.#plan ? ['plan', 'plan-review'] : []), ...(rt.goalSlash ? ['goal'] : []), ...hosted.map(c => c.name)]);
  const all = [...(this.#plan?.commands() ?? []), ...(rt.goalSlash?.rpcGoalCommands(s) ?? []), ...hosted, ...list.filter(c => !own.has(c.name))];
  // Built-ins OMP ships only for its terminal UI and nothing here runs: rejected instead of reaching the model as text,
  // unless an extension, custom or file command of that name takes them.
  const taken = new Set(all.flatMap(c => [c.name, ...(c.aliases ?? [])]));
  for (const h of this.#hosted) for (const n of h.names) taken.add(n);
  this.#unhosted = new Set(rt.builtinRegistry.BUILTIN_SLASH_COMMANDS_INTERNAL.filter(c => !c.handle).flatMap(c => [c.name, ...(c.aliases ?? [])]).filter(n => !taken.has(n) && !(n.startsWith('plan') && !this.#plan) && n !== 'goal'));
  return all;
 }
 async #publishCommands() { if (this.alive) this.#emit({ type: 'available_commands_update', commands: plain(await this.#commands()) }); }
 async #reloadPlugins() {
  const cwd = this.#session.sessionManager.getCwd(), h = this.#rt.discoveryHelpers;
  const project = await h.resolveActiveProjectRegistryPath(cwd);
  h.clearPluginRootsAndCaches(project ? [project] : undefined);
  await this.#session.refreshSkillsAndCommands();
  await this.#publishCommands();
 }

 // The SlashCommandRuntime OMP's RPC host gives built-in commands (18.12.6: MCP reconnect and a host abort signal).
 #commandRuntime(signal, background = task => this.#track(task())) {
  const s = this.#session, manager = this.#mcp, reauth = this.#rt.mcpReauth;
  return {
   session: s, sessionManager: s.sessionManager, settings: s.settings, cwd: s.sessionManager.getCwd(),
   output: t => this.#emit({ type: 'command_output', text: t }),
   refreshCommands: () => this.#publishCommands(),
   reloadPlugins: () => this.#reloadPlugins(),
   mcpManager: manager,
   reconnectMcpServer: manager && reauth ? async (name, selected) => {
    const state = await reauth.reconnectMcpManagerServer(manager, name, selected);
    // No tools-changed callback is wired here, as in OMP's RPC host: rebind so later prompts see the recovered tools.
    if (state) await s.refreshMCPTools(manager.getTools());
    return state;
   } : undefined,
   signal,
   runCommandInBackground: background,
   notifyTitleChanged: async () => this.#emit({ type: 'session_info_update', title: s.sessionName, sessionId: s.sessionId }),
   notifyConfigChanged: async () => { await this.#plan?.refreshPlanModelRole?.(); this.#emit({ type: 'config_update', model: plain(s.model), thinkingLevel: s.thinkingLevel }); },
  };
 }
 // A host abort (Stop, Stop & send): built-in commands still running are torn down and hosted commands told (abort?()).
 #abortBuiltins(reason) {
  for (const c of this.#builtinAborts) c.abort(reason);
  this.#builtinAborts.clear();
  this.#eachHost(h => h.abort?.());
  this.#custom?.closeAll(reason);
 }
 #eachHost(fn) { for (const h of this.#hosted) { try { fn(h); } catch (e) { console.error('Companion command host failed:', e); } } }

 // What a hosted command (command-hosts.mjs) gets for its session.
 #hostIO() {
  const self = this;
  return {
   rt: this.#rt, ui: this.#ui, buses: this.#buses,
   get session() { return self.#session; }, get mcpManager() { return self.#mcp; }, get goal() { return self.#goal; },
   /** Plan mode as the companion's plan host sees it ({ enabled, paused, … }); undefined when this build has none. */
   get planMode() { return self.#plan?.state; },
   emit: f => this.#emit(f),
   output: t => this.#emit({ type: 'command_output', text: t }),
   notice: (level, text) => this.#emit({ type: 'notice', level, message: text }),
   track: task => this.#track(task),
   publishCommands: () => this.#publishCommands(),
   commandRuntime: signal => this.#commandRuntime(signal),
   /** A new, switched, branched or forked session from inside a command (the prompt queue is already held). `change`, when
    *  given, performs the change itself (resolving to { cancelled }) instead of OMP's RPC session change for `type`. */
   changeSession: (type, extra, change) => this.#changeNow(this.#accept(type, extra), change),
   /** The same from outside a command (a host reacting to its own events): accepted now, run in command order. */
   queueSessionChange: (type, extra, change) => this.#change(type, extra, 0, change),
   /** Sends text as the user's next prompt, after whatever the companion is doing now. */
   submit: (text, images, id) => this.prompt({ id, message: text, images }, 0),
   /** True while user input (a prompt, steer, follow-up, Stop & send or session change) is accepted but not yet admitted. */
   inputPending: () => this.#inputs.size > 0,
   plain,
  };
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
   // A host that takes over the session's input (a collab guest forwards it to the room's host).
   for (const h of this.#hosted) if (h.intercept?.(text, images, kind)) return 'local';
   if (kind !== 'steer' && kind !== 'follow_up') await this.#plan?.beforePrompt();
   if (!current()) return 'cancelled';
   if (kind === 'steer') { await s.steer(text, images); return 'admitted'; }
   if (kind === 'follow_up') { await s.followUp(text, images); return 'admitted'; }
   // What the user typed (or a command's prompt), for hosts that repeat it (/loop); queued: sent while a turn ran.
   let typed = command.message;
   const queued = s.isStreaming;
   if (kind === 'prompt') {
    const skillTurn = t => this.#rt.rpc.dispatchRpcSkillPrompt({ ticket, session: s, message: t, streamingBehavior: command.streamingBehavior, results: this.#results, onError: this.#lateError(command.id, kind), extensionUserMessageTracker: this.#tracker, images, isCurrent: current });
    const skill = await skillTurn(text);
    if (skill === 'cancelled') return 'cancelled';
    if (skill) { this.#eachHost(h => h.prompted?.(typed, { queued: false })); return 'admitted'; }
    // Companion-hosted built-ins first (they may refine a text-mode built-in, like /todo edit), then OMP's.
    const parsed = this.#rt.slashParse.parseSlashCommand(text);
    const host = parsed ? this.#hosted.find(h => h.claims ? h.claims(parsed) : h.names.includes(parsed.name)) : undefined;
    const abort = new AbortController();
    let builtin, background = false;
    this.#builtinAborts.add(abort);
    try {
     builtin = host ? (await host.run(parsed, { images, signal: abort.signal })) ?? { consumed: true }
      : await this.#rt.builtins.executeAcpBuiltinSlashCommand(text, this.#commandRuntime(abort.signal, task => { background = true; this.#track(task().finally(() => this.#builtinAborts.delete(abort))); }));
    } finally { if (!background) this.#builtinAborts.delete(abort); }
    // The command replaced the transcript (and so invalidated input accepted before it): report it, whatever is current.
    if (builtin?.sessionChanged) { command.result = { sessionChanged: true, ...(builtin.note ? { note: builtin.note } : {}), ...(builtin.failed ? { failed: true } : {}) }; return 'local'; }
    if (!current()) return 'cancelled';
    if (builtin === false && parsed && this.#unhosted.has(parsed.name)) throw new Error(unhostedMessage(parsed.name));
    if (builtin !== false) {
     if (!('prompt' in builtin)) {
      if (builtin.failed) command.result = { failed: true };
      if (builtin.agentInvoked === true) {
       void s.waitForIdle().then(() => this.#results.settle(ticket), e => this.#results.fail(ticket, message(e)));
       return 'builtin-agent';
      }
      return 'local';
     }
     text = typed = builtin.prompt;
     // A hosted command's prompt can name a skill (/vibe /skill:x), which the TUI invokes as one.
     if (host) {
      const hostedSkill = await skillTurn(text);
      if (hostedSkill === 'cancelled') return 'cancelled';
      if (hostedSkill) { this.#eachHost(h => h.prompted?.(typed, { queued: false })); return 'admitted'; }
     }
    }
   }
   if (!current() || !ticket) return 'cancelled';
   this.#eachHost(h => h.prompted?.(typed, { queued }));
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
 // User input accepted but not yet admitted (or finished locally), for io.inputPending().
 #pendingInput(command, run) { this.#inputs.add(command); const done = () => { this.#inputs.delete(command); }; run.then(done, done); return run; }

 /** Sends a message as a new turn (or, while one runs, as `streamingBehavior` says). Slash commands run here too. */
 prompt({ id = randomUUID(), message: text, images, streamingBehavior }, timeout = 30000) {
  const command = this.#accept('prompt', { id, message: text, images, streamingBehavior });
  return this.#pendingInput(command, this.#serial('prompt', timeout, async () => {
   const ticket = this.#results.begin(id);
   try {
    const goalArgs = this.#rt.goalSlash?.parseRpcGoalSlash(text);
    if (goalArgs !== undefined) {
     // Handled before #input (where hosts intercept slash commands), so a host may refuse it here.
     this.#guard('/goal');
     try {
      const { objective } = await this.#rt.goalSlash.runRpcGoalSlash(goalArgs, this.#session, this.#goal, this.#ui, this.#plan?.state);
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
     this.#guard(`/${planSlash[1]}`);
     if (planSlash[1] === 'plan-review') { if (planSlash[2]?.trim()) throw new Error('/plan-review takes no arguments'); await this.#plan.review(); }
     else {
      // OMP's TUI /plan [prompt]: toggles on → paused → off, and `/plan <prompt>` enters plan mode (from off or paused) and
      // submits the prompt as the first planning turn; while planning it leaves plan mode. on/off/parallel/iterative are the
      // RPC host's explicit modes.
      const option = planSlash[2]?.trim(), plan = this.#plan, keyword = ['on', 'off', 'parallel', 'iterative'].includes(option);
      const enable = keyword ? option !== 'off' : !plan.state.enabled && (!plan.state.paused || !!option);
      if (enable || await this.#confirmPlanExit()) {
       await plan.setMode(enable, option === 'parallel' || option === 'iterative' ? option : undefined);
       if (enable && option && !keyword) {
        command.message = option;
        const outcome = await this.#input('prompt', command, ticket);
        if (outcome === 'local') { this.#results.discard(ticket); return { agentInvoked: false }; }
        if (outcome === 'cancelled') this.#results.settle(ticket);
        return { agentInvoked: outcome !== 'cancelled' };
       }
      }
     }
     this.#results.discard(ticket); return { agentInvoked: false };
    }
    const outcome = await this.#input('prompt', command, ticket);
    // sessionChanged: the command replaced the transcript; failed: a built-in reported failure (OMP 18.12.6).
    if (outcome === 'local') { this.#results.discard(ticket); return { agentInvoked: false, ...command.result }; }
    if (outcome === 'builtin-agent') return { agentInvoked: true };
    if (outcome === 'cancelled') this.#results.settle(ticket);
    return {};
   } catch (e) { this.#results.discard(ticket); throw e; }
  }));
 }
 steer({ message: text, images }) { const c = this.#accept('steer', { message: text, images }); return this.#pendingInput(c, this.#serial('steer', 30000, async () => { await this.#input('steer', c); })); }
 followUp({ message: text, images }) { const c = this.#accept('follow_up', { message: text, images }); return this.#pendingInput(c, this.#serial('follow_up', 30000, async () => { await this.#input('follow_up', c); })); }
 /** Stop & send: aborts the turn, then starts this message. */
 interrupt({ id = randomUUID(), message: text, images }) {
  const command = this.#accept('abort_and_prompt', { id, message: text, images });
  this.#inputs.add(command);
  const done = () => { this.#inputs.delete(command); };
  return this.#serial('abort_and_prompt', 30000, async () => {
   this.#plan?.cancel(); this.#goal.stopForHostAbort(); this.#abortBuiltins('RPC command aborted by host');
   await this.#session.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL });
   await this.#plan?.settle();
   const ticket = this.#results.begin(id);
   void this.#input('abort_and_prompt', command, ticket).then(
    outcome => { done(); if (outcome === 'cancelled') this.#results.settle(ticket); else if (outcome === 'local') this.#results.completeLocal(ticket); },
    e => { done(); this.#lateError(id, 'abort_and_prompt')(e); this.#results.fail(ticket, message(e)); });
  }).catch(e => { done(); throw e; });
 }
 abort() {
  this.#accept('abort');
  return this.#call('abort', 30000, async () => {
   this.#plan?.cancel(); this.#goal.stopForHostAbort(); this.#abortBuiltins('RPC command aborted by host');
   await this.#session.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL });
  });
 }
 /** Stop for one background run a hosted command reported (`command_run` frame key; every run when omitted): the TUI's Esc
  * on that command's panel. The turn and other runs are not touched. */
 stopCommands(run) { return this.#call('stop_commands', 30000, async () => this.#eachHost(h => h.stopRun?.(run))); }
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
    // Built-ins the companion rejects (terminal UI only, not hosted), and what the hosted ones report.
    unhostedCommands: [...this.#unhosted],
    ...Object.assign({}, ...this.#hosted.map(h => h.state?.() ?? {})),
    // The live model's selectable levels, `off` included (OMP's RPC get_available_thinking_levels).
    thinkingLevels: ['off', ...s.getAvailableThinkingLevels()],
    slowModeSupported: s.isSlowModeSupported(), slowModeEnabled: s.isSlowModeEnabled(), slowModeScope: s.getSlowModeScope() ?? null,
    cacheWarming: this.#rt.configRegistry.lookup('providers.cacheWarming')?.get(s.settings) ?? null,
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
 // A host that stands in for this session's agents (a collab guest: the room host's subagents, run through its Agent Hub).
 #roster() { for (const h of this.#hosted) { const r = h.agents?.(); if (r) return r; } }
 subagents() { return this.#serial('get_subagents', 30000, async () => plain({ subagents: this.#roster()?.list() ?? this.#subagents.getSubagents() })); }
 // A subagent transcript the roster keeps from elsewhere (a collab guest's copy of the room host's), brought up to date
 // before the dashboard reads it; false when the file is not the roster's. Not serialized: the host's reply may take seconds.
 subagentTranscript(file) { return this.#call('subagent_transcript', 30000, async () => (await this.#roster()?.transcript?.(file)) ?? false); }
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
 // Session operations a hosted command can refuse while it owns the session (a collab guest: the room's host runs them).
 // `detail`: for 'session', the host-supplied change function (undefined for the companion's and extensions' changes).
 #guard(op, detail) { for (const h of this.#hosted) { const why = h.refuse?.(op, detail); if (why) throw new Error(why); } }
 async #findModel(provider, modelId) {
  const s = this.#session, find = () => s.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
  const model = find(); if (model) return model;
  await s.modelRegistry.awaitBackgroundRefresh();
  return find();
 }
 setModel(provider, modelId) {
  return this.#serial('set_model', 30000, async () => {
   this.#guard('model'); this.#planIdle();
   const model = await this.#findModel(provider, modelId);
   if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
   await this.#session.setModel(model);
   return plain(model);
  });
 }
 cycleModel() { return this.#serial('cycle_model', 30000, async () => { this.#guard('model'); this.#planIdle(); return plain(await this.#session.cycleModel()); }); }
 availableModels() { return this.#serial('get_available_models', 60000, async () => { await this.#session.modelRegistry.awaitBackgroundRefresh(); return plain({ models: this.#session.getAvailableModels() }); }); }
 setThinking(level) { return this.#serial('set_thinking_level', 30000, async () => { this.#guard('thinking'); this.#planIdle(); this.#session.setThinkingLevel(level); }); }
 cycleThinking() { return this.#serial('cycle_thinking_level', 30000, async () => { this.#guard('thinking'); this.#planIdle(); const level = this.#session.cycleThinkingLevel(); return level ? { level } : null; }); }
 /** The dashboard's per-session toggles. */
 setPref(key, value) {
  return this.#serial(PREF_COMMANDS[key] ?? 'set_pref', 30000, async () => {
   const s = this.#session;
   if (key === 'fast') { if (!s.setFastMode(value) && value) throw new Error('Fast mode is unavailable for the current model.'); }
   else if (key === 'autoCompaction') s.setAutoCompactionEnabled(value);
   else if (key === 'autoRetry') s.setAutoRetryEnabled(value);
   else if (key === 'steeringMode' || key === 'followUpMode' || key === 'interruptMode') this.#rt.rpc.applyRpcQueueModeCommand(s, { type: PREF_COMMANDS[key], mode: value });
   // As OMP's RPC set_slow_mode / set_cache_warming: slow mode follows the live model; cache warming is a session override.
   else if (key === 'slowMode') { if (!s.setSlowMode(value) && value) throw new Error('Slow mode is unavailable for the current model.'); }
   else if (key === 'cacheWarming') s.setCacheWarmingMode(value);
   else throw new Error(`Unknown session setting: ${key}`);
  });
 }
 compact(customInstructions) { return this.#serial('compact', 0, async () => { this.#guard('compact'); this.#planIdle(); return plain(await this.#session.compact(customInstructions)); }); }
 // Outside the command queue, so abortBash can stop it.
 bash(command) {
  return this.#call('bash', 0, () => this.#track((async () => {
   this.#guard('bash');
   if (this.#plan && (this.#plan.state.enabled || this.#plan.busy)) throw new Error('User bash commands are unavailable during native read-only planning');
   return plain(await this.#session.executeBash(command));
  })()));
 }
 abortBash() { return this.#call('abort_bash', 30000, async () => { this.#session.abortBash(); }); }
 handoff(customInstructions) {
  return this.#serial('handoff', 0, async () => {
   this.#guard('handoff');
   if (this.#session.isStreaming) throw new Error('Cannot hand off while a response is in progress');
   const r = await this.#session.handoff(customInstructions);
   return r ? { savedPath: r.savedPath } : null;
  });
 }

 // New, switched and branched sessions: the same quiesce/reattach OMP's hosts run around a session change.
 // Accepted when requested, not when it runs: input sent after the change survives it (RpcUserInputGate's ordering).
 #change(type, extra, timeout, change) { const command = this.#accept(type, extra); return this.#pendingInput(command, this.#serial(type, timeout, () => this.#changeNow(command, change))); }
 // The change itself, for #change and for hosted commands that already hold the command queue (/fork, /clear).
 async #changeNow(command, change) {
  const type = command.type;
  // Checked when the change runs, not when it was queued: a guest's own queued restore must not let an earlier one through.
  this.#guard('session', change);
  await this.#plan?.beforeSessionChange();
  for (const h of this.#hosted) await h.beforeSessionChange?.();
  let result;
  try {
   await this.#btw.close(); await this.#goal.beginSessionChange();
   try {
    if (change) { const data = await change(); if (!data.cancelled) this.#subagents.clear(); result = { data }; }
    else result = await this.#rt.rpc.handleRpcSessionChange(this.#session, command, this.#subagents, undefined);
   }
   finally { await this.#goal.endSessionChange({ detachedRun: type !== 'branch' && result?.data.cancelled !== true }); await this.#goal.settled(); }
  } finally { await this.#plan?.reconcile(); }
  if (!result.data.cancelled) {
   this.#gate.commitSessionChange(command);
   if (type !== 'branch') this.#results.abortOpen();
   void this.#settle.check();
   this.#eachHost(h => h.afterSessionChange?.());
   await this.#publishCommands();
  }
  return plain(result.data);
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
   await this.#session.modelRegistry.authStorage.oauth.login(providerId, {
    onAuth: info => { this.#emit({ type: 'extension_ui_request', id: randomUUID(), method: 'open_url', url: info.url, launchUrl: info.launchUrl, instructions: info.instructions }); },
    onProgress: m => this.#ui.notify(m, 'info'),
    // OMP's RPC host refuses these (no UI of its own); the dashboard asks, a secret in a masked field that is never stored.
    onPrompt: async p => {
     const r = await this.#rt.rpc.requestRpcDialog(this.#pending, f => this.#emit(f), { timeout: 600000 }, undefined, { method: 'input', title: p.message, placeholder: p.placeholder, timeout: 600000, ...(p.secret ? { secret: true } : {}) }, r => r.cancelled ? undefined : 'value' in r ? r.value : undefined);
     if (r === undefined) throw new Error('Login cancelled.');
     return r;
    },
   });
   await this.#session.modelRegistry.refreshProvider(known.storeCredentialsAs ?? known.id, 'online');
   return { providerId };
  });
 }

 btw(question, recordId) { return this.#serial('btw', 60000, async () => plain({ record: await this.#btw.ask(question, recordId) })); }
 btwCancel(recordId) { return this.#call('btw_cancel', 30000, async () => ({ cancelled: this.#btw.cancel(recordId) })); }
 btwHistory() { return this.#serial('get_btw_history', 30000, async () => plain({ records: await this.#btw.history() })); }
 cancelSubagent(subagentId) {
  return this.#serial('cancel_subagent', 30000, async () => {
   const roster = this.#roster();
   return { cancelled: roster ? await roster.cancel(subagentId) : await this.#rt.rpc.handleRpcCancelSubagent(this.#subagents, subagentId) };
  });
 }
 steerSubagent(subagentId, text) {
  return this.#serial('steer_subagent', 60000, async () => {
   const roster = this.#roster();
   if (roster) { await roster.steer(subagentId, text); return; }
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
 // OMP's TUI asks before leaving plan mode with a draft plan (handlePlanModeCommand); No keeps planning.
 async #confirmPlanExit() {
  const plan = this.#plan;
  if (!plan.state.enabled || !(await plan.hasDraft?.())) return true;
  return this.#ui.confirm('Exit plan mode?', 'This exits plan mode without approving a plan.');
 }
 // No time limit: leaving plan mode with a draft waits for the user's answer.
 setPlanMode(enabled, workflow) {
  return this.#serial('set_plan_mode', 0, async () => {
   const plan = this.#needPlan();
   if (!enabled && !(await this.#confirmPlanExit())) return plain({ planMode: plan.state });
   return plain({ planMode: await plan.setMode(enabled, workflow) });
  });
 }
 reviewPlan() { return this.#serial('review_plan', 30000, async () => plain({ proposal: await this.#needPlan().review() })); }
 /** Errors keep OMP's code (stale_proposal). The approved plan then runs in the background. */
 approvePlan(request) {
  return this.#serial('approve_plan', 30000, async () => {
   const run = await this.#needPlan().acceptApproval({ type: 'approve_plan', ...request });
   if (request.action === 'save') {
    // OMP's TUI "Save and quit": the plan is saved and plan mode left, then a fresh session starts (handleClearCommand).
    const { savedPath } = await run();
    const changed = await this.#changeNow(this.#accept('new_session', {}));
    const sessionChanged = changed?.cancelled !== true;
    return { proposalId: request.proposalId, action: request.action, savedPath, sessionChanged, note: sessionChanged ? `Saved plan to ${savedPath}.` : `Saved plan to ${savedPath}, but could not start a new session.` };
   }
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
    for (const c of this.#builtinAborts) c.abort('RPC client disconnected');
    this.#custom?.closeAll('RPC client disconnected');
    for (const h of this.#hosted) await Promise.resolve(h.dispose?.()).catch(e => console.error('Companion command host failed:', e));
    await s.abort({ reason: this.#rt.messages.USER_INTERRUPT_LABEL }).catch(() => {});
    this.#subagents.dispose();
    await s.dispose();
   }
  } catch (e) { error = this.#persistFailure && e === this.#persistFailure ? new Error(`OMP could not save the session: ${message(e)}`) : e instanceof Error ? e : new Error(String(e)); }
  finally { this.#exit(error); this.#closeDone(); }
  return this.#closed;
 }
}

const PREF_COMMANDS = { fast: 'set_fast_mode', autoCompaction: 'set_auto_compaction', autoRetry: 'set_auto_retry', steeringMode: 'set_steering_mode', followUpMode: 'set_follow_up_mode', interruptMode: 'set_interrupt_mode', slowMode: 'set_slow_mode', cacheWarming: 'set_cache_warming' };
