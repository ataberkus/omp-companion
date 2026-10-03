# Desktop app (Windows) — design

## Intent

The user asked for an installable Windows desktop app for OMP Control Room. It should replace the browser tab plus the `start.bat` console with an app window and a tray icon, and run the companion server inside the app.

Decisions made by the user:
- Real installable app, not an `--app`-mode browser window or a native rewrite.
- Windows only.
- Local only by default, with a tray toggle for phone/LAN access.
- Closing the window hides it to the tray; sessions keep running.
- Electron, with the server running in-process.

Success: installing the `.exe` gives a Start-menu app that opens the existing dashboard in its own window, with no console. Agents keep running while the window is hidden. Quitting stops OMP cleanly, and the existing `node companion/server.mjs` / `start.bat` / `node --test` flows keep working as they do today.

## Non-goals

- macOS/Linux builds, code signing, auto-update.
- Any change to the dashboard (`local-dist/`), or to `createCompanion()` in `companion/server.mjs`.
- Remembering the LAN toggle between launches.
- A native (non-web) UI.

## Files

| Path | Change |
| --- | --- |
| `package.json` | New, at the repo root. `"main": "desktop/main.mjs"`, `"private": true`. Dev dependencies: `electron` (>= 35, bundled Node >= 22), `electron-builder`. Scripts: `"desktop": "electron ."`, `"dist": "electron-builder --win nsis"`. Inline `build` config (below). |
| `desktop/main.mjs` | New. The whole shell: server boot, window, tray, LAN rebind, quit logic. |
| `desktop/links.mjs` | New. Pure, Electron-free: `phoneLinks(interfaces, port, token) → [{ label, url }]`, which builds the ordered **Copy phone link** entries from `os.networkInterfaces()` output. |
| `tests/desktop-links.test.mjs` | New. Covers `phoneLinks` ordering and filtering. |
| `desktop/icon.png` | New. 256×256 PNG rasterized once from `local-dist/favicon.svg`; used for the window, tray and installer. |
| `.gitignore` | Add `node_modules/` and `dist/`. |
| `README.md` | New "Desktop app" section: build, install, tray menu, LAN toggle, SmartScreen note, the "one companion at a time" rule. |
| `companion/server.mjs` | Add `export async function portBusy(port, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean>`, a connect probe: `true` if something answers or the connect hasn't resolved within the timeout, `false` on any error such as `ECONNREFUSED`. The CLI block calls it before `createCompanion()` and, if the port is busy, prints the existing "Port N is already in use" message and exits 1. `createCompanion()` is unchanged. (User decision: `start.bat` launched while the app sits in the tray would otherwise bind `0.0.0.0` next to it and pause and overwrite the app's sessions.) |
| `tests/port-busy.test.mjs` | New. Checks that `portBusy` is `true` for a port held on `0.0.0.0` and `false` once it's released. |

Placing `package.json` at the root keeps `desktop/`, `companion/` and `local-dist/` at the same relative paths in development and inside `app.asar`. `server.mjs` resolves its static root as `../local-dist` from `import.meta.url`, so it works unchanged. Its CLI block is guarded by `process.argv[1] === fileURLToPath(import.meta.url)` and therefore does not run when the module is imported.

### electron-builder config

```json
"build": {
  "appId": "dev.omp.control-room",
  "productName": "OMP Control Room",
  "directories": { "output": "dist" },
  "files": ["package.json", "desktop/**", "companion/**", "local-dist/**"],
  "win": { "target": "nsis", "icon": "desktop/icon.png" },
  "nsis": { "oneClick": true, "perMachine": false }
}
```

`files` is an explicit allowlist. Without it, `docs/` (about 95 MB of showreel video), `tests/` and `start.bat` would be packed into the installer. The installer is per-user and needs no admin rights. It is unsigned, so SmartScreen shows "Unknown publisher" on first run.

## Runtime behavior (`desktop/main.mjs`)

