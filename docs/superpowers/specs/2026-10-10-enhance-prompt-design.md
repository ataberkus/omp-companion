# Enhance prompt — design

Status: approved in chat 2026-10-10, pending written-spec review.

## Goal

A **✨ Enhance** button in the composer rewrites the user's draft into a clearer, more specific prompt for the coding agent. It works like Augment Code's prompt enhancer: before rewriting, it reads the project and names the real files and symbols the draft refers to. The rewrite replaces the draft, and the user can undo it. Nothing is ever sent automatically.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Context | Conversation tail + repo rules (AGENTS.md etc.) + read-only code lookup |
| Model | OMP model role `enhance` if configured, else the composer's selected model |
| Result | Replace the draft in place, Undo via toast and Ctrl+Z |
| Engine | One-shot read-only `omp -p` run per click (no long-lived process) |
| OMP not running (existing session) | Start the session's OMP alongside the enhance |
| New-session screen | Enhance creates and starts a session in the picked folder, switches to it, and puts the enhanced draft in its composer (not sent) |
| Attached images | Passed to the enhancer as context; they stay attached to the draft |

OMP has no prompt enhancer of its own. The RPC `btw` side question is not used: it always uses the session model, can't call tools, and works only for live sessions.

## 1. User-facing behaviour

- **Button:** `✨ Enhance` in the composer bar, next to `＋ Image`. Present on every composer: live sessions, the New-session screen, and continuing a session from OMP history. Disabled when the draft is empty, starts with `/` or `!`, or an enhance is already running in this view.
- **Shortcut:** Ctrl+Shift+E (Cmd+Shift+E on macOS) while the composer has focus. It is listed in the button's title and added to the dashboard-shortcut list that composer hotkeys can't reuse. Firefox reserves Ctrl+Shift+E for its network monitor; the button still works there.
- **While running:**
  - The textarea is read-only, so the user can't type into a draft that is about to be replaced.
  - The button turns into `■ Cancel`.
  - The status line shows progress: `Enhancing with <model> · reading local-dist/app.js…`. The step text comes from the enhancer's tool calls.
  - Send stays disabled until the enhance finishes or is cancelled.
- **Done:**
  - The draft is replaced, the caret moves to the end, and the composer gets focus.
  - A toast says `Prompt enhanced` with an **Undo** action that restores the original draft. Ctrl+Z restores it too: the replacement goes through `document.execCommand('insertText')` so it lands on the browser's native undo stack. If that is unavailable, it falls back to setting the value directly, and the toast Undo still works.
- **Failure / cancel:** the draft is untouched. Failures show an error toast with the reason (model not found, timed out, OMP error). Cancel shows no toast.
- **Leaving the view:** the job keeps running. If the user comes back to that view before it finishes, the result is applied then. If the user has edited the draft in the meantime (it no longer equals the text that was sent to be enhanced), the result is **not** applied: an info toast offers `Use enhanced prompt` instead.

## 2. Server (`companion/server.mjs`)

Follows the existing CLI-job pattern (`runCli`, `cliJobs`, `cliProcs`).

### Routes

- `POST /api/enhance` with `{ text, session? | path?, model?, thinking?, images?, preview? }` → `202 { id, model }`.
  - `text`: required, 1–20 000 characters.
  - `session`: a panel session id. The folder is the session's `cwd` (which may be an isolated worktree); the model is the session's current choice; the conversation tail comes from its messages.
  - `path`: a folder from the OMP-history view, validated with `resolveDir`. Used together with `model`/`thinking` from the client. No conversation tail.
  - Exactly one of `session` / `path` is required.
  - `images`: validated with the existing `chatImages()` (same limits as prompts). The body cap is 48 MB, as for `/api/quick-start`.
- `GET /api/enhance?id=` → `{ id, status: 'running'|'done'|'error'|'cancelled', step, model, text?, error? }`.
- `POST /api/enhance/stop` with `{ id }` → `{ status }`. Kills the process.
- Jobs are kept in memory only. At most **3** can run at once (409 beyond that). A finished job is dropped 5 minutes after it finishes. Companion shutdown kills running enhance processes.

### Model resolution

1. If `modelRoles.enhance` is set (read through the cached `listModels()` roles), use `--model=@enhance`. The role's own `:thinking` suffix applies.
2. Otherwise use the session's model selector (or `model` from the client on the history view) with `--thinking=low`. This keeps an Opus-xhigh composer from making every enhance take minutes.
3. If there is no model at all (OMP default), pass nothing: OMP uses its own default role.

The response and `GET` report the model actually used, for the status line.

### Process

