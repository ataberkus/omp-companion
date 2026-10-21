// /tan, /omfg, /cleanse and /seance: OMP runs them only in its terminal UI. The companion drives the TUI's own controllers
// (TanCommandController, OmfgController, SEANCE_SLASH_COMMAND.handleTui) through tui-context.mjs; their docked panels
// render into dashboard widgets and are posted to the chat once settled, and Stop stands in for the terminal's Esc.
// /cleanse runs OMP's cleanse pieces in the session's folder: runCleanse itself always works in the process's project
// directory (getProjectDir), which in the companion is not the session's.
import { builtinEntry } from './command-hosts.mjs';
import { fenced, componentLines, loadTuiKit, tuiContext } from './tui-context.mjs';

export const tan = {
 name: 'tan',
 async load(env) {
  const [kit, { TanCommandController }] = await Promise.all([loadTuiKit(env), env.at('modes/controllers/tan-command-controller.ts')]);
  const entries = [builtinEntry(env.m.builtinRegistry, 'tan')];
  return io => {
   const ctx = tuiContext(io, kit), controller = new TanCommandController(ctx);
   return { names: ['tan'], commands: () => entries, run: parsed => ctx.command(() => controller.start(parsed.args)) };
  };
 },
};

export const seance = {
 name: 'seance',
 async load(env) {
  const [kit, { SEANCE_SLASH_COMMAND }] = await Promise.all([loadTuiKit(env), env.at('slash-commands/seance.ts')]);
  const entries = [builtinEntry(env.m.builtinRegistry, 'seance')];
  return io => {
   const ctx = tuiContext(io, kit);
   // draftDetached: the dashboard already cleared its composer, so the TUI's editor is never touched.
   return { names: ['seance'], commands: () => entries, run: parsed => ctx.command(() => SEANCE_SLASH_COMMAND.handleTui(parsed, { ctx, draftDetached: true })), abort: () => ctx.cancelDialogs(), dispose: () => ctx.cancelDialogs() };
  };
 },
};

// The TUI's /omfg panel stays docked after it settles until Esc dismisses it; here the settled panel goes to the chat.
export const omfg = {
 name: 'omfg',
 async load(env) {
  const [kit, { OmfgController }] = await Promise.all([loadTuiKit(env), env.at('modes/controllers/omfg-controller.ts')]);
  const entries = [builtinEntry(env.m.builtinRegistry, 'omfg')];
  return io => {
   const ctx = tuiContext(io, kit);
   ctx.omfgContainer = ctx.widget('omfg');
   const controller = new OmfgController(ctx);
   const stop = () => { ctx.cancelDialogs(); if (controller.hasActiveRequest()) controller.handleEscape(); };
   return {
    names: ['omfg'], commands: () => entries,
    async run(parsed) {
     await ctx.command(() => controller.start(parsed.args));
     const panel = ctx.omfgContainer.children[0];
     if (!controller.hasActiveRequest() || !panel) return;
     ctx.background('omfg', '/omfg', settled(panel, ['markSaved', 'markRejected', 'markAborted', 'markError'], closed => {
      if (closed()) return;
      ctx.flush();
      io.output(fenced(componentLines(panel, kit)));
      controller.handleEscape();
     }));
    },
    // The panel's own Stop is the TUI's Esc on it; the turn's Stop leaves it running, as Esc goes to the panel first.
    stopRun: key => { if (key === undefined || key === 'omfg') stop(); }, beforeSwitch: stop, dispose: stop,
   };
  };
 },
};

/** Resolves once `panel` is closed; `onTerminal(closed)` runs after any terminal-state call, once the controller's step is done. */
function settled(panel, terminal, onTerminal) {
 return new Promise(resolve => {
  let isClosed = false;
  const close = panel.close.bind(panel);
  panel.close = (...a) => { isClosed = true; const r = close(...a); resolve(); return r; };
  for (const name of terminal) {
   const original = panel[name].bind(panel);
   panel[name] = (...a) => { const r = original(...a); queueMicrotask(() => onTerminal(() => isClosed)); return r; };
  }
 });
}

const CLEANSE_USAGE = 'Usage: /cleanse [request] [--all] [--tests] [-n <agents>] [-m <model>]';
const CUSTOM_REQUEST_OPTION = 'Describe what to fix…';
const DEFAULT_MODEL = '@smol', DISPLAY_FILE_LIMIT = 50;

