// Smoke test for a built macOS app, run by CI after `npm run build` (node scripts/smoke-app.mjs "<path>/OMP Control Room.app").
// What the build alone can't show: the bundled Bun, which the bundler re-signs with the app's entitlements under the
// hardened runtime, still runs and loads OMP's native modules; the bundled companion host reads the login shell's
// environment when started without a terminal and answers the shell's protocol; and the app opened through
// LaunchServices (as from Finder) starts its companion, serves the dashboard and stops the companion again when it quits.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const app = path.resolve(process.argv[2] || '');
const bun = path.join(app, 'Contents', 'MacOS', 'bun');
const resources = path.join(app, 'Contents', 'Resources');

async function step(name, run) {
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    await run();
    console.log(`✔ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (e) {
    console.error(`✘ ${name}: ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(what, check, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}`);
    await sleep(1000);
  }
}

const answers = async port => (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })).status === 200;
const pids = async pattern => (await exec('pgrep', ['-f', pattern]).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean);

await step('the bundled Bun runs and loads OMP\'s native module', async () => {
  const natives = path.join(resources, 'node_modules', '@oh-my-pi', 'pi-natives', 'native', 'index.js');
  const code = `const n = await import(${JSON.stringify(natives)}); if (typeof n.EditStore !== 'function') throw new Error('no native bindings'); console.log(process.versions.bun, process.arch, Object.keys(n).length + ' native exports')`;
  const { stdout } = await exec(bun, ['-e', code], { timeout: 60000 });
  console.log(`  ${stdout.trim()}`);
});

await step('the bundled companion host reads the login shell, serves the dashboard and quits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omp-smoke-'));
  const port = await freePort();
  // launchd's environment for apps opened from Finder: no TERM, the system PATH only.
  const env = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME || process.env.USER, SHELL: process.env.SHELL || '/bin/zsh', TMPDIR: process.env.TMPDIR || '/tmp', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', OMP_WEB_PORT: String(port), OMP_WEB_DATA_DIR: dir, PI_CODING_AGENT_DIR: dir, OMP_SESSIONS_DIR: path.join(dir, 'sessions'), OMP_WEB_NO_UPDATE: '1' };
  const child = spawn(bun, [path.join(resources, 'desktop', 'host.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async () => {
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error(`the host exited before answering\n${stderr}`);
        try { return JSON.parse(value); } catch {}
      }
    };
    const ready = await Promise.race([next(), sleep(90000).then(() => { throw new Error(`no ready event within 90 s\n${stderr}`); })]);
    if (ready.event !== 'ready' || ready.port !== port) throw new Error(`unexpected first event ${JSON.stringify(ready)}\n${stderr}`);
    if (/Could not read your login shell/.test(stderr)) throw new Error(`the login shell environment was not read:\n${stderr}`);
    if (!(await answers(port))) throw new Error('the dashboard did not answer 200');
    child.stdin.write(JSON.stringify({ id: 1, cmd: 'busy' }) + '\n');
    const busy = await next();
    if (busy.id !== 1 || busy.ok !== true || busy.busy !== 0) throw new Error(`busy: ${JSON.stringify(busy)}`);
    child.stdin.write(JSON.stringify({ id: 2, cmd: 'quit' }) + '\n');
    const quit = await next();
    if (quit.id !== 2 || quit.ok !== true) throw new Error(`quit: ${JSON.stringify(quit)}`);
    const code = await Promise.race([exited, sleep(30000).then(() => 'still running after 30 s')]);
    if (code !== 0) throw new Error(`the host exited with ${code}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

await step('the app opens through LaunchServices, serves the dashboard and stops its companion on quit', async () => {
  const { stdout } = await exec('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Contents', 'Info.plist')]);
  const main = path.join(app, 'Contents', 'MacOS', stdout.trim());
  await exec('open', [app]);
  try {
    await until('the dashboard on port 4545', () => answers(4545), 120000);
    const companions = await pids(bun);
    if (!companions.length) throw new Error('no bundled Bun is running');
    console.log(`  app ${(await pids(main)).join(' ')}, companion ${companions.join(' ')}`);
    await exec('screencapture', ['-x', path.join(process.env.RUNNER_TEMP || tmpdir(), 'omp-app.png')]).catch(e => console.log(`  (no screenshot: ${e.message.split('\n')[0]})`));
    // Quit from outside, as the Dock icon's Quit does; when automation is not allowed here, SIGTERM ends the app instead
    // and the companion must still stop once its pipe from the app closes.
    const quit = await exec('osascript', ['-e', 'tell application id "dev.omp.control-room" to quit'], { timeout: 30000 }).then(() => 'quit event', e => `SIGTERM (osascript: ${e.message.split('\n')[0]})`);
    if (quit !== 'quit event') await exec('pkill', ['-TERM', '-f', main]).catch(() => {});
    console.log(`  stopped with ${quit}`);
    await until('the app and its companion to exit', async () => !(await pids(main)).length && !(await pids(bun)).length, 60000);
    await until('port 4545 to close', async () => !(await answers(4545).catch(() => false)), 30000);
  } finally {
    await exec('pkill', ['-KILL', '-f', app]).catch(() => {});
  }
});

if (process.exitCode) console.error('\nThe macOS app smoke test failed.');