### Startup
1. `app.requestSingleInstanceLock()`. If the lock is not acquired, `app.exit(0)` immediately: the bootstrap runs only in the lock-holder branch, so a second instance never reaches `createCompanion`. The running instance handles `second-instance` by showing and focusing its window.
2. **Port probe before `createCompanion`.** `createCompanion()` marks `running`/`queued` sessions as `paused` and persists `workspace.json` (`server.mjs` lines 347 and 1105) before anything listens. Launching next to a live `start.bat` would therefore rewrite its sessions on disk. Also, Windows lets `127.0.0.1:N` and `0.0.0.0:N` bind side by side, so a bind can't detect `start.bat` (which binds `0.0.0.0`). So first call `portBusy(port)`, exported from `server.mjs`. If it returns `true`, show the error dialog ("The companion is already running on port N, probably start.bat. Close it and try again.") and quit. Do not fall back to another port. The CLI uses the same probe, so `start.bat` refuses to start while the app is running. Known limit: companions on *different* `OMP_WEB_PORT`s with the same data dir aren't detected; the README says to run one companion at a time.
3. `const companion = await createCompanion({ exposeToken: false })`, imported from `../companion/server.mjs`. The desktop app ignores `OMP_WEB_HOST` and `OMP_WEB_NO_TOKEN`. Other variables (`OMP_BIN`, `OMP_WEB_DATA_DIR`, `OMP_SESSIONS_DIR`, `PI_CODING_AGENT_DIR`, `OMP_ALLOWED_ORIGINS`) are read by `createCompanion` as usual.
4. Listen on `127.0.0.1` at port `Number(process.env.OMP_WEB_PORT || 4545)`, with no fallback port, so the "already running" check always targets the same address. The token is still generated per launch, so phone links last only until the app restarts; that is deliberate, because a stored token would keep a leaked link valid indefinitely. The startup `error` handler is attached with `once('error')` and removed on `listening`, so a later LAN rebind failure never reaches it. It covers the small race after the probe and any other listen error: show the message (the "already running" copy for `EADDRINUSE`) and quit.
5. If `createCompanion()` throws or `listen` fails for another reason, show an error dialog with the message and quit.

### Window
- `BrowserWindow` with no menu bar, the app icon, and default `webPreferences` (context isolation on, no node integration).
- Loads `http://127.0.0.1:<port>/#token=<token>`.
- Bounds (x, y, width, height, maximized) are saved to `app.getPath('userData')/window.json` on close and restored on launch.
- `setWindowOpenHandler`: URLs on the dashboard's own origin are allowed and open as new app windows. They inherit the token through `sessionStorage`, as the dashboard already expects. Any other `http(s)` URL goes to `shell.openExternal` and is denied in-app. All other schemes are denied.
- `will-navigate` to a foreign origin is blocked and handed to `shell.openExternal`.
- Downloads (such as the HTML export) use Electron's default Save dialog.
- `close`: unless `isQuitting` is set, `preventDefault()` and hide. The first time, show a tray balloon: "Still running in the tray."

### Tray
Icon, tooltip "OMP Control Room", menu:
- **Open**: shows and focuses the main window. Double-clicking the tray icon does the same.
- **Allow phones on my network**: a checkbox, off at every launch.
- **Copy phone link**: a submenu, enabled only in LAN mode, rebuilt each time LAN mode turns on. It has one item per non-internal IPv4 address, labeled `<adapter name> — <address>`. Private home/office ranges (`192.168.*`, then `10.*`) are listed first, and others (for example a WSL/Hyper-V `vEthernet` 172.x or a VPN address) after them. Clicking an item copies `http://<address>:<port>/#token=<token>`. With no IPv4 adapter, the submenu holds one disabled item: "No network address found".
- **Quit**: see Quitting.

### LAN toggle (rebind, never restart)
Toggling rebinds the same `companion.server`:

```js
server.closeAllConnections();
server.close(() => server.listen(port, lan ? '0.0.0.0' : '127.0.0.1'));
```

