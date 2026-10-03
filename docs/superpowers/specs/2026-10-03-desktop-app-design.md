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
- Any change to the dashboard (`local-dist/`) or the server (`companion/server.mjs`).
- Remembering the LAN toggle between launches.
- A native (non-web) UI.

## Files

| Path | Change |
| --- | --- |
| `package.json` | New, at the repo root. `"main": "desktop/main.mjs"`, `"private": true`. Dev dependencies: `electron` (>= 35, bundled Node >= 22), `electron-builder`. Scripts: `"desktop": "electron ."`, `"dist": "electron-builder --win nsis"`. Inline `build` config (below). |
| `desktop/main.mjs` | New. The whole shell: server boot, window, tray, LAN rebind, quit logic. |
| `desktop/icon.png` | New. 256×256 PNG rasterized once from `local-dist/favicon.svg`; used for the window, tray and installer. |
| `.gitignore` | Add `node_modules/` and `dist/`. |
| `README.md` | New "Desktop app" section: build, install, tray menu, LAN toggle, SmartScreen note, the "one companion at a time" rule. |
| `companion/server.mjs` | Unchanged. |

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
1. `app.requestSingleInstanceLock()`. If the lock is not acquired, quit. The running instance handles `second-instance` by showing and focusing its window.
2. `const companion = await createCompanion({ exposeToken: false })`, imported from `../companion/server.mjs`. The desktop app ignores `OMP_WEB_HOST` and `OMP_WEB_NO_TOKEN`. Other variables (`OMP_BIN`, `OMP_WEB_DATA_DIR`, `OMP_SESSIONS_DIR`, `PI_CODING_AGENT_DIR`, `OMP_ALLOWED_ORIGINS`) are read by `createCompanion` as usual.
3. Listen on `127.0.0.1` at port `Number(process.env.OMP_WEB_PORT || 4545)`. The port is fixed so phone links stay valid across launches.
4. On `EADDRINUSE`, do not fall back to another port. A second companion with the same data dir would overwrite `workspace.json`. Show an error dialog ("The companion is already running on port N, probably start.bat. Close it and try again.") and quit.
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
- **Copy phone link**: enabled only in LAN mode. Copies `http://<first non-internal IPv4>:<port>/#token=<token>` to the clipboard. If no LAN IPv4 exists, shows a dialog instead.
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
- If binding `0.0.0.0` fails, rebind `127.0.0.1`, uncheck the item and show the error.
- The first LAN bind triggers the Windows Firewall prompt for the app; the README tells the user to allow private networks only.

### Quitting
- **Tray Quit:** count `companion.store.sessions` with status `running` or `queued`. If N > 0, show a confirm dialog: "N sessions are still working. Quit and stop them?" (Quit / Cancel). On Quit: set `isQuitting`, `await companion.close()` (freezes timers, marks running sessions paused, persists state, stops OMP processes), then `app.exit(0)`.
- **Windows logoff/shutdown** (`BrowserWindow` `session-end`): no dialog, because Windows kills the process a few seconds after `WM_ENDSESSION`. Set `isQuitting` and call `companion.close()` right away. `close()` runs `persist()` before waiting on runners, so state is saved early even if Windows kills the process mid-shutdown.
- Both paths go through one `quit({ confirm })` function, guarded so it runs once. `window-all-closed` is handled as a no-op, so closing extra dashboard windows (or hiding the main one) never quits the app.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Port in use | Error dialog explaining that another companion is running; quit. |
| `createCompanion` / listen error | Error dialog with the message; quit. |
| LAN bind fails | Revert to 127.0.0.1, uncheck the toggle, error dialog. |
| No LAN IPv4 for Copy phone link | Info dialog. |
| OMP missing or outdated | Unchanged: handled by the dashboard and server as today. |

## Testing

- `node --test "tests/*.test.mjs"` stays green; `server.mjs` is untouched.
- No new permanent tests: `main.mjs` is Electron wiring (window, tray, dialogs) with no logic worth unit-testing outside Electron.
- Smoke test with `npm run desktop`:
  1. The window opens the dashboard, already connected, with no console.
  2. Closing the window hides it to the tray, the balloon shows once, and tray Open restores it.
  3. A second launch focuses the existing window.
  4. LAN toggle on: `GET http://<LAN IP>:<port>/api/state` with `Authorization: Bearer <token>` returns 200, and without it returns 401. The window keeps working. Toggle off: connections to the LAN IP are refused.
  5. Copy phone link puts the expected URL on the clipboard.
  6. With a session running, tray Quit shows the confirm. Cancel keeps it running; Quit exits, and the session is persisted as paused and the OMP process is gone.
  7. With `start.bat` running, launching the app shows the "already running" dialog.
- Packaging: `npm run dist` produces `dist/OMP Control Room Setup <version>.exe`. Install it, launch it from the Start menu and repeat checks 1, 2 and 6. Confirm that the installer does not contain `docs/`.