```
omp -p --mode json --no-session --no-title --no-skills --no-extensions --no-lsp
    --tools=read,grep,glob --approval-mode=always-ask --max-time=120
    --config=<overlay.yml>          # lockdown overlay, see below
    --model=… [--thinking=…]
    --append-system-prompt=<enhancer instructions>
    [@<image-1> @<image-2> …]
stdin: the request (see §3)
cwd: session cwd / path
```

- Spawned with `spawn(ompExecutable, [...ompPrefix, ...args])`, never through a shell, `windowsHide: true`.
- The draft goes in on **stdin**, so long drafts avoid the Windows 32K command-line limit.
- **Lockdown overlay**: a static file written once to `dataDir/enhance-overlay.yml`. `--tools` alone does **not** make the run read-only. On OMP 18.8.6, with the user's config (`autolearn.enabled: true`, four MCP servers), `--tools=read,grep,glob` still exposed `manage_skill`, which created a real skill in `~/.omp/agent/managed-skills`. It also exposed `write` (xd:// devices, which route to MCP tools). With `tools.xdev: false`, the MCP tools mount directly instead, and one was called on the live Blender. The verified overlay:

  ```yaml
  tools:
    xdev: false                 # no `write` / xd:// device route
  advisor:
    enabled: false
  autolearn:
    enabled: false              # no manage_skill / learn, no post-turn capture
    autoContinue: false
  compaction:
    experimentalContextManagement: false   # no context_notes / new_context
  memory:
    backend: "off"              # no recall/retain/reflect/memory_edit or background memory writes
  checkpoint:
    enabled: false
  todo:
    enabled: false
  ask:
    enabled: false
  disabledProviders:            # stop MCP discovery: user + .omp/ configs, project .mcp.json
    - native
    - mcp-json
  ```

  `--approval-mode=always-ask` is a second fence. Print mode has no UI, so any tool above the `read` tier fails closed with "requires approval but no interactive UI". MCP tools never declare a tier and default to `exec`. `read`/`grep`/`glob` are `read` tier and run normally.

  Verified together: the tools are exactly `read, grep, glob`. Write, skill-save and MCP attempts all fail. No MCP server process starts. A trivial run takes about 3.5 s instead of about 7 s.
- **Tool list:** `find` is not in it. On this OMP build it is not a built-in, and `--tools=…,find` aborts with `Built-in tool unavailable in this session: find` (exit 2).
- **What the lockdown costs:**
  - Disabling the `native` provider drops OMP's own `.omp/` sources (`.omp/rules`, `.omp/AGENTS.md`, `SYSTEM.md`) for the enhancer only.
  - Repo-root `AGENTS.md` / `CLAUDE.md` still load; verified with a sentinel.
  - Foreign tools' home configs (`~/.claude.json`, `~/.cursor/mcp.json`, …) stay unloaded, because they are opt-in via `enabledProviders`, which is empty.
  - A repo's own foreign MCP config (e.g. `.cursor/mcp.json`) can still start its servers. Their tools are blocked by `always-ask`.
  - The overlay's `disabledProviders` replaces the user's list for this run. The user's is `[]` today; a non-empty user list would be overridden for the enhancer only.
- `--no-session` writes no session file.

### Events → job state

Stdout is read line by line as JSON:

- `tool_execution_start` → `step` = short label: `reading <path>`, `searching "<pattern>"`, `listing <glob>`. Paths are shown relative to the cwd and truncated to 80 characters.
- `message_end` where role is `assistant` → remember its text content (the last one wins).
- Exit code 0 with non-empty text → `done`, and `text` is that text trimmed, with any wrapping code fence removed.
- Nonzero exit or no text → `error`. The reason is the last stderr line (ANSI stripped). `Model "@enhance" not found`-style output passes through unchanged.
- The server kills the process at 150 s → `error: 'Enhance timed out.'`.

## 3. Enhancer request

### System prompt (`--append-system-prompt`)

> You are a prompt enhancer for a coding agent working in this repository. Rewrite the user's draft into a clear, specific prompt that agent can act on.
> - Keep the user's intent, scope and language. Do not add requirements they did not ask for.
> - Look up only what the draft refers to: at most 6 tool calls. Name real files, symbols and commands you confirmed. Never invent paths.
> - If images are attached, use what they show to make the prompt concrete; they stay attached to the final message, so refer to them rather than re-describing everything.
> - Include acceptance criteria or a verification step only when the draft implies one.
> - Output ONLY the rewritten prompt as plain Markdown. No preamble, no explanation, no code fence around the whole prompt.

### Stdin

```
<conversation>            (session mode only; omitted when empty)
User: …
Assistant: …              (last 6 user/assistant messages, each truncated to 1 500 chars;
                           tool, system and thinking entries skipped)
</conversation>
<draft>
…user's draft…
</draft>
```

