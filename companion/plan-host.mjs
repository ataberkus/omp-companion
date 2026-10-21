// Native plan mode (/plan, /plan-review, plan approval) for OMP builds that do not ship modes/rpc/rpc-plan-mode.ts
// (released builds so far). Same public API and frames as that module's RpcPlanMode (plan_mode_changed, plan_review,
// plan_review_clear; approve_plan actions preserve/fresh/compact/refine), built on the plan-mode mechanism the shipped
// terminal UI uses (interactive-mode.ts #enterPlanMode, #exitPlanMode, handlePlanApproval, #approvePlan):
// - the session's plan-proposal handler receives the model's `xd://propose` write; the planning turn is then stopped
//   silently (markPlanInternalAbortPending + abort), as the TUI's #abortPlanApprovalTurnSilently does, and the plan
//   file is captured as the pending proposal;
// - released sessions have no PlanModeState.reviewPending, so the hold on further model calls while a review is pending
//   is an agent before-model-call gate (the patched build also holds IRC wakes and hidden next-turn messages inside the
//   session; here such a turn starts and is stopped by the gate before reaching the model);
// - Stop during the "compact" approval behaves like the TUI: the plan stays approved and plan mode ends, but execution
//   is not dispatched and the plan reference rides on the next submitted turn.
// Beyond the fork's contract, the TUI's own pieces: hasDraft() (the "Exit plan mode?" check of handlePlanModeCommand)
// and the approve_plan action "save" (the review's "Save and quit": write the plan to a project file, leave plan mode;
// the companion then starts a fresh session, as the TUI's handleClearCommand does).

/** Loads OMP's plan-mode pieces from one SDK copy; `text(rel)` reads an SDK src/ file. Returns { RpcPlanMode }. */
export async function loadPlanMode({ at, pkg, text }) {
 const [compaction, catalog, utils, thinking, resolver, roles, local, approved, transition, autosave, files, planSettings, messages, builtinNames, pathUtils, approvedPrompt, compactPrompt] = await Promise.all([
  pkg('@oh-my-pi/pi-agent-core/compaction'), pkg('@oh-my-pi/pi-catalog/models'), pkg('@oh-my-pi/pi-utils'), pkg('@oh-my-pi/pi-tui/thinking'),
  at('config/model-resolver.ts'), at('config/model-roles.ts'), at('internal-urls/local-protocol.ts'), at('plan-mode/approved-plan.ts'),
  at('plan-mode/model-transition.ts'), at('plan-mode/plan-autosave.ts'), at('plan-mode/plan-files.ts'), at('plan-mode/settings.ts'),
  at('session/messages.ts'), at('tools/builtin-names.ts'), at('tools/path-utils.ts'),
  text('prompts/system/plan-mode-approved.md'), text('prompts/system/plan-mode-compact-instructions.md'),
 ]);
 const deps = {
  CompactionCancelledError: compaction.CompactionCancelledError, modelsAreEqual: catalog.modelsAreEqual,
  isRecord: utils.isRecord, logger: utils.logger, prompt: utils.prompt, Snowflake: utils.Snowflake,
  parseConfiguredThinkingLevel: thinking.parseConfiguredThinkingLevel, resolveModelRoleValue: resolver.resolveModelRoleValue,
  getKnownRoleIds: roles.getKnownRoleIds, copyLocalArtifacts: local.copyLocalArtifacts, resolveLocalRoot: local.resolveLocalRoot,
  humanizePlanTitle: approved.humanizePlanTitle, resolvePlanModelTransition: transition.resolvePlanModelTransition,
  autosaveApprovedPlan: autosave.autosaveApprovedPlan, planSaveFileName: autosave.planSaveFileName, resolveToCwd: pathUtils.resolveToCwd,
  readPlanFile: files.readPlanFile, resolvePlanFilePath: files.resolvePlanFilePath, listPlanFiles: files.listPlanFiles,
  cfgPlanDefaultOnStartup: planSettings.cfgPlanDefaultOnStartup, cfgPlanEnabled: planSettings.cfgPlanEnabled,
  USER_INTERRUPT_LABEL: messages.USER_INTERRUPT_LABEL, isMCPToolName: builtinNames.isMCPToolName,
  planModeApprovedPrompt: approvedPrompt, planModeCompactInstructionsPrompt: compactPrompt,
 };
 for (const [name, value] of Object.entries(deps)) if (value === undefined) throw new Error(`OMP's plan-mode ${name} was not found`);
 return { RpcPlanMode: planModeClass(deps) };
}

