// OMP Control Room desktop shell: runs the companion in-process and shows the dashboard in an app window.
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, screen, shell, Tray } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion, portBusy } from '../companion/server.mjs';
import { phoneLinks } from './links.mjs';

const port = Number(process.env.OMP_WEB_PORT || 4545);
const origin = `http://127.0.0.1:${port}`;
const icon = fileURLToPath(new URL('icon.png', import.meta.url));
const alreadyRunning = `The companion is already running on port ${port}, probably start.bat. Close it and try again.`;
let companion, win, tray;
let isQuitting = false, quitting = false, lan = false, toldAboutTray = false;

function fail(message) {
  dialog.showErrorBox('OMP Control Room', message);
  app.exit(1);
}

function showWindow() {
  // A renderer-side window.close() destroys the window without a preventable 'close'; rebuild it instead of leaving a windowless app.
  if (!win || win.isDestroyed()) return companion && createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return {};
    // A monitor that was unplugged would leave the window off-screen.
    const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch { return {}; }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

function createWindow() {
  const { maximized, ...bounds } = savedBounds();
  win = new BrowserWindow({ width: 1400, height: 900, ...bounds, icon, show: false, title: 'OMP Control Room' });
  win.once('ready-to-show', () => { if (maximized) win.maximize(); win.show(); });
  win.on('close', e => {
    saveBounds();
    if (isQuitting) return;
    // Closing hides to the tray so running agents keep working; Quit lives in the tray menu.
    e.preventDefault();
    win.hide();
    if (!toldAboutTray) { toldAboutTray = true; tray.displayBalloon({ icon: nativeImage.createFromPath(icon), title: 'OMP Control Room', content: 'Still running in the tray.' }); }
  });
  // Windows kills the process seconds after WM_ENDSESSION: no question, save and stop right away.
  win.on('session-end', () => quit({ confirm: false }));
  win.loadURL(`${origin}/#token=${companion.token}`);
}

function rebuildTrayMenu() {
  const links = phoneLinks(os.networkInterfaces(), port, companion.token);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { label: 'Allow phones on my network', type: 'checkbox', checked: lan, click: item => setLan(item.checked) },
    { label: 'Copy phone link', enabled: lan, submenu: links.length ? links.map(l => ({ label: l.label, click: () => clipboard.writeText(l.url) })) : [{ label: 'No network address found', enabled: false }] },
    { type: 'separator' },
    { label: 'Quit', click: () => quit({ confirm: true }) },
  ]));
}

async function quit({ confirm }) {
  if (quitting) return;
  quitting = true;
  const busy = companion.store.sessions.filter(s => s.status === 'running' || s.status === 'queued').length;
  if (confirm && busy) {
    // No parent window: it may be hidden in the tray, and a dialog owned by a hidden window can stay invisible.
    const message = busy === 1 ? '1 session is still working. Quit and stop it?' : `${busy} sessions are still working. Quit and stop them?`;
    const { response } = await dialog.showMessageBox({ type: 'warning', title: 'OMP Control Room', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, message });
    if (response !== 0) { quitting = false; return; }
  }
  isQuitting = true;
  // app.exit() destroys windows without a 'close' event, so save the window position here.
  saveBounds();
  tray.destroy();
  // close() pauses running sessions, saves workspace.json and stops every OMP process.
  try { await companion.close(); } finally { app.exit(0); }
}

function createTray() {
  tray = new Tray(icon);
  tray.setToolTip('OMP Control Room');
  tray.on('double-click', showWindow);
  rebuildTrayMenu();
}

// Rebind the same server instead of restarting the companion: close() would kill every running agent.
// The Host/Origin allowlist is recomputed from server.address() per request, so it follows the new bind.
function bind(host) {
  const server = companion.server;
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(() => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  });
}

async function setLan(on) {
  try { await bind(on ? '0.0.0.0' : '127.0.0.1'); lan = on; }
  catch (e) {
    await bind('127.0.0.1').catch(() => {});
    lan = false;
    // Async on purpose: a sync dialog would block the main process, and with it the in-process companion server.
    dialog.showMessageBox({ type: 'error', title: 'OMP Control Room', message: 'Could not change network access', detail: e.message });
  }
  rebuildTrayMenu();
}

// Every window, including dashboard popups: own-origin pages stay in the app (they inherit the token
// through sessionStorage), web links go to the default browser, anything else is refused.
app.on('web-contents-created', (_, contents) => {
  const external = url => { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); };
  contents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: 'allow', overrideBrowserWindowOptions: { icon } };
    external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (new URL(url).origin === origin) return;
    e.preventDefault();
    external(url);
  });
});

async function bootstrap() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  // Before createCompanion: it pauses running sessions and saves workspace.json, which would clobber a live start.bat.
  if (await portBusy(port)) return fail(alreadyRunning);
  try { companion = await createCompanion({ exposeToken: false }); }
  catch (e) { return fail(`The companion could not start: ${e.message}`); }
  const { server } = companion;
  const onStartError = e => fail(e.code === 'EADDRINUSE' ? alreadyRunning : `The companion could not start: ${e.message}`);
  server.once('error', onStartError);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', onStartError);
    createTray();
    createWindow();
  });
}

// Hidden or extra windows closing must never end the app; only the tray's Quit does.
app.on('window-all-closed', () => {});

if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', showWindow);
  bootstrap();
}
