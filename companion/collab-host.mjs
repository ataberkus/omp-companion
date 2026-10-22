// /collab, /join and /leave: OMP runs them only in its terminal UI (slash-commands/builtin-collaboration.ts). The companion
// runs the same classes OMP's TUI does — CollabController/CollabHost share this session through a relay, CollabGuestLink
// joins someone else's — on the InteractiveModeContext members they use (tui-context.mjs plus the collab ones below).
// Hosting: the join links go to the chat, the room's state to the dashboard's status line and its browser link's QR code to
// a widget; the session's dialogs are raced against the guests (extension-ui-controller.ts); collab.autoStart shares the
// session when it opens. Guest: the session switches to OMP's local replica of the host's transcript; the host's live
// events stream into the dashboard (marked `mirrored`), the user's messages go to the host's agent, Stop interrupts it, the
// host's subagents are listed, stopped and steered through its Agent Hub (their transcripts copied on demand next to the
// replica), and local session operations are refused until /leave.
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinEntry } from './command-hosts.mjs';
import { loadTuiKit, tuiContext } from './tui-context.mjs';

export const host = {
 name: 'collab, /join, /leave',
 async load(env) {
  const { at, pkg, m } = env;
  const [kit, controller, guest, registry, utils, display, render, qr, ask, hookEditor, keys] = await Promise.all([
   loadTuiKit(env), at('collab/controller.ts'), at('collab/guest.ts'), at('collab/registry.ts'), pkg('@oh-my-pi/pi-utils'),
   pkg('@oh-my-pi/pi-tui/overlays/extensions/display-text'), pkg('@oh-my-pi/pi-tui/render/render-utils'), pkg('@oh-my-pi/pi-tui/chrome/qrcode'),
   pkg('@oh-my-pi/pi-tui/overlays/ask-dialog'), pkg('@oh-my-pi/pi-tui/overlays/hook-editor'), pkg('@oh-my-pi/pi-tui/app-keybindings'),
  ]);
  const entries = ['collab', 'join', 'leave'].map(n => builtinEntry(m.builtinRegistry, n));
  const sdk = {
   kit, CollabController: controller.CollabController, CollabGuestLink: guest.CollabGuestLink, guestAllowed: guest.COLLAB_GUEST_ALLOWED_COMMANDS,
   listCollabHosts: registry.listCollabHosts, APP_NAME: utils.APP_NAME, formatAge: utils.formatAge, configRoot: utils.getConfigRootDir,
   sanitize: display.sanitizeDisplayLine, truncate: render.truncateToWidth, shortenPath: render.shortenPath, LENGTHS: render.TRUNCATE_LENGTHS,
   parseSubcommand: m.slashParse.parseSubcommand, parseSlashCommand: m.slashParse.parseSlashCommand, errorMessage: m.slashParse.errorMessage,
   QrCode: qr.QrCode, renderQrText: qr.renderQrText,
   normalizeQuestions: ask.normalizeDialogQuestions, boundPromptTitle: hookEditor.boundPromptTitle,
   disambiguate: render.disambiguateDisplayLabels, sanitizeCr: render.sanitizeCarriageReturns, keyHint: keys.formatKeyHint, keyHints: keys.formatKeyHints,
  };
  return io => new Collab(io, sdk, entries);
 },
};

// What a guest may not do locally (the TUI's "… is host-only during a collab session").
const REFUSED = { model: 'Changing the model', thinking: 'Changing the thinking level', compact: 'Compaction', bash: 'Running shell commands', handoff: 'Handoff' };

