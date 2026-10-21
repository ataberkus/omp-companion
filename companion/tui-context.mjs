// An InteractiveModeContext (OMP src/modes/types.ts) for terminal-UI commands the companion hosts: OMP's own TUI controllers
// run against it, with the dashboard standing in for the terminal.
//   showStatus / showWarning / showError     → toasts (io.notice); inside ctx.command(fn) errors are thrown instead
//   showHookSelector / Input / Confirm / Editor → dashboard dialogs (io.ui), cancelled together by ctx.cancelDialogs()
//   showSessionSelector(_, onSelect), showModelSelector({ selectOnly }) → pick-only dashboard dialogs
//   ctx.widget(key)                          → a pi-tui Container rendered (ANSI stripped) into the dashboard widget `key`
//                                              whenever ui.requestRender() runs, as the terminal re-renders its docked panels
//   rebuildChatFromMessages()                → sends display-only custom messages the session appended without an event
// Hosts add the members their controller needs that have no dashboard meaning through `extra` (property descriptors are
// kept, so getters stay live): tuiContext(io, kit, { get statusLine() { … } }).
const WIDTH = 100, MAX_LINES = 40, RENDER_MS = 200;
const message = e => e instanceof Error ? e.message : String(e);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pi-tui and SDK pieces the context needs, from the SDK copy being loaded (call from a host's load). */
export async function loadTuiKit({ pkg, at }) {
 const [tui, hints, keys, sessions] = await Promise.all([
  pkg('@oh-my-pi/pi-tui/tui'), pkg('@oh-my-pi/pi-tui/chrome/keybinding-hints'), pkg('@oh-my-pi/pi-tui/app-keybindings'), at('session/session-manager.ts'),
 ]);
 return { Container: tui.Container, interruptKey: hints.interruptKey, KeybindingsManager: keys.KeybindingsManager, SessionManager: sessions.SessionManager };
}

/**
 * A rendered component as plain lines for a dashboard widget or chat: ANSI stripped, its interrupt-key hints (Esc in the
 * terminal) worded for the dashboard's Stop button, and at most `max` lines (the head line and the newest tail).
 */
export function componentLines(component, kit, { width = WIDTH, max = MAX_LINES } = {}) {
 const esc = escapeRe(Bun.stripANSI(kit.interruptKey()));
 const cancel = new RegExp(`${esc} cancel (/\\S+)`), dismiss = new RegExp(`(?: · )?${esc} dismiss`);
 const lines = component.render(width).map(raw => {
  const line = Bun.stripANSI(raw).trimEnd(), hinted = line.replace(cancel, 'Stop cancels $1').replace(dismiss, '');
  if (hinted === line) return line;
  const boxed = /^│(.*)│$/.exec(hinted);
  return boxed ? `│${boxed[1].trimEnd().padEnd(width - 2)}│` : hinted.trimEnd();
 });
 while (lines.length && !lines.at(-1).trim()) lines.pop();
 return lines.length > max ? [lines[0], '│ …', ...lines.slice(-(max - 2))] : lines;
}

/** Lines as a fenced plain-text block for chat output. */
export function fenced(lines) {
 const text = lines.join('\n'), longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(r => r.length));
 const fence = '`'.repeat(longest + 1);
 return `${fence}text\n${text}\n${fence}`;
}

