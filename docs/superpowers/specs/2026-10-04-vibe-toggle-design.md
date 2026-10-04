# Vibe mode toggle — design

Date: 2026-10-04
Status: awaiting written-spec review

## Goal

An on/off toggle for OMP's native vibe mode in the companion dashboard. While it is on, the session acts as a director: its toolset is `read`, the optional parent-owned `todo`, and `vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list`, and persistent fast/good worker sessions do the real work (see `../oh-my-pi/docs/vibe-mode.md`). Turning it off kills every worker in the session's scope.

Success: from the browser, a user turns vibe on, sends a directive, sees worker results come back as director turns, and turns vibe off. When it turns off, the workers are gone and the prior toolset is back. On OMP builds without vibe RPC, the control is absent and nothing is simulated.

## Dependency: OMP has no vibe RPC today

`/vibe` defines only `handleTui` (`slash-commands/builtin-modes.ts:314-331`). OMP's RPC layer only reads `getVibeModeState()`, and only to block plan and goal mode (`rpc-plan-mode.ts:228`, `rpc-goal-mode.ts:224,270`). This work therefore starts with an OMP patch. The companion side is useless without it, and capability detection keeps older builds working unchanged.

## Phase 0 — commit the existing OMP WIP (done)

The WIP in `../oh-my-pi` has been committed as two commits. `test/tools/zz-probe.test.ts` was left untracked.

- `0a50a5a397 fix(coding-agent): show the Done row for multi-select ask questions in RPC`: `ask.ts`, `ask.test.ts`, `rpc-extension-ui.test.ts`, plus the `checkedIndices` hunks of `rpc-mode.ts`/`rpc-types.ts` and the CHANGELOG fix line. `dialogOptions.checkedIndices` already exists at HEAD, so this commit builds without the goal changes.
- `50e0a20c9b feat(coding-agent): expose native goal mode over RPC`: `goals/continuation.ts`, `rpc-goal-mode.ts`, `rpc-goal-mode.test.ts` (previously untracked), the goal hunks of `rpc-mode.ts`/`rpc-types.ts`/`interactive-mode.ts`, `README.md`, and the CHANGELOG goal line.

Checked before committing: `bun test` for ask, rpc-extension-ui and rpc-goal-mode (81 pass) and `bun run check:types` (clean).

## Phase 1 — OMP: `RpcVibeMode`

New file `packages/coding-agent/src/modes/rpc/rpc-vibe-mode.ts`, structured like `RpcPlanMode`/`RpcGoalMode`, on top of a shared helper both front ends call.

Shared helper `packages/coding-agent/src/vibe/mode.ts`: `enterVibeMode`, `exitVibeMode`, `quiesceVibeForSwitch` and `reconcileVibeMode` take the session plus a `VibeParentSession` and hold the vibe mode state (`previousTools`, owner scope, in-flight entry, suspended-for-switch flag) in a small object each front end owns. The session-level sequences currently in `interactive-mode.ts` move into it: enter/exit at 5672-5762, quiesce at 4253-4258, and the vibe parts of `#clearTransientModeState`/`#reconcileModeFromSession` at 4490-4534 and 4567-4576. `InteractiveMode` keeps its TUI-only concerns (status line, warnings, `/vibe <prompt>` submission ordering) and calls the helper. That way the switch/suspend ordering exists in exactly one place.

### State and wire contract

- `rpc-types.ts`: `RpcVibeModeState { enabled: boolean }`. `RpcSessionState.vibeMode?: RpcVibeModeState` is always present on capable servers and absent on older ones.
- Command: `{ type: "set_vibe_mode", enabled: boolean }` → `success` with `{ vibeMode }`.
- Frame: `{ type: "vibe_mode_changed", vibeMode }` is emitted after every enable, disable, or reconcile that changes state.

### Enter (`setMode(true)`)

Enter is idempotent when vibe is already on. It rejects with `Exit plan/goal mode first` while plan or goal mode is enabled **or paused**, using the same predicates rpc-mode already passes to `RpcGoalMode`, plus `getGoalModeState()`. Then:

1. `VibeSessionRegistry.global().activateScope(ownerScope(parent))`, where `parent` is a `VibeParentSession` built like `interactive-mode.ts:4237-4251`
2. `previousTools = session.getEnabledToolNames()`; `session.activateVibeTools(["read", ...(hasBuiltInTool("todo") ? ["todo"] : [])])`
3. `session.setVibeModeState({ enabled: true })`
4. if streaming: `session.sendVibeModeContext({ deliverAs: "steer" })`
5. `sessionManager.appendModeChange("vibe", { previousTools })`, then publish

A concurrent second enter joins the in-flight promise, matching the TUI's `#vibeModeEntry` guard.

### Exit (`setMode(false)`)

Exit is a no-op when vibe is off. Otherwise it runs inside `session.runModeExitTeardown(...)`: abort if streaming, `VibeSessionRegistry.global().killAll(parent, ownerScope)`, `deactivateVibeTools(previousTools ?? [])`, `setVibeModeState(undefined)`, then publish. `killAll` → `VibeRuntime.#persistModeExit` already writes the worker tombstones and `appendModeChange("none")` atomically (vibe/runtime.ts:475-484), so exit appends nothing more. The response includes `killed: number`.

### Session transitions

`assertVibeSessionTransitionAllowed` (agent-session.ts:6396) guards only `newSession`, `fork` and `moveSession`. Native rejection already covers those three. During implementation I'll check that `handoff` goes through one of them, and if it doesn't, add an RPC-side guard. `switchSession`, `branch` and `open_session` are not guarded and need the TUI's suspend/reconcile behaviour:

- `beforeSessionChange()` → helper `quiesceVibeForSwitch`: if vibe is on, `VibeSessionRegistry.global().suspendScope(ownerScope, session.asyncJobManager)` and set the suspended-for-switch flag. Called next to plan/goal in the `new_session`/`switch_session`/`branch` case (rpc-mode.ts ~1361-1376) and in `openRpcSession` (501-517).
- `reconcile()` → helper `reconcileVibeMode` (the logic moved from the TUI):
  - `preserve` = vibe was on, the target's mode is `"vibe"`, and the owner scope matches the target scope
  - if vibe was on and not preserving: `removeVibeToolsPreservingActive()`, clear state, and suspend the scope unless it was already suspended
  - `VibeSessionRegistry.global().rehydrate(parent)`
  - if the target's mode is `"vibe"` and not preserving: re-enter with `persistModeChange: false`; pass `previousTools` from the target's `modeData.previousTools` only when the live toolset was lost to teardown
  - publish if the state changed
- Wiring: `RpcVibeMode` registers `session.setSessionSwitchReconciler(() => vibeMode.reconcile())`, as the TUI does at interactive-mode.ts:2203. `switchSession` calls it after a switch and after a rollback (agent-session.ts:10697, 10790), and `branch` calls it at 2522. That covers `switch_session`, `branch` and `open_session`, plus any session change that doesn't come through the RPC case. No explicit reconcile calls are added for those paths. `reconcile()` also runs once at startup next to `goalMode.reconcile()` (1061) for cold resume. The reconciler slot isn't used by anything else in RPC.
- Running `reconcile()` twice is harmless: a second run finds the live state already matching the target (`preserve`, or vibe off with a non-vibe target), so it changes and publishes nothing. A test covers this.
- Mutual exclusion the other way round is already enforced by `rpc-plan-mode.ts:228` and `rpc-goal-mode.ts:270`.

### No `/vibe` over RPC prompt

As approved, there's no RPC inline-prompt variant. `/vibe` stays out of the RPC `commands()` output. The companion toggles with `set_vibe_mode` and then sends normal prompts, so turning it off always goes through the confirmation. In the companion server, a composer message matching `/^\/vibe(?:\s|$)/` is rejected (409 on unsupported builds, otherwise 400 `Use the Vibe toggle; /vibe was not sent to the model.`) next to the `/plan` guard at server.mjs:736, so a typed `/vibe` never reaches the model as literal text.

### OMP tests (`test/rpc-vibe-mode.test.ts`, modeled on `rpc-goal-mode.test.ts`)