// The ask dialog's extra rows when a guest answers it as selects (extension-ui-controller.ts).
const ASK_OTHER = 'Other (type your own)', ASK_CHAT = 'Chat about this', ASK_NEXT = 'Next →';
const wireOptions = options => options.map(o => typeof o === 'string' ? o : o.description ? { label: o.label, description: o.description } : { label: o.label });
const either = (signal, own) => signal ? AbortSignal.any([signal, own]) : own;
// OMP's #raceCollabDialog: the dashboard's dialog against the room's writers. A guest settling as unavailable (teardown,
// relay drop) is not an answer: the dashboard's dialog keeps running and its answer is returned.
async function race(host, request, signal, local) {
 const localAbort = new AbortController(), remoteAbort = new AbortController();
 const remote = host.requestGuestUi(request, either(signal, remoteAbort.signal));
 if (!remote) return local(signal);
 const localWinner = local(either(signal, localAbort.signal)).then(value => ({ source: 'local', value }));
 const remoteWinner = remote.then(r => r.kind === 'answered' ? { source: 'remote', value: r.value } : localWinner);
 const winner = await Promise.race([localWinner, remoteWinner]);
 (winner.source === 'remote' ? localAbort : remoteAbort).abort();
 return winner.value;
}
// One guest select/editor answer of an ask: answered with a string, cancelled, or no guest to ask.
async function guestString(host, request, signal) {
 const remote = host.requestGuestUi(request, signal);
 if (!remote) return { kind: 'unavailable' };
 const r = await remote;
 if (r.kind === 'unavailable') return r;
 return typeof r.value === 'string' ? { kind: 'answered', value: r.value } : { kind: 'cancelled' };
}
// The QR code widget's caption (server.mjs lets `collab-qr` through taller than other widgets).
const QR_CAPTION = 'Scan to open the collab room in a browser:';
// A host subagent transcript's first fetch starts at its last 12 MiB, the most the dashboard reads of any transcript
// (server.mjs importMessages); the host serves at most TRANSCRIPT_READ_CAP per reply (collab/host.ts), so a copy
// takes several replies, and later fetches add what was written since. Agent IDs name the copies, so only file-safe ones.
const TRANSCRIPT_TAIL = 12 * 1024 * 1024, READ_CAP = 4 * 1024 * 1024, NO_TRANSCRIPT = 'The collab host has no transcript for this subagent.', FILE_SAFE = /^(?!\.+$)[\w.-]+$/;
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

class Collab {
 names = ['collab', 'join', 'leave'];
 #io; #sdk; #entries; #ctx; #controller; #proxy;
 // Inside run(): session changes go through io.changeSession; outside it they are queued in command order.
 #inRun = 0;
 // Session changes the guest itself makes (joining, resyncing, restoring); any other change is refused while a guest.
 #mine = new WeakSet();
 #restoration; #disposing = false; #hostRunning = false; #statusText; #qrLink;
 // Host subagents last shown to the dashboard (a guest's mirror of the host's Agent Hub roster).
 #shownAgents = new Set();
 // A guest's copies of host subagent transcripts: file → { offset (host bytes copied), cut, closed, busy }.
 #transcripts = new Map();

