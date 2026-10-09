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
    --tools=read,grep,glob,find --max-time=120
    --config=<overlay.yml>          # advisor.enabled: false
    --model=… [--thinking=…]
    --append-system-prompt=<enhancer instructions>
    [@<image-1> @<image-2> …]
stdin: the request (see §3)
cwd: session cwd / path
```

- Spawned with `spawn(ompExecutable, [...ompPrefix, ...args])`, never through a shell, `windowsHide: true`.
- The draft goes in on **stdin**, so long drafts avoid the Windows 32K command-line limit.
- The overlay is a static file written once to `dataDir/enhance-overlay.yml`. Verified: `advisor.enabled: false` in a `--config` overlay suppresses the advisor for the run. Without it the user's global advisor reviews every enhance.
- Images are written to `dataDir/enhance/<jobId>/image-<n>.<ext>` (mode 0600) and passed as `@path` arguments. Verified: `omp -p` with stdin plus `@image.png` delivers `[text, image]` content. The directory is removed when the job ends, however it ends.
- `--no-session` writes no session file. Only the four read-only tools are enabled. Rules (AGENTS.md / CLAUDE.md) stay **enabled**: they are the project context.
- MCP servers still connect at startup (OMP has no `--no-mcp`), which adds a few seconds. They are inert, because no MCP tools are enabled.

### Events → job state

Stdout is read line by line as JSON:

- `tool_execution_start` → `step` = short label: `reading <path>`, `searching "<pattern>"`, `listing <glob>`, `finding "<query>"`. Paths are shown relative to the cwd and truncated to 80 characters.
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
  1. Enhance calls `POST /api/quick-start` with the same options as Start (`path`, `isolate`, `model`, `thinking`, `fast`, `advisor`, `launch`) but **no prompt and no images**. This creates and starts the session.
  2. The staged attachments move from the home view to the new session's view (`a.view = 'session:' + id`), so they stay attached for Send.
  3. The draft is stored as the new view's draft, the browser navigates to `#/s/<id>`, and the enhance starts there in session mode (cwd = the new session's cwd, including an isolated worktree).
  4. If quick-start fails, the user stays on the home screen with the draft and attachments unchanged, and an error toast is shown.
- **OMP-history view (`native`):** enhance runs in `path` mode with the view's cwd and model choice. It does not resume the session, because resuming requires sending a message.
- **Images:** the view's staged attachments are sent with the enhance request (`imagePayload`). They are not removed from the composer.

## 5. Frontend (`local-dist/app.js`, `app.css`)

- State: `S.enhance = Map<view, { id, original, model, step, pollTimer }>`.
- Polls `GET /api/enhance?id=` every 500 ms while the view's job runs. On `done`, applies the result as described in §1.
- The button is rendered by `renderComposer` and the home composer bar. The status line uses the existing `#statusLine`; on the home screen the job never runs, because Enhance moves to the new session first.
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

## 7. Testing

- **Throwaway smoke (required before done):** start an isolated, loopback-only companion and:
  1. Enhance a draft in a live session: progress steps appear, the result names real files, Undo works.
  2. Enhance on the New-session screen with an attached image: a session is created, the image stays attached, and the result references it.
  3. Cancel mid-run.
  4. Set `modelRoles.enhance` to a bad model: error toast.
  5. Enhance in a session whose OMP is stopped: OMP starts.
- **Permanent tests (`tests/enhance.test.mjs`), only for the boundaries:**
  - The result is applied only when the draft is unchanged; otherwise the offer toast appears.
  - Undo restores the original draft.
  - New-session Enhance moves the attachments and draft to the new session's view.
  - Server: model resolution order (`@enhance` → session model with `--thinking=low` → none) and the argument list never contains the draft text. Tested by exporting the argument builder for unit use.

## Out of scope

- Streaming the rewrite text token by token. Progress shows steps only.
- A separate model picker for enhance. The `enhance` role in Settings covers that.
- Enhancing queued or steer messages.
