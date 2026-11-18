// The Windows fast-update artifacts, made after `tauri build` (release.yml runs it; it works locally too).
//
//   node scripts/pack-update.mjs pack [--config <overlay.json>] [--exe <path>] [--out <dir>] [--unsigned]
//     --config merges a config file over tauri.conf.json as `tauri build --config` does (version, mainBinaryName)
//     <out>/omp-control-room_<version>_x64-app.tar.br     the app: omp-control-room.exe and bundle.resources
//                                                         (companion/, local-dist/, desktop/), about 4 MB
//     <out>/omp-control-room_runtime-<stamp>_x64.tar.br   the runtime: node_modules/ (src-tauri/runtime, staged by
//                                                         stage-runtime.mjs), bun.exe and node_modules/.runtime-id
//     <out>/omp-update-windows-x86_64.json                both files' names, sizes and signatures, for `manifest`
//   Each archive is signed with the updater key (TAURI_SIGNING_PRIVATE_KEY, as for the installer) through
//   `tauri signer sign --app-version`, which binds the version and the file name into the signature's trusted
//   comment: the app accepts a file only under its own name for the announced version, so no artifact of another
//   release or runtime stamp passes for this one. --unsigned skips signing (local tests of the archives only).
//
//   node scripts/pack-update.mjs manifest <latest.json> <omp-update-windows-x86_64.json> <base url>
//     adds platforms["windows-x86_64-fast"] to latest.json (url and signature of the app archive, like every platform
//     entry, so tauri-plugin-updater still parses the manifest; plus size and the runtime). Run again after other
//     jobs rewrote latest.json; it is idempotent.
//
// The installed app (src-tauri/src/update.rs) downloads the app archive for every update and the runtime archive only
// when its node_modules\.runtime-id differs from the stamp, unpacks both beside the running app and swaps them in by
// renaming folders (src-tauri/src/fast.rs). The installer (NSIS) is still made for first installs and manual
// downloads, and old versions (1.0.45 and earlier) keep updating through it via platforms["windows-x86_64"].
//
// Format: one GNU tar stream, brotli-compressed with a 16 MB window (.tar.br). Solid compression matters here: the
// runtime's ~9,000 small, similar files came to 141 MB as a per-file-deflate zip and to 104 MB this way (quality 9),
// near the installer's LZMA, and the app decompresses it in about a second and writes the files on several threads.
// Every entry carries the same date and mode, so the same input makes the same bytes.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'src-tauri');
export const TARGET = 'windows-x86_64';
export const FAST_KEY = `${TARGET}-fast`;
const FRAGMENT = `omp-update-${TARGET}.json`;
// Brotli quality: 9 compresses the runtime in about 30 s, 11 is a few percent smaller and several times slower.
const QUALITY = 9;

export const appArchiveName = version => `omp-control-room_${version}_x64-app.tar.br`;
export const runtimeArchiveName = stamp => `omp-control-room_runtime-${stamp}_x64.tar.br`;

