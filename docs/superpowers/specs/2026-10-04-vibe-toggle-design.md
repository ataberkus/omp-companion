# Vibe mode toggle — design

Date: 2026-10-04
Status: awaiting written-spec review

## Goal

An on/off toggle for OMP's native vibe mode in the companion dashboard. While it is on, the session acts as a director: its toolset is `read`, the optional parent-owned `todo`, and `vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list`, and persistent fast/good worker sessions do the real work (see `../oh-my-pi/docs/vibe-mode.md`). Turning it off kills every worker in the session's scope.

Success: from the browser, a user turns vibe on, sends a directive, sees worker results come back as director turns, and turns vibe off. When it turns off, the workers are gone and the prior toolset is back. On OMP builds without vibe RPC, the control is absent and nothing is simulated.

## Dependency: OMP has no vibe RPC today

`/vibe` defines only `handleTui` (`slash-commands/builtin-modes.ts:314-331`). OMP's RPC layer only reads `getVibeModeState()`, and only to block plan and goal mode (`rpc-plan-mode.ts:228`, `rpc-goal-mode.ts:224,270`). This work therefore starts with an OMP patch. The companion side is useless without it, and capability detection keeps older builds working unchanged.

## Phase 0 — commit the existing OMP WIP

`../oh-my-pi` (on `main`, 3 commits ahead of origin) has uncommitted work in the same files this patch touches. `git status --porcelain` shows these changes, committed as two commits:

1. `feat(coding-agent): expose native goal mode over RPC`
   - untracked: `src/goals/continuation.ts`, `src/modes/rpc/rpc-goal-mode.ts`, `test/rpc-goal-mode.test.ts`
   - modified: goal hunks of `src/modes/rpc/rpc-mode.ts`, `src/modes/rpc/rpc-types.ts` (`RpcGoalModeState`, `goalMode`), `src/modes/interactive-mode.ts`, `README.md`, `packages/coding-agent/CHANGELOG.md` (goal line)
2. `fix(coding-agent): show the Done row for multi-select ask questions in RPC`
   - `src/tools/ask.ts`, `test/tools/ask.test.ts`, `test/rpc-extension-ui.test.ts`, `checkedIndices` hunk of `rpc-types.ts`, CHANGELOG fix line

`test/tools/zz-probe.test.ts` stays untracked and untouched. If the goal and ask hunks can't be separated cleanly with `git add -p`, I fall back to a single WIP commit. Before committing, I show you the exact file list and messages and run the touched tests (`rpc-goal-mode`, `ask`, `rpc-extension-ui`). Each commit has to build on its own, so the untracked goal files are added explicitly, never through `commit -a`.

## Phase 1 — OMP: `RpcVibeMode`

New file `packages/coding-agent/src/modes/rpc/rpc-vibe-mode.ts`, structured like `RpcPlanMode`/`RpcGoalMode`. It calls `AgentSession` APIs directly. `InteractiveMode` is not changed.

Note: `#enterVibeMode`/`#exitVibeMode` in `interactive-mode.ts` (5672-5762) are mostly session calls with TUI concerns mixed in (status line, warnings, `/vibe <prompt>` submission ordering). The RPC class repeats roughly 20 lines of that sequence. The alternative is extracting a shared helper, which means editing `interactive-mode.ts`. Repeating them keeps the patch away from TUI code. If the two copies drift, extracting the helper is the follow-up.

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

Exit is a no-op when vibe is off. Otherwise it runs inside `session.runModeExitTeardown(...)`: abort if streaming, `VibeSessionRegistry.global().killAll(parent, ownerScope)`, `deactivateVibeTools(previousTools ?? [])`, `setVibeModeState(undefined)`. It then appends the `"none"` mode change, but only if the TUI path persists one too (to be confirmed against `VibeRuntime.#persistModeExit`, which already persists tombstones), and publishes. The response includes `killed: number`.

### Session transitions

`assertVibeSessionTransitionAllowed` (agent-session.ts:6396) guards only `newSession`, `fork` and `moveSession`. Native rejection already covers those three. During implementation I'll check that `handoff` goes through one of them, and if it doesn't, add an RPC-side guard. `switchSession`, `branch` and `open_session` are not guarded and need the TUI's suspend/reconcile behaviour:

- `beforeSessionChange()`: if vibe is on, run `VibeSessionRegistry.global().suspendScope(ownerScope, session.asyncJobManager)` and remember that the scope was suspended (TUI `#quiesceVibeForSessionSwitch`, 4253-4258).
- `reconcile()`, ported from TUI `#reconcileModeFromSession` (4510-4534, 4567-4576) plus `#clearTransientModeState` (4490-4506):
  - `preserve` = vibe was on, the target's mode is `"vibe"`, and the owner scope matches the target scope
  - if vibe was on and not preserving: `removeVibeToolsPreservingActive()`, clear state, and suspend the scope unless it was already suspended
  - `VibeSessionRegistry.global().rehydrate(parent)`
  - if the target's mode is `"vibe"` and not preserving: re-enter with `persistModeChange: false`; pass `previousTools` from the target's `modeData.previousTools` only when the live toolset was lost to teardown
  - publish if the state changed
- Wiring in `rpc-mode.ts`: call `vibeMode.beforeSessionChange()`/`reconcile()` alongside plan and goal in the `new_session`/`switch_session`/`branch` case (around 1361-1376) and in `openRpcSession` (501-517). Call `reconcile()` once at startup next to `goalMode.reconcile()` (1061); this covers cold resume of a vibe session. Branch also calls the session-level `#sessionSwitchReconciler`. That reconciler is the TUI's and isn't set in RPC, so the explicit reconcile handles branch.
- Mutual exclusion the other way round is already enforced by `rpc-plan-mode.ts:228` and `rpc-goal-mode.ts:270`.

### Commands list

`/vibe` is added to the RPC `commands()` output. When the companion sends `/vibe` through `prompt`, the server toggles. When it sends `/vibe <prompt>`, it toggles on and then prompts. This mirrors the existing `/plan` handling at rpc-mode.ts:1184-1216, so typing `/vibe` in the browser composer works too.

### OMP tests (`test/rpc-vibe-mode.test.ts`, modeled on `rpc-goal-mode.test.ts`)

- enable → `get_state.vibeMode.enabled === true`; active tools are exactly read/todo/vibe_*; `vibe_mode_changed` is emitted
- disable → the prior toolset is restored; `killAll` runs (scope has no live workers afterwards)
- enable while plan mode is enabled, and while goal mode is paused → rejected, state unchanged
- `switch_session` while vibe is on, to a non-vibe session → vibe is off and the target's tools are intact; switching back re-enters
- startup reconcile of a session whose mode is `"vibe"` → vibe is on with the persisted `previousTools`

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