// OMP's CleanseCommandController with runCleanse's flow in the session's folder (see the header).
export const cleanse = {
 name: 'cleanse',
 async load(env) {
  const { at, pkg } = env;
  const [kit, panel, board, renderUtils, checkers, loop, agent, balance] = await Promise.all([
   loadTuiKit(env), pkg('@oh-my-pi/pi-tui/overlays/cleanse-panel'), pkg('@oh-my-pi/pi-tui/apps/cleanse-board'), pkg('@oh-my-pi/pi-tui/render/render-utils'),
   at('cleanse/checkers.ts'), at('cleanse/loop.ts'), at('cleanse/agent.ts'), at('cleanse/balance.ts'),
  ]);
  const sdk = {
   CleansePanelComponent: panel.CleansePanelComponent, CleanseBoardModel: board.CleanseBoardModel, shortenPath: renderUtils.shortenPath,
   discoverCleanseDiagnosticSuite: checkers.discoverCleanseDiagnosticSuite, buildCustomCleanseSuite: checkers.buildCustomCleanseSuite,
   runCleanseLoop: loop.runCleanseLoop, createCleanseAgentRuntime: agent.createCleanseAgentRuntime, groupDiagnosticsByFile: balance.groupDiagnosticsByFile,
  };
  for (const [k, v] of Object.entries(sdk)) if (typeof v !== 'function') throw new Error(`this OMP build has no ${k}`);
  const entries = [builtinEntry(env.m.builtinRegistry, 'cleanse')];
  return io => new CleanseCommand(io, kit, sdk, entries);
 },
};

class CleanseCommand {
 names = ['cleanse'];
 #io; #kit; #sdk; #entries; #ctx; #active;
 constructor(io, kit, sdk, entries) {
  this.#io = io; this.#kit = kit; this.#sdk = sdk; this.#entries = entries;
  this.#ctx = tuiContext(io, kit);
  this.#ctx.cleanseContainer = this.#ctx.widget('cleanse');
 }
 commands() { return this.#entries; }

 async run(parsed) {
  if (this.#active) throw new Error('A /cleanse run is already active — Stop cancels it.');
  const options = parseCleanseArgs(parsed.args);
  if (options.error) throw new Error(options.error);
  const ctx = this.#ctx, sdk = this.#sdk;
  const run = { panel: new sdk.CleansePanelComponent({ request: options.request, tui: ctx.ui, model: new sdk.CleanseBoardModel() }), abortController: new AbortController(), settled: false };
  this.#active = run;
  ctx.cleanseContainer.clear();
  ctx.cleanseContainer.addChild(run.panel);
  ctx.ui.requestRender();
  ctx.background('cleanse', '/cleanse', this.#run(run, options, this.#io.session.sessionManager.getCwd()));
 }

 async #run(run, options, cwd) {
  try {
   const result = await runCleanse(this.#sdk, cwd, options, {
    board: run.panel,
    print: text => run.panel.log(text),
    printError: text => run.panel.logError(text),
    pickTarget: checkers => this.#pickTarget(checkers),
    promptRequest: () => this.#promptRequest(),
   }, run.abortController.signal);
   if (this.#active !== run) return;
   run.panel.finish(result.status);
   // A picker-level cancel settles without any output worth keeping.
   if (result.status === 'cancelled' && result.report.checks.length === 0) return this.#close(run);
  } catch (error) {
   if (this.#active !== run) return;
   run.panel.markError(error instanceof Error ? error.message : String(error));
  } finally {
   if (this.#active === run) run.settled = true;
  }
  // Settled: the panel the TUI keeps docked until Esc goes to the chat.
  this.#ctx.flush();
  this.#io.output(fenced(componentLines(run.panel, this.#kit, { max: 200 })));
  this.#close(run);
 }

 async #pickTarget(checkers) {
  const allOption = `Run all ${checkers.length} discovered checker${checkers.length === 1 ? '' : 's'}`;
  const labels = checkers.map(c => `${c.label} — ${c.command}`);
  const choice = await this.#ctx.showHookSelector('Select what to cleanse', [allOption, ...labels, CUSTOM_REQUEST_OPTION]);
  if (choice === undefined) return { kind: 'cancel' };
  if (choice === allOption) return { kind: 'all' };
  if (choice === CUSTOM_REQUEST_OPTION) {
   const request = await this.#promptRequest();
   return request === null ? { kind: 'cancel' } : { kind: 'request', request };
  }
  const checker = checkers[labels.indexOf(choice)];
  return checker ? { kind: 'checker', id: checker.id } : { kind: 'cancel' };
 }

 async #promptRequest() {
  const answer = await this.#ctx.showHookInput('Describe what to detect and fix', 'e.g. "ts errors"');
  return answer?.trim() || null;
 }

 #close(run) {
  if (this.#active !== run) return;
  this.#active = undefined;
  run.panel.dispose();
  this.#ctx.cleanseContainer.clear();
  this.#ctx.flush();
 }

 // The run's own Stop (the TUI's Esc on its panel): cancels the running pass; the settled panel then goes to the chat.
 // The turn's Stop leaves it running.
 stopRun(key) {
  if (key !== undefined && key !== 'cleanse') return;
  this.#ctx.cancelDialogs();
  const run = this.#active;
  if (run && !run.settled && !run.abortController.signal.aborted) run.abortController.abort(new Error('Cleanse interrupted'));
 }
 // A session switch or shutdown tears the run down, as the TUI's dispose().
 beforeSwitch() {
  const run = this.#active;
  if (!run) return;
  this.#ctx.cancelDialogs();
  run.abortController.abort(new Error('Cleanse interrupted'));
  this.#close(run);
 }
 dispose() { this.beforeSwitch(); }
}

/** OMP's parseCleanseArgs (cleanse-command-controller.ts); flag names mirror the `omp cleanse` CLI. */
function parseCleanseArgs(args) {
 const tokens = args.split(/\s+/).filter(Boolean), requestParts = [], parsed = { all: false, includeTests: false };
 for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token === '--all' || token === '-a') parsed.all = true;
  else if (token === '--tests' || token === '-t') parsed.includeTests = true;
  else if (token === '--agents' || token === '-n') {
   const value = Number(tokens[++i]);
   if (!Number.isInteger(value) || value <= 0) return { ...parsed, error: CLEANSE_USAGE };
   parsed.maxAgents = value;
  } else if (token === '--model' || token === '-m') {
   const value = tokens[++i];
   if (!value) return { ...parsed, error: CLEANSE_USAGE };
   parsed.model = value;
  } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) return { ...parsed, error: CLEANSE_USAGE };
  else requestParts.push(token);
 }
 parsed.request = requestParts.join(' ') || undefined;
 return parsed;
}

