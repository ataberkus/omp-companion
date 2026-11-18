//! Windows in-app updates, the file side: unpack signed `.tar.br` archives next to the install, swap them in with
//! directory renames, and put the old version back when the new one cannot start. update.rs drives it.
//!
//! The install keeps the layout the NSIS installer writes (exe, companion\, local-dist\, desktop\, node_modules\,
//! bun.exe in one folder), so shortcuts, the uninstaller, the registry entry and Tauri's resource dir stay valid.
//! Everything an update writes lives in `<install>\.update\`:
//!
//! - `download\`: the archives as they download (`.part` until complete); resumable.
//! - `staged\<version>\`: the unpacked top-level entries of the next version; `staged\<version>.json` (written last)
//!   says it is complete. The runtime entries (node_modules, bun.exe) are only there when the runtime changed.
//! - `previous\`: the entries a swap replaced, kept until the new version confirms it started.
//! - `journal.json`: written before the first rename of a swap, removed after the last; a journal found at start means
//!   a swap was cut off (power loss, crash), and `recover` puts the old version back, so no mixed versions survive.
//! - `applied.json`: a swap that has not been confirmed yet. Each start of the new version counts an attempt; past
//!   `MAX_ATTEMPTS`, or when its companion fails to start, `rollback` restores `previous\`.
//! - `failed.json`: a version that was rolled back; it is not installed this way again.
//! - `trash\`: entries on their way out, deleted in the background.
//!
//! A running exe can be renamed on Windows (not deleted or overwritten), so the old process swaps itself out after
//! its companion has stopped; there is no helper process.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{self, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Starts of an unconfirmed update before it is rolled back: one crash is retried, a second one is not.
pub const MAX_ATTEMPTS: u32 = 2;
/// Written into node_modules by the runtime archive and the installer: the runtime build it holds.
pub const RUNTIME_ID: &str = "node_modules/.runtime-id";
/// Top-level names an archive must never replace.
const RESERVED: [&str; 3] = [".update", "uninstall.exe", ".previous"];

pub struct Paths {
    pub download: PathBuf,
    pub staged: PathBuf,
    pub previous: PathBuf,
    pub trash: PathBuf,
    journal: PathBuf,
    applied: PathBuf,
    failed: PathBuf,
}

pub fn paths(install: &Path) -> Paths {
    let root = install.join(".update");
    Paths {
        download: root.join("download"),
        staged: root.join("staged"),
        previous: root.join("previous"),
        trash: root.join("trash"),
        journal: root.join("journal.json"),
        applied: root.join("applied.json"),
        failed: root.join("failed.json"),
    }
}

/// A complete staged version: `staged\<version>\` holds `entries`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Staged {
    pub version: String,
    /// The runtime stamp when the runtime is part of it, None when the installed runtime stays.
    pub runtime: Option<String>,
    pub entries: Vec<String>,
}

/// A swap in progress (journal.json) or done and unconfirmed (applied.json).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Swap {
    pub from: String,
    pub to: String,
    pub entries: Vec<String>,
    /// The entries that existed before the swap (the rest are new and are removed when it is undone).
    pub old: Vec<String>,
    #[serde(default)]
    pub attempts: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Failed {
    pub version: String,
    pub error: String,
    #[serde(default)]
    pub reported: bool,
}

fn read_json<T: DeserializeOwned>(file: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(file).ok()?).ok()
}

/// Write-then-rename, so a reader never sees half a file.
fn write_json<T: Serialize>(file: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, file)
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Removes a file or a directory tree; absent is fine.
pub fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

/// Sharing violations (32, 33) and access denied (5, also a file held open by a scanner or a still-exiting process)
/// usually clear within seconds; they are retried for up to `LOCK_WAIT`.
#[cfg(not(test))]
const LOCK_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
const LOCK_WAIT: Duration = Duration::from_millis(500);

/// An OS error with the path it happened on; `os_code` still finds the error code underneath.
#[derive(Debug)]
pub struct PathError {
    pub source: io::Error,
    pub path: PathBuf,
}
impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{} ({})", self.source, self.path.display())
    }
}
impl std::error::Error for PathError {}

