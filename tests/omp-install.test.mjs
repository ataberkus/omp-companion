import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { installOmp, startupUpdate, updateOmp } from '../companion/server.mjs';
import { ompSetup } from '../companion/update.mjs';

const exec = promisify(execFile);
const win = process.platform === 'win32';
const pathOf = env => env[Object.keys(env).find(k => k.toLowerCase() === 'path')];

// Stands in for OMP's installer: records each run, then puts an `omp` (this Node binary) where the real one does,
// or fails like an offline install. Nothing here touches the network or the real PATH.
const STUB = `const fs = require('node:fs'), path = require('node:path');
const [target, runs, fail, delay] = process.argv.slice(1);
fs.appendFileSync(runs, 'install\\n');
setTimeout(() => {
  if (fail === 'fail') { console.log('Fetching latest release...'); console.error('Failed to resolve an omp build: offline'); process.exit(4); }
  if (fail === 'nothing') return console.log('done');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.linkSync(process.execPath, target); } catch { fs.copyFileSync(process.execPath, target); }
  console.log('Installed omp to ' + target);
}, Number(delay));`;

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omp-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), local = join(home, 'AppData', 'Local'), bin = join(dir, 'bin'), runs = join(dir, 'runs.txt');
  await mkdir(home, { recursive: true });
  await mkdir(bin);
  const target = win ? join(local, 'omp', 'omp.exe') : join(home, '.local', 'bin', 'omp');
  // A PATH holding only an empty folder: no real omp, wherever this runs.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path' && !/^(OMP_BIN|OMP_WEB_NO_UPDATE|OMP_WEB_NO_INSTALL|PI_INSTALL_DIR)$/i.test(k)));
  Object.assign(env, { PATH: bin, LOCALAPPDATA: local });
  const setup = (fail = '', delay = 0) => ({ home, localAppData: local, command: [process.execPath, ['-e', STUB, target, runs, fail, String(delay)]] });
  const installs = async () => (await readFile(runs, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const logs = [], log = m => logs.push(m);
  return { dir, home, local, bin, target, env, setup, installs, logs, log, dataDir: join(dir, 'data') };
}

test('a missing omp is installed on start, then runs from this process and the SDK sync follows', async t => {
  const s = await sandbox(t);
  const result = await startupUpdate({ entry: 'omp', env: s.env, setup: s.setup(), log: s.log, dataDir: s.dataDir, timeout: 60000 });
  assert.equal(result.status, 'installed');
  assert.equal(result.path, s.target);
  assert.equal(await s.installs(), 1);
  // PATH refreshed: the install folder created just now is on it, and `omp` resolves without a restart.
  assert.ok(pathOf(s.env).split(delimiter).includes(dirname(s.target)));
  assert.match((await exec('omp', ['--version'], { env: s.env })).stdout, /^v\d+\./);
  assert.match(s.logs.join('\n'), /omp was not found on PATH; installing OMP/);
  // syncOmpSdk ran against the new CLI (Node's version is no OMP release, so it installs nothing).
  assert.match(s.logs.join('\n'), /OMP SDK not updated: unrecognized OMP CLI version "v\d+/);
  assert.doesNotMatch(s.logs.join('\n'), /Checking for OMP updates/);
});

test('nothing is installed when omp is on PATH or in its install folder, OMP_BIN is set, or an opt-out is set', async t => {
  const s = await sandbox(t);
  const omp = join(s.bin, win ? 'omp.exe' : 'omp');
  assert.equal(ompSetup('omp', { env: { ...s.env }, home: s.home, localAppData: s.local, exists: p => p === omp }), 'ready');
  const env = { ...s.env };
  assert.equal(ompSetup('omp', { env, home: s.home, localAppData: s.local, exists: p => p === dirname(s.target) || p === s.target }), 'ready');
  assert.ok(pathOf(env).split(delimiter).includes(dirname(s.target)));
  assert.equal(ompSetup('omp', { env: { ...s.env }, home: s.home, localAppData: s.local, exists: () => false }), 'install');
  assert.equal(ompSetup('omp', { env: { ...s.env, OMP_WEB_NO_INSTALL: '1' }, home: s.home, localAppData: s.local, exists: () => false }), 'opted-out');
  assert.equal(ompSetup(join(s.dir, 'omp.exe'), { env: { ...s.env }, exists: () => false }), 'missing');
  assert.equal(ompSetup(process.execPath, { env: { ...s.env } }), 'ready');

  const start = (env, entry = 'omp') => startupUpdate({ entry, env, setup: s.setup(), log: s.log, dataDir: s.dataDir, timeout: 60000 });
  assert.deepEqual(await start({ ...s.env, OMP_WEB_NO_UPDATE: '1' }), { status: 'skipped' });
  const optedOut = await start({ ...s.env, OMP_WEB_NO_INSTALL: '1' });
  assert.equal(optedOut.status, 'skipped');
  assert.match(optedOut.output, /OMP_WEB_NO_INSTALL=1.*https:\/\/omp\.sh\/install/);
  const missing = join(s.dir, 'nowhere', win ? 'omp.exe' : 'omp');
  const bad = await start({ ...s.env }, missing);
  assert.equal(bad.status, 'error');
  assert.ok(bad.output.includes(`OMP_BIN is set to ${missing}, which does not exist`));
  const checkout = join(s.dir, 'cli.ts');
  await writeFile(checkout, '');
  assert.equal((await start({ ...s.env }, checkout)).status, 'skipped');
  assert.equal(await s.installs(), 0);
});

test('a failed install is reported in one actionable line and startup carries on', async t => {
  const s = await sandbox(t);
  const result = await startupUpdate({ entry: 'omp', env: s.env, setup: s.setup('fail'), log: s.log, dataDir: s.dataDir, timeout: 60000 });
  assert.equal(result.status, 'error');
  assert.match(result.output, /Fetching latest release/);
  const line = s.logs.at(-1);
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /^OMP could not be installed automatically \(Failed to resolve an omp build: offline\)\. Install it .*omp\.sh\/install/);

  const silent = await installOmp({ env: s.env, ...s.setup('nothing') });
  assert.equal(silent.status, 'error');
  assert.match(silent.summary, /the installer finished, but omp is still not on PATH/);
});

test('an install past the startup budget finishes in the background and reports it', async t => {
  const s = await sandbox(t);
  const started = Date.now();
  const result = await startupUpdate({ entry: 'omp', env: s.env, setup: s.setup('', 1500), log: s.log, dataDir: s.dataDir, timeout: 200 });
  assert.ok(Date.now() - started < 1400, 'startup waited for the install');
  assert.equal(result.status, 'skipped');
  assert.match(s.logs.join('\n'), /Installing OMP continues in the background/);
  const sdk = await result.sdkLate;
  assert.equal(sdk.status, 'skipped');
  assert.match(s.logs.join('\n'), /Installed OMP: /);
  assert.match((await exec('omp', ['--version'], { env: s.env })).stdout, /^v\d+\./);
});

test('one install at a time: Settings\' update joins the running install of a missing OMP', async t => {
  const s = await sandbox(t);
  const first = installOmp({ env: s.env, ...s.setup('', 500) });
  const update = updateOmp('omp', { env: s.env, setup: s.setup('', 500) });
  const [installed, updated] = await Promise.all([first, update]);
  assert.equal(installed.status, 'installed');
  assert.equal(updated.status, 'done');
  assert.match(updated.output, /Installed OMP: /);
  assert.equal(await s.installs(), 1);
});
