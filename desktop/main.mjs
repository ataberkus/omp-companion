// OMP Control Room desktop shell: runs the companion in-process and shows the dashboard in an app window.
import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion, portBusy } from '../companion/server.mjs';

const port = Number(process.env.OMP_WEB_PORT || 4545);
const origin = `http://127.0.0.1:${port}`;
const icon = fileURLToPath(new URL('icon.png', import.meta.url));
const alreadyRunning = `The companion is already running on port ${port}, probably start.bat. Close it and try again.`;
let companion, win;
let isQuitting = false;

function fail(message) {
  dialog.showErrorBox('OMP Control Room', message);
  app.exit(1);
}

function showWindow() {
  if (!win) return;
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

function createWindow() {
  const { maximized, ...bounds } = savedBounds();
  win = new BrowserWindow({ width: 1400, height: 900, ...bounds, icon, show: false, title: 'OMP Control Room' });
  win.once('ready-to-show', () => { if (maximized) win.maximize(); win.show(); });
  win.on('close', () => {
    try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
  });
  win.loadURL(`${origin}/#token=${companion.token}`);
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
    createWindow();
  });
}

if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', showWindow);
  bootstrap();
}