pub fn at(source: io::Error, path: &Path) -> io::Error {
    io::Error::new(source.kind(), PathError { source, path: path.to_path_buf() })
}

pub fn os_code(e: &io::Error) -> Option<i32> {
    e.raw_os_error().or_else(|| e.get_ref()?.downcast_ref::<PathError>()?.source.raw_os_error())
}
pub fn is_locked(e: &io::Error) -> bool {
    matches!(os_code(e), Some(5 | 32 | 33))
}
pub fn is_disk_full(e: &io::Error) -> bool {
    matches!(os_code(e), Some(39 | 112)) || e.kind() == io::ErrorKind::StorageFull
}

fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let start = Instant::now();
    loop {
        match fs::rename(from, to) {
            Err(e) if is_locked(&e) && start.elapsed() < LOCK_WAIT => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(at(e, from)),
            Ok(()) => return Ok(()),
        }
    }
}

/// An archive member's path below the destination, or an error for anything that could escape it.
fn member_path(name: &Path) -> io::Result<PathBuf> {
    let mut out = PathBuf::new();
    for c in name.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unsafe path in update archive: {}", name.display()))),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "empty path in update archive"));
    }
    Ok(out)
}

struct Counting<R> {
    inner: R,
    read: Arc<AtomicU64>,
}
impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

pub fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled")
}

/// Unpacks a `.tar.br` archive into `dest`. Decompression is one stream; files are written by a few threads, which is
/// what makes thousands of small node_modules files fast (each create/close is a round trip through the file system
/// filter drivers, AV included). `progress(compressed bytes read, archive size)`. Returns the number of files.
pub fn unpack(archive: &Path, dest: &Path, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> io::Result<usize> {
    let file = fs::File::open(archive)?;
    let total = file.metadata()?.len();
    let read = Arc::new(AtomicU64::new(0));
    let counting = Counting { inner: BufReader::with_capacity(1 << 20, file), read: read.clone() };
    let mut tar = tar::Archive::new(brotli_decompressor::Decompressor::new(counting, 1 << 16));
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    let (tx, rx) = mpsc::sync_channel::<(PathBuf, Vec<u8>)>(workers * 4);
    let rx = Mutex::new(rx);
    let failed: Mutex<Option<io::Error>> = Mutex::new(None);
    let mut files = 0usize;
    let result = std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let job = rx.lock().unwrap().recv();
                let Ok((path, data)) = job else { break };
                if let Err(e) = fs::write(&path, &data) {
                    failed.lock().unwrap().get_or_insert(at(e, &path));
                }
            });
        }
        let mut dirs: HashSet<PathBuf> = HashSet::new();
        let mut last = Instant::now();
        let produce = (|| -> io::Result<()> {
            for entry in tar.entries()? {
                if cancel.load(Ordering::Relaxed) {
                    return Err(cancelled());
                }
                if let Some(e) = failed.lock().unwrap().take() {
                    return Err(e);
                }
                let mut entry = entry?;
                let rel = member_path(&entry.path()?)?;
                let target = dest.join(&rel);
                match entry.header().entry_type() {
                    tar::EntryType::Directory => {
                        fs::create_dir_all(&target)?;
                        dirs.insert(target);
                    }
                    tar::EntryType::Regular | tar::EntryType::Continuous => {
                        if let Some(parent) = target.parent() {
                            if !dirs.contains(parent) {
                                fs::create_dir_all(parent)?;
                                dirs.insert(parent.to_path_buf());
                            }
                        }
                        let mut data = Vec::with_capacity(entry.size() as usize);
                        entry.read_to_end(&mut data)?;
                        tx.send((target, data)).map_err(|_| io::Error::other("update writer stopped"))?;
                        files += 1;
                    }
                    other => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("unexpected {other:?} entry in update archive: {}", rel.display()))),
                }
                if last.elapsed() > Duration::from_millis(100) {
                    last = Instant::now();
                    progress(read.load(Ordering::Relaxed), total);
                }
            }
            Ok(())
        })();
        drop(tx);
        produce
    });
    if let Some(e) = failed.into_inner().unwrap() {
        return Err(e);
    }
    result?;
    progress(total, total);
    Ok(files)
}