- enable → `get_state.vibeMode.enabled === true`; active tools are exactly read/todo/vibe_*; `vibe_mode_changed` is emitted
- disable → the prior toolset is restored; `killAll` runs (scope has no live workers afterwards)
- enable while plan mode is enabled, and while goal mode is paused → rejected, state unchanged
- `switch_session` while vibe is on, to a non-vibe session → vibe is off, the source scope is suspended, and the target's tools are intact; switching back re-enters and rehydrates workers
- `branch` while vibe is on → the reconciler re-anchors to the new session id; exiting vibe afterwards succeeds (regression for issue #10468)
- startup reconcile of a session whose mode is `"vibe"` → vibe is on with the persisted `previousTools`
- running reconcile twice → no second `vibe_mode_changed`, state unchanged
- the TUI `/vibe` enter/exit and switch tests that already exist still pass after moving to the helper

Docs: `docs/vibe-mode.md` gets an RPC section, and the README RPC section and CHANGELOG get an entry. One commit: `feat(coding-agent): expose vibe mode over RPC`.

## Phase 2 — companion server (`companion/server.mjs`)

- `refresh()`: `s._vibeSupported = Object.hasOwn(state, 'vibeMode')`; `s.vibeMode = state.vibeMode`, deleted when unsupported
- event handler: `vibe_mode_changed` → `s.vibeMode = f.vibeMode; s._vibeSupported = true`
- `/sessions/:id/command` `{ type: 'vibe_mode', enabled }`: a non-boolean `enabled` returns 400; an unsupported build returns 409 with `This OMP build does not expose vibe mode over RPC. Set OMP_BIN to an updated build or the patched checkout's packages/coding-agent/src/cli.ts.`; OMP rejections (plan/goal active) come back as errors
- Turns the director starts on its own: worker results self-deliver through the async job manager and start director turns without a companion prompt. The existing `agent_start` handler (server.mjs:404) already sets `status='running'`, and settling stays on native `isSettled` (server.mjs:517), so no new code is expected. The smoke test has to show that an idle session goes running → review when a worker result arrives. If it doesn't, the fix goes here.

## Phase 3 — dashboard (`local-dist/app.js`, `app.css`)

- Composer chip next to ⚡ Fast, using the existing `model-chip` pattern: `〰 Vibe on/off`, `data-act="vibeToggle"`, `aria-pressed`. It's hidden when `_vibeSupported` is false. It's disabled with the title "Exit plan/goal mode first" while plan or goal mode is on or paused, and disabled while busy.
- Hotkey Alt+Shift+V, next to the Alt+Shift+P handler.
- Turning it off asks for confirmation first ("Turn off vibe mode? Running workers are killed."), using the existing confirm pattern (the same one goal drop uses).
- A `Vibe` pill in the session top bar while it's on, next to the `⚡ Fast` pill (app.js:465).
- No worker panel. During the smoke test I'll check whether workers already show in the activity panel as async jobs and report what I find.

## Phase 4 — companion tests and docs

- `tests/vibe-mode.test.mjs`, following `tests/plan-mode.test.mjs`: route validation (400), 409 on an unsupported build, `set_vibe_mode` forwarded with the right payload, state taken from `get_state`/`vibe_mode_changed`
- README: a feature bullet plus a "Native vibe mode" section covering the toggle, the hotkey, workers killed on off, mutual exclusion, and the OMP build requirement

## Verification

- OMP: `bun test` for `rpc-vibe-mode`, `rpc-plan-mode`, `rpc-goal-mode`, `rpc-extension-ui`; `bun run check` (or the repo's typecheck)
- Companion: `npm test`
- Smoke: run the companion against the patched checkout via `OMP_BIN`. In the browser, turn vibe on, send a small directive, watch a worker spawn and its result arrive with the session going running → review, then turn vibe off with confirmation and check that `vibe_list` / state shows no workers. Also try Alt+Shift+V, check that the chip is disabled while plan mode is on, and switch the entry to another saved session while vibe is on.

## Out of scope

A worker management UI, `/vibe <prompt>` image attachments over RPC, and any change to TUI behaviour.
