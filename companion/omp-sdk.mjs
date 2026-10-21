// OMP's SDK for in-process sessions. The companion ships one (@oh-my-pi/pi-coding-agent in its node_modules), but
// `omp update` only replaces the OMP CLI. So each update also installs the SDK release matching the updated CLI under
// <data dir>/omp-sdk/<version>, and sessions load the newest copy there when it is newer than the shipped one.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PACKAGE = '@oh-my-pi/pi-coding-agent';
const VERSION = /^\d+\.\d+\.\d+$/;

/** The SDK files (under its src/) companion/omp.mjs imports; a copy missing one cannot run sessions. */
export const RUNTIME_FILES = {
 sdk: 'sdk.ts', settingsMod: 'config/settings.ts', registryMod: 'config/model-registry.ts', configRegistry: 'config/registry.ts',
 main: 'main.ts', cliArgs: 'cli/args.ts', toolSettings: 'tools/settings.ts', authSync: 'session/auth-broker-config.ts',
 discovery: 'discovery/index.ts', discoveryHelpers: 'discovery/helpers.ts', bus: 'utils/event-bus.ts', runtimeInit: 'modes/runtime-init.ts',
 rpc: 'modes/rpc/rpc-mode.ts', btw: 'modes/rpc/rpc-btw.ts', goal: 'modes/rpc/rpc-goal.ts', results: 'modes/rpc/rpc-prompt-results.ts',
 settle: 'modes/rpc/rpc-session-settle.ts', subagents: 'modes/rpc/rpc-subagents.ts', compat: 'modes/rpc/rpc-compat.ts',
 builtins: 'slash-commands/acp-builtins.ts', available: 'slash-commands/available-commands.ts', messages: 'session/messages.ts',
 todo: 'tools/todo.ts', tokenRate: 'utils/token-rate.ts', modeSettings: 'modes/settings.ts', predict: 'predict/client.ts',
};

export function compareVersions(a, b) {
 const x = a.split('.').map(Number), y = b.split('.').map(Number);
 for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
 return 0;
}

const bundledSrc = () => path.dirname(fileURLToPath(import.meta.resolve(PACKAGE)));
const versionAt = src => { try { return JSON.parse(readFileSync(path.join(src, '..', 'package.json'), 'utf8')).version; } catch { return undefined; } };
const store = dataDir => path.join(dataDir, 'omp-sdk');
const srcIn = dir => path.join(dir, 'node_modules', ...PACKAGE.split('/'), 'src');

/** Installed SDK copies newer than the bundled SDK, newest first: their src/ folders. */
function newerCopies(dataDir) {
 const bundled = versionAt(bundledSrc());
 let names;
 try { names = readdirSync(store(dataDir)); } catch { return []; }
 return names.filter(n => VERSION.test(n) && (!bundled || compareVersions(n, bundled) > 0) && existsSync(path.join(srcIn(path.join(store(dataDir), n)), 'sdk.ts')))
  .sort((a, b) => compareVersions(b, a)).map(n => srcIn(path.join(store(dataDir), n)));
}

/** Folders of OMP's TypeScript sources to load sessions from, preferred first: the checkout whose cli.ts OMP_BIN names,
 *  else the newest installed SDK copy (when newer than the bundled one), then the bundled SDK. */
export function ompSources(entry, dataDir) {
 if (/\.ts$/i.test(entry || '')) return [path.dirname(path.resolve(entry))];
 return [...(dataDir ? newerCopies(dataDir).slice(0, 1) : []), bundledSrc()];
}

/** Environment for running the OMP CLI: an absolute executable path also puts its folder on PATH. */
export function cliEnv(entry) {
 const env = { ...process.env };
 if (path.isAbsolute(entry) && !/\.ts$/i.test(entry)) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[key] = path.dirname(entry) + path.delimiter + (env[key] || '');
 }
 return env;
}

const errorTail = e => String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ').slice(0, 500);

let syncing;
/**
 * Installs the OMP SDK release matching the OMP CLI's version (`entry --version`) when it is newer than the copy sessions
 * load now. `prune()` returning true (startup, before any session loads OMP) also deletes older copies and leftovers of
 * interrupted installs. Never throws: { status: 'installed'|'current'|'skipped'|'error', version?, output? }.
 */
export function syncOmpSdk(options) {
 return syncing ??= sync(options).finally(() => { syncing = undefined; });
}

async function sync({ entry, dataDir, prune = () => false, timeout = 20 * 60 * 1000 }) {
 const root = store(dataDir);
 try {
  let cli;
  try { cli = (await exec(entry, ['--version'], { env: cliEnv(entry), timeout: 30000, windowsHide: true })).stdout; }
  catch (e) { return { status: 'skipped', output: `OMP SDK not updated: could not read the OMP CLI version (${errorTail(e)}).` }; }
  // `omp --version` prints `omp/18.12.5`; anything else (a prerelease, another program) is not an SDK release to install.
  const version = /^omp\/(\d+\.\d+\.\d+)\s*$/m.exec(String(cli))?.[1];
  if (!version) return { status: 'skipped', output: `OMP SDK not updated: unrecognized OMP CLI version "${String(cli).trim().slice(0, 100)}".` };
  const copy = newerCopies(dataDir)[0], active = versionAt(copy ?? bundledSrc());
  if (active && compareVersions(version, active) <= 0) {
   if (prune()) await pruneStore(root, copy ? active : undefined);
   return { status: 'current', version: active };
  }
  const dir = path.join(root, version), tmp = `${dir}.partial-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'omp-companion-sdk', private: true, dependencies: { [PACKAGE]: version } }, null, 1));
  try { await exec(process.versions.bun ? process.execPath : 'bun', ['install', '--production', '--no-progress'], { cwd: tmp, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); return { status: 'error', output: `Installing OMP SDK ${version} failed; sessions keep OMP ${active}. ${errorTail(e)}` }; }
  const src = srcIn(tmp), missing = Object.values(RUNTIME_FILES).filter(f => !existsSync(path.join(src, f)));
  if (versionAt(src) !== version || missing.length) {
   await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
   return { status: 'error', output: `OMP SDK ${version} does not fit this companion${missing.length ? ` (missing ${missing.join(', ')})` : ''}; sessions keep OMP ${active}. Update the companion.` };
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmp, dir);
  if (prune()) await pruneStore(root, version);
  return { status: 'installed', version, output: `Installed OMP SDK ${version} for sessions.` };
 } catch (e) { return { status: 'error', output: `OMP SDK update failed: ${errorTail(e)}` }; }
}

/** Deletes every entry of the SDK store except `keep` (a version folder). */
async function pruneStore(root, keep) {
 let names;
 try { names = await fs.readdir(root); } catch { return; }
 await Promise.all(names.filter(n => n !== keep).map(n => fs.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {})));
}
