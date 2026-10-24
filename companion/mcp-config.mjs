// OMP's MCP server configs, read and switched with OMP's own discovery and config writer: the code behind its
// /extensions dashboard and `/mcp enable|disable`. Servers come from OMP's discovery providers: `native`
// (~/.omp/agent/mcp.json, <project>/.omp/mcp.json), `mcp-json` (a project's mcp.json / .mcp.json) and other tools' configs
// OMP imports (Claude Code, Cursor, ...). OMP writes only its own two formats; a server from another tool's file is
// switched through the user-level `disabledServers` / `enabledServers` lists in ~/.omp/agent/mcp.json instead.
// The only per-server setting OMP changes from its UI is on/off, so that is the only one written here.

const WRITABLE = new Set(['native', 'mcp-json']);
const SECRET = /(token|secret|password|passwd|api[-_]?key|apikey|credentials?|auth(orization)?)$/i;
const HIDDEN = '•••';

// Config values can carry credentials: env and header values are never returned (only their names), URL userinfo and
// query values are hidden, and so is the value of an argument named like a secret (`--api-key X`, `--token=X`).
export function maskUrl(raw) {
 try {
  const u = new URL(raw);
  if (u.username || u.password) { u.username = u.username ? HIDDEN : ''; u.password = ''; }
  for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, HIDDEN);
  return u.toString().replaceAll(encodeURIComponent(HIDDEN), HIDDEN);
 } catch { return raw; }
}
export function maskArgs(args) {
 const out = [];
 for (let i = 0; i < args.length; i++) {
  const a = String(args[i]), eq = a.match(/^(--?[\w.-]+)=/);
  if (eq && SECRET.test(eq[1])) out.push(`${eq[1]}=${HIDDEN}`);
  else if (/^https?:\/\//i.test(a)) out.push(maskUrl(a));
  else out.push(a);
  if (!eq && /^--?[\w.-]+$/.test(a) && SECRET.test(a) && i + 1 < args.length) { out.push(HIDDEN); i++; }
 }
 return out;
}

/**
 * One discovered server as the dashboard shows it. `lists` holds the user-level denylist/allowlist and the
 * `disabledExtensions` setting; `gates` OMP's provider switches. State and reason follow OMP's extensions dashboard.
 */
export function serverView(s, { denied, forced, disabledIds, projectConfig, gates }) {
 const src = s._source || {};
 const transport = s.transport ?? (s.command ? 'stdio' : s.url ? 'http' : 'stdio');
 const off = denied.has(s.name) ? 'listed in disabledServers in the user mcp.json'
  : disabledIds.includes(`mcp:${s.name}`) ? 'listed in the disabledExtensions setting'
  : s.enabled === false && !forced.has(s.name) ? 'enabled: false in its config' : '';
 const foreignUser = src.level === 'user' && !gates.isUserSourceEnabled(src.provider) && !(src.provider === 'claude-plugins' && src.origin !== undefined && src.origin !== 'claude');
 const [state, reason] = off ? ['disabled', off]
  : s._shadowed ? ['shadowed', 'a higher-priority config defines a server with this name']
  : !gates.isProviderEnabled(src.provider) ? ['disabled', `the ${src.providerName || src.provider} source is turned off in OMP`]
  : foreignUser ? ['disabled', `user-level ${src.providerName || src.provider} configs are not loaded unless turned on in OMP`]
  : src.level === 'project' && !projectConfig ? ['disabled', 'mcp.enableProjectConfig is off']
  : ['active', ''];
 const v = {
  name: s.name, enabled: !off, state, reason, transport,
  source: { provider: src.provider, providerName: src.providerName || src.provider, path: src.path, level: src.level },
  writable: WRITABLE.has(src.provider),
 };
 if (s.command) v.command = s.command;
 if (s.args?.length) v.args = maskArgs(s.args);
 if (s.cwd) v.cwd = s.cwd;
 if (s.url) v.url = maskUrl(s.url);
 if (s.env && Object.keys(s.env).length) v.env = Object.keys(s.env);
 if (s.headers && Object.keys(s.headers).length) v.headers = Object.keys(s.headers);
 if (s.timeout !== undefined) v.timeout = s.timeout;
 if (s.instructions === false) v.instructions = false;
 if (s.requestIdFormat) v.requestIdFormat = s.requestIdFormat;
 if (s.auth?.type) v.auth = s.auth.type;
 if (s.oauth) v.oauth = true;
 return v;
}

/** Binds OMP's MCP modules from one loaded SDK (`at`/`pkg` resolve inside it; `settings` is the shared settings tree). */
export async function loadMcpConfig({ at, pkg, settings }) {
 const [writer, discovery, utils, ext, mcpSettings] = await Promise.all([
  at('mcp/config-writer.ts'), at('discovery/index.ts'), pkg('@oh-my-pi/pi-utils'), at('extensibility/settings.ts'), at('mcp/settings.ts'),
 ]);
 const disabledIds = () => ext.cfgDisabledExtensions.get(settings) ?? [];
 // `project` picks the project-level configs found from cwd, else every other level. The filter runs before OMP's
 // dedupe, so one scope never shadows the other here.
 const load = async (cwd, project) => {
  const r = await discovery.loadCapability('mcps', { cwd, includeDisabled: true, disabledExtensions: disabledIds(), filter: s => (s._source.level === 'project') === project });
  return { items: r.all, warnings: r.warnings ?? [] };
 };
 // An unreadable user mcp.json throws here: OMP would then ignore its server lists, so the page reports it instead.
 const lists = async cwd => {
  const userPath = utils.getMCPConfigPath('user', cwd);
  const [denied, forced] = await Promise.all([writer.readDisabledServers(userPath), writer.readEnabledServers(userPath)]);
  return { userPath, denied: new Set(denied), forced: new Set(forced) };
 };
 return {
  /** scopes: [{ cwd, project?: { id, name } }]; a scope without `project` lists user-level servers. */
  async list(scopes) {
   const projectConfig = mcpSettings.cfgMcpEnableProjectConfig.get(settings) !== false;
   const { userPath, denied, forced } = await lists(scopes[0]?.cwd);
   const ctx = { denied, forced, disabledIds: disabledIds(), projectConfig, gates: discovery };
   const loaded = await Promise.all(scopes.map(async sc => ({ sc, ...await load(sc.cwd, !!sc.project) })));
   const servers = [], warnings = [];
   for (const { sc, items, warnings: w } of loaded) {
    warnings.push(...w.map(String));
    for (const s of items) servers.push({ ...serverView(s, ctx), ...(sc.project ? { project: sc.project } : {}) });
   }
   return { servers, userFile: userPath, projectConfig, warnings: [...new Set(warnings)] };
  },
  /** Turns one server on or off where OMP's dashboard would write it. */
  async setEnabled({ cwd, project, name, enabled }) {
   const { items } = await load(cwd, project);
   const s = items.find(x => x.name === name && !x._shadowed);
   if (!s) throw Object.assign(new Error(`MCP server "${name}" is not configured${project ? ' in this project' : ''}.`), { status: 404 });
   await writer.setMcpServerEnabled({
    userPath: utils.getMCPConfigPath('user', cwd), projectPath: utils.getMCPConfigPath('project', cwd),
    sourcePath: WRITABLE.has(s._source.provider) ? s._source.path : undefined, name, enabled,
   });
   // As OMP's dashboard does: a legacy `mcp:<name>` entry in disabledExtensions would keep the server off.
   const ids = disabledIds();
   if (enabled && ids.includes(`mcp:${name}`)) { ext.cfgDisabledExtensions.set(settings, ids.filter(id => id !== `mcp:${name}`)); await settings.flush?.(); }
  },
 };
}
