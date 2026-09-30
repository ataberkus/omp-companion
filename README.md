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

- **Every session in one sidebar**, including ones you started in a terminal, grouped by *Working now*, *Needs your review*, *Today* and older.
- **Readable conversations:** Markdown, tables and code blocks with copy. Tool calls and thinking fold into one activity summary.
- **GitHub-style diffs** with word-level highlights, in unified or split view.
- **Live plan and activity panel** for todos, subagents with expandable live reasoning, background jobs and advisor transcripts.
- **Native plan mode:** enable read-only planning before your first prompt, review the proposed Markdown plan, request refinement, or approve implementation with the current, fresh or compacted context. Requires an OMP build with plan-mode RPC support.
- **Native goal mode:** `/goal` opens an objective prompt or the current goal's controls; start autonomous work, replace an objective, pause/resume, set a token budget, or confirm dropping it. Requires an OMP build with goal-mode RPC support.
- **Smart composer:** send, steer a running turn, queue follow-ups, attach images, switch model or reasoning level (Ctrl+P cycles configured default/smol/slow roles), complete `/commands` as you type (find skills by name, e.g. `/front` completes to `/skill:frontend-design`), and run `!command` in the session's shell.
- **Answer OMP's questions** (`ask` tool and extension prompts) directly in the browser. Sessions with unanswered questions move to *Needs your review* until the last question is answered or cancelled, then return to their current work state. Extension notifications, status lines, widgets and sign-in links appear in the chat.
- **Session tools:** rename, branch from an earlier message, hand off to a fresh context, export as HTML, session stats, provider login, and per-session toggles for fast mode, auto-compaction, auto-retry and steering behaviour.
- **Live feedback:** streaming tool output, retry progress with a *Stop retrying* button, fallback-model switches, extension errors and goals.
- **Settings UI** for every `omp config` value and for plugins, plus one-click `omp update`.
- **Isolated git worktrees** so parallel sessions don't overwrite each other's files.

## Quick start

Requires **Node.js 22+** and a working OMP install (`omp --version` works and a model provider is configured).

```sh
node companion/server.mjs
```

On Windows you can double-click `start.bat` instead.

The dashboard opens in your browser, already connected. Press **Alt+N** (or click **New session**), pick a folder, type a prompt and press Enter. Keep the companion terminal open while you work.

## Good to know

- **Don't continue a session in the panel while it's still open in a terminal.** Both would write to the same file.
- **Subagent reasoning:** the Activity card shows the current thought in an expandable, scrollable **Reasoning** section. **Watch subagent** updates the unfinished thought as it streams. Sessions running in a separate terminal only expose saved reasoning. After updating the companion, wait for running work to finish, restart it and refresh the browser.
- **Worktrees:** tick **Isolated git worktree** when starting a session in a Git repo. You get an `omp-web/<id>` branch off HEAD. Uncommitted changes and dependencies are not copied. Worktrees are never merged or deleted automatically.
- **Where data lives:** `~/.omp-web/` holds `workspace.json`, managed sessions and worktrees. Sessions started normally also appear in OMP's own store, so `omp --resume` works.
- **Security:** the companion listens only on `127.0.0.1`. It uses a random per-launch token and checks Host and Origin. Anyone with the token can run shell commands in a session's folder (`!command`, the same as OMP's own `!` prefix), and OMP keeps its usual tools and permissions.

### Native plan mode

Click **Enable plan mode** before sending your task, or toggle it with **Alt+Shift+P**. `/plan` and `/plan-review` use OMP's native planning workflow, not a planning-only prompt or automatic approval.

The project stays read-only until you explicitly approve implementation or turn plan mode off. **Review plan** offers **Keep context**, **Fresh context**, **Compact context**, an optional execution model, and **Request refinement** with required feedback. Closing the review leaves it unapproved. Stale proposals must be reviewed again.

The installed OMP must expose `set_plan_mode`, `review_plan` and `approve_plan`. Older builds show **Requires updated OMP RPC support**; the companion does not simulate planning or silently approve it.

To run the patched sibling checkout on Windows, with Bun on PATH and the checkout's dependencies, generated tool views and native bindings prepared:

```bat
set "OMP_BIN=%CD%\..\oh-my-pi\packages\coding-agent\src\cli.ts"
start.bat
```

`OMP_BIN` can also point to a compiled OMP executable containing the same RPC changes. Restart companion sessions after changing the runtime.

### Native goal mode

Type `/goal` to open the objective prompt or manage the current goal. `/goal <objective>` starts work directly; `/goal set <objective>` replaces an active objective. `/goal show`, `/goal pause`, `/goal resume`, `/goal budget <N|off>` and `/goal drop` use OMP's native goal runtime. Dropping a goal requires confirmation in the browser.

Use an OMP build that advertises `/goal` over RPC and exposes `get_state.goalMode`, such as the patched sibling checkout configured above. Older builds reject `/goal` rather than send it to the model; `goal.enabled` must also be enabled. Command discovery starts an idle session's runner, but restored goals remain paused until you explicitly resume them.

In `rpc-ui`, automatic continuation follows `goal.continuationModes`'s `interactive` profile. It stops on completion, pause/drop, exhausted budget, blocked work, errors, or no progress.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_BIN` | `omp` | OMP executable, or a prepared checkout's `cli.ts` (requires Bun) |
| `OMP_WEB_PORT` | `4545` | Companion port |
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

## Development

```sh
node --test "tests/*.test.mjs"
```

`companion/` is the Node server. `local-dist/` is the prebuilt dashboard, which you edit directly because the frontend source isn't in this repo. The companion speaks OMP's RPC protocol (`--mode rpc-ui`, with protocol v2 framing when OMP offers it). Native plan and goal modes require the RPC support described above.

**Not supported:** attaching to already-running terminal sessions, automatic Git merges, and custom extension TUIs beyond select, confirm, text and editor prompts.
