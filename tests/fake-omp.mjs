// An in-memory OMP for tests: createCompanion({ omp: fakeOmp(...) }) runs sessions on it instead of OMP's SDK.
// Sessions follow companion/omp.mjs's contract: `ready`, method calls that resolve with OMP's result or reject with its
// error, events through onEvent, and onExit(error, stopping) once when the session ends.
import { NOT_RUNNING } from '../companion/omp.mjs';

const DEFAULTS = {
 prompt: () => ({}),
 state: () => ({}),
 commands: () => ({ commands: [] }),
 entries: () => ({ entries: [], leafId: null }),
 subagents: () => ({ subagents: [] }),
};

/**
 * `handlers` maps OmpSession method names (prompt, state, setModel, answer, ...) to functions called with the method's
 * arguments and `this` set to the session; `open` runs before `ready` settles (emit start-up events or throw there).
 * Pass a function instead to get fresh handlers per session: it receives the session (cwd, args, emit, ...).
 * Every call is logged in session.calls and host.calls as { method, args }.
 */
export function fakeOmp(handlers = {}) {
 const host = {
  sessions: [], calls: [],
  start(options) { const s = new FakeSession(options, host, handlers); host.sessions.push(s); return s; },
  get last() { return host.sessions.at(-1); },
  /** The arguments of every call to `method`, in order. */
  sent(method) { return host.calls.filter(c => c.method === method).map(c => c.args); },
 };
 return host;
}

const METHODS = ['prompt', 'steer', 'followUp', 'interrupt', 'abort', 'removeQueued', 'state', 'commands', 'entries', 'tree', 'subagents',
 'lastAssistantText', 'sessionStats', 'branchMessages', 'exportHtml', 'setTodos', 'setSessionName', 'setModel', 'cycleModel',
 'availableModels', 'setThinking', 'cycleThinking', 'setPref', 'compact', 'bash', 'abortBash', 'handoff', 'newSession',
 'switchSession', 'branch', 'loginProviders', 'login', 'btw', 'btwCancel', 'btwHistory', 'cancelSubagent', 'steerSubagent',
 'predictWord', 'predictFeedback', 'setPlanMode', 'reviewPlan', 'approvePlan'];

class FakeSession {
 alive = true; stopping = false; startedAt = Date.now(); calls = [];
 #host; #onEvent; #onExit; #handlers; #exited = false; #closeDone; #dead; #die;
 constructor({ cwd, args, onEvent, onExit }, host, handlers) {
  this.cwd = cwd; this.args = args; this.#host = host; this.#onEvent = onEvent; this.#onExit = onExit;
  this.closed = new Promise(resolve => { this.#closeDone = resolve; });
  this.#dead = new Promise((_, reject) => { this.#die = reject; });
  this.#dead.catch(() => {});
  this.#handlers = { ...DEFAULTS, ...(typeof handlers === 'function' ? handlers(this) : handlers) };
  this.ready = Promise.race([(async () => { await null; await this.#handlers.open?.call(this); })(), this.#dead]);
  this.ready.catch(e => this.exit(e.message, this.stopping));
  for (const method of METHODS) this[method] = (...args) => this.#call(method, args);
 }
 /** Delivers an OMP event to the companion, as OMP's event stream would. */
 emit(frame) { if (this.alive) this.#onEvent(frame); }
 /** OMP ended on its own: calls in flight reject and the companion sees an exit (not a stop). */
 exit(message = 'OMP exited (0).', stopping = this.stopping) {
  this.alive = false;
  const e = new Error(message);
  this.#die(e);
  if (!this.#exited) { this.#exited = true; this.#onExit(e, stopping); }
  this.#closeDone();
 }
 kill() { if (!this.alive) return this.closed; this.stopping = true; this.exit('OMP stopped.', true); return this.closed; }
 answer(id, reply) {
  if (!this.alive) throw new Error(NOT_RUNNING);
  this.#log('answer', [id, reply]);
  this.#handlers.answer?.call(this, id, reply);
 }
 #log(method, args) { const c = { method, args }; this.calls.push(c); this.#host.calls.push(c); }
 async #call(method, args) {
  await this.ready;
  if (!this.alive) throw new Error(NOT_RUNNING);
  this.#log(method, args);
  const fn = this.#handlers[method];
  return fn ? Promise.race([fn.apply(this, args), this.#dead]) : undefined;
 }
}
