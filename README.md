# OMP Control Room

A local web control panel for [oh-my-pi](https://github.com/can1357/oh-my-pi). OMP stays unchanged. One companion process manages multiple project directories and OMP RPC processes, so you can use one browser instead of many terminals.

## Run the prebuilt companion

1. Install **Node.js 22 or newer**.
2. Install and configure OMP using the upstream instructions. Verify that `omp --version` works and that your model provider is configured in OMP.
3. Extract `omp-companion.zip`, open a terminal in the extracted folder, and run:

```sh
node companion/server.mjs
```

On Windows you can double-click `start.bat` instead; it checks that `node` and `omp` are on PATH and keeps the window open after the companion stops.

4. The dashboard opens automatically and connects itself (the printed link carries the token in the URL fragment, which is never sent to the server). Set `OMP_WEB_NO_OPEN=1` to skip opening the browser. The token is kept in the tab's `sessionStorage`, so reloading the tab stays connected.
5. Click **New session** in the sidebar (or press `Alt+N`): pick a recently used folder or browse to any folder, optionally type a prompt, and press Enter. The project is registered automatically. Each session has an independent OMP process.

Keep this one companion terminal open. You no longer need one terminal for every project or session.

## Controls

The dashboard at `/` is organised around sessions:

- **Sidebar:** every session in one list. That includes the ones you ran in a terminal (read from `~/.omp/agent/sessions`; override with `OMP_SESSIONS_DIR`). Grouped as *Working now*, *Needs your review*, *Today*, *Yesterday*, *Previous 7 days* and *Older*. Search with `/`; filter to *Active* or *In panel*.
- **New session** (`Alt+N`): pick a recent folder or browse to one, optionally type what to do, press Enter. The project is registered automatically.
- **Conversation:** a compact plan line above chat shows the active todo and progress; click it to open the full plan in the right-hand panel. Below it, rendered Markdown includes code blocks with copy, tables, lists and links. Each stretch of tool calls and thinking folds into one activity block, open while OMP works and collapsed afterward with tool counts, failures and changed-file summaries. Replies show the model that wrote them. Automatic context compaction shows “Compacting context…” while it runs and records the outcome in chat.
- **Questions:** OMP's built-in `ask` tool and extension selection, confirmation, text and editor prompts appear above the composer. Choose an option, type an answer, decline, or cancel; only the matching live session receives the reply.
- **Advisor:** set an advisor model with **◆ Change advisor model…** in the advisor panel, then enable `advisor.enabled` globally or use **⋯ → Enable advisor** in a chat. The model comes from `advisors[].model` in `WATCHDOG.yml` (in the OMP agent directory) when present, otherwise from the `advisor` model role; changing it updates that source for all sessions and restarts the current session's OMP while it is idle. The menu also offers **Disable advisor** and **Advisor status**; these are session-scoped and do not change OMP settings. Advice appears inline with its severity and reviewer name. Without a configured advisor model, OMP reports that no model is assigned.
- **Diffs:** edits appear as GitHub/VS Code-style diffs with old and new line numbers, syntax colors and word-level highlights. Switch between **Unified** and **Split** (your choice is remembered). **± N files changed** in the header opens every change in the session, grouped by file.
- **Plan & Activity:** tabs in the right-hand panel keep the full plan (all phases and tasks) separate from running and finished subagents, background bash jobs, and read-only advisor transcripts. The panel overlays chat on narrow screens. **Open transcript** shows a subagent or advisor's history with a link back to its parent.
- **Models:** the **◆** chip in the composer opens a searchable model picker. It lists your OMP roles, recently used models and every provider, with a reasoning-level choice for each model. It works for new sessions, running sessions (from the next turn) and saved sessions you continue.
- **Settings** (**⚙ Settings** in the sidebar footer): every OMP setting from `omp config`, grouped, searchable and filterable to the ones you changed. Switches, dropdowns, lists and JSON editors write through `omp config set`, so OMP validates each value. **Reset** returns a setting to OMP's default. Model roles and agent model overrides use the model picker. Secret values are never shown; you can only replace them. Changes apply to new sessions and to sessions you restart. **Update OMP** runs the installed `omp update` in the background and shows its result or error; restart existing sessions to use an installed update. **Plugins** (first section) lists installed plugins with an enable/disable switch and **Remove**, installable ones from `omp plugin discover`, and a field to install by name; removal asks for confirmation.
- **One composer, always the right action:**
  - Saved OMP session: **Continue** resumes that exact session file and sends your message.
  - Images: click **＋ Image** or paste an image into the composer. One PNG, JPEG, WebP or GIF at a time; image-only messages work. Files up to 25 MB are resized when needed to meet the companion's 5 MB attachment limit. Remove a selected image before sending with **✕**.
  - Idle, finished or stopped: **Send** continues the conversation.
  - Working: **Enter steers** the current turn; the steer stays pending above the composer until OMP reads it. **Alt+Enter / Queue** adds a message to **Send later** above the composer; it does not interrupt or split the live chat. Click the pencil to edit its text (an attached image stays attached), **✕** to remove it, or the send button to **Steer now** (while OMP works) or **Send now** (while it waits). The companion sends queued messages after the current work settles, one turn at a time, and notices when a session goes idle even if OMP never reports it settled. **■** stops the turn; queued messages wait until you resume and finish another turn. If the companion closes before OMP acknowledges a queued send, that item remains queued for retry. You cannot mark a session done or remove it from the panel while it has queued messages.
  - Error: the error is shown above the composer with **Retry last message**. For an image message, reattach the image if it is no longer selected before sending again.
- **Header:** status, branch, model, tokens, cost and context use; **Stop**, **Mark done** and a **⋯** menu (new session in this folder, copy paths or the `omp --resume` command, compact context, remove from panel).

Don't continue a session from the panel while the same session is still open in a terminal. Both would write to the same file.

Sessions launched by this panel are managed by this companion. It does not attach to or take over an independently running interactive CLI. The separate upstream checkout has not been modified.

## Parallel work and persistence

By default, **New session** runs in the chosen folder and saves to OMP's normal session store, so `omp --resume` in a terminal sees it too. For a Git folder, tick **Isolated git worktree** to run in a separate branch; isolation requires a repository with an initial commit. Each worktree gets an `omp-web/<id>` branch based on HEAD. Uncommitted changes in the original checkout are not copied. Worktrees do not install project dependencies automatically; tell OMP any setup your task needs. Without isolation, concurrent sessions in the same folder can edit the same files.

Data is saved in `~/.omp-web/workspace.json`; transcripts managed by OMP are under `~/.omp-web/sessions/`; worktrees are under `~/.omp-web/worktrees/`. The panel keeps the most recent 250 visible message records per session; OMP retains its complete native transcript. Session processes are stopped when the companion exits. Reopening and prompting a session resumes its dedicated OMP session directory. Worktrees are kept for review and manual cleanup; the panel never auto-merges or deletes them.

The hosted preview opens a labeled demo with browser-local persistence. Connecting replaces it with your real local workspace. Demo examples never launch an OMP process. The token and provider credentials are not saved in browser storage. No provider credentials are sent to the website.

## Use the private hosted dashboard

The local dashboard is the most reliable way to connect. To use the hosted dashboard, explicitly allow its exact origin:

```sh
OMP_ALLOWED_ORIGINS=https://omp-control-room.ataberk-oztrk3.chatgpt.site node companion/server.mjs
```

PowerShell:

```powershell
$env:OMP_ALLOWED_ORIGINS="https://omp-control-room.ataberk-oztrk3.chatgpt.site"
node companion/server.mjs
```

Use `http://127.0.0.1:4545` as the companion address and paste its token. Your browser may ask for local network permission. If it blocks HTTPS-to-loopback access, use the local dashboard instead.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OMP_BIN` | `omp` | Full path to an installed OMP executable when it is not on PATH |
| `OMP_WEB_PORT` | `4545` | Companion HTTP port |
| `OMP_WEB_DATA_DIR` | `~/.omp-web` | Persistent control-panel state, OMP sessions and worktrees |
| `OMP_ALLOWED_ORIGINS` | none | Comma-separated exact browser origins allowed to connect |
| `OMP_SESSIONS_DIR` | `<agent dir>/sessions` | OMP's native session store, listed under Recent OMP sessions |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | OMP agent directory; read for `config.yml`, `WATCHDOG.yml` and the default session store |
| `OMP_WEB_NO_OPEN` | unset | Set to skip opening the dashboard in a browser on start |

The companion binds only to `127.0.0.1`. Every API call requires a random per-launch bearer token. Host and Origin checks prevent arbitrary websites from controlling it. The API intentionally exposes a small set of session commands; raw shell commands are not an HTTP endpoint. OMP itself still has its normal coding tools and permissions, so prompts can edit files and run commands just as they do in the CLI.

## Tests

```sh
node --test "tests/*.test.mjs"
```

This repository contains the companion (`companion/`) and the prebuilt dashboard (`local-dist/`). The frontend source and its build tooling are not included here; edit `local-dist/` directly or rebuild it from the frontend project.

## Verification and compatibility

The integration suite spawns deterministic NDJSON processes to exercise real HTTP authorization, concurrent process routing, actual Git worktrees, RPC rejection, cooperative stop, startup failure, persisted sessions, mid-stream restart ordering and asynchronous provider errors. Types and both production frontend builds are checked.

Protocol implementation was inspected against upstream commit `33f887a0c3970f17bd8147df25b73fd88a889353`, particularly `docs/rpc.md` and `packages/coding-agent/src/modes/rpc/rpc-types.ts`. It uses protocol v1 and bounded output, `--mode rpc-ui` for interactive questions, separate session directories, and the native session/task controls. It does not require an upstream fork.

Provider-backed turns are not covered by the deterministic integration suite. Browser visual and interaction QA covers the local question flow. Browser WebMCP tools, when supported, only list the visible workspace and open a conversation; they do not run prompts.

Current limits: no attachment to existing terminal processes, no automatic Git merge, no file-diff editor, and no custom extension TUI surfaces beyond RPC selection, confirmation, text and editor prompts. These are intentionally outside the control-panel scope.
