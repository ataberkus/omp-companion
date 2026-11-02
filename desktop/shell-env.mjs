// macOS apps opened from Finder, the Dock, Spotlight or Login Items start with launchd's bare environment
// (PATH=/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's shell profile builds. OMP sessions, the tools they run and the
// companion's own omp, git and editor lookups all inherit the companion's environment, so without this the app would miss
// Homebrew, the omp CLI, nvm's node and API keys exported in ~/.zshrc. Like VS Code, the app asks the user's login shell for
// its environment once, before the companion loads.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Shells that take -i -l -c and expand "$VAR" inside double quotes. Any other login shell (nu, xonsh, pwsh, tcsh…) is
// replaced by zsh, macOS's default, which still runs path_helper (/etc/paths, /etc/paths.d) and the user's zsh files.
const SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish']);
const PROBE = ['OMP_SHELL_ENV_RUNTIME', 'OMP_SHELL_ENV_PROBE', 'OMP_SHELL_ENV_MARK'];
// Per-shell bookkeeping that means nothing outside the shell that set it.
const SKIP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', ...PROBE]);
const MAX_OUTPUT = 8 * 1024 * 1024;

// Resolves to { env } with the login shell's environment, or { error } when the shell fails, prints no environment or
// takes longer than `timeout` ms. `runtime` is a JavaScript runtime that takes -e (the app's Bun) and prints the
// environment as JSON between two random marks, so banners and other output from the user's shell files are ignored.
export function loginShellEnv({ env = process.env, shell = env.SHELL, timeout = 8000, runtime = process.execPath } = {}) {
  const fallback = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
  const sh = shell && path.isAbsolute(shell) && SHELLS.has(path.basename(shell)) ? shell : fallback;
  const mark = randomBytes(16).toString('hex');
  return new Promise(resolve => {
    let out = '', settled = false, timer, child;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The shell may still be finishing its profile; it ends on its own and must not keep this process alive.
      child?.stdout?.destroy();
      child?.unref();
      resolve(result);
    };
    // -i -l: an interactive login shell reads both ~/.zprofile and ~/.zshrc (bash: ~/.bash_profile, which most source
    // ~/.bashrc from). stdin is /dev/null, so a profile that asks something (an update prompt) reads end-of-file at once.
    // Detached: its own session without a terminal, and its own process group to stop as a whole on timeout.
    try {
      child = spawn(sh, ['-i', '-l', '-c', '"$OMP_SHELL_ENV_RUNTIME" -e "$OMP_SHELL_ENV_PROBE"'], {
        env: {
          ...env,
          OMP_SHELL_ENV_RUNTIME: runtime,
          OMP_SHELL_ENV_MARK: mark,
          // The probe's own variables go first: the mark must not appear inside the JSON it frames.
          OMP_SHELL_ENV_PROBE: `const m=process.env.OMP_SHELL_ENV_MARK;for(const k of ${JSON.stringify(PROBE)})delete process.env[k];process.stdout.write(m+JSON.stringify(process.env)+m)`,
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch (e) {
      return finish({ error: `${sh}: ${e.message}` });
    }
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      finish({ error: `${sh} did not finish within ${timeout / 1000} s` });
    }, timeout);
    child.on('error', e => finish({ error: `${sh}: ${e.message}` }));
    child.stdout.setEncoding('utf8').on('data', chunk => {
      out += chunk;
      // Done as soon as the second mark arrives: a background job started by the profile can keep stdout open long after.
      const start = out.indexOf(mark), end = start < 0 ? -1 : out.indexOf(mark, start + mark.length);
      if (end >= 0) {
        try {
          const parsed = JSON.parse(out.slice(start + mark.length, end));
          for (const key of SKIP) delete parsed[key];
          finish({ env: parsed });
        } catch (e) {
          finish({ error: `${sh} printed an unreadable environment: ${e.message}` });
        }
      } else if (out.length > MAX_OUTPUT) {
        finish({ error: `${sh} printed too much output` });
      }
    });
    child.on('close', code => finish({ error: `${sh} exited with code ${code} without printing its environment` }));
  });
}

// Install folders a GUI app's PATH lacks (Homebrew on Apple silicon and Intel, the usual user bin folders), appended when
// they exist and are missing. Used only when the login shell could not be read.
export function addFallbackDirs(env, { home = os.homedir(), exists = existsSync } = {}) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const add = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')]
    .filter(d => !dirs.includes(d) && exists(d));
  if (add.length) env.PATH = [...dirs, ...add].join(path.delimiter);
  return add;
}

// Copies the login shell's environment into `env` (process.env by default) when the app was started from Finder, the
// Dock or Login Items on macOS. Started from a terminal (TERM set: npm run desktop, or the binary run by hand), the
// environment is already the shell's. Variables the shell doesn't set (the app's own) are kept.
export async function adoptLoginShellEnv(env = process.env, { platform = process.platform, ...options } = {}) {
  if (platform !== 'darwin' || env.TERM) return { source: 'inherited' };
  const started = Date.now();
  const { env: shellEnv, error } = await loginShellEnv({ env, ...options });
  const ms = Date.now() - started;
  if (error) return { source: 'fallback', ms, error, added: addFallbackDirs(env, options) };
  Object.assign(env, shellEnv);
  return { source: 'shell', ms };
}
