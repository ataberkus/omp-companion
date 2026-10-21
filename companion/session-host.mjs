// /fork, /clear and /logout: OMP runs them only in its terminal UI (command-controller.ts, selector-controller.ts); the
// companion runs the same session calls OMP's RPC host exposes (handleRpcSessionChange fork, resetSessionContext, and
// /logout's listLogoutAccounts/logoutCredential), with the dashboard's dialogs for OMP's pickers.
import { builtinEntry } from './command-hosts.mjs';

export const host = {
 name: 'fork, /clear, /logout',
 async load({ at, pkg, m }) {
  const [logout, oauth] = await Promise.all([at('slash-commands/helpers/logout.ts'), pkg('@oh-my-pi/pi-ai/oauth')]);
  // Only the bare /fork: its pane/window variants open terminal multiplexer panes.
  const fork = { ...builtinEntry(m.builtinRegistry, 'fork'), subcommands: undefined, input: undefined };
  const entries = [fork, builtinEntry(m.builtinRegistry, 'clear'), builtinEntry(m.builtinRegistry, 'logout')];
  return io => new SessionCommands(io, entries, logout, oauth);
 },
};

class SessionCommands {
 names = ['fork', 'clear', 'logout'];
 #io; #entries; #logout; #oauth;
 constructor(io, entries, logout, oauth) { this.#io = io; this.#entries = entries; this.#logout = logout; this.#oauth = oauth; }
 commands() { return this.#entries; }

 async run(parsed) {
  if (parsed.name === 'fork') return this.#fork(parsed.args.trim());
  if (parsed.name === 'clear') return this.#clear(parsed.args.trim());
  return this.#logoutCommand(parsed.args.trim());
 }

 async #fork(args) {
  if (args) throw new Error(`/fork ${args.split(/\s+/)[0]} opens the fork in a terminal pane or window, which the companion has none of. Use /fork alone to fork this session in place.`);
  // As OMP's RPC fork: a snapshot, refused while work could still write into the transcript.
  if (this.#io.session.isStreaming) throw new Error('Wait for the current response to finish or stop it before forking.');
  const r = await this.#io.changeSession('fork', {});
  if (r.cancelled) throw new Error('Fork failed (the session is not saved, still busy, or an extension cancelled it).');
  return { consumed: true, sessionChanged: true, note: 'Forked into a new session file. The previous session file is unchanged.' };
 }

 // OMP's /clear (handleResetContextCommand): the model's context starts empty; the session file keeps the history.
 async #clear(args) {
  if (args) throw new Error('/clear takes no arguments.');
  const s = this.#io.session;
  if (s.isCompacting) { s.abortCompaction(); while (s.isCompacting) await Bun.sleep(10); }
  const r = await s.resetSessionContext();
  if (!r) throw new Error('Wait for the current response to finish or stop it before resetting the context.');
  return { consumed: true, sessionChanged: true, note: `Context reset: ${r.droppedCount} ${r.droppedCount === 1 ? 'message' : 'messages'} dropped; the session continues.` };
 }

 async #logoutCommand(args) {
  const { session, ui, output } = this.#io, auth = session.modelRegistry.authStorage, providers = this.#oauth.getOAuthProviders();
  let provider;
  if (args) {
   provider = providers.find(p => p.id === args);
   if (!provider) throw new Error(`Unknown OAuth provider: ${args}`);
  } else {
   await auth.credentials.reload();
   const stored = providers.filter(p => auth.credentials.has(p.id));
   if (!stored.length) { output('No stored provider credentials to log out. Remove env or config auth at its source.'); return; }
   const picked = await ui.select('Log out of which provider?', stored.map(p => p.name));
   provider = stored.find(p => p.name === picked);
   if (!provider) return;
  }
  const accounts = await this.#logout.listLogoutAccounts(auth, provider.id, session.sessionId);
  if (!accounts.length) {
   const source = auth.keys.describe(provider.storeCredentialsAs ?? provider.id, session.sessionId);
   throw new Error(`Logout skipped: no stored credentials for ${provider.id}.${source ? ` Current auth comes from ${source}; remove that source to log out.` : ''}`);
  }
  const labels = accounts.map((a, i) => `${a.label}${a.active ? ' (active)' : ''}${accounts.some((b, j) => j !== i && b.label === a.label) ? ` #${a.credentialId}` : ''}`);
  const picked = await ui.select(`Log out which ${provider.name} account?`, accounts.map((a, i) => ({ label: labels[i], description: a.detail })));
  const account = accounts[labels.indexOf(picked)];
  if (!account) return;
  const { removed, remainingSource } = await this.#logout.logoutCredential(session.modelRegistry, provider.id, account.credentialId, session.sessionId);
  if (!removed) throw new Error(`Logout skipped: ${account.label} is no longer stored for ${provider.id}.`);
  output(`Logged out ${account.label} from ${provider.id}.${remainingSource ? ` ${provider.id} is still authenticated via ${remainingSource}.` : ''}`);
 }
}