## 4. Starting OMP, the New-session screen, and images

- **Existing session, OMP not running:** in parallel with `POST /api/enhance`, the frontend calls `GET /api/commands?session=<id>`. That route already runs `start(s)` under the session lock (it is what the slash menu uses). Once OMP is up, ghost text works and the next Send doesn't wait for OMP to start. No new endpoint.
- **New-session screen:**
  1. Enhance calls `POST /api/quick-start` with the same options as Start (`path`, `isolate`, `model`, `thinking`, `fast`, `advisor`, `launch`) plus `draft: true`, but **no prompt and no images**. This only creates and saves the session: with an empty prompt, `createSession` persists without starting OMP, and quick-start starts OMP only as a side effect of the `advisor`/`fast` options. So the frontend then calls `GET /api/commands?session=<id>`, the same start path as an existing session that isn't running (above), so OMP always starts on the picked folder.
  2. The staged attachments move from the home view to the new session's view (`a.view = 'session:' + id`), so they stay attached for Send.
  3. The draft is stored as the new view's draft, the browser navigates to `#/s/<id>`, and the enhance starts there in session mode (cwd = the new session's cwd, including an isolated worktree).
  4. If quick-start fails, the user stays on the home screen with the draft and attachments unchanged, and an error toast is shown.
- **OMP-history view (`native`):** enhance runs in `path` mode with the view's cwd and model choice. It does not resume the session, because resuming requires sending a message.
- **Images:** the view's staged attachments are sent with the enhance request (`imagePayload`). They are not removed from the composer.

### Draft sessions (discarded if you leave without sending)

A session created by Enhance is a **draft session** until its first message goes out. Picking workspace A, pressing Enhance, then going back to New session and picking B must not leave A's session, OMP process or worktree behind.

- **Marker:** quick-start with `draft: true` sets `s.draft = true` on the stored session. The marker is cleared, and the session becomes a normal one, the first time `command()` handles a `prompt`, `steer`, `follow_up`, `interrupt` or `bash` for it, including slash commands and queued follow-ups. It is cleared **synchronously at the top of `command()`, before any `await`**: the prompt and bash paths `await start(s)` before they record the user message (server.mjs:671, 747), so "no user message yet" is not a safe test on its own.
- **Visible:** while `s.draft` is set, the status line reads `Draft · discarded if you leave without sending`.
- **What counts as leaving** (frontend, on route change from `#/s/<id>` of a draft session to):
  - New session (`#/new`, Alt+N, `＋ New here`), including then picking another folder;
  - another panel session or an OMP-history item.

  Settings, Tools, Spend, and that session's own subagent, changes and transcript views do **not** count, so the user can, for example, set the `enhance` role and come back. Discard is fire-and-forget: navigation never waits for it.
