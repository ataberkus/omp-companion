// Runs before `npm run build`, `npm run dist` and `npm run desktop` (npm pre-scripts).
// Installs the npm dependencies (which include the Tauri CLI) when they are missing, and stops early with
// install commands when Rust or the MSVC build tools are missing, instead of failing halfway through cargo.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); } catch { return null; } };

if (process.platform !== 'win32') {
  console.error('The desktop app builds on Windows only. On this system, run the companion with: node companion/server.mjs');
  process.exit(1);
}

// build.rs copies this Node.js into the app, so the version that builds is the version that ships.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) problems.push(`Node.js 22 or newer is required (this is ${process.version}). Install it from https://nodejs.org or: winget install --id OpenJS.NodeJS.LTS -e`);

if (!existsSync(path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json'))) {
  console.log('npm dependencies (Tauri CLI) are missing; running npm ci…');
  // npm ci installs exactly the committed package-lock.json and never rewrites it, so a fresh clone stays clean.
  // npm_execpath is npm's own CLI when this runs as an npm script; calling it through node avoids npm.cmd shell quoting.
  const [cmd, args] = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, 'ci']] : ['npm', ['ci']];
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: !process.env.npm_execpath });
  if (result.status !== 0) { console.error('npm ci failed; fix the error above and run the build again.'); process.exit(1); }
}

if (run('cargo', ['--version']) === null) {
  // rustup installs into ~/.cargo/bin, but terminals opened before the install do not have it on PATH yet.
  const installed = existsSync(path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe'));
  problems.push(installed
    ? 'Rust is installed but cargo is not on PATH in this terminal. Close it, open a new terminal and run the build again. If it still fails, run: rustup default stable'
    : 'Rust is missing. Install it, then open a new terminal: winget install --id Rustlang.Rustup -e');
}

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const msvc = existsSync(vswhere) && run(vswhere, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
if (!msvc) problems.push('The MSVC C++ build tools are missing (Rust needs their linker). Install them: winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"');

if (problems.length) {
  console.error(`\nThe desktop app cannot be built yet:\n\n${problems.map(p => `- ${p}`).join('\n')}\n`);
  process.exit(1);
}
