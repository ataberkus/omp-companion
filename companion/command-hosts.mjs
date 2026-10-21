// OMP built-in slash commands that ship only a terminal-UI handler (`handleTui`, no text-mode `handle`), so OMP's own
// headless hosts cannot run them. The companion hosts them on the same SDK pieces, the way goal-host.mjs hosts /goal.
//
// A host module exports `host = { name, load(env) }`. `load` runs once per SDK copy with
// env = { at(rel) imports an SDK src/ file, optional(rel) imports it when present, pkg(spec) imports a package, text(rel)
// reads an SDK src/ file as text (prompt templates), m (the RUNTIME_FILES modules) } and returns `create(io)`; when it
// throws, the command stays unavailable (and is rejected).
// `create` runs once per session with io (see OmpSession#hostIO in omp.mjs) and returns the session's host:
//   names: string[]                command names it runs (aliases included)
//   commands(): entry[]            its available_commands_update entries; [] while a setting turns it off
//   claims?(parsed): boolean       default: names.includes(parsed.name)
//   run(parsed, call): result      parsed = { name, args, text }; call = { images, signal }; result as OMP's
//                                  SlashCommandResult (undefined | { consumed, agentInvoked?, failed? } | { prompt }),
//                                  plus sessionChanged: true when the session's transcript was replaced
//   observe?(event), state?(): object merged into get_state, dispose?(), abort?() (the user's Stop / Stop & send)
//   stopRun?(key):                 the dashboard's Stop on a background run the host announced with a
//                                  { type: 'command_run', key, label, active } frame (key undefined: all its runs);
//                                  the turn's Stop calls abort?() only and leaves such runs going
//   beforeSessionChange?(), afterSessionChange?(): around changes the companion or an extension starts
//   beforeSwitch?(), afterSwitch?(): OMP's session-switch reconcilers, inside every switch/new/branch whoever starts it
//   intercept?(text, images, kind): true when it took the user's input (prompt, steer, follow-up, Stop & send) itself,
//                                  after extension input hooks and before skills and commands; throw to reject it
//   refuse?(op, detail): string    a user-facing reason to refuse a local session operation ('model', 'thinking',
//                                  'compact', 'bash', 'handoff'; '/goal', '/plan', '/plan-review', which run before
//                                  intercept; 'session' for any session change, detail = the change function a host
//                                  passed to io.changeSession/queueSessionChange) while the host owns the session
//   raceUi?(method, args, signal, local): Promise | undefined   races the dashboard's dialog ('select' { title, options,
//                                  dialog }, 'editor' { title, prefill }, 'askDialog' { questions }) against another
//                                  answerer; local(signal) shows the dashboard's; first answer wins, the loser cancelled
//   agents?(): { list(), cancel(id), steer(id, text), transcript?(file) } | undefined   stands in for the session's
//                                  subagent roster; transcript(file) brings a listed sessionFile kept elsewhere up to date
//                                  before the dashboard reads it (true), false when the file is not the roster's
//   prompted?(text, { queued }):   a prompt is about to start a model turn: what the user typed (a skill command as
//                                  typed, a command's { prompt } expanded); queued when it was sent while a turn ran
// io.changeSession(type, extra, change?) changes the session from inside run (change() → { cancelled } replaces OMP's
// RPC change for type); io.queueSessionChange(type, extra, change?) does the same in command order from outside run. A
// host that replaces the transcript outside run emits { type: 'session_replaced', note? } so the dashboard reloads it;
// events of another session it mirrors into this one carry `mirrored: true`.
import { host as fork } from './session-host.mjs';
import { host as pause } from './pause-host.mjs';
import { host as live } from './live-host.mjs';
import { host as todoEdit } from './todo-host.mjs';
import { host as modes } from './vibe-host.mjs';
import { host as loop } from './loop-host.mjs';
import { host as collab } from './collab-host.mjs';
import { tan, omfg, cleanse, seance } from './tui-hosts.mjs';

// collab first: while a guest, its intercept takes the session's input before any other host sees it.
const HOSTS = [collab, fork, pause, live, todoEdit, modes, loop, tan, omfg, cleanse, seance];

export async function loadCommandHosts(env) {
 const loaded = await Promise.all(HOSTS.map(async h => {
  try { return { name: h.name, create: await h.load(env) }; }
  catch (e) { console.error(`/${h.name} is unavailable with this OMP build: ${e instanceof Error ? e.message : e}`); return null; }
 }));
 return loaded.filter(Boolean);
}

/** The available_commands_update entry for OMP's own definition of a built-in (its description, hint and subcommands). */
export function builtinEntry(registry, name) {
 const c = registry.BUILTIN_SLASH_COMMANDS_INTERNAL.find(x => x.name === name);
 if (!c) throw new Error(`OMP defines no /${name} command`);
 const hint = c.acpInputHint ?? c.inlineHint;
 return {
  name: c.name, ...(c.aliases?.length ? { aliases: [...c.aliases] } : {}), description: c.acpDescription ?? c.description,
  ...(hint ? { input: { hint } } : {}),
  ...(c.subcommands?.length ? { subcommands: c.subcommands.map(s => ({ name: s.name, description: s.description, ...(s.usage ? { usage: s.usage } : {}) })) } : {}),
  source: 'builtin',
 };
}

// Where the dashboard already does what a terminal-only built-in does there.
const ELSEWHERE = {
 new: 'Use “Start a fresh OMP session (/new)…” in the session’s ⋯ menu', resume: 'Use “Switch to another saved session…” in the session’s ⋯ menu',
 branch: 'Use “Branch from an earlier message…” in the session’s ⋯ menu', rewind: 'Use “Branch from an earlier message…” in the session’s ⋯ menu',
 tree: 'Use “Session tree…” in the session’s ⋯ menu', login: 'Use “Log in to a provider…” in the session’s ⋯ menu',
 setup: 'Use “Log in to a provider…” in the session’s ⋯ menu, or Settings', providers: 'Use “Log in to a provider…” in the session’s ⋯ menu, or Settings',
 settings: 'Use Settings in the sidebar', extensions: 'Use Settings in the sidebar (plugins)', skills: 'Use the Tools page (skills registry)',
 agents: 'Use the Tools page (agents)', hub: 'Use the background tasks panel', copy: 'Use “Copy last reply” in the session’s ⋯ menu',
 git: 'Use “Commit changes in this folder…” or “Branch & recent commits” in the session’s ⋯ menu', restart: 'Use “Restart companion…” in the session’s ⋯ menu',
};
/** The 409 text for a built-in OMP runs only in its terminal UI and the companion does not host. */
export function unhostedMessage(name) {
 const where = ELSEWHERE[name];
 return `OMP runs /${name} only in its terminal UI${where ? `. ${where}` : ', and the companion cannot host it'}; /${name} was not sent to the model.`;
}
