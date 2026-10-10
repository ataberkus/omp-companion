<p align="center"><img src="docs/banner.svg" alt="OMP Control Room" width="100%"/></p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-22%2B-8b5cf6?style=flat-square&labelColor=09090b"/>
  <img alt="Runs locally on 127.0.0.1" src="https://img.shields.io/badge/runs-locally-ec4fbf?style=flat-square&labelColor=09090b"/>
  <img alt="No build step" src="https://img.shields.io/badge/build-none-3fd0e6?style=flat-square&labelColor=09090b"/>
</p>

**One browser tab for all your [oh-my-pi](https://github.com/can1357/oh-my-pi) sessions.** Run, watch and review OMP agents across many projects without juggling terminals.

<!-- Animated preview (plays inline, no sound). For a real player with sound, upload the MP4 through GitHub's web editor and put the resulting https://github.com/user-attachments/assets/... URL on its own line here. -->
<p align="center"><img src="docs/showreel.webp" alt="30-second showreel of OMP Control Room: sessions sidebar, chat, diffs, live plan, composer and more" width="100%"/></p>

![A session ready for review: chat with rendered Markdown, a folded activity summary, and the plan panel](docs/screenshots/dashboard-session.png)

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/dashboard-diff.png" alt="Side-by-side diff of every file the session changed"/></td>
    <td width="50%"><img src="docs/screenshots/dashboard-home.png" alt="New session screen with recent folders and sessions to pick up"/></td>
  </tr>
  <tr>
    <td align="center"><sub>Review every change as a unified or split diff</sub></td>
    <td align="center"><sub>Start a session in any folder in two keystrokes</sub></td>
  </tr>
</table>

## Features

- **Every session in one sidebar**, including ones you started in a terminal, grouped by *Working now*, *Needs your review*, *Today* and older, or by project (▤); click a group's heading to collapse it. Search it (`/`), filter by *All*, *Active*, *In panel* or *Archived*, archive and restore sessions, and open one in a new tab (middle-click or right-click).
- **New session screen** (**Alt+N**): pick a recent folder, paste a path or browse subfolders with a filter, then type the first prompt. *Pick up where you left off* lists your latest sessions. Sessions from OMP history can be added to the panel without sending a message.
- **Continuous work timers:** the sidebar shows **Running** elapsed time, then the frozen **Last run** duration, using hours, minutes and seconds for long runs (e.g. `1h 5m 19s`). Steering, queued continuations, question prompts, retries and background waits stay in the same interval; hover for exact start/end times.
- **Readable conversations:** Markdown, tables and code blocks with copy. Tool calls and thinking fold into one activity summary.
- **GitHub-style diffs** with word-level highlights, in unified or split view; **± N files changed** in the top bar reviews every file a session touched.
- **Live plan and activity panel** for todos, subagents with expandable live reasoning, background jobs and advisor transcripts; **Watch →** (subagents) and **Open transcript →** (advisors) open the full transcript.
- **Native plan mode:** enable read-only planning before your first prompt (**Alt+Shift+P**), review the proposed Markdown plan, request refinement, or approve implementation with the current, fresh or compacted context. Requires an OMP build with plan-mode RPC support.
- **Native goal mode:** `/goal` opens an objective prompt or the current goal's controls; start autonomous work, replace an objective, pause/resume, set a token budget, or confirm dropping it. Requires an OMP build with goal-mode RPC support.
- **Smart composer:** send, steer a running turn (edit or cancel a steer until OMP reads it), queue follow-ups, attach images (button, paste or drag and drop), switch model or reasoning level from a searchable picker with favourites (Ctrl+P cycles configured default/smol/slow roles), toggle fast mode (⚡ chip, shown only for models with a priority service tier: Anthropic, OpenAI/Codex, Google, and their OpenRouter variants) in new and live sessions, use the ⚑ advisor menu to turn the advisor on or off (also before continuing a session from OMP history, applied before the first message), change its model, open its transcript, and filter its output in the chat (hide all while it keeps running, show reviews, important notes only), complete `/commands` in both new and live sessions (find skills by name, e.g. `/front` completes to `/skill:frontend-design`), complete the current word with Tab from OMP's local word predictor (n-gram or the tiny SmolLM2 model), rewrite the draft with **✨ Enhance** (below), and run `!command` in the session's shell.
- **Enhance prompt:** **✨** (or **Ctrl+Shift+E**) in every composer (live sessions, New session, and continuing a session from OMP history) rewrites your draft into a concrete prompt. Each click is one read-only `omp -p` run limited to read/grep/glob; it uses the repo's `AGENTS.md`/`CLAUDE.md`, the conversation tail and attached images to name real files and symbols. The draft is replaced in place, with **Undo** in the toast or Ctrl+Z; nothing is sent automatically, and **✕** cancels a run. The model is OMP's `enhance` role if set, otherwise the composer's model at the reasoning level set under *Settings › Enhance* (default low). On New session it creates a draft session, discarded if you leave without sending.
- **Provider usage in chat:** `/usage` (or **◔ Usage** in the top bar) shows the selected model's provider quotas, remaining percentages and amounts, and reset times for every reported account. It works during a running turn without steering it or queueing another prompt.
- **Answer OMP's questions** (`ask` tool and extension prompts) directly in the browser. Sessions with unanswered questions move to *Needs your review* until the last question is answered or cancelled, then return to their current work state. Extension notifications, status lines, widgets and sign-in links appear in the chat.
- **Session tools:** rename, browse the full **session tree**, copy the last reply, cycle OMP's model and thinking level, export as HTML, share a link, session stats, commit the folder's changes, provider login, copy the working directory or `omp --resume` command, and **✓ Mark done**. While idle: branch from an earlier message, hand off to a fresh context, compact with optional instructions, start a fresh OMP session (`/new`), switch the entry to another saved session, or remove it from the panel. Per-session toggles cover fast mode, auto-compaction, auto-retry and steer/follow-up delivery (*Deliver all steers at once*, *Send all queued follow-ups together*, *Hold steers until the turn ends*).
- **Stop & send:** while OMP is working, **■ Stop & send** cancels the current turn and sends your message in its place. Plain Enter still steers; Ctrl+Enter, Alt+Enter or Ctrl+Q queue it for after the turn.
- **Hotkeys:** *Settings › Hotkeys* sets the composer keys for **Queue** and **Stop & send** (comma-separated, e.g. `Ctrl+Enter, Alt+Q`; empty turns one off). A combo is Ctrl, Alt or Meta (plus optional Shift) and a letter, digit or key name such as Enter, Space, Tab, Up, Down or Esc. Letters follow your keyboard layout; when a combo types something else (Option+letter on a Mac, non-Latin layouts) the key's position counts instead. The dashboard's own shortcuts (Ctrl+P, Ctrl+Shift+E, Alt+Shift+P, Alt+↑/↓, Alt+N) can't be reused. They're saved in this browser. Some browsers keep Ctrl+Q / Cmd+Q for themselves (Firefox on Linux, macOS), so use another combo there.
- **Prompt rail:** the thin strip right of the chat has one tick per prompt you sent, placed where it sits in the conversation. Hover a tick to preview the prompt, click to jump to it; **Alt+↑ / Alt+↓** step to the previous / next prompt. The highlighted tick is the prompt you're reading.
- **Editable task plan:** click a task's status icon in the Plan panel to cycle pending → in progress → done (or *Clear task plan*). Changes go to OMP's own todo list.
- **Launch options:** **⚙ Options** in the new-session composer and *Launch options…* in a session menu set OMP's startup flags: approval mode, tool and skill allowlists, extra folders (`--add-dir`), max run time, model roles (smol/slow/plan), plan-yolo, prewalk, system-prompt overrides, and switches such as no LSP, no rules or no extensions. Changing them restarts an idle session's OMP process.
- **Live feedback:** streaming tool output, retry progress with a *Stop retrying* button, fallback-model switches, extension errors and goals.
- **Settings UI** for every `omp config` value and for plugins, plus one-click `omp update`.
- **Tools page** (🧰 in the sidebar) for OMP's command-line tools: AI `commit` (dry run by default), `worktree`, usage `stats`, `share`, the skills registry, advanced `plugin` maintenance, `agents unpack`, background processes (`ps`), storage cleanup (`gc`, dry run unless *Apply*), `ssh` hosts, optional-feature `setup`, `tiny-models`, semantic `find` and tool `grievances`. Commands run in the background with live output and a Stop button; arguments are validated and never pass through a shell.
- **Spend page** ($ in the sidebar): dollar cost per model for today, this month and all time, plus this month day by day. Figures come from OMP's usage stats (`~/.omp/stats.db`, synced via `omp stats` on each load) and are API list prices, so subscription/OAuth usage shows what it would have cost, not what you were billed.
- **Isolated git worktrees** so parallel sessions don't overwrite each other's files.

## Quick start

Requires **Node.js 22+** and a working OMP install (`omp --version` works and a model provider is configured).

```sh
node companion/server.mjs
```

On Windows you can double-click `start.bat` instead.

The dashboard opens in your browser, already connected. Press **Alt+N** (or click **New session**), pick a folder, type a prompt and press Enter. Keep the companion terminal open while you work.

With **Group by project** enabled, click **+** beside a workspace's session count to open **New session** with that folder already selected.

Type `/` in the composer to browse commands and skills. Use ↑/↓ to select, Tab or Enter to complete a partial name, and Esc to dismiss; clicking an option also completes it. On **New session**, the catalog follows the selected folder, including its local skills and commands, without creating a saved session.

While you type in a session's composer, OMP's word predictor shows the rest of the current word in faint text. **Tab** accepts it and **Esc** dismisses it. Keep typing to ignore it. Suggestions only appear while the session's OMP process is running, and only for prose: not for slash commands, `!` shell lines or paths. The engine follows OMP's `spelling.autocomplete` setting (*Settings*). The default `auto` uses a local n-gram model built from your prompt history. For the tiny SmolLM2-135M model, download `smollm` under *Tools › Tiny local models*, then set `spelling.autocomplete` to `smollm`. `off` turns suggestions off. Changes apply to running sessions immediately. The first suggestion after a switch can take a few seconds while OMP loads the model.

Press **✨** (or **Ctrl+Shift+E**) with a draft in the composer to enhance it. The enhancer looks up at most six things in the code; while it runs the composer is read-only and the status line names the model in use. If you edit the draft before it finishes, the result isn't applied and the toast offers **Use enhanced prompt** instead. *Settings › Enhance* picks the model: **Composer's model** (the default), or a model you choose, saved with its own reasoning level as OMP's `enhance` model role (pick something fast and cheap). With a role set, the *Reasoning level* row edits the role's level; a role saved without one runs at OMP's default level, so pick one. The enhancer can read, search and list files but cannot write, run commands, save skills or memories, or use MCP servers.

On **New session**, Enhance starts the session in the picked folder right away and moves your draft and images into it. Until you send its first message it is a *draft* session: going back to New session, picking another folder or opening another session removes it again, including its OMP process and, if you ticked *Isolated git worktree*, its worktree and branch. Settings, Tools and Spend don't count as leaving.

During a running turn, Enter or **Run** dispatches slash commands instead of steering their literal text. Local controls leave the current turn and unread ordinary steers intact. **Queue** / **Alt+Enter** still defers commands until the turn finishes; `/usage` is always immediate. Restart the companion and refresh the browser after updating.

Click **◔ Usage** in a session's top bar, or send `/usage` (or `/usage show`), to put a quota snapshot in the conversation. The selected model determines the provider; account, model and tier limits are labeled as reported, because a quota can be shared by several models. Snapshots include their fetch time and UTC reset timestamps. Providers without usage data show **Remaining quota unavailable**, not estimated remaining messages or a session-token total. This uses the configured OMP runtime's `usage --provider <id> --json` command.

## Desktop app (Windows)

The same dashboard in its own window, with the companion running inside the app: no console window, no browser tab.

```sh
npm install
npm run dist
```

Run `dist/OMP Control Room Setup <version>.exe`. It installs for your user only (no admin rights) and adds **OMP Control Room** to the Start menu. The installer is unsigned, so Windows SmartScreen may show *Unknown publisher* on first run: choose **More info → Run anyway**. For development, `npm run desktop` starts the app from this checkout.

- **Closing the window** hides it to the tray; sessions keep working. Open it again from the tray icon (double-click or **Open**) or by launching the app again.
- **Quit** (tray menu) stops the companion and every OMP process it started. If sessions are still working it asks first; they are saved as paused. Signing out or shutting Windows down quits without asking.
- **Allow phones on my network** (tray menu, off at every launch) makes the app reachable from your local network. The connection token stays required: use **Copy phone link** and pick the adapter your phone shares (usually `192.168.x.x`), then open the link on the phone. The token changes every time the app starts, so copy a fresh link after restarting it. Allow the Windows Firewall prompt for **private networks only**.
- **One companion at a time.** The desktop app and `start.bat` share `~/.omp-web`, so each refuses to start while the other is running on the same port.
- `OMP_BIN`, `OMP_WEB_PORT`, `OMP_WEB_DATA_DIR` and the other variables below still apply. `OMP_WEB_HOST` and `OMP_WEB_NO_TOKEN` are ignored: the app always starts on `127.0.0.1` with a token.

## Good to know

- **Don't continue a session in the panel while it's still open in a terminal.** Both would write to the same file.
- **Image attachments:** there is no fixed count. A message's text plus its images must fit the session's remaining context, estimated as about 4 characters per token and (width × height) / 750 tokens per image after a 1568 px / 1.15 MP downscale (at most ~1,530). The composer refuses an image that would overflow and says why; the companion checks again on send, and queued follow-ups sent together go one at a time when their total doesn't fit. Images over 1568 px are scaled down before upload, and one message's images may total up to 45 MB. When the context window is unknown (the *OMP default* model before the session starts, or models not loaded yet), only the upload size limits images.
- **Finished turns:** OMP's completed-and-settled result or idle state moves the session to **Ready for review**, even if the separate settled notification is missing. Unrelated command output no longer keeps a finished turn **Working**. Queued continuations stay in the same work interval, and stale or duplicate completion signals cannot finish the next run. Click **Mark done** after reviewing the result. Restart the companion and refresh the browser after updating.
- **Work timing:** counted from the agent's actual start until the session settles with no queued continuation. Stop, terminal failure or companion shutdown also freeze the timer; independent work starts a new interval. Durations persist across reloads and restarts, but past or terminal-only sessions have no invented timing. After updating, finish running work, restart the companion and refresh the browser.
- **Stopping retries:** **Stop** and **Stop retrying** cancel the active turn, including retry backoff and in-flight provider requests. The session returns to Idle, and queued follow-ups stay queued. Restart the companion after updating it, then refresh the browser.
- **Cancelling steers:** **Cancel** removes a steer only while OMP still has it queued. If delivery wins the click, the panel clears the stale controls and shows an informational notice instead of an error; the delivered message stays in the transcript. Restart the companion and refresh the browser after updating.
- **OpenCode Go multi-account limits:** the patched sibling OMP runtime tries another stored account for `429 Output token rate limit exceeded`, including advisor requests. Select it with `OMP_BIN` as shown below; updating the companion alone does not change an installed OMP executable. Generic backend `503` errors remain ordinary retry errors.
- **Subagent reasoning:** Activity cards stay compact so several running subagents fit at once: name, elapsed time and a **Watch →** link on top, then model, description and the live tool/intent line. Expand **Reasoning** to read the current thought; it follows new text until you scroll it and stays open while the panel updates. **Watch** updates the unfinished thought as it streams. Sessions running in a separate terminal only expose saved reasoning. After updating the companion, wait for running work to finish, restart it and refresh the browser.
- **Subagent cost:** the dollar amount on each Activity job covers that subagent's own transcript only, not subagents it started in turn.
- **Subagent reasoning level:** each Activity card shows the level next to the model, for example `Subagent · Claude Opus 5.5 · high · $1.72`. The level comes from the subagent's own transcript, so for `auto` it is the level OMP actually picked. It is left out until the transcript records one.
- **Plugins vs standalone skills:** disabling a plugin does not disable separately installed copies under folders such as `~/.agents/skills`. To disable a skill from every source, add its name (for example, `impeccable`) to `skills.ignoredSkills` in Settings. After plugin changes, use `/reload-plugins` or restart existing sessions. A skill already read remains in that conversation's history; start a new session to remove that context.
- **Worktrees:** tick **Isolated git worktree** when starting a session in a Git repo. You get an `omp-web/<id>` branch off HEAD. Uncommitted changes and dependencies are not copied. Worktrees are never merged or deleted automatically.
- **Not in the panel:** importing from Claude Code or Codex (`--from-claude`, `--from-codex`) needs OMP's terminal picker, and `--profile` sessions live in a separate store the panel does not list. Use the terminal for those, and for the interactive `omp stats` dashboard server and skill publishing.
- **Where data lives:** `~/.omp-web/` holds `workspace.json`, managed sessions and worktrees. Sessions started normally also appear in OMP's own store, so `omp --resume` works.
- **Security:** `node companion/server.mjs` listens only on `127.0.0.1`; `start.bat` opens it to your network with no token (see [Phone or tablet on your network](#phone-or-tablet-on-your-network)). It uses a random per-launch token and checks Host and Origin. Anyone with the token can run shell commands in a session's folder (`!command`, the same as OMP's own `!` prefix), and OMP keeps its usual tools and permissions. Unless `OMP_WEB_NO_TOKEN=1`, the token is printed in the companion's console and passed to your browser when it opens the dashboard; on a shared machine, set `OMP_WEB_NO_OPEN=1` and paste the link yourself. Sessions opened in a new tab share the token through the tab's session storage.

### Native plan mode

Click **Enable plan mode** before sending your task, or toggle it with **Alt+Shift+P**. `/plan` and `/plan-review` use OMP's native planning workflow, not a planning-only prompt or automatic approval.

The project stays read-only until you explicitly approve implementation or turn plan mode off. **Review plan** offers **Keep context**, **Fresh context**, **Compact context**, an optional execution model, and **Request refinement** with required feedback. Closing the review leaves it unapproved. Stale proposals must be reviewed again.

The installed OMP must expose `set_plan_mode`, `review_plan` and `approve_plan`. Older builds show **Requires updated OMP RPC support**; the companion does not simulate planning or silently approve it.

`start.bat` runs the patched sibling checkout (`..\oh-my-pi\packages\coding-agent\src\cli.ts`) automatically when it exists and Bun is on PATH; the checkout needs its dependencies, generated tool views and native bindings prepared. The console prints `Using OMP: …` when it does. Otherwise it falls back to `omp` on PATH.

Set `OMP_BIN` before `start.bat` to override, for example with a compiled OMP executable containing the same RPC changes. Restart companion sessions after changing the runtime.

### Native goal mode

Type `/goal` to open the objective prompt or manage the current goal. `/goal <objective>` starts work directly; `/goal set <objective>` replaces an active objective. `/goal show`, `/goal pause`, `/goal resume`, `/goal budget <N|off>` and `/goal drop` use OMP's native goal runtime. Dropping a goal requires confirmation in the browser.

Use an OMP build that advertises `/goal` over RPC and exposes `get_state.goalMode`, such as the patched sibling checkout configured above. Older builds reject `/goal` rather than send it to the model; `goal.enabled` must also be enabled. Command discovery starts an idle session's runner, but restored goals remain paused until you explicitly resume them.

In `rpc-ui`, automatic continuation follows `goal.continuationModes`'s `interactive` profile. It stops on completion, pause/drop, exhausted budget, blocked work, errors, or no progress.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_BIN` | `omp` (sibling `oh-my-pi` checkout via `start.bat`, if present with Bun) | OMP executable, or a prepared checkout's `cli.ts` (requires Bun) |
| `OMP_WEB_PORT` | `4545` | Companion port |
| `OMP_WEB_HOST` | `127.0.0.1` (`0.0.0.0` via `start.bat`) | Bind address; `0.0.0.0` opens it to your local network (see below) |
| `OMP_WEB_NO_TOKEN` | unset (`1` via `start.bat`) | `1` serves the token inside the page, so no device is asked for it |
| `OMP_WEB_DATA_DIR` | `~/.omp-web` | Panel state, sessions and worktrees |
| `OMP_SESSIONS_DIR` | `<agent dir>/sessions` | OMP's native session store |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | OMP agent directory (`config.yml`, `WATCHDOG.yml`) |
| `OMP_ALLOWED_ORIGINS` | none | Extra browser origins allowed to connect (see below) |
| `OMP_WEB_NO_OPEN` | unset | Don't open the browser on start |

### Hosted dashboard (optional)

The local dashboard is the most reliable option. To use the hosted one instead, allow its origin, then connect to `http://127.0.0.1:4545` with the printed token:

```sh
OMP_ALLOWED_ORIGINS=https://omp-control-room.ataberk-oztrk3.chatgpt.site node companion/server.mjs
```

Your browser may block HTTPS-to-localhost requests. If it does, use the local dashboard.

### Phone or tablet on your network

`start.bat` listens on every network adapter and doesn't ask for a token. The console prints a `LAN:` address per adapter (usually the `192.168.x.x` one); open it on a phone on the same Wi-Fi. Allow Node.js through Windows Firewall for private networks when prompted.

**Anyone on that network can open the address and run commands on this PC.** Use it only on networks you trust. To lock it back down to this PC with a token:

```bat
set OMP_WEB_HOST=127.0.0.1
set OMP_WEB_NO_TOKEN=0
start.bat
```

## Development

```sh
node --test "tests/*.test.mjs"
```

`companion/` is the Node server. `local-dist/` is the prebuilt dashboard, which you edit directly because the frontend source isn't in this repo. `desktop/` is the Electron shell that runs the companion in-process for the Windows app. The companion speaks OMP's RPC protocol (`--mode rpc-ui`, with protocol v2 framing when OMP offers it). Native plan and goal modes require the RPC support described above.

**Not supported:** attaching to already-running terminal sessions, automatic Git merges, and custom extension TUIs beyond select, confirm, text and editor prompts.