- **Discard** (`POST /api/sessions/<id>/command {type:'discard'}`) runs **under the session lock** (`lock(s.id, …)`), like every other command except `answer` and `predict_word`. Discard is not on a per-keystroke path. Because it is serialised behind any Send in flight, and Send clears `s.draft` first, discard can't kill a session whose first prompt is being dispatched. Under the lock it is a no-op unless `s.draft` is still set and the session has no user message. When it runs:
  1. Stop the session's running enhance job, if any, and **await its process's `close` event**.
  2. Stop its OMP process and **await `close`**, using the same pattern as `discoverCommands` (server.mjs:380-382: `once('close')`, `kill()` unless already stopping, await only if still alive). `hide` (line 701) kills without waiting, which isn't enough here.
  3. Delete its OMP session file only if `readSessionHead` shows no user message. In a file that has messages, it is left alone and the session is simply hidden.
  4. If `s.isolated` and `s.branch` starts with `omp-web/`: `git worktree remove --force <cwd>`, then `git branch -D <branch>`, both in the project path. On Windows a just-exited process tree (OMP's LSP/MCP children, antivirus, indexers) can briefly keep the folder busy. So the remove is retried with growing backoff like `replaceFile` (server.mjs:361): up to 20 tries, 50 ms × attempt, retrying on a failing `git worktree remove`.
  5. If the worktree still can't be removed, the session is **not** dropped from the store. It keeps `draft: true`, is marked `hidden: true` so it leaves the sidebar, and is retried by the startup cleanup below. Otherwise it is removed from `store.sessions` (not just hidden). Either way the client drops its staged attachments and in-tab draft, and the store is persisted.
- **Tab closed or companion quit while a draft session exists:** in-tab drafts don't survive a reload, so the session would come back empty. On companion **startup**, every stored session that still has `draft: true` and no user message, hidden or not, is discarded the same way. No OMP processes exist at that point, so worktree removal normally succeeds then. A worktree that still fails stays recorded for the next startup.
- **Known limit:** with two dashboard tabs, leaving the draft in one tab discards it even if the other tab is showing it. The other tab sees the session disappear on its next poll. This is acceptable, because draft sessions are short-lived and single-tab in practice.

## 5. Frontend (`local-dist/app.js`, `app.css`)

- State: `S.enhance = Map<view, { id, original, model, step, pollTimer }>`.
- Polls `GET /api/enhance?id=` every 500 ms while the view's job runs. On `done`, applies the result as described in §1.
- The button is rendered by `renderComposer` and the home composer bar. The status line uses the existing `#statusLine`; on the home screen the job never runs, because Enhance moves to the new session first.
- Draft discard hooks into the existing `route()` change handling: remember the previous view; if it was a draft session and the new view counts as leaving (§4), send `discard`.
  - **In-flight guard:** skip `discard` while a send for that view is still in flight. The server lock alone can't order them: the server reads the whole request body (server.mjs:1081) before it takes the lock (1134). A Send with several MB of images can therefore lose the lock to a tiny `discard` sent just after it, leaving the Send with a 404 and its draft restored into a view that no longer exists. The guard checks `S.pending?.view === prevView` (set by `send()` before its request, app.js:1942) **and** a new `S.sendingBash` view marker set around the `!cmd` path (1890-1893), which sends `bash` without setting `S.pending`.
  - **After the guard:** when that send finishes, the session either has a message (no longer a draft) or the send failed. On failure, if the user is no longer on that view, `discard` is sent then, from the send's `finally`.
- The keyboard shortcut is added to the global keydown handler, next to Ctrl+P.

## 6. Error handling summary

| Case | Result |
|---|---|
| Empty draft, `/…` or `!…` | Button disabled |
| `@enhance` role set to an unknown model | Error toast with OMP's message; draft unchanged |
| No provider auth, network error | Error toast (last stderr line) |
| Over 120 s / 150 s | Error toast `Enhance timed out.` |
| A fourth job while three are running | 409 toast `Wait for the running enhance to finish.` |
| Draft edited while running | Not applied; info toast with `Use enhanced prompt` action |
| Companion shutdown | Processes killed; images directory removed |
| Leaving a draft session without sending | Session, OMP process, empty session file and its worktree/branch removed after both processes have exited (§4) |
| Worktree still busy after 20 retries | Session hidden but kept with `draft: true`; removal retried on the next companion startup |
| Send and leave in quick succession | The client skips `discard` while that view's send is in flight; if the send fails after the user left, `discard` is sent then. On the server, a send that takes the lock first clears `draft` before any `await`, so a later discard does nothing |
| Draft session left over after a crash or tab close | Discarded on the next companion startup |

## 7. Testing

- **Throwaway smoke (required before done):** start an isolated, loopback-only companion and:
  1. Enhance a draft in a live session: progress steps appear, the result names real files, Undo works.
  2. Enhance on the New-session screen with an attached image: a session is created, the image stays attached, and the result references it.
  3. Cancel mid-run.
  4. Set `modelRoles.enhance` to a bad model: error toast.
  5. Enhance in a session whose OMP is stopped: OMP starts.
  6. Enhance on New session in folder A with *Isolated git worktree* ticked, then Alt+N and pick folder B: A's session is gone from the sidebar, its `omp` process has exited, and `git worktree list` / `git branch` in A no longer show `omp-web/…`. Repeat without leaving and press Send: the session stays.
- **Permanent tests (`tests/enhance.test.mjs`), only for the boundaries:**
  - The result is applied only when the draft is unchanged; otherwise the offer toast appears.
  - Undo restores the original draft.
  - New-session Enhance moves the attachments and draft to the new session's view.
  - Leaving a draft session for New session or another session sends `discard`; leaving for Settings does not; a session that has sent a message is never discarded (server no-op).
  - Leaving a draft session while its Send (or `!cmd`) request is still pending sends no `discard`. If that request then fails, `discard` is sent once it settles.
  - Server (with a fake `omp` via the existing `ompCommand` option): a `prompt` and a `discard` sent back to back for a draft session leave the session in the store with its message, and a lone `discard` removes it only after the fake process has exited.
  - Server: model resolution order (`@enhance` → session model with `--thinking=low` → none) and the argument list never contains the draft text. Tested by exporting the argument builder for unit use.

## Out of scope

- Streaming the rewrite text token by token. Progress shows steps only.
- A separate model picker for enhance. The `enhance` role in Settings covers that.
- Enhancing queued or steer messages.