export function tuiContext(io, kit, extra = {}) {
 const widgets = new Map(), shown = new Map(), shownCustom = new WeakSet();
 let sink, timer, rendered = 0, dialogs = new AbortController(), keybindings;
 const say = (level, text) => sink ? sink.push({ level, text: String(text) }) : io.notice(level, String(text));
 const scoped = d => ({ ...d, signal: d?.signal ? AbortSignal.any([d.signal, dialogs.signal]) : dialogs.signal });
 const render = () => {
  timer = undefined; rendered = Date.now();
  for (const [key, container] of widgets) {
   const lines = container.children.length ? componentLines(container, kit) : undefined, text = lines?.join('\n');
   if (shown.get(key) === text) continue;
   if (text === undefined) shown.delete(key); else shown.set(key, text);
   io.ui.setWidget(key, lines);
  }
 };
 const ctx = {
  // The terminal: docked panels re-render through requestRender, at most every RENDER_MS (panels repaint spinners many
  // times a second).
  ui: { requestRender() { timer ??= setTimeout(render, Math.max(0, rendered + RENDER_MS - Date.now())); }, terminal: { columns: WIDTH, rows: MAX_LINES } },
  get session() { return io.session; },
  get sessionManager() { return io.session.sessionManager; },
  get settings() { return io.session.settings; },
  get agent() { return io.session.agent; },
  get mcpManager() { return io.mcpManager; },
  get eventBus() { return io.buses.eventBus; },
  get subagentEventBus() { return io.buses.subagentEventBus; },
  get keybindings() { return keybindings ??= kit.KeybindingsManager.create(io.session.settings.getAgentDir()); },

  /** A docked container shown as the dashboard widget `key`. */
  widget(key) {
   const container = new kit.Container();
   widgets.set(key, container);
   return container;
  },
  /** Renders pending widget changes now (a settled panel before it is snapshotted or removed). */
  flush() { clearTimeout(timer); render(); },

  showStatus: text => say('info', text),
  showWarning: text => say('warning', text),
  showError: text => say('error', text),
  showHookSelector: (title, options, dialog) => io.ui.select(title, options, scoped(dialog)),
  showHookInput: (title, placeholder, dialog) => io.ui.input(title, placeholder, scoped(dialog)),
  showHookConfirm: (title, text, dialog) => io.ui.confirm(title, text, scoped(dialog)),
  showHookEditor: (title, prefill, dialog, options) => io.ui.editor(title, prefill, scoped(dialog), options),
  /** Closes the dialogs this context has open (the user stopped the command). */
  cancelDialogs() { dialogs.abort(); dialogs = new AbortController(); },

  // OMP's session picker in its pick-only form (`onSelect`). The TUI's opens on this folder's sessions and Tab switches
  // to every project's (SessionManager.listAllForPicker); here a last option switches scope. Dashboard pickers list at
  // most 100 options: the newest 99 sessions of the scope (pinned first, as OMP sorts them) plus that option.
  // Like the TUI's it may be left running by its caller: the pick and onSelect are tracked and their errors shown.
  showSessionSelector(source, onSelect) {
   if (source || !onSelect) throw new Error('Only picking a saved session is available here; use the session’s ⋯ menu to switch sessions.');
   const task = (async () => {
    const sm = io.session.sessionManager, current = sm.getSessionFile();
    for (let all = false; ;) {
     const sessions = (await (all ? kit.SessionManager.listAllForPicker() : kit.SessionManager.listForPicker(sm.getCwd(), sm.getSessionDir()))).slice(0, 99);
     const labels = sessions.map(s => `${oneLine(s.title || s.firstMessage || s.id, 80)} · ${new Date(s.modified).toLocaleString()}${s.path === current ? ' (this session)' : ''}`);
     for (const [i, l] of labels.entries()) if (labels.indexOf(l) !== i) labels[i] = `${l} #${i + 1}`;
     const toggle = all ? 'This folder…' : 'All projects…';
     const empty = sessions.length ? '' : all ? 'No sessions found. ' : 'No sessions in this folder. ';
     const picked = await io.ui.select(all ? 'Select a Session to Consult (all projects)' : 'Select a Session to Consult', [
      ...sessions.map((s, i) => ({ label: labels[i], description: `${s.messageCount} messages · ${s.cwd || s.path}` })),
      { label: toggle, description: empty + (all ? 'Show only this folder’s sessions' : 'Show sessions of every project') },
     ], scoped());
     if (picked === toggle) { all = !all; continue; }
     const session = sessions[labels.indexOf(picked)];
     if (session) await onSelect(session);
     return;
    }
   })().catch(e => say('error', message(e)));
   io.track(task);
   return task;
  },
  // OMP's model picker in its select-only form: a one-off `provider/id` for the caller, the session's model unchanged.
  // Returns at once like the TUI's; the pick and the caller's onSelect run on (tracked, their errors shown).
  showModelSelector(options) {
   const selectOnly = options?.selectOnly;
   if (!selectOnly) throw new Error('Change the session’s model with the model chip under the composer.');
   const task = (async () => {
    const all = io.session.modelRegistry.getAvailable();
    let models = all;
    // Dashboard pickers list at most 100 options: a longer list is narrowed by provider first.
    if (models.length > 100) {
     const providers = [...new Set(all.map(m => m.provider))];
     if (providers.length <= 100) {
      const provider = await io.ui.select('Select a provider', providers.map(p => ({ label: p, description: `${all.filter(m => m.provider === p).length} models` })), scoped());
      if (!provider) return;
      models = all.filter(m => m.provider === provider);
     }
    }
    const picked = models.length > 100
     ? (await io.ui.input('Model (provider/id)', selectOnly.currentSelector, scoped()))?.trim()
     : await io.ui.select('Select a model', models.map(m => ({ label: `${m.provider}/${m.id}`, description: m.name && m.name !== m.id ? m.name : '' })), scoped());
    if (picked) await selectOnly.onSelect(picked);
   })().catch(e => say('error', message(e)));
   io.track(task);
  },

  // The TUI re-renders its transcript after appending a custom message without an event (idle sendCustomMessage); the
  // dashboard gets those display messages as the message_end frames OMP sends for custom messages during a turn.
  rebuildChatFromMessages() {
   const fresh = [];
   for (const m of [...io.session.messages].reverse()) {
    if (m.role !== 'custom') break;
    if (shownCustom.has(m)) continue;
    shownCustom.add(m);
    if (m.display) fresh.unshift(m);
   }
   for (const m of fresh) io.emit({ type: 'message_end', message: io.plain(m) });
  },

  /** Runs a controller step; its error messages become the thrown error, its other messages toasts. */
  async command(fn) {
   const said = [], prev = sink;
   sink = said;
   try { await fn(); } finally { sink = prev; }
   for (const m of said) if (m.level !== 'error') io.notice(m.level, m.text);
   const errors = said.filter(m => m.level === 'error');
   if (errors.length) throw new Error(errors.map(m => m.text).join('\n'));
  },
  /** Work that outlives the command's run: shown as running (with a Stop control), awaited by shutdown. */
  background(key, label, task) {
   io.emit({ type: 'command_run', key, label, active: true });
   io.track(Promise.resolve(task).catch(e => io.notice('error', `${label} failed: ${message(e)}`)).finally(() => io.emit({ type: 'command_run', key, active: false })));
  },
 };
 return Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(extra));
}

const oneLine = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