/** OMP's runCleanse (src/cleanse/index.ts) with the project folder passed in instead of read from getProjectDir(). */
async function runCleanse(sdk, cwd, options, ui, signal) {
 const maxAgents = options.maxAgents ?? 32;
 if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error('--agents must be a positive integer');
 const model = options.model?.trim() || DEFAULT_MODEL;
 let runtime, runtimePromise, loopResult;
 const board = ui.board;
 const hooks = {
  onStart: (name, assignment) => board.agentStarted(name, assignment),
  onProgress: (name, _assignment, progress) => board.agentProgress(name, progress),
  onFinish: (outcome, assignment) => board.agentFinished(outcome, assignment),
 };
 const checkerEvents = {
  onCheckerStart: checker => board.checkerStarted(checker),
  onCheckerEnd: (check, durationMs) => board.checkerFinished(check, durationMs),
 };
 const ensureRuntime = () => runtimePromise ??= (async () => {
  board.phase(`Resolving model ${model}...`);
  try { runtime = await sdk.createCleanseAgentRuntime({ cwd, model, hooks }); } finally { board.phase(undefined); }
  board.log(`Model: ${runtime.model}`);
  board.log(`Session: ${sdk.shortenPath(runtime.sessionFile)}`);
  return runtime;
 })();
 const skippedOnly = suite => ({ checks: [], diagnostics: [], skipped: [...(suite?.skipped ?? [])] });
 try {
  let request = options.request?.trim() || undefined, suite;
  if (!request) {
   board.phase('Detecting configured project checkers...');
   suite = await sdk.discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
   board.phase(undefined);
   const pickTarget = options.all === true ? undefined : ui.pickTarget;
   if (pickTarget) {
    if (suite.checkers.length > 0) {
     const choice = await pickTarget(suite.checkers);
     if (choice.kind === 'cancel') { ui.printError('Cleanse cancelled.'); return { exitCode: 130, status: 'cancelled', report: skippedOnly(suite) }; }
     if (choice.kind === 'checker') suite.select([choice.id]);
     if (choice.kind === 'request') { request = choice.request; suite = undefined; }
    } else {
     printSkippedChecks(ui, skippedOnly(suite));
     ui.print('No supported checker with an available executable was found.');
     const answer = (await ui.promptRequest?.()) ?? null;
     if (answer === null) return { exitCode: 1, status: 'unsupported', report: skippedOnly(suite) };
     request = answer;
     suite = undefined;
    }
   }
  }
  if (request) {
   const activeRuntime = await ensureRuntime();
   board.phase(`Discovering checkers for "${request}"...`);
   try {
    const specs = await activeRuntime.discoverCheckers(request, signal);
    suite = await sdk.buildCustomCleanseSuite(cwd, specs);
   } finally { board.phase(undefined); }
   for (const checker of suite.checkers) board.log(`[checker] ${checker.label}: ${checker.command}`);
  }
  if (!suite || suite.checkers.length === 0) {
   const report = skippedOnly(suite);
   printSkippedChecks(ui, report);
   ui.printError(request ? 'Checker discovery produced no runnable command.' : 'No supported checker with an available executable was found.');
   return { exitCode: 1, status: 'unsupported', report, sessionFile: runtime?.sessionFile };
  }
  printSkippedChecks(ui, skippedOnly(suite));
  const activeSuite = suite;
  loopResult = await sdk.runCleanseLoop({ maxAgents, signal }, {
   collect: (onDiagnostics, loopSignal) => activeSuite.run({ signal: loopSignal, events: { ...checkerEvents, onDiagnostics: (_checker, diagnostics) => onDiagnostics(diagnostics) } }),
   verify: loopSignal => activeSuite.run({ signal: loopSignal, events: checkerEvents }),
   dispatch: async (assignment, worker, peers, loopSignal) => (await ensureRuntime()).dispatchWorker(assignment, { worker, peers, checkers: activeSuite.selected }, loopSignal),
   followUp: async (worker, diagnostics) => {
    const delivered = (await runtime?.followUp(worker, diagnostics)) ?? false;
    if (delivered) board.log(`CleanseA${worker} ← ${diagnostics.length} follow-up diagnostic${diagnostics.length === 1 ? '' : 's'}`);
    return delivered;
   },
   onCollected(report) {
    if (report.diagnostics.length === 0) return;
    const fileCount = sdk.groupDiagnosticsByFile(report.diagnostics).filter(g => g.file !== undefined).length;
    board.log(`Checkers done: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}.`);
   },
   onVerified(report) {
    board.repairFinished();
    board.log(`Verification: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? '' : 's'} remaining.`);
   },
  });
  board.close();
  await runtime?.close(loopResult);
  if (loopResult.status === 'cancelled') {
   ui.printError('Cleanse cancelled.');
   return { exitCode: 130, status: 'cancelled', report: loopResult.report, sessionFile: runtime?.sessionFile };
  }
  if (loopResult.status === 'clean') {
   const n = loopResult.report.checks.length;
   ui.print(loopResult.workers === 0 ? `Clean: ${n} checker${n === 1 ? '' : 's'} passed.` : 'Clean: all detected diagnostics are resolved.');
   return { exitCode: 0, status: 'clean', report: loopResult.report, sessionFile: runtime?.sessionFile };
  }
  printRemaining(sdk, ui, loopResult.report);
  return { exitCode: 1, status: 'unresolved', report: loopResult.report, sessionFile: runtime?.sessionFile };
 } catch (error) {
  if (!signal.aborted) throw error;
  const report = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
  board.close();
  ui.printError('Cleanse cancelled.');
  return { exitCode: 130, status: 'cancelled', report, sessionFile: runtime?.sessionFile };
 } finally {
  board.close();
  await runtime?.close(loopResult);
 }
}

function printSkippedChecks(ui, report) {
 for (const skipped of report.skipped) ui.print(`- ${skipped.label}: skipped (${skipped.reason})`);
}

function printRemaining(sdk, ui, report) {
 const groups = sdk.groupDiagnosticsByFile(report.diagnostics);
 ui.printError(`Unresolved: ${report.diagnostics.length} diagnostic${report.diagnostics.length === 1 ? '' : 's'}.`);
 for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) ui.printError(`- ${group.file ?? '<project>'}: ${group.diagnostics.length}`);
 if (groups.length > DISPLAY_FILE_LIMIT) ui.printError(`- ... ${groups.length - DISPLAY_FILE_LIMIT} more files`);
}
