import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { addFallbackDirs, adoptLoginShellEnv, loginShellEnv } from '../desktop/shell-env.mjs';

// The fake shells are POSIX scripts; the app reads login shells on macOS only.
const skip = process.platform === 'win32' && 'needs a POSIX shell';

// A stand-in for the user's login shell: `profile` plays ~/.zprofile and ~/.zshrc, then the -c command runs.
async function fakeShell(t, name, profile) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-shell-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shell = join(dir, name);
  await writeFile(shell, `#!/bin/sh\n${profile}\nwhile [ $# -gt 1 ]; do shift; done\n/bin/sh -c "$1"\n`);
  await chmod(shell, 0o755);
  return shell;
}

const profile = [
  'echo "Last login: Mon on ttys001"',
  'export PATH="/opt/homebrew/bin:$PATH"',
  'export ANTHROPIC_API_KEY="from-zshrc"',
  'export NOTE="two',
  'lines"',
  'unset GONE',
].join('\n');

test('the login shell environment is read around the noise its profile prints', { skip }, async t => {
  const shell = await fakeShell(t, 'zsh', `${profile}\ntrap 'echo bye' EXIT`);
  const { env, error } = await loginShellEnv({ shell, env: { PATH: '/usr/bin:/bin', HOME: '/Users/me', GONE: 'x' } });
  assert.equal(error, undefined);
  assert.equal(env.PATH.split(delimiter)[0], '/opt/homebrew/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'from-zshrc');
  assert.equal(env.NOTE, 'two\nlines');
  assert.equal(env.HOME, '/Users/me');
  assert.equal('GONE' in env, false);
  for (const key of ['OMP_SHELL_ENV_RUNTIME', 'OMP_SHELL_ENV_PROBE', 'OMP_SHELL_ENV_MARK', 'PWD', 'SHLVL', '_']) assert.equal(key in env, false, key);
});

test('a shell that hangs is stopped at the timeout, and one that fails reports it', { skip }, async t => {
  const started = Date.now();
  const hung = await loginShellEnv({ shell: await fakeShell(t, 'bash', 'sleep 30'), env: { PATH: '/usr/bin:/bin' }, timeout: 300 });
  assert.match(hung.error, /did not finish within 0.3 s/);
  assert.ok(Date.now() - started < 5000);
  const failed = await loginShellEnv({ shell: await fakeShell(t, 'zsh', 'exit 3'), env: { PATH: '/usr/bin:/bin' } });
  assert.match(failed.error, /exited with code 3/);
});

test('a profile that leaves a background job holding stdout does not delay the result', { skip }, async t => {
  const shell = await fakeShell(t, 'zsh', 'sleep 3 &');
  const started = Date.now();
  const { env, error } = await loginShellEnv({ shell, env: { PATH: '/usr/bin:/bin' }, timeout: 10000 });
  assert.equal(error, undefined);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.ok(Date.now() - started < 2500);
});

test('the app adopts the login shell environment on macOS only when not started from a terminal', { skip }, async t => {
  const shell = await fakeShell(t, 'zsh', profile);
  const gui = { PATH: '/usr/bin:/bin', __CFBundleIdentifier: 'dev.omp.control-room', GONE: 'x' };
  assert.equal((await adoptLoginShellEnv(gui, { platform: 'darwin', shell })).source, 'shell');
  assert.equal(gui.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(gui.ANTHROPIC_API_KEY, 'from-zshrc');
  // Variables the shell keeps stay; the profile's unset doesn't remove the app's own.
  assert.equal(gui.__CFBundleIdentifier, 'dev.omp.control-room');
  assert.equal(gui.GONE, 'x');
  const terminal = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' };
  assert.deepEqual(await adoptLoginShellEnv(terminal, { platform: 'darwin', shell }), { source: 'inherited' });
  assert.equal(terminal.PATH, '/usr/bin:/bin');
  const windows = { PATH: 'C:\\Windows' };
  assert.deepEqual(await adoptLoginShellEnv(windows, { platform: 'win32', shell }), { source: 'inherited' });
});

test('when the shell fails, common install folders that exist are added to PATH', { skip }, async t => {
  const shell = await fakeShell(t, 'zsh', 'exit 1');
  const env = { PATH: '/usr/bin:/bin' };
  const result = await adoptLoginShellEnv(env, { platform: 'darwin', shell, home: '/Users/me', exists: d => d !== '/usr/local/bin' });
  assert.equal(result.source, 'fallback');
  assert.match(result.error, /exited with code 1/);
  assert.deepEqual(result.added, ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/Users/me/.local/bin', '/Users/me/.bun/bin']);
  assert.equal(env.PATH, '/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/Users/me/.local/bin:/Users/me/.bun/bin');
  assert.deepEqual(addFallbackDirs(env, { home: '/Users/me', exists: () => true }), ['/usr/local/bin']);
});