- It never calls `companion.close()`, which kills every runner and would stop live agents.
- The Host/Origin allowlist is recomputed from `server.address()` on every request (`server.mjs` around line 995), so it follows the new bind.
- The dashboard polls `/state`. Requests in flight during the rebind fail and the next poll recovers.
- The token stays required in LAN mode. Phones open the copied link, which carries the token in the URL fragment.
- The rebind attaches its own one-shot `error` handler. If binding `0.0.0.0` fails, rebind `127.0.0.1`, uncheck the item and show the error.
- The first LAN bind triggers the Windows Firewall prompt for the app; the README tells the user to allow private networks only.

### Quitting
- **Tray Quit:** count `companion.store.sessions` with status `running` or `queued`. If N > 0, show a confirm dialog: "N sessions are still working. Quit and stop them?" (Quit / Cancel). On Quit: set `isQuitting`, `await companion.close()` (freezes timers, marks running sessions paused, persists state, stops OMP processes), then `app.exit(0)`.
- **Windows logoff/shutdown** (`BrowserWindow` `session-end`): no dialog, because Windows kills the process a few seconds after `WM_ENDSESSION`. Set `isQuitting` and call `companion.close()` right away. `close()` runs `persist()` before waiting on runners, so state is saved early even if Windows kills the process mid-shutdown.
- Both paths go through one `quit({ confirm })` function, guarded so it runs once. `window-all-closed` is handled as a no-op, so closing extra dashboard windows (or hiding the main one) never quits the app.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Port in use (connect probe succeeds or times out) | Error dialog explaining that another companion is running; quit before `createCompanion` touches `workspace.json`. |
| `createCompanion` / listen error | Error dialog with the message; quit. |
| LAN bind fails | Revert to 127.0.0.1, uncheck the toggle, error dialog. |
| No LAN IPv4 for Copy phone link | Disabled "No network address found" submenu item. |
| OMP missing or outdated | Unchanged: handled by the dashboard and server as today. |

## Testing

- `node --test "tests/*.test.mjs"` stays green; `createCompanion()` is untouched.
- One new permanent test, `tests/desktop-links.test.mjs`. It checks that `192.168.*` comes before `10.*` and both come before 172.x/VPN addresses, that internal and IPv6 addresses are skipped, that labels read `<adapter> — <address>` and URLs carry `#token=`, and that no adapters gives an empty list. The rest of `main.mjs` is Electron wiring, verified by the smoke test.
- Smoke test with `npm run desktop`:
  1. The window opens the dashboard, already connected, with no console.
  2. Closing the window hides it to the tray, the balloon shows once, and tray Open restores it.
  3. A second launch focuses the existing window and shows no dialog.
  4. LAN toggle on: `GET http://<LAN IP>:<port>/api/state` with `Authorization: Bearer <token>` returns 200, and without it returns 401. The window keeps working. Toggle off: connections to the LAN IP are refused.
  5. Copy phone link lists every adapter, private ranges first, and the clicked item puts its URL on the clipboard.
  6. With a session running, tray Quit shows the confirm. Cancel keeps it running; Quit exits, and the session is persisted as paused and the OMP process is gone.
  7. With `start.bat` running (binds `0.0.0.0`) and one of its sessions working, launching the app shows the "already running" dialog. Afterwards `~/.omp-web/workspace.json` still has that session as `running`, not `paused`.
  8. Run a session that makes a bash tool call, then send a `!dir` command in the composer. No console window flashes up.
  9. With the app running (hidden in the tray), `start.bat` prints "Port 4545 is already in use" and stops. The app's sessions in `workspace.json` are unchanged.
- Packaging: `npm run dist` produces `dist/OMP Control Room Setup <version>.exe`. Install it, launch it from the Start menu and repeat checks 1, 2, 6 and 8. Check 8 is only conclusive here, because `npm run desktop` attaches Electron to the terminal's console. Confirm that the installer does not contain `docs/`.