// One 512-byte GNU tar header.
function header(name, size, type) {
  const h = Buffer.alloc(512);
  const field = (value, offset, length) => h.write(value, offset, length, 'utf8');
  const octal = (n, offset, length) => field(n.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  field(name, 0, 100);
  octal(type === '5' ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  h.fill(' ', 148, 156);
  field(type, 156, 1);
  field('ustar  \0', 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

const pad = n => Buffer.alloc((512 - (n % 512)) % 512);

// The tar stream of `entries` ([{ name: 'a/b.js', file } | { name, data }]): names longer than 100 bytes get a GNU
// long-name record first.
async function* tarStream(entries) {
  for (const { name, file, data } of entries) {
    const body = data ?? await fs.promises.readFile(file);
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 100) {
      const long = Buffer.concat([nameBuf, Buffer.from([0])]);
      yield header('././@LongLink', long.length, 'L');
      yield long;
      yield pad(long.length);
    }
    yield header(name, body.length, '0');
    yield body;
    yield pad(body.length);
  }
  yield Buffer.alloc(1024);
}

// [{ name: 'a/b.js', file: '/abs/path' } | { name, data }] → a .tar.br at `out`. Directories are implied by the names.
export async function writeArchive(out, entries, { quality = QUALITY } = {}) {
  const seen = new Set();
  let bytes = 0;
  for (const e of entries) {
    const { name } = e;
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '' || p === '.')) throw new Error(`Invalid archive entry name: ${name}`);
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate archive entry: ${name}`);
    seen.add(name.toLowerCase());
    bytes += e.data ? e.data.length : fs.statSync(e.file).size;
  }
  const tmp = `${out}.tmp`;
  const brotli = zlib.createBrotliCompress({ params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes,
  } });
  await pipeline(tarStream(entries), brotli, fs.createWriteStream(tmp));
  fs.renameSync(tmp, out);
  return { size: fs.statSync(out).size, entries: entries.length, bytes };
}

// Every file under dir as archive entries below prefix ('' or 'name/'), in a stable order.
function tree(dir, prefix, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(file, `${prefix}${entry.name}/`, out);
    else if (entry.isFile()) out.push({ name: `${prefix}${entry.name}`, file });
  }
  return out;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The app archive's entries: the main executable and bundle.resources, laid out as the installer lays them out.
export function appEntries(conf, exe) {
  const entries = [{ name: path.basename(exe), file: exe }];
  for (const [from, to] of Object.entries(conf.bundle.resources)) {
    const src = path.resolve(tauriDir, from);
    if (fs.statSync(src).isDirectory()) tree(src, to.replace(/\/?$/, '/'), entries);
    else entries.push({ name: to, file: src });
  }
  return entries;
}

function sign(file, version) {
  // npx tauri signer sign reads TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) from the environment and writes <file>.sig.
  const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  execFileSync(process.execPath, [cli, 'signer', 'sign', '--app-version', version, file], { stdio: ['ignore', 'ignore', 'inherit'] });
  return fs.readFileSync(`${file}.sig`, 'utf8').trim();
}

const arg = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// `tauri build --config`: objects merge key by key, anything else replaces.
const merge = (base, over) => {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
};

async function pack(args) {
  if (process.platform !== 'win32') throw new Error('Fast-update artifacts are made for the Windows build only (macOS updates through the .app.tar.gz).');
  const overlay = arg(args, '--config');
  const conf = merge(readJson(path.join(tauriDir, 'tauri.conf.json')), overlay ? readJson(path.resolve(overlay)) : {});
  const { version } = conf;
  const binary = conf.mainBinaryName ?? 'omp-control-room';
  const exe = path.resolve(arg(args, '--exe') ?? path.join(tauriDir, 'target', 'release', `${binary}.exe`));
  const out = path.resolve(arg(args, '--out') ?? path.join(tauriDir, 'target', 'release', 'bundle', 'omp-update'));
  const unsigned = args.includes('--unsigned');
  if (!unsigned && !process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('TAURI_SIGNING_PRIVATE_KEY is not set: the app installs only signed updates (or pass --unsigned for a local test).');
  const stampFile = path.join(tauriDir, 'runtime.stamp');
  const runtimeDir = path.join(tauriDir, 'runtime');
  if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; run the build first.`);
  if (!fs.existsSync(stampFile) || !fs.existsSync(runtimeDir)) throw new Error('src-tauri/runtime is not staged; run the build (or node scripts/stage-runtime.mjs) first.');
  const stamp = fs.readFileSync(stampFile, 'utf8').trim();
  const bun = path.join(tauriDir, 'binaries', 'bun-x86_64-pc-windows-msvc.exe');
  if (!fs.existsSync(bun)) throw new Error(`${bun} is missing; the build bundles it (src-tauri/build.rs).`);
  fs.mkdirSync(out, { recursive: true });

  const started = Date.now();
  const appFile = path.join(out, appArchiveName(version));
  const app = await writeArchive(appFile, appEntries(conf, exe), { quality: 11 });
  const runtimeFile = path.join(out, runtimeArchiveName(stamp));
  let runtime;
  if (fs.existsSync(runtimeFile)) {
    runtime = { size: fs.statSync(runtimeFile).size, reused: true };
  } else {
    // .runtime-id goes last: the NSIS hooks and the app read it as "this node_modules is complete".
    const entries = [...tree(runtimeDir, 'node_modules/'), { name: 'bun.exe', file: bun }, { name: 'node_modules/.runtime-id', data: Buffer.from(stamp) }];
    runtime = await writeArchive(runtimeFile, entries);
  }
  for (const old of fs.readdirSync(out)) {
    if (/^omp-control-room_(runtime-[0-9a-f]+|[\d.]+)_x64(-app)?\.tar\.br(\.sig)?$/.test(old) && !old.startsWith(path.basename(runtimeFile)) && !old.startsWith(path.basename(appFile))) fs.rmSync(path.join(out, old));
  }
  const fragment = {
    version,
    target: TARGET,
    app: { file: path.basename(appFile), size: app.size, signature: unsigned ? '' : sign(appFile, version) },
    runtime: { stamp, file: path.basename(runtimeFile), size: runtime.size, signature: unsigned ? '' : sign(runtimeFile, version) },
  };
  fs.writeFileSync(path.join(out, FRAGMENT), JSON.stringify(fragment, null, 2));
  const mb = n => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`pack-update: ${fragment.app.file} ${mb(app.size)} (${app.entries} files), ${fragment.runtime.file} ${mb(runtime.size)}${runtime.reused ? ' (reused)' : ` (${runtime.entries} files)`}, ${unsigned ? 'unsigned' : 'signed'}, in ${((Date.now() - started) / 1000).toFixed(1)} s → ${out}`);
}

// Adds the fast-update entry to a release's latest.json.
export function mergeManifest(latest, fragment, baseUrl) {
  if (latest.version !== fragment.version) throw new Error(`latest.json is for ${latest.version}, the fast-update artifacts for ${fragment.version}.`);
  if (!fragment.app.signature || !fragment.runtime.signature) throw new Error('The fast-update artifacts are unsigned; installed apps would refuse them.');
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  latest.platforms ??= {};
  latest.platforms[FAST_KEY] = {
    url: new URL(encodeURIComponent(fragment.app.file), base).href,
    signature: fragment.app.signature,
    size: fragment.app.size,
    runtime: {
      stamp: fragment.runtime.stamp,
      url: new URL(encodeURIComponent(fragment.runtime.file), base).href,
      signature: fragment.runtime.signature,
      size: fragment.runtime.size,
    },
  };
  return latest;
}

function manifest([latestFile, fragmentFile, baseUrl]) {
  if (!latestFile || !fragmentFile || !baseUrl) throw new Error('usage: pack-update.mjs manifest <latest.json> <omp-update-windows-x86_64.json> <base url>');
  const merged = mergeManifest(readJson(latestFile), readJson(fragmentFile), baseUrl);
  fs.writeFileSync(latestFile, JSON.stringify(merged, null, 2));
  console.log(`pack-update: ${latestFile} now offers the fast update for ${merged.version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'pack') await pack(args);
    else if (cmd === 'manifest') manifest(args);
    else throw new Error('usage: pack-update.mjs pack [--exe <path>] [--out <dir>] [--unsigned] | manifest <latest.json> <fragment.json> <base url>');
  } catch (e) {
    console.error(`pack-update: ${e.message}`);
    process.exit(1);
  }
}