const stale = message => Object.assign(new Error(message), { code: 'stale_proposal' });

function planModeClass(d) {
 const { CompactionCancelledError, modelsAreEqual, isRecord, logger, prompt, Snowflake, USER_INTERRUPT_LABEL } = d;
 const snapshot = session => session.model ? { model: session.model, thinkingLevel: session.configuredThinkingLevel() } : undefined;

 /** Native restrictions stay active until a current, explicit approval finishes preparation. */
 return class RpcPlanMode {
  #paused = false; #workflow = 'parallel'; #entered = false; #sessionId;
  #previousTools; #previousModel; #suspendedModel; #pendingModel; #planRoleValue; #proposal;
  #generation = 0; #acceptProposals = false; #reviewWork = Promise.resolve(); #approvalWork; #detachReviewGate;
  // The generation a host Stop cancelled while an approval was in flight (see #executeApproval).
  #stopped;

  constructor(session, output) { this.session = session; this.output = output; this.#sessionId = session.sessionId; }

  get state() {
   const state = this.session.getPlanModeState();
   return {
    available: d.cfgPlanEnabled.get(this.session.settings),
    enabled: state?.enabled === true,
    paused: this.#paused,
    reviewPending: state?.reviewPending === true,
    planFilePath: state?.planFilePath ?? (this.#paused ? this.session.getPlanReferencePath() : undefined),
    workflow: state?.workflow ?? (this.#paused ? this.#workflow : undefined),
   };
  }
  get proposal() { return this.#proposal; }
  get busy() { return this.#approvalWork !== undefined; }

  commands() {
   if (!this.state.available) return [];
   return [
    { name: 'plan', description: 'Toggle native read-only planning', input: { hint: '[on|off|parallel|iterative|prompt]' }, source: 'builtin', subcommands: ['on', 'off', 'parallel', 'iterative'].map(name => ({ name })) },
    { name: 'plan-review', description: 'Review the current plan before explicit approval', source: 'builtin' },
   ];
  }

  #fileOptions() {
   const manager = this.session.sessionManager;
   return { cwd: manager.getCwd(), localProtocolOptions: { getArtifactsDir: () => manager.getArtifactsDir(), getSessionId: () => manager.getSessionId() } };
  }
  #read(planFilePath) { return d.readPlanFile(planFilePath, this.#fileOptions()); }
  /** The TUI's #hasPlanModeDraftContent: the plan file or a session-local `*plan.md` holds text. */
  async hasDraft() {
   const state = this.session.getPlanModeState();
   const candidates = new Set([state?.planFilePath || this.session.getPlanReferencePath() || 'local://PLAN.md', ...(await d.listPlanFiles(this.#fileOptions()))]);
   for (const candidate of candidates) if ((await this.#read(candidate))?.trim()) return true;
   return false;
  }
  #publish() { this.output({ type: 'plan_mode_changed', planMode: this.state }); }
  #clearProposal() {
   if (!this.#proposal) return;
   const proposalId = this.#proposal.id;
   this.#proposal = undefined;
   this.output({ type: 'plan_review_clear', proposalId });
  }

  /** The host's Stop: invalidates pending review/approval before the asynchronous native abort starts. */
  cancel() { this.#cancel(true); }
  #cancel(stop) {
   if (stop && this.#approvalWork) this.#stopped = this.#generation;
   this.#generation++;
   this.#acceptProposals = false;
   this.#clearProposal();
   this.session.clearPlanInternalAbortPending();
   if (this.#approvalWork) this.session.abortCompaction(USER_INTERRUPT_LABEL);
  }

  async settle() { await this.#reviewWork; await this.#approvalWork; }

  #persist() {
   const state = this.session.getPlanModeState();
   this.session.sessionManager.appendModeChange(state?.enabled ? 'plan' : this.#paused ? 'plan_paused' : 'none', {
    planFilePath: state?.planFilePath ?? this.session.getPlanReferencePath(),
    workflow: state?.workflow ?? this.#workflow,
    reviewPending: state?.reviewPending === true,
    previousTools: this.#previousTools?.enabled,
    previousMountedTools: this.#previousTools?.mounted,
    previousModel: this.#previousModel ? { provider: this.#previousModel.model.provider, modelId: this.#previousModel.model.id, thinkingLevel: this.#previousModel.thinkingLevel } : undefined,
   });
  }

  /** Loads the target journal, not the source session's transient snapshots. */
  async reconcile() {
   this.#cancel(false);
   this.#detachReviewGate?.();
   this.#detachReviewGate = undefined;
   const suspendedModel = this.#sessionId === this.session.sessionId ? this.#suspendedModel : undefined;
   this.#suspendedModel = undefined;
   this.#sessionId = this.session.sessionId;
   this.session.setPlanProposalHandler(null);
   this.session.setPlanModeState(undefined);
   this.#paused = false; this.#entered = false;
   this.#previousTools = undefined; this.#previousModel = undefined; this.#pendingModel = undefined;
   const context = this.session.sessionManager.buildSessionContext();
   const data = context.modeData;
   this.#workflow = data?.workflow === 'iterative' ? 'iterative' : 'parallel';
   const names = value => Array.isArray(value) && value.every(name => typeof name === 'string');
   const savedTools = names(data?.previousTools) && names(data?.previousMountedTools) ? { enabled: data.previousTools, mounted: data.previousMountedTools } : undefined;
   let savedModel;
   if (isRecord(data?.previousModel)) {
    const saved = data.previousModel;
    const model = this.session.modelRegistry.getAvailable().find(m => m.provider === saved.provider && m.id === saved.modelId);
    if (model) savedModel = { model, thinkingLevel: typeof saved.thinkingLevel === 'string' ? d.parseConfiguredThinkingLevel(saved.thinkingLevel) : undefined };
   }
   if (!this.state.available) {
    if (context.mode === 'plan' || context.mode === 'plan_paused') {
     if (savedModel) await this.#applyModel(savedModel);
     if (savedTools) await this.session.restoreNonMCPToolPresentation(savedTools.enabled, savedTools.mounted);
     this.#persist();
    }
    this.#publish();
    return;
   }
   if (context.mode === 'plan_paused') {
    this.#paused = this.#entered = true;
    if (typeof data?.planFilePath === 'string') this.session.setPlanReferencePath(data.planFilePath);
   } else if (context.mode === 'plan') {
    await this.#enter(this.#workflow, typeof data?.planFilePath === 'string' ? data.planFilePath : undefined, true);
    if (savedTools) this.#previousTools = savedTools;
    if (savedModel) this.#previousModel = savedModel;
    if (suspendedModel) await this.#applyModel(suspendedModel);
    this.#persist();
    if (data?.reviewPending === true) {
     try { await this.review(); } catch (error) { this.#report(error); }
    }
   } else if (context.messages.length === 0 && !this.session.sessionManager.getEntries().some(entry => entry.type === 'mode_change') && d.cfgPlanDefaultOnStartup.get(this.session.settings)) {
    await this.#enter('parallel');
   }
   this.#publish();
  }

  async setMode(enabled, workflow) {
   if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
   if (workflow !== undefined && workflow !== 'parallel' && workflow !== 'iterative') throw new Error('workflow must be "parallel" or "iterative"');
   this.#cancel(false);
   await this.settle();
   if (enabled) {
    // The TUI's /plan refusals (handlePlanModeCommand).
    if (!this.state.available) throw new Error('Plan mode is disabled. Enable it in settings (plan.enabled).');
    if (this.session.getGoalModeState()) throw new Error('Exit goal mode first.');
    if (this.session.getVibeModeState()?.enabled) throw new Error('Exit vibe mode first.');
    if (this.state.enabled) {
     const state = this.session.getPlanModeState();
     this.#workflow = workflow ?? state.workflow ?? this.#workflow;
     this.session.setPlanModeState({ ...state, workflow: this.#workflow });
     this.#persist();
    } else await this.#enter(workflow ?? this.#workflow);
    this.#acceptProposals = true;
   } else if (this.state.enabled) {
    await this.session.runModeExitTeardown(async () => {
     await this.session.abort({ reason: USER_INTERRUPT_LABEL });
     await this.#leave(true);
    });
   } else {
    this.#paused = this.#entered = false;
    this.#persist();
   }
   this.#publish();
   return this.state;
  }

  #installReviewGate() {
   this.#detachReviewGate?.();
   this.#detachReviewGate = this.session.agent.addBeforeModelCall(() => this.session.getPlanModeState()?.reviewPending ? { stop: true, reason: 'plan review pending' } : undefined);
  }

  async #enter(workflow, planFilePath = this.session.getPlanReferencePath() || 'local://PLAN.md', restored = false) {
   if (!this.session.hasBuiltInTool('write') && (this.session.getEnabledToolNames().includes('write') || this.session.getMountedXdevToolNames().includes('write')))
    throw new Error('Plan mode: the `write` tool is provided by an extension and cannot submit plans. Disable it to use plan mode.');
   this.#previousTools = {
    enabled: this.session.getEnabledToolNames().filter(name => !d.isMCPToolName(name)),
    mounted: this.session.getMountedXdevToolNames().filter(name => !d.isMCPToolName(name)),
   };
   this.#previousModel = snapshot(this.session);
   this.#workflow = workflow;
   this.session.setPlanModeState({ enabled: true, planFilePath, workflow, reentry: this.#entered });
   this.#acceptProposals = true;
   try {
    // Never activate an extension-shadowed write: the native write guard is the safety boundary.
    const tools = this.session.getEnabledToolNames();
    await this.session.setActiveToolsByName(this.session.hasBuiltInTool('write') ? [...new Set([...tools, 'write'])] : tools);
    this.session.setPlanProposalHandler(title => this.#prepareProposal(title));
    this.#installReviewGate();
    if (restored) this.#planRoleValue = this.session.settings.getModelRole('plan');
    else await this.refreshPlanModelRole(true);
    if (this.session.isStreaming) await this.session.sendPlanModeContext({ deliverAs: 'steer' });
   } catch (error) {
    await this.#leave(false, false);
    throw error;
   }
   this.#paused = false;
   this.#entered = true;
   if (!restored) this.#persist();
  }

  async #prepareProposal(title) {
   const generation = this.#generation;
   const result = await this.session.preparePlanForReview(title);
   if (generation === this.#generation && this.#acceptProposals && this.state.enabled && result.details) {
    this.#acceptProposals = false;
    this.session.setPlanModeState({ ...this.session.getPlanModeState(), reviewPending: true });
    this.#publish();
    // The TUI's silent approval abort: an internal transition, not operator cancellation.
    this.session.markPlanInternalAbortPending();
    // Stop the core loop immediately; asynchronous tool-result subscribers are too late.
    this.session.agent.abort();
    this.#reviewWork = this.#reviewWork.then(() => this.#captureReview(result.details, generation)).catch(error => this.#report(error));
   }
   return result;
  }

  /** Role edits during planning change the planning model, never the pre-plan restore snapshot. */
  async refreshPlanModelRole(force = false) {
   if (!this.state.enabled || this.busy) return;
   const value = this.session.settings.getModelRole('plan');
   if (!force && value === this.#planRoleValue) return;
   this.#planRoleValue = value;
   const t = d.resolvePlanModelTransition(this.session.model, this.session.resolveRoleModelWithThinking('plan'), this.session.isStreaming);
   this.#pendingModel = undefined;
   if (t.kind === 'thinking') this.session.setThinkingLevel(t.thinkingLevel);
   else if (t.kind === 'apply') {
    const next = { model: t.model, thinkingLevel: t.thinkingLevel };
    if (t.deferred) this.#pendingModel = next;
    else await this.#applyModel(next);
   }
  }

  async #applyModel(s) {
   if (modelsAreEqual(this.session.model, s.model)) this.session.setThinkingLevel(s.thinkingLevel);
   else await this.session.setModelTemporary(s.model, s.thinkingLevel);
  }

  async #leave(paused, persist = true, restoreModel = true) {
   const state = this.session.getPlanModeState();
   const tools = this.session.getEnabledToolNames(), mounted = this.session.getMountedXdevToolNames();
   const model = snapshot(this.session);
   try {
    if (restoreModel && this.#previousModel) await this.#applyModel(this.#previousModel);
    this.#pendingModel = undefined;
    this.session.setPlanModeState(undefined);
    if (this.#previousTools) await this.session.restoreNonMCPToolPresentation(this.#previousTools.enabled, this.#previousTools.mounted);
   } catch (error) {
    this.session.setPlanModeState(state);
    try {
     await this.session.setActiveToolPresentation(tools, mounted);
     if (model) await this.#applyModel(model);
    } catch (rollbackError) { logger.warn('Failed to restore native plan presentation', { error: String(rollbackError) }); }
    throw error;
   }
   this.session.setPlanProposalHandler(null);
   this.#detachReviewGate?.();
   this.#detachReviewGate = undefined;
   this.#paused = this.#entered = paused;
   this.#previousTools = undefined;
   this.#previousModel = undefined;
   if (persist) this.#persist();
  }

  /** Explicit session transitions restore the source before native session loading. */
  async beforeSessionChange() {
   this.#cancel(false);
   await this.session.abort({ reason: USER_INTERRUPT_LABEL });
   await this.settle();
   this.#suspendedModel = this.state.enabled ? snapshot(this.session) : undefined;
   if (this.state.enabled) await this.#leave(false, false);
  }

  async beforePrompt() {
   if (this.busy) throw new Error('Plan approval is being prepared; abort it before submitting another turn');
   this.#cancel(false);
   await this.#reviewWork;
   const state = this.session.getPlanModeState();
   if (state?.reviewPending) {
    this.session.setPlanModeState({ ...state, reviewPending: false });
    this.#persist();
    this.#publish();
   }
   this.#acceptProposals = state?.enabled === true;
  }

  observe(event) {
   if (event.type === 'agent_end' && !this.session.isStreaming && this.#pendingModel) {
    const next = this.#pendingModel;
    this.#pendingModel = undefined;
    this.#reviewWork = this.#reviewWork.then(() => (this.state.enabled ? this.#applyModel(next) : undefined)).catch(error => this.#report(error));
   }
  }

  async #captureReview(details, generation) {
   const current = () => generation === this.#generation && this.#sessionId === this.session.sessionId && this.state.enabled;
   if (!current()) return;
   this.#acceptProposals = false;
   const pendingState = this.session.getPlanModeState();
   if (!pendingState.reviewPending) {
    this.session.setPlanModeState({ ...pendingState, reviewPending: true });
    this.#publish();
   }
   this.session.markPlanInternalAbortPending();
   try { await this.session.runModeExitTeardown(() => this.session.abort({ goalReason: 'internal' })); }
   finally { this.session.clearPlanInternalAbortPending(); }
   if (!current()) return;
   const content = await this.#read(details.planFilePath);
   if (!content?.trim()) throw new Error(`Plan file not found at ${details.planFilePath}`);
   if (!current()) return;
   // The reviewed path drives the next planning turn (the TUI promotes it into plan-mode state the same way).
   this.session.setPlanModeState({ ...this.session.getPlanModeState(), planFilePath: details.planFilePath });
   this.#persist();
   this.#clearProposal();
   this.#proposal = { id: String(Snowflake.next()), title: details.title, planFilePath: details.planFilePath, content };
   this.output({ type: 'plan_review', proposal: this.#proposal });
   this.#publish();
  }

  /** `/plan-review`: the pending proposal, or a fresh one from the latest plan file. */
  async review() {
   if (this.busy) throw new Error('Plan approval is being prepared');
   if (!this.state.enabled) throw new Error('Plan mode is not active.');
   await this.#reviewWork;
   const pending = this.#proposal;
   if (pending && (await this.#read(pending.planFilePath)) === pending.content && this.#proposal === pending) return pending;
   const generation = this.#generation, noPlan = 'No plan to review yet — write one to a local://<slug>-plan.md file first.';
   // preparePlanForReview's only refusal here is OMP's model-facing "Plan file not found …"; /plan-review answers as the TUI's.
   const result = await this.session.preparePlanForReview('').catch(() => undefined);
   if (!result?.details) throw new Error(noPlan);
   await this.#captureReview(result.details, generation);
   if (!this.#proposal) throw new Error('Plan review was cancelled');
   return this.#proposal;
  }

  /** Validates and reserves once; the caller acknowledges before running the returned task ("save" resolves to { savedPath }). */
  async acceptApproval(command) {
   if (typeof command.proposalId !== 'string' || !command.proposalId.trim()) throw new Error('proposalId must be a non-empty string');
   if (!['preserve', 'fresh', 'compact', 'refine', 'save'].includes(command.action)) throw new Error('Invalid plan approval action');
   if (command.feedback !== undefined && typeof command.feedback !== 'string') throw new Error('feedback must be a string');
   if (command.action === 'refine' && !command.feedback?.trim()) throw new Error('Refinement requires explicit feedback');
   if (command.action !== 'refine' && command.feedback !== undefined) throw new Error('feedback is only supported for refinement');
   if (command.executionModel !== undefined && (typeof command.executionModel !== 'string' || !command.executionModel.trim() || command.action === 'refine' || command.action === 'save'))
    throw new Error('executionModel requires a non-empty execution selector');
   if (command.savePath !== undefined && (typeof command.savePath !== 'string' || command.action !== 'save')) throw new Error('savePath is only supported for save');
   if (this.busy) throw stale('Plan approval is already in progress');
   await this.#reviewWork;
   const proposal = this.#proposal, generation = this.#generation;
   if (!this.state.enabled || !proposal || proposal.id !== command.proposalId) throw stale('Stale or missing plan proposal; review the plan again');
   const content = await this.#read(proposal.planFilePath);
   if (generation !== this.#generation || this.#proposal !== proposal) throw stale('Plan approval was cancelled');
   if (content !== proposal.content) { this.#clearProposal(); throw stale('Plan artifact changed; review the plan again before approving'); }
   const selector = command.executionModel?.trim();
   const resolved = selector
    ? d.getKnownRoleIds(this.session.settings).includes(selector)
     ? this.session.resolveRoleModelWithThinking(selector)
     : d.resolveModelRoleValue(selector, this.session.getAvailableModels(), { settings: this.session.settings })
    : undefined;
   if (selector && (!resolved?.model || resolved.warning)) throw new Error(resolved?.warning ?? `Execution model not found: ${selector}`);
   const executionModel = resolved?.model ? { model: resolved.model, thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : this.#previousModel?.thinkingLevel } : undefined;
   // "Save and quit" writes to the chosen project path; the TUI suggests <TITLE>_PLAN.md in the working directory.
   let destination;
   if (command.action === 'save') {
    try { destination = d.resolveToCwd(command.savePath?.trim() || d.planSaveFileName(proposal.title), this.session.sessionManager.getCwd()); }
    catch (error) { throw new Error(`Invalid plan save path: ${error instanceof Error ? error.message : String(error)}`); }
   }
   this.#clearProposal();
   const reserved = Promise.withResolvers();
   this.#approvalWork = reserved.promise;
   return async () => {
    try { return command.action === 'save' ? await this.#saveApproval(proposal, destination) : await this.#executeApproval(command, proposal, generation, executionModel); }
    finally { this.#approvalWork = undefined; reserved.resolve(); }
   };
  }

  /** The TUI's #savePlanAndQuit up to its new session: write the plan, then leave plan mode silently (not paused). */
  async #saveApproval(proposal, destination) {
   try { await Bun.write(destination, proposal.content); }
   catch (error) { throw new Error(`Failed to save plan to ${destination}: ${error instanceof Error ? error.message : String(error)}`); }
   try { await this.#leave(false); }
   catch (error) { throw new Error(`Saved plan to ${destination}, but could not exit plan mode: ${error instanceof Error ? error.message : String(error)}`); }
   this.#publish();
   return { savedPath: destination };
  }

  async #executeApproval(command, proposal, generation, executionModel) {
   const current = () => generation === this.#generation;
   if (!current()) return;
   if (command.action === 'refine') {
    this.session.setPlanModeState({ ...this.session.getPlanModeState(), reviewPending: false });
    this.#persist();
    this.#publish();
    this.#acceptProposals = true;
    void this.session.prompt(command.feedback, { streamingBehavior: 'followUp' }).catch(error => this.#report(error));
    return;
   }
   // Native read-only guards stay installed through compaction/cancellation and artifact migration.
   let compactionFailed = false;
   if (command.action === 'compact') {
    this.session.markPlanInternalAbortPending();
    try {
     await this.session.compact(undefined, { suppressContinuation: true, internalGuidance: prompt.render(d.planModeCompactInstructionsPrompt, { planFilePath: proposal.planFilePath }) });
    } catch (error) {
     if (error instanceof CompactionCancelledError || !current()) {
      if (this.#stopped === generation) await this.#approvedWithoutExecution(proposal, executionModel);
      return;
     }
     compactionFailed = true;
     logger.warn('Plan approval compaction failed; retaining context', { error: String(error) });
    } finally { this.session.clearPlanInternalAbortPending(); }
   }
   if (!current()) return;
   if ((await this.#read(proposal.planFilePath)) !== proposal.content) throw new Error('Plan artifact changed; review it again');
   if (!current()) return;
   const previousTools = this.#previousTools, previousModel = this.#previousModel;
   const planningState = this.session.getPlanModeState();
   const planningModel = snapshot(this.session);
   const planningTools = { enabled: this.session.getEnabledToolNames(), mounted: this.session.getMountedXdevToolNames() };
   if (command.action === 'fresh') {
    const oldRoot = d.resolveLocalRoot(this.#fileOptions().localProtocolOptions);
    if (!(await this.session.newSession())) return;
    this.#sessionId = this.session.sessionId;
    this.session.setPlanModeState(planningState);
    this.#persist();
    await d.copyLocalArtifacts(oldRoot, d.resolveLocalRoot(this.#fileOptions().localProtocolOptions));
    await Bun.write(d.resolvePlanFilePath(proposal.planFilePath, this.#fileOptions()), proposal.content);
   }
   if (!current()) return;
   this.session.setPlanReferencePath(proposal.planFilePath);
   await this.#autosave(proposal);
   if (!current()) return;
   if (!this.session.sessionName) await this.session.sessionManager.setSessionName(d.humanizePlanTitle(proposal.title), 'auto');
   if (!current()) return;
   await this.session.runModeExitTeardown(async () => {
    let dispatched = false;
    try {
     if (!current()) return;
     if ((await this.#read(proposal.planFilePath)) !== proposal.content) throw new Error('Plan artifact changed; review it again');
     if (!current()) return;
     await this.#leave(false, true, !compactionFailed);
     if (!current()) return;
     // Execution tools, with `read` forced on so the durable local:// plan stays reachable.
     if (previousTools) await this.session.restoreNonMCPToolPresentation([...new Set([...previousTools.enabled, 'read'])], previousTools.mounted);
     if (!current()) return;
     if (executionModel && !compactionFailed) await this.#applyModel(executionModel);
     if (!current()) return;
     if ((await this.#read(proposal.planFilePath)) !== proposal.content) throw new Error('Plan artifact changed; review it again');
     if (!current()) return;
     this.session.markPlanReferenceSent();
     this.#publish();
     const text = prompt.render(d.planModeApprovedPrompt, { planFilePath: proposal.planFilePath, planContent: proposal.content, contextPreserved: command.action !== 'fresh' });
     void this.session.prompt(text, { synthetic: true, streamingBehavior: 'followUp' }).catch(error => this.#report(error));
     dispatched = true;
    } finally {
     if (!dispatched && !this.state.enabled) {
      // Cancellation/error before execution never leaves a silent grant of workspace writes.
      this.session.setPlanModeState(planningState);
      this.#previousTools = previousTools;
      this.#previousModel = previousModel;
      this.#entered = true;
      this.#paused = false;
      this.session.setPlanProposalHandler(title => this.#prepareProposal(title));
      this.#installReviewGate();
      await this.session.setActiveToolPresentation(planningTools.enabled, planningTools.mounted);
      if (planningModel) await this.#applyModel(planningModel);
      this.#persist();
      this.#publish();
     }
    }
   });
  }

  /**
   * Stop while the approved plan's compaction ran, as the TUI's #approvePlan: the approval stands (plan mode ends, the
   * execution tools and model come back, the plan is autosaved) but execution is not dispatched; the plan reference
   * stays unsent, so the session attaches it to the next submitted turn.
   */
  async #approvedWithoutExecution(proposal, executionModel) {
   if (this.#sessionId !== this.session.sessionId || !this.state.enabled) return;
   const previousTools = this.#previousTools;
   this.session.setPlanReferencePath(proposal.planFilePath);
   await this.#leave(false, true, true);
   if (previousTools) await this.session.restoreNonMCPToolPresentation([...new Set([...previousTools.enabled, 'read'])], previousTools.mounted);
   if (executionModel) await this.#applyModel(executionModel);
   await this.#autosave(proposal);
   this.#publish();
   this.session.emitNotice('warning', 'Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.', 'plan-mode');
  }

  async #autosave(proposal) {
   try { await d.autosaveApprovedPlan({ settings: this.session.settings, cwd: this.session.sessionManager.getCwd(), title: proposal.title, planContent: proposal.content }); }
   catch (error) { this.session.emitNotice('warning', `Failed to autosave plan: ${String(error)}`, 'plan-mode'); }
  }

  #report(error) { this.session.emitNotice('error', error instanceof Error ? error.message : String(error), 'plan-mode'); }
 };
}