 constructor(io, sdk, entries) {
  this.#io = io; this.#sdk = sdk; this.#entries = entries;
  const self = this, ui = { clear() {}, disposeChildren() {} };
  this.#ctx = tuiContext(io, sdk.kit, {
   get session() { return self.#session(); },
   collabHost: undefined, collabGuest: undefined,
   get collabController() { return self.#controller; },
   statusLine: {
    setCollabStatus: status => this.#collabStatus(status),
    // Footer repaint and activity meter: the dashboard's status line is set in setCollabStatus, its run state by events.
    invalidate() {}, markActivityStart() {}, resetActiveTime() {},
    markActivityEnd: () => this.#hostIdle(),
    getCachedContextBreakdown: () => {
     const s = io.session, u = s.getContextUsage();
     return { usedTokens: u?.tokens ?? 0, contextWindow: u?.contextWindow ?? s.model?.contextWindow ?? 0 };
    },
   },
   // The host's mirrored session events: the dashboard renders them as it renders this session's own.
   eventController: { dispatchSessionEvent: async event => this.#mirror(event), resetTranscriptAnchors() {}, takeDisplaceableComponents: () => [] },
   ensureLoadingAnimation: () => { if (!this.#hostRunning) { this.#hostRunning = true; io.emit({ type: 'agent_start' }); } },
   // The dashboard reloads the transcript (and its todos) from the session file whenever the replica replaces it.
   renderInitialMessages: async () => this.#replaced(),
   reloadTodos: async () => {},
   handleResumeSession: async file => { if (await this.#change('switch_session', { sessionPath: file }, () => io.session.switchSession(file))) this.#replaced('The collab session ended; this is your own session again.'); },
   // Terminal widgets with no dashboard counterpart (spinners, pending-message rows, the subagent badge, editor border).
   pendingTools: new Map(), statusContainer: ui, pendingMessagesContainer: ui, compactionQueuedMessages: [],
   loadingAnimation: undefined, autoCompactionLoader: undefined, retryLoader: undefined, streamingComponent: undefined, streamingMessage: undefined,
   // The TUI's running-subagent badge follows the guest's mirror of the host's agents: here, the dashboard's roster.
   syncRunningSubagentBadge: () => this.#publishAgents(),
   resetObserverRegistry() {}, updateEditorBorderColor() {}, updatePendingMessagesDisplay() {},
  });
  const controller = new sdk.CollabController(this.#ctx);
  // A guest's restoration of the local session: /leave must not wait on one already queued behind it.
  const resume = controller.resumeAfterGuest.bind(controller);
  controller.resumeAfterGuest = restoration => {
   this.#restoration = restoration;
   const clear = () => { if (this.#restoration === restoration) this.#restoration = undefined; };
   restoration.then(clear, clear);
   resume(restoration);
  };
  this.#controller = controller;
  // OMP's interactive startup (main.ts): collab.autoStart shares the session when it opens. The controller reads the
  // setting live, so it does nothing while the setting is off and follows later session changes once it is on.
  controller.autoStart();
  // Companion sessions take input as soon as they are open.
  controller.startupComplete();
 }

 commands() { return this.#entries; }

 async run(parsed) {
  this.#inRun++;
  try {
   const args = parsed.args.trim();
   if (parsed.name === 'join') return await this.#join(args);
   if (parsed.name === 'leave') return await this.#leave();
   return await this.#collab(args);
  } finally { this.#inRun--; }
 }

 // While a guest, the user's input is the room's: prompts go to the host's agent, slash commands outside OMP's guest
 // allowlist are host-only (input-controller.ts and builtin-registry.ts in the TUI).
 intercept(text, images) {
  const guest = this.#ctx.collabGuest;
  if (!guest) return false;
  if (text.startsWith('/')) {
   if (this.#sdk.guestAllowed[this.#sdk.parseSlashCommand(text)?.name]) return false;
   throw new Error(`${text.split(/\s+/, 1)[0]} is host-only during a collab session; /leave to run it here.`);
  }
  if (guest.readOnly) throw new Error('This collab link is read-only — prompting is disabled.');
  guest.sendPrompt(text, images?.length ? images : undefined);
  return true;
 }
 refuse(op, change) {
  if (!this.#ctx.collabGuest) return;
  if (op === 'session') return this.#mine.has(change) ? undefined : 'Session changes are host-only during a collab session; /leave first.';
  if (op.startsWith('/')) return `${op} is host-only during a collab session; /leave to run it here.`;
  if (REFUSED[op]) return `${REFUSED[op]} is host-only during a collab session; /leave first.`;
 }
 // While hosting, the session's dialogs also go to the room's writers; the first answer wins (extension-ui-controller.ts).
 raceUi(method, args, signal, local) {
  const host = this.#ctx.collabHost;
  if (!host) return;
  if (method === 'askDialog') return this.#raceAsk(host, args.questions, signal, local);
  const d = args.dialog;
  const request = method === 'select' ? {
   kind: 'select', title: args.title, options: wireOptions(args.options), initialIndex: d?.initialIndex, selectionMarker: d?.selectionMarker,
   checkedIndices: d?.checkedIndices ? [...d.checkedIndices] : undefined, markableCount: d?.markableCount, helpText: d?.helpText,
  } : method === 'editor' ? { kind: 'editor', title: args.title, prefill: args.prefill } : undefined;
  if (request) return race(host, request, signal, local);
 }
 // A guest's subagent roster is the room host's: stopped and steered through its Agent Hub (the TUI hub's hubRemote), and
 // its transcripts read through it as the TUI's agent views do — on read-only links too (the host serves every peer).
 agents() {
  const guest = this.#ctx.collabGuest;
  if (!guest) return;
  const live = id => {
   if (guest.readOnly) throw new Error('This collab link is read-only — agent control is disabled.');
   return this.#hostAgents(guest).some(a => a.id === id && (a.status === 'running' || a.status === 'idle'));
  };
  return {
   list: () => this.#hostAgents(guest),
   cancel: async id => { if (!live(id)) return false; guest.hubRemote.kill(id); return true; },
   steer: async (id, text) => {
    if (!live(id)) throw new Error('That subagent is no longer running on the collab host.');
    if (!text.trim()) throw new Error('Message cannot be empty.');
    guest.hubRemote.chat(id, text);
   },
   transcript: async file => {
    const agent = this.#hostAgents(guest).find(a => a.sessionFile && samePath(a.sessionFile, file));
    if (!agent) return false;
    await this.#syncTranscript(guest, agent.id, agent.sessionFile);
    return true;
   },
  };
 }
 // Stop: the guest's replica never runs, so the host's agent is interrupted (the TUI's Esc).
 abort() {
  const guest = this.#ctx.collabGuest;
  if (guest && (guest.state?.isStreaming || this.#hostRunning)) guest.sendAbort();
 }
 state() {
  const host = this.#controller.host, guest = this.#ctx.collabGuest, plain = this.#io.plain;
  if (host) return { collab: { role: 'host', access: host.access, link: host.access === 'view' ? host.webViewLink : host.webLink, participants: plain(host.participants) } };
  // The replica never runs: while a guest, the session is as busy as the room's host says.
  if (guest) return { isStreaming: this.#hostRunning, isSettled: !this.#hostRunning, collab: { role: 'guest', readOnly: guest.readOnly, participants: plain(guest.state?.participants ?? []) } };
  return { collab: null };
 }
 async dispose() {
  this.#disposing = true;
  const guest = this.#ctx.collabGuest;
  // Back to the local session file before OMP disposes the session, so the companion reopens that, not the replica.
  if (guest) await guest.leave('left').catch(e => console.error('Companion collab guest could not restore its session:', e));
  await this.#controller.shutdown('host exited');
 }

 #session() {
  const real = this.#io.session;
  if (this.#proxy?.real === real) return this.#proxy.session;
  // The guest switches to (and back from) its replica through the companion's session-change path.
  const own = { switchSession: (file, options) => this.#change('switch_session', { sessionPath: file }, () => real.switchSession(file, options)),
   newSession: options => this.#change('new_session', {}, () => real.newSession(options)) };
  const session = new Proxy(real, {
   get: (t, p) => { if (Object.hasOwn(own, p)) return own[p]; const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; },
   set: (t, p, v) => Reflect.set(t, p, v, t),
  });
  this.#proxy = { real, session };
  return session;
 }
 async #change(type, extra, perform) {
  const change = async () => ({ cancelled: !(await perform()) });
  if (this.#disposing) return !(await change()).cancelled;
  this.#mine.add(change);
  const r = this.#inRun ? await this.#io.changeSession(type, extra, change) : await this.#io.queueSessionChange(type, extra, change);
  return !r.cancelled;
 }
 // A transcript replaced outside a command (resync, the host ending the room): the dashboard reloads it.
 #replaced(note) { if (!this.#inRun && !this.#disposing) this.#io.emit({ type: 'session_replaced', ...(note ? { note } : {}) }); }
 #mirror(event) {
  if (event.type === 'agent_start') this.#hostRunning = true;
  this.#io.emit({ ...this.#io.plain(event), mirrored: true });
  // The host's run ended (the TUI stops its loader here); a later agent_start or busy host state starts it again.
  if (event.type === 'agent_end') this.#hostIdle();
 }
 // The host reported its agent idle: the dashboard's run settles (the replica never produces a prompt result).
 #hostIdle() { if (this.#hostRunning) { this.#hostRunning = false; this.#io.emit({ type: 'session_settled' }); } }
 #collabStatus(status) {
  let text, link;
  if (status?.role === 'host') {
   const host = this.#ctx.collabHost, guests = Math.max(0, status.participantCount - 1);
   link = host && (host.access === 'view' ? host.webViewLink : host.webLink);
   text = `Collab: hosting, ${guests} guest${guests === 1 ? '' : 's'}${link ? ` — ${link}` : ''}`;
  } else if (status?.role === 'guest') {
   const people = status.stateOverride?.participants ?? [], hostName = people.find(p => p.role === 'host')?.name;
   text = `Collab: ${this.#ctx.collabGuest?.readOnly ? 'read-only guest' : 'guest'}${hostName ? ` of ${this.#sdk.sanitize(hostName)}` : ''}, ${people.length} participant${people.length === 1 ? '' : 's'} (/leave to exit)`;
  } else this.#hostIdle();
  this.#showQr(link);
  if (text === this.#statusText) return;
  this.#statusText = text;
  this.#io.ui.setStatus('collab', text);
 }
 // The TUI's CollabQrCodeComponent for the room's browser link, as plain half-block rows (light modules inked: the
 // dashboard draws light text on dark), shown while hosting. Any link a QR code holds fits the widget (version 40: 94
 // lines with the caption); one longer than a QR code can hold (2331 bytes) has only the status line's link.
 #showQr(link) {
  if (link === this.#qrLink) return;
  this.#qrLink = link;
  let rows = [];
  try { if (link) rows = this.#sdk.renderQrText(this.#sdk.QrCode.encodeText(link, 'M'), true); } catch {}
  this.#io.ui.setWidget('collab-qr', rows.length ? [QR_CAPTION, ...rows] : undefined);
 }

 // The host's subagents as the dashboard lists a session's own (RpcSubagentRegistry snapshots), each with a session file
 // where its transcript is copied on demand: the replica's artifact folder, where the dashboard finds subagent transcripts.
 #hostAgents(guest) {
  const replica = this.#io.session.sessionManager.getSessionFile();
  // Not before the replica is open (agents arrive with the room's first state): never in the user's own session folder.
  const dir = replica?.endsWith('.jsonl') && samePath(path.dirname(replica), path.join(this.#sdk.configRoot(), 'collab')) ? replica.slice(0, -6) : undefined;
  return guest.agentRegistry.list().filter(a => a.kind === 'sub').map(a => ({ id: a.id, agent: a.displayName, description: a.activity ?? '',
   status: a.status, lastUpdate: a.lastActivity, remote: true, sessionFile: dir && FILE_SAFE.test(a.id) ? path.join(dir, `${a.id}.jsonl`) : '' }));
 }
 #publishAgents() {
  const guest = this.#ctx.collabGuest, now = guest ? this.#hostAgents(guest) : [], ids = new Set(now.map(a => a.id));
  for (const a of now) this.#io.emit({ type: 'subagent_lifecycle', payload: a });
  // Gone from the host's roster (removed there, or the room ended).
  for (const id of this.#shownAgents) if (!ids.has(id)) this.#io.emit({ type: 'subagent_lifecycle', payload: { id, status: 'completed' } });
  this.#shownAgents = ids;
  if (!guest) this.#dropTranscripts();
 }
 // OMP's agent activity view reads a guest's host transcripts this way (activity/index.ts #syncRemote): the tail first,
 // then what was written since; a host transcript that got shorter starts over from its new tail. One fetch per file at a time.
 #syncTranscript(guest, id, file) {
  let copy = this.#transcripts.get(file);
  if (!copy) this.#transcripts.set(file, copy = { offset: -1, cut: false, closed: false, busy: Promise.resolve() });
  const run = copy.busy.then(() => this.#fetchTranscript(guest, id, file, copy));
  copy.busy = run.catch(() => {});
  return run;
 }
 async #fetchTranscript(guest, id, file, copy) {
  if (copy.closed) throw new Error(NO_TRANSCRIPT);
  // Null or an error: no transcript (yet), or the host did not answer. A copy already made stays readable as it is.
  const read = async from => {
   const r = await guest.hubRemote.readTranscript(id, from);
   if (r && !r.error) return r;
   if (copy.offset < 0) throw new Error(NO_TRANSCRIPT);
  };
  const restart = async size => {
   copy.offset = Math.max(0, size - TRANSCRIPT_TAIL); copy.cut = copy.offset > 0;
   await fs.mkdir(path.dirname(file), { recursive: true });
   await fs.writeFile(file, '');
  };
  if (copy.offset < 0) await restart((await read(Number.MAX_SAFE_INTEGER)).newSize);
  for (let more = true; more && !copy.closed;) {
   const r = await read(copy.offset);
   if (!r) return;
   if (r.newSize < copy.offset) { await restart(r.newSize); continue; }
   let text = r.text;
   // A tail starts mid-line: drop up to its first line break (the host ends every reply but the last on a whole line).
   if (copy.cut && text) { const nl = text.indexOf('\n'); if (nl >= 0) copy.cut = false; text = nl >= 0 ? text.slice(nl + 1) : ''; }
   if (text) await fs.appendFile(file, text);
   copy.offset = r.newSize;
   more = Buffer.byteLength(r.text) >= READ_CAP / 2;
  }
 }
 // Leaving the room: the copies go with it (the replica they sit beside is OMP's to collect).
 #dropTranscripts() {
  if (!this.#transcripts.size) return;
  const copies = [...this.#transcripts];
  this.#transcripts.clear();
  for (const [, copy] of copies) copy.closed = true;
  this.#io.track((async () => {
   for (const [file, copy] of copies) { await copy.busy; await fs.rm(file, { force: true }).catch(() => {}); }
   for (const dir of new Set(copies.map(([file]) => path.dirname(file)))) await fs.rmdir(dir).catch(() => {});
  })());
 }

 async #raceAsk(host, questions, signal, local) {
  const normalized = this.#sdk.normalizeQuestions(questions), localAbort = new AbortController(), remoteAbort = new AbortController();
  const localWinner = local(either(signal, localAbort.signal)).then(value => ({ source: 'local', value }));
  const remoteWinner = this.#guestAsk(host, normalized, either(signal, remoteAbort.signal))
   .then(result => result === 'unavailable' ? localWinner : { source: 'remote', value: result });
  const winner = await Promise.race([localWinner, remoteWinner]);
  (winner.source === 'remote' ? localAbort : remoteAbort).abort();
  return winner.value;
 }
 // OMP's #runGuestAskDialog: each question as a guest select (plus Other / Chat / Next), in order.
 async #guestAsk(host, questions, signal) {
  const results = [];
  for (const question of questions) {
   const result = await this.#guestQuestion(host, question, signal);
   if (result === 'unavailable' || result === undefined) return result;
   if (result === 'chat') return { kind: 'chat' };
   results.push(result);
  }
  return { kind: 'submit', results };
 }
 async #guestQuestion(host, question, signal) {
  const sdk = this.#sdk, selected = new Set();
  let customInput;
  const help = (enter, extra = '') => `${sdk.keyHints(['up', 'down'])} navigate  ${sdk.keyHint('enter')} ${enter}  ${extra}${sdk.keyHint('escape')} cancel`;
  const labels = sdk.disambiguate(question.options.map(o => o.label), [ASK_OTHER, ASK_CHAT, ASK_NEXT]);
  const original = new Map(question.options.map((o, i) => [labels[i], o.label]));
  const title = sdk.sanitizeCr(question.question);
  const base = question.options.map((o, i) => o.description?.trim() ? { label: labels[i], description: sdk.sanitizeCr(o.description.trim()) } : labels[i]);
  const custom = () => guestString(host, { kind: 'editor', title: sdk.boundPromptTitle('Custom answer: ', title) }, signal);
  if (question.multi) {
   while (true) {
    const checkedIndices = question.options.map((o, i) => selected.has(o.label) ? i : -1).filter(i => i >= 0);
    const answered = selected.size > 0 || customInput !== undefined;
    const options = [...base, ASK_OTHER, ...(answered ? [ASK_NEXT] : []), ASK_CHAT];
    const choice = await guestString(host, { kind: 'select', title, options, selectionMarker: 'checkbox', checkedIndices, markableCount: question.options.length, helpText: help('toggle', answered ? 'Next → continue  ' : '') }, signal);
    if (choice.kind === 'unavailable') return 'unavailable';
    if (choice.kind === 'cancelled') return undefined;
    if (choice.value === ASK_CHAT) return 'chat';
    if (choice.value === ASK_NEXT) break;
    if (choice.value === ASK_OTHER) {
     const input = await custom();
     if (input.kind === 'unavailable') return 'unavailable';
     if (input.kind === 'cancelled') continue;
     customInput = input.value;
     break;
    }
    const picked = original.get(choice.value) ?? choice.value;
    if (selected.has(picked)) selected.delete(picked); else selected.add(picked);
   }
  } else {
   const recommended = Number.isInteger(question.recommended) ? question.recommended : 0;
   const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
   while (true) {
    const choice = await guestString(host, { kind: 'select', title, options: [...base, ASK_OTHER, ASK_CHAT], initialIndex, selectionMarker: 'radio', markableCount: question.options.length, helpText: help('select') }, signal);
    if (choice.kind === 'unavailable') return 'unavailable';
    if (choice.kind === 'cancelled') return undefined;
    if (choice.value === ASK_CHAT) return 'chat';
    if (choice.value === ASK_OTHER) {
     const input = await custom();
     if (input.kind === 'unavailable') return 'unavailable';
     if (input.kind === 'cancelled') continue;
     customInput = input.value;
    } else selected.add(original.get(choice.value) ?? choice.value);
    break;
   }
  }
  const all = question.options.map(o => o.label);
  return { id: question.id, question: question.question, options: all, multi: question.multi ?? false, selectedOptions: all.filter(l => selected.has(l)), customInput };
 }

 async #collab(args) {
  const { output } = this.#io, ctx = this.#ctx, controller = this.#controller, sdk = this.#sdk;
  const { verb, rest } = sdk.parseSubcommand(args);
  if (verb === 'stop') { await controller.stop('host stopped'); output('Collab stopped'); return; }
  if (verb === 'status') {
   const host = controller.host;
   if (host) {
    const names = host.participants.map(p => p.role === 'host' ? `${p.name} (host)` : p.readOnly ? `${p.name} (view-only)` : p.name);
    output(`Collab: ${names.join(', ')} — ${host.access === 'view' ? host.webViewLink : host.webLink}`);
   } else if (ctx.collabGuest) output(ctx.collabGuest.readOnly ? 'In a collab session as a read-only guest (/leave to exit)' : 'In a collab session as a guest (/leave to exit)');
   else output('Not in a collab session');
   return;
  }
  if (verb === 'list') return this.#list(rest);
  if (ctx.collabGuest) throw new Error('Already in a collab session as a guest (/leave first)');
  const view = verb === 'view', existing = controller.host;
  let host;
  try { host = await controller.start({ access: view ? 'view' : 'control', relay: verb === 'start' || view ? rest : args }); }
  catch (e) { throw new Error(`Failed to start collab session: ${sdk.errorMessage(e)}`); }
  let heading = existing ? 'Collab session restarted with control access' : 'Collab session started!';
  if (host === existing) heading = view ? 'Read-only collab session active' : 'Collab session active';
  output([
   heading,
   ` • ${view ? 'Watch from another terminal:' : 'Join from another terminal:'} ${sdk.APP_NAME} join "${view ? host.viewLink : host.link}"`,
   ` • or any web browser: ${view ? host.webViewLink : host.webLink}`,
   view ? 'Anyone with this link can watch the session but cannot prompt the agent.' : 'Anyone with the link can read the session and prompt the agent. Read-only link: /collab view',
  ].join('\n'));
 }

 // The local registry, metadata only: a link is a deliberate per-host act (`omp collab link`).
 async #list(rest) {
  const sdk = this.#sdk, line = t => sdk.truncate(t, sdk.LENGTHS.LINE);
  if (rest) throw new Error(`Usage: /collab list — for links or JSON use \`${sdk.APP_NAME} collab link|list\``);
  let hosts;
  try { hosts = await sdk.listCollabHosts(); }
  catch (e) { throw new Error(line(sdk.sanitize(`Failed to list collab hosts: ${sdk.errorMessage(e)}`))); }
  if (!hosts.length) { this.#io.output('No active Collab hosts'); return; }
  const lines = [`${hosts.length} active local Collab host${hosts.length === 1 ? '' : 's'}`];
  for (const h of hosts) {
   const name = h.sessionName ? sdk.sanitize(h.sessionName) : '', id = sdk.sanitize(h.sessionId), guests = h.participants - 1;
   const session = sdk.truncate(name ? `${name} (${id})` : id, sdk.LENGTHS.LONG);
   const room = [`gen ${h.generation}`, h.model ? sdk.sanitize(`${h.model.provider}/${h.model.id}`) : 'no model', `started ${sdk.formatAge(Math.round((Date.now() - h.startedAt) / 1000)) || 'just now'}`].join(', ');
   const detail = [`pid ${h.pid}`, `${guests} guest${guests === 1 ? '' : 's'}`, h.access, h.relayConnected ? 'relay connected' : 'relay reconnecting',
    ...(h.inputRequired ? ['input required'] : []), ...(h.busy === null ? [] : [h.busy ? 'working' : 'idle']),
    sdk.truncate(sdk.sanitize(sdk.shortenPath(h.cwd)), sdk.LENGTHS.TITLE)].join(', ');
   lines.push(line(` • ${session} — ${room}`), line(`   ${detail}`), `   ${sdk.APP_NAME} collab link ${h.instanceId}${h.access === 'view' ? ' --view' : ''}`);
  }
  this.#io.output(lines.join('\n'));
 }

 async #join(link) {
  const ctx = this.#ctx, controller = this.#controller;
  if (!link) throw new Error('Usage: /join <link>');
  if (ctx.collabGuest) throw new Error('Already in a collab session (/leave first)');
  // Stop stale/ending ownership and cancel pending starts, not a live room.
  try { if (!controller.host) await controller.stop('joining another session'); }
  catch (e) { throw new Error(`Failed to join collab session: ${this.#sdk.errorMessage(e)}`); }
  if (controller.host) throw new Error('Stop hosting first (/collab stop)');
  const guest = new this.#sdk.CollabGuestLink(ctx);
  try { await guest.join(link); }
  catch (e) { throw new Error(`Failed to join collab session: ${this.#sdk.errorMessage(e)}`); }
  return { consumed: true, sessionChanged: true, note: `Joined the collab session${guest.readOnly ? ' (read-only): you can watch the host’s session' : ': your messages go to the host’s agent and Stop interrupts it'}. /leave returns to your own session.` };
 }

 async #leave() {
  const ctx = this.#ctx, guest = ctx.collabGuest;
  if (guest) {
   // The room already ended and the local session is being restored after the command queue.
   if (this.#restoration) { this.#io.output('Already leaving the collab session.'); return; }
   await guest.leave('left');
   return { consumed: true, sessionChanged: true, note: 'Left the collab session; this is your own session again.' };
  }
  const wasHosting = ctx.collabHost !== undefined;
  await this.#controller.stop('host stopped');
  this.#io.output(wasHosting ? 'Collab stopped' : 'Not in a collab session');
 }
}
