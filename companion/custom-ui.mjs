// ctx.ui.custom() for the dashboard. OMP's TUI (ExtensionUiController.showHookCustom) builds the caller's component with
// (tui, theme, keybindings, done), mounts it in place of the editor (or as an overlay when options.overlay), gives it
// keyboard focus and settles with the value passed to done(); an aborted options.signal rejects, and closing disposes the
// component. Extensions use it for their own panels, and the bash tool for `pty: true` commands (its xterm overlay).
// The companion does the same on a headless pi-tui TUI, set up like OMP's own `omp render`: a sink terminal that never
// touches a TTY, sized like the dashboard's panel. Every paint goes to the dashboard as an extension_ui_request `custom`
// frame (the viewport's rows, SGR styling kept), repeated under the same id while the component lives and withdrawn with a
// `cancel` frame. The dashboard's keys enter through the TUI's stdin pipeline (injectDebugInput), so focus, input capture,
// overlays the component opens and key matching behave as in a terminal. Close in the dashboard, Stop and session shutdown
// abort it like an aborted signal does in the TUI: the component is disposed and the promise rejects with an AbortError.
import { randomUUID } from 'node:crypto';

// The terminal a component starts with until the dashboard reports its panel's size, and the sizes a panel may take.
const COLUMNS = 100, ROWS = 30;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const panelSize = ({ columns, rows }) => ({ columns: clamp(columns, 20, 300), rows: clamp(rows, 5, 100) });

export async function loadCustomUI(pkg) {
 const [{ TUI }, { KeybindingsManager }, { default: chalk }] = await Promise.all([
  pkg('@oh-my-pi/pi-tui'), pkg('@oh-my-pi/pi-tui/app-keybindings'),
  // OMP's theme styles bold, italic, underline and inverse through this chalk (theme-class.ts); colors are explicit SGR.
  pkg('@oh-my-pi/pi-utils/chalk'),
 ]);
 return { TUI, KeybindingsManager, chalk };
}

// OMP's render-cli SinkTerminal: the TUI paints into it, the companion reads paints through a paint listener instead.
const sinkTerminal = size => ({
 start() {}, stop() {}, async drainInput() {}, write() {},
 get columns() { return size.columns; }, get rows() { return size.rows; },
 get kittyProtocolActive() { return false; }, get kittyEnableSequence() { return null; },
 moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
 setTitle() {}, setProgress() {}, onAppearanceChange() {}, refreshAppearance() {}, get appearance() { return undefined; },
});

// A painted row as the dashboard shows it: SGR (colors, bold, inverse) kept; every other escape and control character dropped.
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f]/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
const row = r => String(r).replace(ESCAPE, m => SGR.test(m) ? m : '').replace(/\t/g, '  ');
const blank = r => !r.replace(/\x1b\[[0-9;:]*m/g, '').trim();
function rows(viewport) {
 const out = viewport.map(row);
 let a = 0, b = out.length;
 while (a < b && blank(out[a])) a++;
 while (b > a && blank(out[b - 1])) b--;
 return out.slice(a, b);
}
const abortError = reason => reason ?? new DOMException('Dialog aborted', 'AbortError');

/** The session's custom() surface; `emit` sends frames to the dashboard, `theme()` is OMP's current theme. */
export function customUI({ TUI, KeybindingsManager, chalk }, theme, emit) {
 const open = new Map();
 // The size the dashboard last reported: the next panel opens at it.
 let size = { columns: COLUMNS, rows: ROWS };
 // The dashboard draws styling whatever the companion's stdout supports, so the component's code runs with chalk at full
 // color, and only then: chalk's level is OMP-wide, and the companion's own logs stay plain.
 const styled = fn => {
  const level = chalk.level;
  chalk.level = 3;
  try { return fn(); } finally { chalk.level = level; }
 };
 // The TUI's renders (scheduled by the component's requestRender calls) run styled too.
 const renderScheduler = {
  now: () => performance.now(),
  scheduleImmediate: cb => { setImmediate(() => styled(cb)); },
  scheduleRender: (cb, delayMs) => { const t = setTimeout(() => styled(cb), delayMs); return { cancel: () => clearTimeout(t) }; },
 };
 return {
  show(factory, options) {
   const { promise, resolve, reject } = Promise.withResolvers();
   const signal = options?.signal;
   if (signal?.aborted) { reject(abortError(signal.reason)); return promise; }
   const id = randomUUID(), terminalSize = { ...size }, tui = new TUI(sinkTerminal(terminalSize), false, { renderScheduler });
   let component, closed = false, shown;
   tui.addPaintListener(p => {
    if (closed) return;
    const lines = rows(p.viewport), key = lines.join('\n');
    if (key === shown) return;
    shown = key;
    emit({ type: 'extension_ui_request', id, method: 'custom', lines });
   });
   const finish = settle => {
    if (closed) return;
    closed = true; open.delete(id);
    signal?.removeEventListener('abort', onAbort);
    try { component?.dispose?.(); tui.stop(); }
    finally { emit({ type: 'extension_ui_request', id: randomUUID(), method: 'cancel', targetId: id }); settle(); }
   };
   const fail = e => finish(() => reject(e));
   const onAbort = () => fail(abortError(signal.reason));
   const close = result => finish(() => resolve(result));
   signal?.addEventListener('abort', onAbort, { once: true });
   open.set(id, { tui, terminalSize, fail });
   Promise.try(() => styled(() => factory(tui, theme(), KeybindingsManager.inMemory(), close)))
    .then(c => {
     if (closed) { c?.dispose?.(); return; }
     component = c;
     styled(() => {
      if (options?.overlay) {
       const placement = typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions;
       const handle = tui.showOverlay(c, placement ?? { anchor: 'bottom-center', width: '100%', maxHeight: '100%', margin: 0 });
       options.onHandle?.(handle);
      } else { tui.addChild(c); tui.setFocus(c); }
     });
     tui.requestRender(true);
    })
    .catch(fail);
   return promise;
  },
  has: id => open.has(id),
  /**
   * Dashboard input for an open component: `{ input }` is terminal input, one key (or bracketed paste) per string, as
   * pi-tui's StdinBuffer splits stdin for the TUI; `{ resize: { columns, rows } }` is the panel's size in cells, applied
   * like a terminal resize (the component re-renders at the new size; the bash PTY follows it); `{ cancelled }` closes it.
   */
  reply(id, r) {
   const c = open.get(id);
   if (!c) return;
   if (r.cancelled) { c.fail(abortError()); return; }
   if (r.resize) {
    size = panelSize(r.resize);
    if (size.columns === c.terminalSize.columns && size.rows === c.terminalSize.rows) return;
    Object.assign(c.terminalSize, size);
    styled(() => { c.tui.invalidate(); c.tui.renderNow(); });
    return;
   }
   styled(() => {
    for (const key of [].concat(r.input ?? [])) {
     // A key can finish the component (done()); the rest of the batch has nothing left to reach.
     if (open.get(id) !== c) return;
     if (typeof key === 'string' && key) c.tui.injectDebugInput(key);
    }
    // Paint now, so the reply to this input already shows its effect; later changes arrive with the next paints.
    if (open.get(id) === c) c.tui.renderNow();
   });
  },
  /** Stop and shutdown: every open component is closed as an aborted signal would close it. */
  closeAll(reason) { for (const c of [...open.values()]) c.fail(abortError(reason ? new DOMException(reason, 'AbortError') : undefined)); },
 };
}
