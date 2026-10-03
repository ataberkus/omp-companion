# Desktop App (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable Windows Electron app that runs the companion server in-process and shows the existing dashboard in its own window, with a tray icon, an optional LAN mode and a clean quit.

**Architecture:** `desktop/main.mjs` imports `createCompanion()` from `companion/server.mjs`, listens on `127.0.0.1:4545` and loads the dashboard with `#token=` into a `BrowserWindow`. Tray actions rebind the same `http.Server` for LAN mode and route quitting through `companion.close()`. `desktop/links.mjs` is the only unit-tested logic (phone-link ordering). The server and dashboard are not modified.

**Tech Stack:** Electron `^44.5.1` (ESM main), electron-builder `^26.15.3` (NSIS), Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-03-desktop-app-design.md`

## Global Constraints

- Windows only. The installer is per-user NSIS (`oneClick: true`, `perMachine: false`) and unsigned.
- Electron's bundled Node is >= 22.
- `local-dist/**` and `createCompanion()` are NOT modified. `companion/server.mjs` only gains the exported `portBusy` and a guard in its CLI block (user decision).
- `build.files` is exactly `["package.json", "desktop/**", "companion/**", "local-dist/**"]`, and `directories.output` is `"dist"`.
- Desktop mode always binds `127.0.0.1` with a token at launch (`exposeToken: false`) and ignores `OMP_WEB_HOST` and `OMP_WEB_NO_TOKEN`.
- Port: `Number(process.env.OMP_WEB_PORT || 4545)`, with no fallback port.
- The LAN toggle never calls `companion.close()`; it only rebinds `companion.server`.
- Copy, verbatim from the spec: "The companion is already running on port N, probably start.bat. Close it and try again." · "Still running in the tray." · "N sessions are still working. Quit and stop them?" · "No network address found" · tray items "Open", "Allow phones on my network", "Copy phone link", "Quit".
- `node --test "tests/*.test.mjs"` stays green.

## Review Focus

1. **Startup listen error vs. LAN rebind error.** A failed `0.0.0.0` bind must revert to `127.0.0.1` and must not show the "already running" dialog or quit. Pinned by smoke check T3-4b (force the failure by holding `0.0.0.0:<port>` from another process; a helper on a specific IP does not block a wildcard bind on Windows).
2. **The window hides when the user closes it, and quits when the app is quitting.** If `isQuitting` isn't set before `companion.close()`, quitting hangs with a hidden window. If it is set too early, close-to-tray quits the app. Pinned by T3 and T4 smoke checks.
3. **Busy count.** Only `running` and `queued` sessions count, not `review` or `paused`. A wrong filter either nags on every quit or kills agents silently. Pinned by T4-3 (one session in `review`: no prompt).
4. **Same-origin popup windows.** "Open in new tab" in the dashboard must open a connected app window, not the system browser, which has no token. Pinned by T1-4.
5. **Launching next to a live `start.bat`.** `createCompanion()` pauses and persists sessions before `listen`, and Windows allows `127.0.0.1:N` and `0.0.0.0:N` to bind side by side. So the app must stop at the connect probe, before `createCompanion`, or it rewrites `start.bat`'s working sessions as `paused` on disk. Pinned by T1-3. (Phone-link ordering, the previous item 5, is already covered by the T2 unit test.)

---

### Task 1: Electron shell boots the companion into a window

**Files:**
- Create: `package.json`, `desktop/main.mjs`, `desktop/icon.png`, `tests/port-busy.test.mjs`
- Modify: `.gitignore`, `companion/server.mjs` (new export, plus the CLI block at the end of the file)

**Interfaces:**
- Produces in `companion/server.mjs`: `export async function portBusy(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean>`.
- Produces in `desktop/main.mjs` (module scope, used by Tasks 3–4): `companion` (return value of `createCompanion`), `port: number`, `win: BrowserWindow`, `let isQuitting = false`, `showWindow(): void` (show, restore if minimized, focus).

- [ ] **Step 1: Write the failing test** `tests/port-busy.test.mjs`. Hold a `net` server on `0.0.0.0` at an ephemeral port (`listen(0, '0.0.0.0')`, read `address().port`). Assert `await portBusy(p) === true`. Close it, then assert `await portBusy(p) === false`.
- [ ] **Step 2: Run** `node --test tests/port-busy.test.mjs`. Expected: FAIL (`portBusy` is not exported).
- [ ] **Step 3: Implement `portBusy`** in `server.mjs`. `net.connect(port, host)`: `connect` → `true`; `error` → `false`; a `timeoutMs` timer → `true`. Destroy the socket and clear the timer in every case. In the CLI block, `if (await portBusy(port))`, print the existing `EADDRINUSE` message (factor that string into one const shared with the `server.on('error')` handler) and `process.exit(1)`. This must happen **before** `createCompanion()`, which means moving the `port` const above it.
- [ ] **Step 4: Run** `node --test tests/port-busy.test.mjs`. Expected: PASS. Smoke: with `node companion/server.mjs` already running, a second `node companion/server.mjs` prints "Port 4545 is already in use" and exits 1.
- [ ] **Step 5: Create `package.json`.** `name: "omp-control-room"`, `version: "1.0.0"`, `private: true`, `type: "module"`, `main: "desktop/main.mjs"`. Scripts: `"desktop": "electron ."`, `"dist": "electron-builder --win nsis"`. devDependencies: `electron@^44.5.1`, `electron-builder@^26.15.3`. Include the `build` block verbatim from the spec. Run `npm install`. Add `dist/` to `.gitignore`; `node_modules/` is already there.
  - `type: "module"` must not break the tests: they are already `.mjs` and `server.mjs` is ESM. Verify in Step 10.
- [ ] **Step 6: Create `desktop/icon.png` (256×256, transparent corners) from `local-dist/favicon.svg`.** Use a throwaway Electron script that is **not committed**. An offscreen `BrowserWindow` 256×256 with `transparent: true` loads an HTML string whose body is the SVG markup read from disk, inlined with `width=256 height=256`. (A `data:` page can't load `file://` subresources.) Then `capturePage()` → `.resize({ width: 256, height: 256 })` (display scaling returns device pixels) → `toPNG()` → write the file. Expected: a 256×256 PNG with the gradient square and "π".
- [ ] **Step 7: Implement startup in `desktop/main.mjs`.**
  - `if (!app.requestSingleInstanceLock()) app.exit(0); else bootstrap();`, so the second instance never reaches `createCompanion`. On `second-instance`, call `showWindow()`.
  - `bootstrap()`: `await app.whenReady()`. If `await portBusy(port)` (imported from `server.mjs`), show `dialog.showErrorBox` with the verbatim "already running" copy and call `app.exit(1)`. Only after that, call `createCompanion({ exposeToken: false })`, then `companion.server.listen(port, '127.0.0.1')`.
  - Attach `server.once('error', onStartError)`; on `listening`, remove it with `server.off('error', onStartError)`.
  - `onStartError`: for `EADDRINUSE`, show the same "already running" copy; otherwise show the message. Then `app.exit(1)`. Wrap `createCompanion` in try/catch with the same dialog-and-exit.
  - `Menu.setApplicationMenu(null)`.
- [ ] **Step 8: Implement the window.**
  - `new BrowserWindow({ icon, show: false, ...savedBounds })`. On `ready-to-show`, call `show()`, and `maximize()` if saved.
  - Load `http://127.0.0.1:${port}/#token=${companion.token}`.
  - Bounds file: `path.join(app.getPath('userData'), 'window.json')` with `{ x, y, width, height, maximized }`. Write it on the window's `close`, using `getNormalBounds()`. Ignore a missing or corrupt file.
  - `webContents.setWindowOpenHandler(({ url }))`:
    - If `new URL(url).origin === origin`, return `{ action: 'allow' }`.
    - Else if the protocol is `http:` or `https:`, call `shell.openExternal(url)` and return `{ action: 'deny' }`.
    - Otherwise return `{ action: 'deny' }`.
  - Apply the same handler to child windows through `app.on('web-contents-created')` so popups follow the rules too, along with a `will-navigate` guard that does `preventDefault()` plus `openExternal` for foreign origins.
- [ ] **Step 9: Smoke test** with `npm run desktop`:
  - **T1-1:** the window shows the dashboard, already connected (session list loads, no token prompt), and no console window appears.
  - **T1-2:** a second `npm run desktop` exits with no dialog and focuses the first window.
  - **T1-3:** start `start.bat` (it binds `0.0.0.0:4545`) and give one of its sessions a long-running prompt. While it works, run `npm run desktop`. Expect the "already running" dialog and an exit. Right afterwards, `~/.omp-web/workspace.json` still shows that session with `"status": "running"`. Then repeat with plain `node companion/server.mjs` (`127.0.0.1`): same dialog.
  - **T1-4:** "Open in new tab" on a session opens a connected app window.
  - **T1-5:** a Markdown link to `https://example.com` opens in the system browser.
  - **T1-6:** with the app running, `start.bat` prints "Port 4545 is already in use" and stops.
  - Verify with `computer` screenshots.
- [ ] **Step 10: Run the tests.** `node --test "tests/*.test.mjs"`. Expected: all pass.
- [ ] **Step 11: Commit:** `git add package.json package-lock.json .gitignore desktop/ companion/server.mjs tests/port-busy.test.mjs && git commit -m "Add Electron desktop shell"`

### Task 2: `phoneLinks` (pure, tested)

**Files:**
- Create: `desktop/links.mjs`, `tests/desktop-links.test.mjs`

**Interfaces:**
- Produces: `export function phoneLinks(interfaces: Record<string, os.NetworkInterfaceInfo[]>, port: number, token: string): { label: string, url: string }[]`

- [ ] **Step 1: Write the failing test** `tests/desktop-links.test.mjs` (`node:test` + `node:assert/strict`). Input:
  - `{'vEthernet (WSL)':[{family:'IPv4',address:'172.20.0.1',internal:false}], 'Wi-Fi':[{family:'IPv6',address:'fe80::1',internal:false},{family:'IPv4',address:'192.168.1.20',internal:false}], 'Corp VPN':[{family:'IPv4',address:'10.8.0.5',internal:false}], 'Loopback':[{family:'IPv4',address:'127.0.0.1',internal:true}]}`
  - port `4545`, token `'abc'`.

  Assert deep-equal:
  ```js
  [{label:'Wi-Fi — 192.168.1.20',url:'http://192.168.1.20:4545/#token=abc'},
   {label:'Corp VPN — 10.8.0.5',url:'http://10.8.0.5:4545/#token=abc'},
   {label:'vEthernet (WSL) — 172.20.0.1',url:'http://172.20.0.1:4545/#token=abc'}]
  ```
  Also assert that `phoneLinks({}, 4545, 'abc')` deep-equals `[]`.
- [ ] **Step 2: Run** `node --test tests/desktop-links.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Rank 0 for `192.168.`, 1 for `10.`, 2 for everything else. Use a stable sort by rank, which keeps adapter order within a rank. Skip `internal` and non-IPv4 entries. `family` can be the string `'IPv4'` (and is the number `4` on some older Node versions), so accept both.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `git add desktop/links.mjs tests/desktop-links.test.mjs && git commit -m "Add phone link ordering for desktop tray"`

### Task 3: Tray, hide-to-tray, LAN rebind

**Files:**
- Modify: `desktop/main.mjs`

**Interfaces:**
- Consumes: Task 1 module state; `phoneLinks` from Task 2.
- Produces: `rebuildTrayMenu(): void`; `let lan = false`.

- [ ] **Step 1: Hide to tray.**
  - On the main window's `close`: if `!isQuitting`, call `e.preventDefault()` and `win.hide()`. The first time only, call `tray.displayBalloon({ title: 'OMP Control Room', content: 'Still running in the tray.' })`.
  - `app.on('window-all-closed', () => {})` (no-op).
- [ ] **Step 2: Tray.**
  - `new Tray(iconPath)`, tooltip `OMP Control Room`. `double-click` calls `showWindow()`.
  - `rebuildTrayMenu()` builds: Open · checkbox "Allow phones on my network" (`checked: lan`) · "Copy phone link" submenu (`enabled: lan`) · separator · Quit.
  - Submenu items come from `phoneLinks(os.networkInterfaces(), port, companion.token)`; clicking one calls `clipboard.writeText(url)`. If the list is empty, show one item `{ label: 'No network address found', enabled: false }`.
  - Quit calls `quit({ confirm: true })` from Task 4. Until Task 4 lands, it calls `app.quit()` as a placeholder that Task 4 replaces.
- [ ] **Step 3: Implement `setLan(on: boolean): Promise<void>`** (an algorithm the spec pins):
  ```js
  const bind = host => new Promise((resolve, reject) => {
    const s = companion.server;
    s.closeAllConnections();
    s.close(() => { s.once('error', reject); s.listen(port, host, () => { s.off('error', reject); resolve(); }); });
  });
  try { await bind(on ? '0.0.0.0' : '127.0.0.1'); lan = on; }
  catch (e) { await bind('127.0.0.1').catch(() => {}); lan = false; dialog.showErrorBox('Could not change network access', e.message); }
  rebuildTrayMenu();
  ```
- [ ] **Step 4: Smoke test** with `npm run desktop`:
  - **T3-1:** close the window. It hides, the balloon appears once, and the app is still in the tray. Tray Open restores it. Close it again: no second balloon.
  - **T3-2:** toggle LAN on. Allow the Windows Firewall prompt for private networks.
  - **T3-3:** run `curl -s -o NUL -w "%{http_code}" -H "Authorization: Bearer <token>" http://<192.168 IP>:4545/api/state` and expect `200`. Without the header, expect `401`. Read the token from the copied link. The dashboard window keeps updating.
  - **T3-4:** the Copy phone link submenu lists `192.168.*` first, and clicking an entry puts that URL on the clipboard.
  - **T3-4b:** with LAN off, run `node -e "require('net').createServer().listen(4545,'0.0.0.0')"`. This works next to the app's `127.0.0.1:4545` on Windows, and makes the app's `0.0.0.0:4545` rebind fail with `EADDRINUSE`. Toggle LAN on and expect the "Could not change network access" dialog (not "already running"), the checkbox unchecked, the app still running and the window still connected. Stop the helper.
  - **T3-5:** toggle LAN off. The curl command to the LAN IP fails to connect.
- [ ] **Step 5: Commit:** `git commit -am "Desktop: tray, hide to tray, LAN rebind"`

### Task 4: Quit flow and logoff

**Files:**
- Modify: `desktop/main.mjs`

**Interfaces:**
- Consumes: `companion.store.sessions`, `companion.close()`, `isQuitting`.
- Produces: `quit({ confirm }: { confirm: boolean }): Promise<void>`

- [ ] **Step 1: Implement `quit`.** It is guarded by a module-level `quitting` promise, so a second call returns the same promise.
  - `const busy = companion.store.sessions.filter(s => s.status === 'running' || s.status === 'queued').length`.
  - If `confirm && busy`, call `dialog.showMessageBox(win, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, message: `${busy} sessions are still working. Quit and stop them?` })`. On Cancel, reset the guard and return. (Use the singular "session is" when `busy === 1`.)
  - Then set `isQuitting = true`, `tray.destroy()`, `await companion.close()`, `app.exit(0)`.
  - Replace the tray Quit placeholder from Task 3 with `quit({ confirm: true })`.
- [ ] **Step 2: Logoff/shutdown.** `win.on('session-end', () => quit({ confirm: false }))`.
- [ ] **Step 3: Smoke test** with `npm run desktop`:
  - **T4-1:** start a session with a long prompt, for example "count slowly to 200 using bash sleep 1 between numbers". While it works, tray Quit shows the prompt. Cancel: the session keeps running.
  - **T4-2:** quit again and confirm. The app exits, no `omp`/`bun` child of the app remains (`tasklist`), and `~/.omp-web/workspace.json` shows the session `status: "paused"`.
  - **T4-3:** with only a `review`-state session, tray Quit exits without a prompt.
  - **T4-4:** during T4-1's run, the bash tool calls cause no console window flashes. Then send `!dir` from the composer: no console flash, and its output appears in the chat. Watch with `computer` screenshots during the run.
- [ ] **Step 4: Commit:** `git commit -am "Desktop: confirmed quit and clean logoff shutdown"`

### Task 5: Installer and README

**Files:**
- Modify: `README.md` (new `## Desktop app` section after "Quick start")

- [ ] **Step 1: Build.** `npm run dist`. Expected: `dist/OMP Control Room Setup 1.0.0.exe`.
- [ ] **Step 2: Inspect the package.** `npx asar list "dist/win-unpacked/resources/app.asar"`. Expected: only `package.json`, `desktop/`, `companion/` and `local-dist/` paths, with no `docs/`, `tests/` or `start.bat`. The installer is under 150 MB.
- [ ] **Step 3: Install and smoke test.** Run the installer and launch "OMP Control Room" from the Start menu. Repeat T1-1, T3-1, T4-2 and T4-4. T4-4 (no console flashes) is only conclusive here, because `npm run desktop` attaches Electron to the terminal's console.
- [ ] **Step 4: README section** containing:
  - Build steps: `npm install`, `npm run dist`, run the installer; `npm run desktop` for development.
  - Tray menu items.
  - Closing the window hides it to the tray; Quit stops OMP after a confirmation when sessions are working.
  - LAN toggle: token still required, Copy phone link, allow the firewall prompt for private networks only.
  - "Run either the desktop app or `start.bat`, not both: they share `~/.omp-web`."
  - The SmartScreen "Unknown publisher" note.
  - `OMP_BIN` and the other variables still apply; `OMP_WEB_HOST` and `OMP_WEB_NO_TOKEN` are ignored.
- [ ] **Step 5: Commit:** `git add README.md && git commit -m "Document the desktop app"`