/// The runtime stamp of the installed node_modules (empty when it has none).
pub fn installed_runtime(install: &Path) -> String {
    fs::read_to_string(install.join(RUNTIME_ID)).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Unpacks the app archive (and the runtime archive when the runtime changed) into `staged\<version>\`. Only a complete
/// stage gets its `staged\<version>.json`; any other staged version is removed.
pub fn stage(install: &Path, exe: &str, version: &str, app: &Path, runtime: Option<(&Path, &str)>, progress: &(dyn Fn(u64, u64) + Sync), cancel: &AtomicBool) -> io::Result<Staged> {
    let p = paths(install);
    fs::create_dir_all(&p.staged)?;
    let partial = p.staged.join(format!("{version}.partial"));
    remove(&partial)?;
    fs::create_dir_all(&partial)?;
    let app_size = fs::metadata(app)?.len();
    let total = app_size + runtime.map_or(0, |(r, _)| fs::metadata(r).map_or(0, |m| m.len()));
    unpack(app, &partial, &|done, _| progress(done, total), cancel)?;
    if let Some((archive, stamp)) = runtime {
        unpack(archive, &partial, &|done, _| progress(app_size + done, total), cancel)?;
        let got = fs::read_to_string(partial.join(RUNTIME_ID)).unwrap_or_default();
        if got.trim() != stamp {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("the runtime archive is for runtime {}, expected {stamp}", got.trim())));
        }
    }
    if !partial.join(exe).is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("the update has no {exe}")));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&partial)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&name)) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("the update may not replace {name}")));
        }
        entries.push(name);
    }
    entries.sort();
    // node_modules carries .runtime-id: a staged runtime without node_modules (or the reverse) would mismatch bun.exe.
    if runtime.is_some() != entries.iter().any(|e| e == "node_modules") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the update's runtime entries do not match its manifest"));
    }
    let staged = Staged { version: version.into(), runtime: runtime.map(|(_, s)| s.to_string()), entries };
    let dir = p.staged.join(version);
    remove(&p.staged.join(format!("{version}.json")))?;
    remove(&dir)?;
    rename(&partial, &dir)?;
    write_json(&p.staged.join(format!("{version}.json")), &staged)?;
    for entry in fs::read_dir(&p.staged)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != version && name != format!("{version}.json") {
            let _ = remove(&entry.path());
        }
    }
    Ok(staged)
}

/// The complete staged version, if one is there.
pub fn staged(install: &Path) -> Option<Staged> {
    let p = paths(install);
    for entry in fs::read_dir(&p.staged).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = name.strip_suffix(".json") else { continue };
        let Some(s) = read_json::<Staged>(&entry.path()) else { continue };
        let dir = p.staged.join(version);
        if s.version == version && s.entries.iter().all(|e| exists(&dir.join(e))) {
            return Some(s);
        }
    }
    None
}

pub fn drop_staged(install: &Path) {
    let _ = remove(&paths(install).staged);
}

/// Swaps the staged version in: each entry of the install moves to `previous\`, the staged one takes its place. Any
/// failure puts everything back (into `staged\`, so Retry needs no new download); `journal.json` covers a crash
/// halfway. `step(done, total)` counts moves.
pub fn apply(install: &Path, exe: &str, from: &str, staged: &Staged, step: &mut dyn FnMut(usize, usize)) -> io::Result<Swap> {
    let p = paths(install);
    let src = p.staged.join(&staged.version);
    if !src.join(exe).is_file() || !staged.entries.iter().all(|e| exists(&src.join(e))) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "the staged update is incomplete"));
    }
    remove(&p.previous)?;
    fs::create_dir_all(&p.previous)?;
    let old: Vec<String> = staged.entries.iter().filter(|e| exists(&install.join(e))).cloned().collect();
    let swap = Swap { from: from.into(), to: staged.version.clone(), entries: staged.entries.clone(), old, attempts: 0 };
    write_json(&p.journal, &swap)?;
    let total = swap.entries.len() * 2;
    let mut done = 0;
    let moved = (|| -> io::Result<()> {
        for e in &swap.entries {
            let cur = install.join(e);
            if swap.old.contains(e) {
                rename(&cur, &p.previous.join(e))?;
            }
            done += 1;
            step(done, total);
            rename(&src.join(e), &cur)?;
            done += 1;
            step(done, total);
        }
        write_json(&p.applied, &swap)
    })();
    if let Err(err) = moved {
        // The journal stays when putting things back fails too: the next start finishes the job.
        if recover(install).is_ok() {
            let _ = remove(&p.applied);
        }
        return Err(err);
    }
    remove(&p.journal)?;
    let _ = remove(&p.staged.join(format!("{}.json", staged.version)));
    let _ = remove(&src);
    Ok(swap)
}

/// Undoes a cut-off swap from its journal: entries of the new version go back to `staged\<to>\` when that is still
/// there (else to trash), the old ones come back from `previous\`. Returns the swap that was undone.
pub fn recover(install: &Path) -> io::Result<Option<Swap>> {
    let p = paths(install);
    let Some(swap) = read_json::<Swap>(&p.journal) else {
        let _ = remove(&p.journal);
        return Ok(None);
    };
    let src = p.staged.join(&swap.to);
    let back = src.is_dir();
    let trash = p.trash.join(format!("{}-{}", swap.to, std::process::id()));
    for e in swap.entries.iter().rev() {
        let cur = install.join(e);
        let prev = p.previous.join(e);
        let was = swap.old.contains(e);
        // Already back where it was, or the swap never got to this entry.
        if was && !exists(&prev) {
            continue;
        }
        if exists(&cur) {
            let to = if back { src.join(e) } else { trash.join(e) };
            if let Some(dir) = to.parent() {
                fs::create_dir_all(dir)?;
            }
            remove(&to)?;
            rename(&cur, &to)?;
        }
        if was {
            rename(&prev, &cur)?;
        }
    }
    remove(&p.journal)?;
    Ok(Some(swap))
}

/// What the start of this version found.
#[derive(Debug, PartialEq)]
pub enum Start {
    Normal,
    /// The first starts of a swapped-in version, before it confirms.
    Unconfirmed(Swap),
    /// This version failed to start too often: roll it back.
    RollBack(Swap),
}

/// Counts a start of an unconfirmed version.
pub fn note_start(install: &Path, version: &str) -> Start {
    let p = paths(install);
    let Some(mut swap) = read_json::<Swap>(&p.applied) else { return Start::Normal };
    if swap.to != version {
        // Applied by a version that is not running: stale (a manual install since, or a rollback that finished).
        let _ = remove(&p.applied);
        return Start::Normal;
    }
    swap.attempts += 1;
    if swap.attempts > MAX_ATTEMPTS {
        return Start::RollBack(swap);
    }
    let _ = write_json(&p.applied, &swap);
    Start::Unconfirmed(swap)
}

/// Puts the version before an unconfirmed swap back, and remembers the failed one so it is not installed this way again.
pub fn rollback(install: &Path, swap: &Swap, error: &str) -> io::Result<()> {
    let p = paths(install);
    let _ = remove(&p.staged.join(&swap.to));
    write_json(&p.journal, swap)?;
    remove(&p.applied)?;
    recover(install)?;
    write_json(&p.failed, &Failed { version: swap.to.clone(), error: error.into(), reported: false })
}

/// The new version is running: the swap stands.
pub fn confirm(install: &Path) {
    let _ = remove(&paths(install).applied);
}

/// The swap this version came in by, while it is unconfirmed.
pub fn unconfirmed(install: &Path) -> Option<Swap> {
    read_json(&paths(install).applied)
}

pub fn failed(install: &Path) -> Option<Failed> {
    read_json(&paths(install).failed)
}

pub fn mark_reported(install: &Path) {
    let p = paths(install);
    if let Some(mut f) = read_json::<Failed>(&p.failed) {
        f.reported = true;
        let _ = write_json(&p.failed, &f);
    }
}

pub fn clear_failed(install: &Path) {
    let _ = remove(&paths(install).failed);
}

/// Deletes what a finished update left: `previous\`, trash, stale staged versions, the downloads and the installer's
/// own `.previous` set-aside. Never touches anything while a swap is unconfirmed (previous\ is its way back).
/// `keep` names download files still in use.
pub fn cleanup(install: &Path, current: &str, keep: Option<&[String]>) {
    let p = paths(install);
    if exists(&p.applied) || exists(&p.journal) {
        return;
    }
    let _ = remove(&p.previous);
    let _ = remove(&p.trash);
    let _ = remove(&install.join(".previous"));
    if let Some(s) = staged(install) {
        if !newer(&s.version, current) {
            drop_staged(install);
        }
    } else if p.staged.is_dir() {
        drop_staged(install);
    }
    // None: no update just finished, so a download here is one in progress (resumed later); leave them all.
    if let (Some(keep), Ok(dir)) = (keep, fs::read_dir(&p.download)) {
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !keep.iter().any(|k| name == *k || name == format!("{k}.part")) {
                let _ = remove(&entry.path());
            }
        }
    }
    if let Some(f) = failed(install) {
        if !newer(&f.version, current) {
            clear_failed(install);
        }
    }
}

pub fn newer(version: &str, than: &str) -> bool {
    match (semver::Version::parse(version), semver::Version::parse(than)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-fast-{name}-{}", std::process::id()));
        let _ = remove(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A .tar.br archive like scripts/pack-update.mjs writes (GNU long names included).
    fn archive(path: &Path, files: &[(&str, &str)]) {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            builder.append_data(&mut h, name, data.as_bytes()).unwrap();
        }
        let tar = builder.into_inner().unwrap();
        let mut out = Vec::new();
        brotli_compress(&tar, &mut out);
        fs::write(path, out).unwrap();
    }

    // brotli-decompressor has no encoder; an uncompressed meta-block stream is valid brotli and enough for tests.
    fn brotli_compress(data: &[u8], out: &mut Vec<u8>) {
        // WBITS = 16 (one 0 bit), then for each chunk: ISLAST=0, MNIBBLES=4 (value 0, 2 bits), MLEN-1 (16 bits),
        // ISUNCOMPRESSED=1, pad to a byte boundary, the raw bytes; then a final empty meta-block (ISLAST=1, ISEMPTY=1).
        struct Bits<'a> {
            out: &'a mut Vec<u8>,
            acc: u64,
            n: u32,
        }
        impl Bits<'_> {
            fn push(&mut self, value: u64, count: u32) {
                self.acc |= value << self.n;
                self.n += count;
                while self.n >= 8 {
                    self.out.push(self.acc as u8);
                    self.acc >>= 8;
                    self.n -= 8;
                }
            }
            fn align(&mut self) {
                if self.n > 0 {
                    self.push(0, 8 - self.n);
                }
            }
        }
        let mut b = Bits { out, acc: 0, n: 0 };
        b.push(0, 1);
        for chunk in data.chunks(65536) {
            b.push(0, 1);
            b.push(0, 2);
            b.push((chunk.len() - 1) as u64, 16);
            b.push(1, 1);
            b.align();
            b.out.extend_from_slice(chunk);
        }
        b.push(0b11, 2);
        b.align();
    }

    fn install(dir: &Path, version: &str, runtime: &str) {
        fs::create_dir_all(dir.join("companion")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("app.exe"), version).unwrap();
        fs::write(dir.join("companion/server.mjs"), version).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), runtime).unwrap();
        fs::write(dir.join(RUNTIME_ID), runtime).unwrap();
        fs::write(dir.join("bun.exe"), runtime).unwrap();
        fs::write(dir.join("uninstall.exe"), "u").unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn stage_version(dir: &Path, version: &str, runtime: Option<&str>) -> Staged {
        let app = dir.join("app.tar.br");
        let long = format!("companion/{}/deep.js", "d".repeat(120));
        archive(&app, &[("app.exe", version), ("companion/server.mjs", version), (&long, version), ("local-dist/index.html", version)]);
        let rt = dir.join("rt.tar.br");
        if let Some(stamp) = runtime {
            archive(&rt, &[("node_modules/pkg/index.js", stamp), ("bun.exe", stamp), (RUNTIME_ID, stamp)]);
        }
        let never = AtomicBool::new(false);
        stage(dir, "app.exe", version, &app, runtime.map(|s| (rt.as_path(), s)), &|_, _| {}, &never).unwrap()
    }

    #[test]
    fn app_only_update_keeps_the_runtime_and_replaces_the_app() {
        let dir = tmp("app-only");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", None);
        assert_eq!(s.entries, vec!["app.exe", "companion", "local-dist"]);
        let swap = apply(&dir, "app.exe", "1.0", &s, &mut |_, _| {}).unwrap();
        assert_eq!(read(&dir.join("app.exe")), "1.1");
        assert_eq!(read(&dir.join("companion/server.mjs")), "1.1");
        assert!(dir.join(format!("companion/{}/deep.js", "d".repeat(120))).is_file(), "GNU long names unpack");
        assert_eq!(read(&dir.join(RUNTIME_ID)), "rt1", "the runtime is untouched");
        assert_eq!(read(&dir.join("uninstall.exe")), "u");
        assert_eq!(swap.old, vec!["app.exe", "companion"], "local-dist is new");
        assert_eq!(read(&paths(&dir).previous.join("app.exe")), "1.0", "the old version stays until confirmed");
        assert!(staged(&dir).is_none());
    }

    #[test]
    fn runtime_update_swaps_node_modules_and_bun() {
        let dir = tmp("runtime");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", Some("rt2"));
        assert_eq!(s.runtime.as_deref(), Some("rt2"));
        apply(&dir, "app.exe", "1.0", &s, &mut |_, _| {}).unwrap();
        assert_eq!(installed_runtime(&dir), "rt2");
        assert_eq!(read(&dir.join("bun.exe")), "rt2");
    }

    #[test]
    fn a_runtime_archive_for_another_stamp_is_refused() {
        let dir = tmp("stamp");
        install(&dir, "1.0", "rt1");
        let app = dir.join("app.tar.br");
        archive(&app, &[("app.exe", "1.1")]);
        let rt = dir.join("rt.tar.br");
        archive(&rt, &[("bun.exe", "x"), (RUNTIME_ID, "other")]);
        let never = AtomicBool::new(false);
        let err = stage(&dir, "app.exe", "1.1", &app, Some((&rt, "rt2")), &|_, _| {}, &never).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(staged(&dir).is_none(), "nothing half-staged counts as staged");
    }

    #[test]
    fn archives_cannot_escape_or_replace_reserved_entries() {
        let dir = tmp("escape");
        install(&dir, "1.0", "rt1");
        let never = AtomicBool::new(false);
        // tar::Builder refuses `..` itself, so build the header by hand.
        let mut h = tar::Header::new_gnu();
        h.as_gnu_mut().unwrap().name[..12].copy_from_slice(b"../evil.txt\0");
        h.set_size(1);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        let mut raw = h.as_bytes().to_vec();
        raw.extend_from_slice(&[b'x']);
        raw.resize(raw.len() + 511, 0);
        raw.resize(raw.len() + 1024, 0);
        let mut out = Vec::new();
        brotli_compress(&raw, &mut out);
        let bad = dir.join("bad.tar.br");
        fs::write(&bad, out).unwrap();
        assert!(unpack(&bad, &dir.join("x"), &|_, _| {}, &never).is_err());
        assert!(!dir.join("evil.txt").exists());
        let app = dir.join("app.tar.br");
        archive(&app, &[("app.exe", "1.1"), ("uninstall.exe", "evil")]);
        assert!(stage(&dir, "app.exe", "1.1", &app, None, &|_, _| {}, &never).is_err());
        assert_eq!(read(&dir.join("uninstall.exe")), "u");
    }

    #[test]
    fn a_swap_cut_off_halfway_is_undone_at_the_next_start() {
        let dir = tmp("journal");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", None);
        // Simulate a crash after app.exe was swapped and companion moved aside, before its replacement moved in.
        let p = paths(&dir);
        fs::create_dir_all(&p.previous).unwrap();
        let swap = Swap { from: "1.0".into(), to: "1.1".into(), entries: s.entries.clone(), old: vec!["app.exe".into(), "companion".into()], attempts: 0 };
        write_json(&p.journal, &swap).unwrap();
        fs::rename(dir.join("app.exe"), p.previous.join("app.exe")).unwrap();
        fs::rename(p.staged.join("1.1/app.exe"), dir.join("app.exe")).unwrap();
        fs::rename(dir.join("companion"), p.previous.join("companion")).unwrap();
        assert_eq!(recover(&dir).unwrap().unwrap().to, "1.1");
        assert_eq!(read(&dir.join("app.exe")), "1.0");
        assert_eq!(read(&dir.join("companion/server.mjs")), "1.0");
        assert!(!dir.join("local-dist").exists(), "no entry of the new version is left behind");
        assert_eq!(staged(&dir).map(|s| s.version), Some("1.1".into()), "the staged update is whole again for a retry");
        assert!(recover(&dir).unwrap().is_none());
    }

    #[test]
    #[cfg(windows)]
    fn a_locked_folder_halfway_puts_the_old_version_back() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tmp("locked");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", None);
        // A file held open without delete sharing (a scanner, a process still exiting) blocks moving its folder:
        // app.exe has already been swapped when companion\ cannot move.
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(dir.join("companion/server.mjs")).unwrap();
        let err = apply(&dir, "app.exe", "1.0", &s, &mut |_, _| {}).unwrap_err();
        drop(held);
        assert!(is_locked(&err), "{err}");
        assert_eq!(read(&dir.join("app.exe")), "1.0");
        assert_eq!(read(&dir.join("companion/server.mjs")), "1.0");
        assert!(!dir.join("local-dist").exists());
        assert!(!paths(&dir).journal.exists());
        assert!(!paths(&dir).applied.exists());
        assert_eq!(staged(&dir).map(|s| s.version), Some("1.1".into()), "Retry needs no new download");
    }

    #[test]
    fn a_version_that_keeps_failing_to_start_is_rolled_back_and_remembered() {
        let dir = tmp("rollback");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", Some("rt2"));
        apply(&dir, "app.exe", "1.0", &s, &mut |_, _| {}).unwrap();
        assert!(matches!(note_start(&dir, "1.1"), Start::Unconfirmed(_)));
        assert!(matches!(note_start(&dir, "1.1"), Start::Unconfirmed(_)));
        let Start::RollBack(swap) = note_start(&dir, "1.1") else { panic!("third start rolls back") };
        rollback(&dir, &swap, "did not start").unwrap();
        assert_eq!(read(&dir.join("app.exe")), "1.0");
        assert_eq!(installed_runtime(&dir), "rt1");
        assert_eq!(read(&dir.join("bun.exe")), "rt1");
        assert!(!dir.join("local-dist").exists());
        assert_eq!(failed(&dir).map(|f| f.version), Some("1.1".into()));
        assert_eq!(note_start(&dir, "1.0"), Start::Normal);
    }

    #[test]
    fn a_confirmed_update_cleans_up_after_itself() {
        let dir = tmp("cleanup");
        install(&dir, "1.0", "rt1");
        let s = stage_version(&dir, "1.1", None);
        apply(&dir, "app.exe", "1.0", &s, &mut |_, _| {}).unwrap();
        fs::create_dir_all(dir.join(".previous/x")).unwrap();
        fs::create_dir_all(paths(&dir).download).unwrap();
        fs::write(paths(&dir).download.join("old.tar.br"), "x").unwrap();
        fs::write(paths(&dir).download.join("next.tar.br.part"), "x").unwrap();
        cleanup(&dir, "1.1", Some(&[]));
        assert!(paths(&dir).previous.exists(), "nothing goes while the swap is unconfirmed");
        confirm(&dir);
        cleanup(&dir, "1.1", Some(&["next.tar.br".into()]));
        assert!(!paths(&dir).previous.exists());
        assert!(!dir.join(".previous").exists());
        assert!(!paths(&dir).download.join("old.tar.br").exists());
        assert!(paths(&dir).download.join("next.tar.br.part").exists(), "a download in progress stays");
    }

    #[test]
    fn cancelling_stops_unpacking() {
        let dir = tmp("cancel");
        let app = dir.join("app.tar.br");
        archive(&app, &[("a", "1"), ("b", "2")]);
        let stop = AtomicBool::new(true);
        assert_eq!(unpack(&app, &dir.join("out"), &|_, _| {}, &stop).unwrap_err().kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn versions_compare_by_semver() {
        assert!(newer("1.0.10", "1.0.9"));
        assert!(!newer("1.0.9", "1.0.9"));
        assert!(!newer("1.0.8", "1.0.9"));
    }
}
