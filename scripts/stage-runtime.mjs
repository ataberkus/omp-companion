// Runs before `tauri build` (build.beforeBuildCommand in src-tauri/tauri.conf.json).
// Stages the npm packages the installed app runs into src-tauri/runtime/, which src-tauri/windows/installer-hooks.nsh
// packs as the installed app's node_modules/ (written only when it changed). Left out, because nothing reads them at runtime:
// - devDependencies (the Tauri CLI) and anything only they pull in (`"dev": true` in package-lock.json);
// - source maps and TypeScript declarations (*.map, *.d.ts, *.d.mts, *.d.cts, *.tsbuildinfo);
// - prebuilt native binaries for other platforms (onnxruntime-node's bin/napi-v6/<os>/<arch>/ ships linux, darwin and
//   win32 arm64 builds next to the win32 x64 one the app loads).
// That is about half the files and over a third of the bytes of node_modules/: a smaller installer that installs
// faster. The path is short on purpose: makensis can't open files whose path passes 259 characters, it gets them as
// <repo>\src-tauri\runtime\<package path>, and the deepest package paths are over 150 characters long.
// Files are hard links into node_modules/ (copies where linking fails). The stage is rebuilt when package-lock.json,
// node_modules/.package-lock.json or this script change (src-tauri/runtime.stamp); delete src-tauri/runtime/ to force it.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const dest = path.join(root, 'src-tauri', 'runtime');
const stampFile = path.join(root, 'src-tauri', 'runtime.stamp');

const SKIP_FILE = /\.(?:map|d\.[cm]?ts|tsbuildinfo)$/i;
const OSES = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);

// `rel` is a directory path below a package: true for <napi-vN>/<os>[/<arch>] of another platform than this build's.
function foreignBinaries(rel) {
  const parts = rel.split(path.sep);
  for (let i = 0; i + 1 < parts.length; i++) {
    if (!/^napi-v\d+$/.test(parts[i]) || !OSES.has(parts[i + 1])) continue;
    if (parts[i + 1] !== process.platform) return true;
    if (parts[i + 2] && parts[i + 2] !== process.arch) return true;
  }
  return false;
}

const read = file => { try { return fs.readFileSync(file); } catch { return Buffer.alloc(0); } };
const lockText = read(path.join(root, 'package-lock.json'));
if (!lockText.length || !fs.existsSync(modules)) {
  console.error('stage-runtime: package-lock.json or node_modules/ is missing; run npm ci first.');
  process.exit(1);
}
const stamp = createHash('sha256')
  .update(read(fileURLToPath(import.meta.url)))
  .update(lockText)
  .update(read(path.join(modules, '.package-lock.json')))
  .update(`${process.platform}-${process.arch}`)
  .digest('hex');
if (fs.existsSync(dest) && read(stampFile).toString() === stamp) {
  console.log('stage-runtime: src-tauri/runtime is up to date.');
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.rmSync(stampFile, { force: true });
let linked = 0, copied = 0, bytes = 0;
const place = (from, to) => {
  try { fs.linkSync(from, to); linked++; } catch { fs.copyFileSync(from, to); copied++; }
};
// One package directory, without its own node_modules/ (nested packages are separate lockfile entries).
function stagePackage(pkgDir, outDir) {
  const walk = rel => {
    fs.mkdirSync(path.join(outDir, rel), { recursive: true });
    for (const entry of fs.readdirSync(path.join(pkgDir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (child === 'node_modules' || foreignBinaries(child)) continue;
        walk(child);
      } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
        const from = path.join(pkgDir, child);
        place(from, path.join(outDir, child));
        bytes += fs.statSync(from).size;
      }
    }
  };
  walk('');
}

const { packages = {} } = JSON.parse(lockText.toString());
let count = 0;
for (const [key, info] of Object.entries(packages)) {
  // "" is this project; link entries are workspaces (none here). Optional packages for other platforms aren't installed.
  if (!key.startsWith('node_modules/') || info.dev || info.link) continue;
  const pkgDir = path.join(root, key);
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
  stagePackage(pkgDir, path.join(dest, key.slice('node_modules/'.length)));
  count++;
}
fs.writeFileSync(stampFile, stamp);
console.log(`stage-runtime: ${count} packages, ${linked + copied} files (${(bytes / 1048576).toFixed(0)} MB) staged in src-tauri/runtime${copied ? ` (${copied} copied, hard links failed)` : ''}.`);
