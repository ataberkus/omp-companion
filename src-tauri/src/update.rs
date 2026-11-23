//! In-app updates: find a newer signed release, download it in the background, and install it behind the app's own
//! update window (local-dist/update.html) instead of the installer's.
//!
//! Windows installs from two signed `.tar.br` archives listed under `windows-x86_64-fast` in latest.json
//! (scripts/pack-update.mjs): the app (exe, companion, local-dist, desktop; a few MB) every release, and the runtime
//! (node_modules plus bun.exe, ~100 MB) only when its stamp differs from the installed `node_modules\.runtime-id`. They
//! are unpacked next to the install while the app keeps running, then swapped in by directory renames (src/fast.rs)
//! once the companion has saved the sessions: no installer, no file-by-file extraction. Without that entry, or for a
//! version that already failed this way, it falls back to the NSIS setup, run silently.
//! macOS installs the `.app.tar.gz` through tauri-plugin-updater, behind the same window.
//!
//! The window has no IPC (no window here does): Rust shows state with `window.ompUpdate(state)`, and the page asks for
//! actions by navigating to `/__update/<action>`, which the navigation handler cancels and acts on.

use crate::{adopt, busy_sessions, create_tray, error_dialog, main_url, refresh_menu, spawn_host, stop_companion, utc_now, Shell, TITLE, TRAY};
#[cfg(windows)]
use crate::fast;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const WINDOW: &str = "update";
#[cfg(windows)]
const FAST: &str = "windows-x86_64-fast";
/// Retries of one download before it is reported (a retry that got data starts the count again).
const ATTEMPTS: u32 = 8;
const NOTES_MAX: usize = 20_000;
/// The "Updated to X" screen is shown at the next launch only when the update finished this recently.
const UPDATED_WINDOW: u64 = 30 * 60 * 1000;

// ---------- state ----------

#[derive(Clone)]
enum How {
    #[cfg(windows)]
    Fast(fast::Staged),
    /// The platform package (macOS .app.tar.gz, the Windows NSIS setup): verified again by the plugin's install().
    Package(PathBuf),
}

#[derive(Clone)]
struct Ready {
    version: String,
    notes: String,
    size: String,
    how: How,
}

#[derive(Clone, Copy, PartialEq)]
enum Retry {
    Check,
    Prepare,
    Apply,
}

struct Flow {
    /// What the window shows; re-sent whenever it loads.
    ui: Value,
    /// The version the background job is preparing.
    job: Option<String>,
    /// Install as soon as it is prepared (Install now was chosen).
    install: bool,
    applying: bool,
    ready: Option<Ready>,
    retry: Retry,
    /// Download percent for the tray (refreshed in 5 % steps).
    percent: Option<u8>,
    /// The swap this start counts (Windows): confirmed once the dashboard loads.
    unconfirmed: bool,
    /// When the install that started this version began (ms since the epoch), for the log.
    updated_at: Option<u64>,
}

static FLOW: Mutex<Flow> = parking_lot::const_mutex(Flow { ui: Value::Null, job: None, install: false, applying: false, ready: None, retry: Retry::Check, percent: None, unconfirmed: false, updated_at: None });
static CANCEL: AtomicBool = AtomicBool::new(false);

/// app_local_data/update.json: choices and markers that outlive a restart.
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Later on this version: no prompt and no notification until a newer one.
    #[serde(default)]
    later: Option<String>,
    /// Written just before an install, read by the next launch ("Updated to X", or the failure).
    #[serde(default)]
    installing: Option<Installing>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Installing {
    from: String,
    to: String,
    at: u64,
}

fn saved_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("update.json"))
}

fn load(app: &AppHandle) -> Saved {
    saved_file(app).and_then(|f| fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn store(app: &AppHandle, change: impl FnOnce(&mut Saved)) {
    let Some(file) = saved_file(app) else { return };
    let mut saved = load(app);
    change(&mut saved);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("tmp");
    if fs::write(&tmp, serde_json::to_vec_pretty(&saved).unwrap_or_default()).is_ok() {
        let _ = fs::rename(tmp, file);
    }
}

/// Milliseconds since the epoch.
fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn current(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// app_log/updater.log: every check, phase and timing, for support and for measuring updates.
pub fn log(app: &AppHandle, line: impl AsRef<str>) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let file = dir.join("updater.log");
    if fs::metadata(&file).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = fs::rename(&file, dir.join("updater.old.log"));
    }
    if let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(out, "{} UTC [{}] {}", utc_now(), current(app), line.as_ref());
    }
}

// ---------- failures ----------

#[derive(Clone, Debug)]
pub enum Failure {
    Offline(String),
    Unreachable(String),
    Signature(String),
    DiskFull(String),
    Locked(String),
    Partial(String),
    Cancelled,
    Other(String),
}

impl Failure {
    fn kind(&self) -> &'static str {
        match self {
            Failure::Offline(_) => "offline",
            Failure::Unreachable(_) => "unreachable",
            Failure::Signature(_) => "signature",
            Failure::DiskFull(_) => "disk",
            Failure::Locked(_) => "locked",
            Failure::Partial(_) => "partial",
            Failure::Cancelled => "cancelled",
            Failure::Other(_) => "other",
        }
    }

    fn title(&self) -> &'static str {
        match self {
            Failure::Offline(_) => "You seem to be offline",
            Failure::Unreachable(_) => "The update server could not be reached",
            Failure::Signature(_) => "The update's signature did not match",
            Failure::DiskFull(_) => "Not enough disk space",
            Failure::Locked(_) => "Some files are in use",
            Failure::Partial(_) => "The update was incomplete",
            Failure::Cancelled => "Update cancelled",
            Failure::Other(_) => "The update did not work",
        }
    }

    fn advice(&self) -> &'static str {
        match self {
            Failure::Offline(_) => "Check your internet connection, then try again.",
            Failure::Unreachable(_) => "GitHub may be busy or blocked on this network. Try again in a moment.",
            Failure::Signature(_) => "Nothing was installed. The download was deleted; trying again downloads it fresh.",
            Failure::DiskFull(_) => "Free some space on the drive OMP Control Room is installed on, then try again.",
            Failure::Locked(_) => "Another program (often an antivirus scan) is holding files of the app. Nothing was changed; try again in a moment.",
            Failure::Partial(_) => "Nothing was changed. Trying again downloads the missing parts.",
            Failure::Cancelled => "",
            Failure::Other(_) => "Nothing was changed; this version keeps running.",
        }
    }

    fn detail(&self) -> String {
        match self {
            Failure::Offline(d) | Failure::Unreachable(d) | Failure::Signature(d) | Failure::DiskFull(d) | Failure::Locked(d) | Failure::Partial(d) | Failure::Other(d) => d.clone(),
            Failure::Cancelled => String::new(),
        }
    }

    fn io(e: io::Error) -> Self {
        let text = e.to_string();
        #[cfg(windows)]
        {
            if fast::is_disk_full(&e) {
                return Failure::DiskFull(text);
            }
            if fast::is_locked(&e) {
                return Failure::Locked(text);
            }
        }
        #[cfg(unix)]
        if e.raw_os_error() == Some(libc::ENOSPC) {
            return Failure::DiskFull(text);
        }
        match e.kind() {
            io::ErrorKind::Interrupted => Failure::Cancelled,
            io::ErrorKind::StorageFull => Failure::DiskFull(text),
            io::ErrorKind::UnexpectedEof | io::ErrorKind::InvalidData => Failure::Partial(text),
            _ => Failure::Other(text),
        }
    }

    /// From the message of a reqwest or updater-plugin error (with its causes: see `chain`).
    fn network(text: String) -> Self {
        let lower = text.to_lowercase();
        let offline = ["dns error", "failed to lookup", "no such host", "nodename nor servname", "getaddrinfo", "os error 11001", "network is unreachable", "os error 10051", "os error 10065"];
        if offline.iter().any(|p| lower.contains(p)) {
            Failure::Offline(text)
        } else {
            Failure::Unreachable(text)
        }
    }
}

/// An error with its causes: reqwest's own message never says why ("error sending request for url …"); the reason
/// (a DNS failure, a refused connection) is in its sources.
fn chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let more = cause.to_string();
        if !text.contains(&more) {
            text = format!("{text}: {more}");
        }
        source = cause.source();
    }
    text
}

// ---------- the window ----------

/// Shows or updates the update window. focus: bring it to the front (asked for); otherwise it opens without taking
/// the keyboard (a ready update offered by itself).
fn show(app: &AppHandle, focus: bool) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        if focus {
            let _ = window.set_focus();
        }
        push(app);
        return;
    }
    let app2 = app.clone();
    let built = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("update.html".into()))
        .title(format!("{TITLE} update"))
        .inner_size(500.0, 600.0)
        .min_inner_size(400.0, 440.0)
        .maximizable(false)
        .center()
        .visible(false)
        .focused(focus)
        .disable_drag_drop_handler()
        .on_navigation(move |url| navigate(&app2, url))
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let state = FLOW.lock().ui.clone();
            let _ = window.eval(format!("window.ompUpdate&&window.ompUpdate({state})"));
            let _ = window.show();
            if focus {
                let _ = window.set_focus();
            }
        })
        .build();
    if let Err(e) = built {
        log(app, format!("update window: {e}"));
    }
}

/// Sends the current state to an open window and mirrors download progress on the taskbar button.
fn push(app: &AppHandle) {
    let state = FLOW.lock().ui.clone();
    let Some(window) = app.get_webview_window(WINDOW) else { return };
    let _ = window.eval(format!("window.ompUpdate&&window.ompUpdate({state})"));
    let progress = state["progress"].as_f64();
    let bar = match (state["state"].as_str(), progress) {
        (Some("downloading" | "applying"), Some(p)) => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some((p * 100.0).round().clamp(0.0, 100.0) as u64) },
        (Some("downloading" | "applying" | "checking"), None) => ProgressBarState { status: Some(ProgressBarStatus::Indeterminate), progress: None },
        (Some("error"), _) => ProgressBarState { status: Some(ProgressBarStatus::Error), progress: Some(100) },
        _ => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
    };
    let _ = window.set_progress_bar(bar);
}

fn set_ui(app: &AppHandle, ui: Value) {
    FLOW.lock().ui = ui;
    push(app);
}

/// Merges fields into the shown state (progress ticks).
fn patch_ui(app: &AppHandle, fields: Value) {
    {
        let mut flow = FLOW.lock();
        if let (Some(ui), Some(fields)) = (flow.ui.as_object_mut(), fields.as_object()) {
            for (k, v) in fields {
                ui.insert(k.clone(), v.clone());
            }
        }
    }
    push(app);
}

fn close_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

/// The page's own origin (tauri://localhost on macOS, http://tauri.localhost on Windows).
fn own(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn navigate(app: &AppHandle, url: &Url) -> bool {
    if own(url) {
        let Some(action) = url.path().strip_prefix("/__update/") else { return true };
        let (app, action) = (app.clone(), action.to_owned());
        // Off the webview's event handler: actions block, and building a window inside it deadlocks on Windows.
        thread::spawn(move || act(&app, &action));
        return false;
    }
    // Links in the release notes.
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

fn act(app: &AppHandle, action: &str) {
    match action {
        "install" => begin_install(app),
        "later" => {
            let version = FLOW.lock().ready.as_ref().map(|r| r.version.clone()).or_else(|| app.state::<Shell>().update.lock().as_ref().map(|u| u.version.clone()));
            if let Some(version) = version {
                store(app, |s| s.later = Some(version.clone()));
                log(app, format!("later: {version}"));
            }
            FLOW.lock().install = false;
            close_window(app);
        }
        "cancel" => {
            let mut flow = FLOW.lock();
            if flow.applying {
                return;
            }
            flow.install = false;
            if flow.job.is_some() {
                CANCEL.store(true, Ordering::SeqCst);
            }
        }
        "retry" => {
            let retry = FLOW.lock().retry;
            match retry {
                Retry::Check => check_now(app),
                Retry::Prepare => begin_install(app),
                Retry::Apply => begin_install(app),
            }
        }
        "check" => check_now(app),
        "close" => close_window(app),
        _ => {}
    }
}

// ---------- checking ----------

/// Asks the endpoint. The plugin compares versions: the same or an older release is no update.
pub fn check(app: &AppHandle) -> Result<Option<Update>, Failure> {
    let updater = app.updater().map_err(|e| Failure::Other(e.to_string()))?;
    tauri::async_runtime::block_on(updater.check()).map_err(|e| Failure::network(chain(&e)))
}

/// Check for updates with the update window: it says what it found (the window's Retry, and the check action).
pub fn check_now(app: &AppHandle) {
    set_ui(app, json!({ "state": "checking", "current": current(app) }));
    show(app, true);
    match check(app) {
        Ok(Some(update)) => {
            offer(app, update);
            prompt(app, true);
        }
        Ok(None) => {
            log(app, "check: up to date");
            // A prepared update is still there to install when the endpoint no longer lists it (a pulled release).
            set_ui(app, json!({ "state": "uptodate", "current": current(app) }));
        }
        Err(e) => {
            log(app, format!("check failed: {e:?}"));
            FLOW.lock().retry = Retry::Check;
            set_ui(app, error_state(app, &e, true));
        }
    }
}

/// Check for updates and update without asking: the dashboard's ⋯ menu (also from a phone, through the companion). A
/// prepared update installs at once; a newer release found by the background check downloads and installs as soon as its
/// signature is verified; otherwise the check runs now. Sessions are paused and saved by the install, and the new version
/// resumes the ones that were working. Returns what the caller can show, since the app restarts before it could ask
/// anything else.
pub fn auto(app: &AppHandle) -> Value {
    let current = current(app);
    if cfg!(debug_assertions) {
        return json!({ "ok": false, "state": "unsupported", "current": current, "error": "Development builds do not update themselves." });
    }
    let ready = {
        let mut flow = FLOW.lock();
        if flow.applying {
            let version = flow.ready.as_ref().map(|r| r.version.clone());
            return json!({ "ok": true, "state": "installing", "version": version, "current": current });
        }
        flow.install = true;
        flow.ready.as_ref().map(|r| r.version.clone())
    };
    store(app, |s| s.later = None);
    if let Some(version) = ready {
        log(app, format!("update: installing prepared {version} without asking"));
        // The caller's answer (a phone asking through the companion) goes out before the companion stops: the install
        // starts a moment later.
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            apply_flow(&app);
        });
        return json!({ "ok": true, "state": "installing", "version": version, "current": current });
    }
    // A release the background check found is already downloading (or about to): the job installs it when it finishes.
    if let Some(version) = app.state::<Shell>().update.lock().as_ref().map(|u| u.version.clone()) {
        start_job(app);
        log(app, format!("update: installing {version} without asking once it is ready"));
        return json!({ "ok": true, "state": "downloading", "version": version, "current": current });
    }
    match check(app) {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log(app, format!("update: found {version}; installing without asking"));
            offer(app, update);
            json!({ "ok": true, "state": "downloading", "version": version, "current": current })
        }
        Ok(None) => {
            cancel_auto();
            log(app, "update: up to date");
            let _ = app.notification().builder().title(TITLE).body(format!("{TITLE} {current} is the newest version.")).show();
            json!({ "ok": true, "state": "up-to-date", "current": current })
        }
        Err(e) => {
            cancel_auto();
            log(app, format!("update check failed: {e:?}"));
            let _ = app.notification().builder().title(TITLE).body(format!("The update check failed. {}. {}", e.title(), e.advice())).show();
            json!({ "ok": true, "state": "error", "current": current, "error": { "kind": e.kind(), "title": e.title(), "advice": e.advice(), "detail": e.detail() } })
        }
    }
}

/// A check that found nothing drops the install flag an auto update set, unless a job started meanwhile (the background
/// check finding a release at the same moment): that job installs when it is ready.
fn cancel_auto() {
    let mut flow = FLOW.lock();
    if flow.job.is_none() && flow.ready.is_none() {
        flow.install = false;
    }
}

/// A newer release: remember it, start downloading it in the background and offer it in the tray. A newer one found
/// while an older one downloads replaces it.
pub fn offer(app: &AppHandle, update: Update) {
    let shell = app.state::<Shell>();
    let version = update.version.clone();
    let known = shell.update.lock().replace(update).is_some_and(|old| old.version == version);
    if !known {
        log(app, format!("found {version}"));
        let mut flow = FLOW.lock();
        if flow.job.as_ref().is_some_and(|v| *v != version) {
            CANCEL.store(true, Ordering::SeqCst);
        }
        if flow.ready.as_ref().is_some_and(|r| fast_newer(&version, &r.version)) {
            flow.ready = None;
        }
    }
    refresh_menu(app);
    start_job(app);
}

fn fast_newer(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => a != b,
    }
}

fn notes_of(update: &Update) -> String {
    update.body.as_deref().map(str::trim).unwrap_or_default().chars().take(NOTES_MAX).collect()
}

/// The prompt for the newest known version: "ready" when prepared, else "available" (downloading in the background).
fn prompt(app: &AppHandle, focus: bool) {
    let shell = app.state::<Shell>();
    let busy = busy_sessions(&shell);
    let update = shell.update.lock().clone();
    let flow = FLOW.lock();
    let later = load(app).later;
    let state = if let Some(ready) = &flow.ready {
        json!({ "state": "ready", "version": ready.version, "current": current(app), "notes": ready.notes, "size": ready.size, "busy": busy, "later": later.as_deref() == Some(&ready.version), "applyOnQuit": true })
    } else if let Some(update) = &update {
        let downloading = flow.job.as_deref() == Some(update.version.as_str());
        let progress = flow.ui["progress"].clone();
        json!({ "state": "available", "version": update.version, "current": current(app), "notes": notes_of(update), "size": flow.ui["size"].clone(), "busy": busy, "downloading": downloading, "progress": if downloading { progress } else { Value::Null } })
    } else {
        json!({ "state": "uptodate", "current": current(app) })
    };
    drop(flow);
    set_ui(app, state);
    show(app, focus);
}

/// The tray's update item and Restart to update.
pub fn show_prompt(app: &AppHandle) {
    let flow = FLOW.lock();
    let busy = flow.applying || flow.install;
    drop(flow);
    if busy {
        return show(app, true);
    }
    prompt(app, true);
}

/// Shows the window as it is (the tray's progress item, a second launch during an update).
pub fn focus(app: &AppHandle) {
    if FLOW.lock().ui.is_null() {
        return show_prompt(app);
    }
    show(app, true);
}

/// Whether an update is being installed (a second launch shows its window instead of the dashboard).
pub fn busy() -> bool {
    let flow = FLOW.lock();
    flow.applying || (flow.install && flow.job.is_some())
}

pub fn applying() -> bool {
    FLOW.lock().applying
}

// ---------- the tray ----------

pub enum TrayItem {
    Check,
    Downloading(Option<u8>),
    Install(String),
    Ready(String),
    Installing,
}

pub fn tray_item(shell: &Shell) -> TrayItem {
    let flow = FLOW.lock();
    if flow.applying || shell.updating.load(Ordering::SeqCst) {
        TrayItem::Installing
    } else if let Some(ready) = &flow.ready {
        TrayItem::Ready(ready.version.clone())
    } else if flow.job.is_some() {
        TrayItem::Downloading(flow.percent)
    } else {
        shell.update.lock().as_ref().map_or(TrayItem::Check, |u| TrayItem::Install(u.version.clone()))
    }
}

fn set_tray_percent(app: &AppHandle, percent: Option<u8>) {
    let changed = {
        let mut flow = FLOW.lock();
        let step = |p: Option<u8>| p.map(|p| p / 5);
        let changed = step(flow.percent) != step(percent);
        flow.percent = percent;
        changed
    };
    if changed {
        refresh_menu(app);
    }
}

// ---------- preparing: download, verify, unpack ----------

struct Artifact {
    url: Url,
    signature: String,
    size: Option<u64>,
    /// The local file name, which is also the name the signature was made for (fast archives).
    file: String,
    signed_name: bool,
}

struct Plan {
    artifacts: Vec<Artifact>,
    /// Windows fast update: the runtime stamp when the runtime comes along.
    #[cfg(windows)]
    fast: Option<Option<String>>,
}

fn install_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| dunce::simplified(d).to_path_buf())
}

fn exe_name() -> String {
    std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "omp-control-room.exe".into())
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, Failure> {
    #[cfg(windows)]
    {
        let _ = app;
        install_dir().map(|d| fast::paths(&d).download).ok_or_else(|| Failure::Other("the install folder is unknown".into()))
    }
    #[cfg(not(windows))]
    {
        app.path().app_cache_dir().map(|d| d.join("updates")).map_err(|e| Failure::Other(e.to_string()))
    }
}

fn plan(app: &AppHandle, update: &Update) -> Result<Plan, Failure> {
    #[cfg(windows)]
    {
        let install = install_dir().ok_or_else(|| Failure::Other("the install folder is unknown".into()))?;
        let failed = fast::failed(&install).is_some_and(|f| f.version == update.version);
        let entry = &update.raw_json["platforms"][FAST];
        if entry.is_object() && !failed {
            let artifact = |e: &Value, file: String| -> Result<Artifact, Failure> {
                let url = e["url"].as_str().and_then(|u| Url::parse(u).ok()).ok_or_else(|| Failure::Other("the update manifest lists no download".into()))?;
                let signature = e["signature"].as_str().ok_or_else(|| Failure::Other("the update manifest lists no signature".into()))?.to_owned();
                Ok(Artifact { url, signature, size: e["size"].as_u64(), file, signed_name: true })
            };
            let app_file = format!("omp-control-room_{}_x64-app.tar.br", update.version);
            let mut artifacts = vec![artifact(entry, app_file)?];
            let stamp = entry["runtime"]["stamp"].as_str().unwrap_or_default().to_owned();
            if stamp.is_empty() || !stamp.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(Failure::Other("the update manifest names no runtime".into()));
            }
            let runtime = (fast::installed_runtime(&install) != stamp).then_some(stamp.clone());
            if runtime.is_some() {
                artifacts.push(artifact(&entry["runtime"], format!("omp-control-room_runtime-{stamp}_x64.tar.br"))?);
            }
            return Ok(Plan { artifacts, fast: Some(runtime) });
        }
        if failed {
            log(app, format!("{} failed to start after a fast update before; using the installer", update.version));
        }
    }
    let name = update.download_url.path_segments().and_then(|mut s| s.next_back().map(str::to_owned)).filter(|n| !n.is_empty()).unwrap_or_else(|| "package".into());
    let size = probe_size(app, &update.download_url);
    Ok(Plan {
        artifacts: vec![Artifact { url: update.download_url.clone(), signature: update.signature.clone(), size, file: format!("{}-{name}", update.version), signed_name: false }],
        #[cfg(windows)]
        fast: None,
    })
}

fn size_text(plan: &Plan) -> String {
    let Some(total) = plan.artifacts.iter().map(|a| a.size).sum::<Option<u64>>() else { return String::new() };
    #[cfg(windows)]
    if let Some(runtime) = &plan.fast {
        return if runtime.is_some() { format!("Update: {} (includes a new OMP runtime)", mb(total)) } else { format!("Small update: {}", mb(total)) };
    }
    format!("Download: {}", mb(total))
}

fn mb(bytes: u64) -> String {
    let mb = bytes as f64 / 1_048_576.0;
    if mb < 10.0 {
        format!("{mb:.1} MB")
    } else {
        format!("{mb:.0} MB")
    }
}

fn client(app: &AppHandle) -> Result<reqwest::Client, Failure> {
    // The plugin installs the same provider for its check; whichever runs first wins, the other call is a no-op.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .user_agent(format!("omp-control-room/{}", current(app)))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Failure::Other(e.to_string()))
}

fn probe_size(app: &AppHandle, url: &Url) -> Option<u64> {
    let client = client(app).ok()?;
    // The request is built inside the runtime: its timeout needs Tokio's timer.
    let reply = tauri::async_runtime::block_on(async { client.head(url.clone()).timeout(Duration::from_secs(20)).send().await }).ok()?;
    // The header: content_length() is the size of the (empty) body of a HEAD reply.
    let length = reply.headers().get(reqwest::header::CONTENT_LENGTH)?.to_str().ok()?.parse::<u64>().ok();
    reply.status().is_success().then_some(length).flatten().filter(|n| *n > 0)
}

/// Bytes per second over the last few seconds, and the time left.
struct Meter {
    samples: VecDeque<(Instant, u64)>,
}

impl Meter {
    fn new() -> Self {
        Meter { samples: VecDeque::new() }
    }

    fn tick(&mut self, done: u64) -> f64 {
        let now = Instant::now();
        self.samples.push_back((now, done));
        while self.samples.len() > 2 && now.duration_since(self.samples[0].0) > Duration::from_secs(5) {
            self.samples.pop_front();
        }
        let (t0, d0) = self.samples[0];
        let secs = now.duration_since(t0).as_secs_f64();
        if secs < 0.3 {
            0.0
        } else {
            done.saturating_sub(d0) as f64 / secs
        }
    }
}

fn download_detail(done: u64, total: Option<u64>, speed: f64) -> String {
    let mut parts = vec![match total {
        Some(t) => format!("{} of {}", mb(done), mb(t)),
        None => mb(done),
    }];
    if speed > 0.0 {
        parts.push(format!("{}/s", mb(speed as u64)));
        if let Some(t) = total {
            let left = (t.saturating_sub(done) as f64 / speed).ceil() as u64;
            parts.push(match left {
                0..=59 => format!("{left} s left"),
                60..=3599 => format!("{} min left", left.div_ceil(60)),
                _ => format!("{} h {} min left", left / 3600, left % 3600 / 60),
            });
        }
    }
    parts.join(" · ")
}

enum Attempt {
    Done,
    /// Worth another try (network trouble, server busy); true when data arrived.
    Retry(String, bool),
    Fail(Failure),
}

async fn attempt(client: &reqwest::Client, art: &Artifact, part: &Path, total: &mut Option<u64>, on: &mut dyn FnMut(u64, Option<u64>)) -> Attempt {
    let mut have = fs::metadata(part).map_or(0, |m| m.len());
    let mut request = client.get(art.url.clone());
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return Attempt::Retry(chain(&e), false),
    };
    let status = response.status();
    let append = match status.as_u16() {
        206 => true,
        200 => {
            have = 0;
            false
        }
        416 if total.is_some_and(|t| t == have) => return Attempt::Done,
        416 => {
            let _ = fs::remove_file(part);
            return Attempt::Retry("the partial download did not match the file on the server".into(), false);
        }
        429 | 500..=599 => return Attempt::Retry(format!("the server answered {status}"), false),
        _ => return Attempt::Fail(Failure::Unreachable(format!("{} answered {status}", art.url))),
    };
    if let Some(len) = response.content_length() {
        *total = Some(have + len);
    }
    if let (Some(expected), Some(t)) = (art.size, *total) {
        if expected != t {
            let _ = fs::remove_file(part);
            return Attempt::Fail(Failure::Partial(format!("the server has {t} bytes, the manifest says {expected}")));
        }
    }
    let file = fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(part);
    let mut file = match file {
        Ok(f) => io::BufWriter::with_capacity(1 << 20, f),
        Err(e) => return Attempt::Fail(Failure::io(e)),
    };
    let mut stream = response.bytes_stream();
    let mut got = false;
    on(have, *total);
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::SeqCst) {
            let _ = file.flush();
            return Attempt::Fail(Failure::Cancelled);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = file.flush();
                return Attempt::Retry(chain(&e), got);
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            return Attempt::Fail(Failure::io(e));
        }
        got = true;
        have += chunk.len() as u64;
        on(have, *total);
    }
    if let Err(e) = file.flush() {
        return Attempt::Fail(Failure::io(e));
    }
    match *total {
        Some(t) if have < t => Attempt::Retry("the connection ended early".into(), got),
        _ => Attempt::Done,
    }
}

/// Downloads one artifact into `dir`, resuming a `.part` left by an earlier run (Range), with retries and backoff.
fn download(app: &AppHandle, client: &reqwest::Client, art: &Artifact, dir: &Path, on: &mut dyn FnMut(u64, Option<u64>)) -> Result<PathBuf, Failure> {
    let done = dir.join(&art.file);
    if let Ok(meta) = fs::metadata(&done) {
        if art.size.is_none_or(|s| s == meta.len()) {
            on(meta.len(), Some(meta.len()));
            return Ok(done);
        }
        let _ = fs::remove_file(&done);
    }
    let part = dir.join(format!("{}.part", art.file));
    let mut total = art.size;
    let mut tries = 0;
    let mut delay = Duration::from_secs(1);
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        match tauri::async_runtime::block_on(attempt(client, art, &part, &mut total, on)) {
            Attempt::Done => break,
            Attempt::Fail(f) => return Err(f),
            Attempt::Retry(reason, got) => {
                if got {
                    tries = 0;
                    delay = Duration::from_secs(1);
                }
                tries += 1;
                log(app, format!("download {} retry {tries}: {reason}", art.file));
                if tries >= ATTEMPTS {
                    return Err(Failure::network(reason));
                }
                let until = Instant::now() + delay;
                while Instant::now() < until {
                    if CANCEL.load(Ordering::SeqCst) {
                        return Err(Failure::Cancelled);
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                delay = (delay * 2).min(Duration::from_secs(30));
            }
        }
    }
    fs::rename(&part, &done).map_err(Failure::io)?;
    Ok(done)
}

fn pubkey(app: &AppHandle) -> Result<minisign_verify::PublicKey, Failure> {
    let encoded = app.config().plugins.0.get("updater").and_then(|u| u["pubkey"].as_str()).ok_or_else(|| Failure::Other("no update public key is configured".into()))?;
    let text = b64_text(encoded)?;
    minisign_verify::PublicKey::decode(&text).map_err(|e| Failure::Other(format!("the update public key: {e}")))
}

fn b64_text(encoded: &str) -> Result<String, Failure> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|e| Failure::Signature(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| Failure::Signature(e.to_string()))
}

/// Checks a downloaded file against its minisign signature while reading it once. The signature's trusted comment (signed
/// too) must name this version, and for the fast archives this file name, so a tampered manifest can neither pass off
/// an older release nor swap the app and runtime archives.
fn verify(key: &minisign_verify::PublicKey, file: &Path, art: &Artifact, version: &str, on: &mut dyn FnMut(u64, u64)) -> Result<(), Failure> {
    let signature = minisign_verify::Signature::decode(&b64_text(&art.signature)?).map_err(|e| Failure::Signature(e.to_string()))?;
    let mut verifier = key.verify_stream(&signature).map_err(|e| Failure::Signature(e.to_string()))?;
    let mut input = fs::File::open(file).map_err(Failure::io)?;
    let total = input.metadata().map_or(0, |m| m.len());
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        let n = input.read(&mut buf).map_err(Failure::io)?;
        if n == 0 {
            break;
        }
        verifier.update(&buf[..n]);
        done += n as u64;
        on(done, total);
    }
    verifier.finalize().map_err(|e| Failure::Signature(e.to_string()))?;
    let comment = signature.trusted_comment();
    let field = |name: &str| comment.split('\t').find_map(|f| f.strip_prefix(name)).map(str::to_owned);
    let signed = field("version:");
    let same = signed.as_deref().is_some_and(|s| match (semver::Version::parse(s.trim_start_matches('v')), semver::Version::parse(version)) {
        (Ok(a), Ok(b)) => a == b,
        _ => s == version,
    });
    if !same {
        return Err(Failure::Signature(format!("signed for version {}, offered as {version}", signed.as_deref().unwrap_or("(none)"))));
    }
    if art.signed_name && field("file:").as_deref() != Some(art.file.as_str()) {
        return Err(Failure::Signature(format!("signed for {}, offered as {}", field("file:").unwrap_or_default(), art.file)));
    }
    Ok(())
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let mut free = 0u64;
    (unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) } != 0).then_some(free)
}

#[cfg(unix)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(path.as_ptr(), &mut stat) } == 0).then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

/// Starts the background job for the newest known version unless it runs already.
fn start_job(app: &AppHandle) {
    let version = app.state::<Shell>().update.lock().as_ref().map(|u| u.version.clone());
    let Some(version) = version else { return };
    {
        let mut flow = FLOW.lock();
        if flow.job.is_some() || flow.applying || flow.ready.as_ref().is_some_and(|r| r.version == version) {
            return;
        }
        flow.job = Some(version);
    }
    CANCEL.store(false, Ordering::SeqCst);
    let app = app.clone();
    thread::spawn(move || job(app));
}

fn job(app: AppHandle) {
    let shell = app.state::<Shell>();
    let result = loop {
        let Some(update) = shell.update.lock().clone() else { break Err(Failure::Cancelled) };
        FLOW.lock().job = Some(update.version.clone());
        // A bug in preparing must not leave the update stuck as "downloading": it becomes an error with Retry.
        let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| prepare(&app, &update))).unwrap_or_else(|panic| {
            let text = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
            Err(Failure::Other(format!("preparing the update failed: {text}")))
        });
        match prepared {
            Err(Failure::Cancelled) if shell.update.lock().as_ref().is_some_and(|u| u.version != update.version) => {
                // A newer release turned up while this one downloaded.
                CANCEL.store(false, Ordering::SeqCst);
                continue;
            }
            other => break other,
        }
    };
    let install = {
        let mut flow = FLOW.lock();
        flow.job = None;
        flow.percent = None;
        if let Ok(ready) = &result {
            flow.ready = Some(ready.clone());
        }
        flow.install
    };
    refresh_menu(&app);
    match result {
        Ok(_) if install => apply_flow(&app),
        Ok(ready) => announce(&app, &ready),
        Err(Failure::Cancelled) => {
            log(&app, "download cancelled");
            FLOW.lock().install = false;
            if app.get_webview_window(WINDOW).is_some() {
                prompt(&app, false);
            }
        }
        Err(e) => {
            log(&app, format!("prepare failed: {e:?}"));
            let shown = app.get_webview_window(WINDOW).is_some();
            {
                let mut flow = FLOW.lock();
                flow.retry = Retry::Prepare;
                flow.install = false;
            }
            set_ui(&app, error_state(&app, &e, true));
            if !shown {
                let version = shell.update.lock().as_ref().map(|u| u.version.clone()).unwrap_or_default();
                // A chosen update that could not be prepared says why: no window is open to show it.
                let body = if install {
                    format!("OMP Control Room {version} could not be installed. {}. {}", e.title(), e.advice())
                } else if load(&app).later.as_deref() != Some(&version) {
                    // Found in the background and not downloadable right now: the tray still offers it.
                    format!("OMP Control Room {version} is available. Choose Install update in {TRAY} menu.")
                } else {
                    String::new()
                };
                if !body.is_empty() {
                    let _ = app.notification().builder().title(TITLE).body(body).show();
                }
            }
        }
    }
}

fn error_state(app: &AppHandle, e: &Failure, retry: bool) -> Value {
    let version = app.state::<Shell>().update.lock().as_ref().map(|u| u.version.clone());
    json!({ "state": "error", "current": current(app), "version": version, "error": { "kind": e.kind(), "title": e.title(), "advice": e.advice(), "detail": e.detail(), "retry": retry } })
}

fn phases(fast: bool) -> Value {
    if fast {
        json!(["download", "verify", "prepare", "save", "install", "restart"])
    } else {
        json!(["download", "verify", "save", "install", "restart"])
    }
}

/// Download, verify and (Windows fast updates) unpack next to the install. The app keeps running throughout.
fn prepare(app: &AppHandle, update: &Update) -> Result<Ready, Failure> {
    let started = Instant::now();
    let version = update.version.clone();
    let notes = notes_of(update);
    #[cfg(windows)]
    let install = install_dir().ok_or_else(|| Failure::Other("the install folder is unknown".into()))?;
    // Unpacked by an earlier run that could not install it (quit during sign-out, files in use).
    #[cfg(windows)]
    if let Some(staged) = fast::staged(&install).filter(|s| s.version == version) {
        log(app, format!("{version} is staged already"));
        return Ok(Ready { version, notes, size: String::new(), how: How::Fast(staged) });
    }
    let plan = plan(app, update)?;
    #[cfg(windows)]
    let fast_update = plan.fast.is_some();
    #[cfg(not(windows))]
    let fast_update = false;
    let size = size_text(&plan);
    let base = json!({ "version": version, "current": current(app), "notes": notes, "size": size, "phases": phases(fast_update) });
    let ui = |phase: &str, progress: Option<f64>, detail: String| {
        let install = FLOW.lock().install;
        let mut state = base.clone();
        state["state"] = json!(if install { "applying" } else { "downloading" });
        state["install"] = json!(install);
        state["phase"] = json!(phase);
        state["progress"] = json!(progress);
        state["detail"] = json!(detail);
        state
    };
    set_ui(app, ui("download", Some(0.0), size.clone()));
    let dir = download_dir(app)?;
    fs::create_dir_all(&dir).map_err(Failure::io)?;
    // Downloads of versions this plan does not need (one a newer release replaced).
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !plan.artifacts.iter().any(|a| name == a.file || name == format!("{}.part", a.file)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let sizes: Vec<u64> = plan.artifacts.iter().map(|a| a.size.unwrap_or(0)).collect();
    let total: u64 = sizes.iter().sum();
    if let Some(free) = free_space(&dir) {
        let have: u64 = plan.artifacts.iter().map(|a| fs::metadata(dir.join(&a.file)).or_else(|_| fs::metadata(dir.join(format!("{}.part", a.file)))).map_or(0, |m| m.len())).sum();
        // The archives, then what they unpack to (brotli packs node_modules about 3.4 : 1), and some room.
        let need = total.saturating_sub(have) + total * 4 + 64 * 1_048_576;
        if free < need {
            return Err(Failure::DiskFull(format!("{} free, about {} needed", mb(free), mb(need))));
        }
    }
    let client = client(app)?;
    let mut files = Vec::new();
    let mut meter = Meter::new();
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut before = 0u64;
    for art in &plan.artifacts {
        let file = download(app, &client, art, &dir, &mut |done, size| {
            if last.elapsed() < Duration::from_millis(200) {
                return;
            }
            last = Instant::now();
            let all = if total > 0 { Some(total) } else { size };
            let sum = before + done;
            let speed = meter.tick(sum);
            let progress = all.map(|t| (sum as f64 / t as f64).min(1.0));
            patch_ui(app, json!({ "progress": progress, "detail": download_detail(sum, all, speed) }));
            set_tray_percent(app, progress.map(|p| (p * 100.0) as u8));
        })?;
        before += fs::metadata(&file).map_or(0, |m| m.len());
        files.push(file);
    }
    let downloaded = started.elapsed();
    set_ui(app, ui("verify", Some(0.0), String::new()));
    let mut checked = 0u64;
    let key = pubkey(app)?;
    for (art, file) in plan.artifacts.iter().zip(&files) {
        let mut tick = Instant::now();
        let result = verify(&key, file, art, &version, &mut |done, _| {
            if tick.elapsed() > Duration::from_millis(150) {
                tick = Instant::now();
                patch_ui(app, json!({ "progress": ((checked + done) as f64 / before.max(1) as f64).min(1.0) }));
            }
        });
        if let Err(e) = result {
            if matches!(e, Failure::Signature(_)) {
                let _ = fs::remove_file(file);
            }
            return Err(e);
        }
        checked += fs::metadata(file).map_or(0, |m| m.len());
    }
    let verified = started.elapsed();
    #[cfg(windows)]
    if let Some(runtime) = &plan.fast {
        set_ui(app, ui("prepare", Some(0.0), String::new()));
        let tick = Mutex::new(Instant::now());
        let runtime_file = runtime.as_ref().map(|stamp| (files[1].as_path(), stamp.as_str()));
        let staged = fast::stage(&install, &exe_name(), &version, &files[0], runtime_file, &|done, total| {
            let mut tick = tick.lock();
            if tick.elapsed() > Duration::from_millis(150) {
                *tick = Instant::now();
                patch_ui(app, json!({ "progress": (done as f64 / total.max(1) as f64).min(1.0) }));
            }
        }, &CANCEL)
        .map_err(Failure::io)?;
        // Unpacked: the archives are not needed again.
        for file in &files {
            let _ = fs::remove_file(file);
        }
        warm_up(&install, &staged);
        log(app, format!("prepared {version}: download {:.1} s, verify {:.1} s, unpack + warm-up {:.1} s, {} (runtime {})", downloaded.as_secs_f64(), (verified - downloaded).as_secs_f64(), (started.elapsed() - verified).as_secs_f64(), mb(before), if runtime.is_some() { "changed" } else { "unchanged" }));
        return Ok(Ready { version, notes, size, how: How::Fast(staged) });
    }
    log(app, format!("prepared {version}: download {:.1} s, verify {:.1} s, {}", downloaded.as_secs_f64(), (verified - downloaded).as_secs_f64(), mb(before)));
    Ok(Ready { version, notes, size, how: How::Package(files.remove(0)) })
}

/// Starts the staged exe (and Bun when it is new) once, hidden, so the antivirus scan of the new binaries happens now
/// and not while the user waits for the restart. Each exits at once.
#[cfg(windows)]
fn warm_up(install: &Path, staged: &fast::Staged) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dir = fast::paths(install).staged.join(&staged.version);
    let mut runs = vec![(dir.join(exe_name()), "--omp-warmup")];
    if staged.runtime.is_some() {
        runs.push((dir.join("bun.exe"), "--version"));
    }
    for (exe, arg) in runs {
        if let Ok(mut child) = std::process::Command::new(&exe).arg(arg).current_dir(&dir).creation_flags(CREATE_NO_WINDOW).spawn() {
            let until = Instant::now() + Duration::from_secs(60);
            while Instant::now() < until && matches!(child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
        }
    }
}

/// A prepared update offered by itself: the window when the dashboard is on screen, a notification otherwise; nothing
/// for a version the user said Later to (the tray still has Restart to update).
fn announce(app: &AppHandle, ready: &Ready) {
    log(app, format!("ready: {}", ready.version));
    if load(app).later.as_deref() == Some(&ready.version) {
        return;
    }
    let on_screen = app.get_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    if on_screen || app.get_webview_window(WINDOW).is_some() {
        prompt(app, false);
    } else {
        let body = format!("OMP Control Room {} is ready. Choose Restart to update in {TRAY} menu, or it installs when you quit.", ready.version);
        let _ = app.notification().builder().title(TITLE).body(body).show();
    }
}

// ---------- installing ----------

/// Install now / Restart to update / Retry: prepare first when needed, then install.
fn begin_install(app: &AppHandle) {
    let ready = {
        let mut flow = FLOW.lock();
        if flow.applying {
            return;
        }
        flow.install = true;
        flow.ready.is_some()
    };
    store(app, |s| s.later = None);
    show(app, true);
    if ready {
        return apply_flow(app);
    }
    patch_ui(app, json!({ "state": "applying", "install": true }));
    start_job(app);
    // A job already running picks the install flag up when it finishes.
}

/// Saving sessions, installing, restarting. On failure the companion comes back and the app keeps running this version.
fn apply_flow(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let Some(ready) = FLOW.lock().ready.clone() else { return };
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let mut flow = FLOW.lock();
        flow.applying = true;
        flow.install = true;
    }
    shell.updating.store(true, Ordering::SeqCst);
    refresh_menu(app);
    let fast_update = !matches!(ready.how, How::Package(_));
    let base = json!({ "state": "applying", "install": true, "version": ready.version, "current": current(app), "notes": ready.notes, "size": ready.size, "phases": phases(fast_update) });
    let phase = |name: &str, progress: Option<f64>, detail: &str| {
        let mut state = base.clone();
        state["phase"] = json!(name);
        state["progress"] = json!(progress);
        state["detail"] = json!(detail);
        state
    };
    set_ui(app, phase("save", Some(0.0), "Pausing and saving sessions"));
    show(app, true);
    let started = Instant::now();
    stop_companion(app, true);
    let saved = started.elapsed();
    log(app, format!("installing {}: sessions saved and companion stopped in {:.1} s", ready.version, saved.as_secs_f64()));
    set_ui(app, phase("install", Some(0.0), ""));
    let result = install_ready(app, &ready, true);
    // Only a failure gets here on Windows (success exits); on macOS the restart follows.
    match result {
        Ok(()) => {}
        Err(e) => {
            log(app, format!("install of {} failed after saving sessions for {:.1} s: {e:?}", ready.version, saved.as_secs_f64()));
            {
                let mut flow = FLOW.lock();
                flow.applying = false;
                flow.install = false;
                flow.retry = Retry::Apply;
                if matches!(e, Failure::Signature(_)) {
                    flow.ready = None;
                }
            }
            store(app, |s| s.installing = None);
            set_ui(app, error_state(app, &e, true));
            reopen(app);
        }
    }
}

/// Brings the companion, tray and dashboard back after an install that did not happen. Its sessions resume from the
/// update note the quit left.
fn reopen(app: &AppHandle) {
    let shell = app.state::<Shell>();
    shell.quitting.store(false, Ordering::SeqCst);
    shell.updating.store(false, Ordering::SeqCst);
    match spawn_host(app, Some(&shell.token)) {
        Ok((host, ready)) if ready.port == shell.port => {
            shell.host_closed.store(false, Ordering::SeqCst);
            adopt(app, host, ready.lan, None);
            let handle = app.clone();
            let url = main_url(&shell);
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = create_tray(&handle) {
                    eprintln!("tray: {e}");
                }
                if let Some(webview) = handle.get_webview("main") {
                    let _ = webview.navigate(url);
                }
            });
        }
        Ok((host, ready)) => {
            host.send_quit();
            host.wait_exit(Duration::from_secs(10));
            error_dialog(app, format!("The update did not install, and the companion could not start again (it listened on port {} instead of {}). Start OMP Control Room again.", ready.port, shell.port));
            app.exit(1);
        }
        Err(e) => {
            error_dialog(app, format!("The update did not install, and the companion could not start again. Start OMP Control Room again.\n\n{e}"));
            app.exit(1);
        }
    }
}

/// Swaps the prepared version in (or runs its package). relaunch: start it and exit (Install now); otherwise the app is
/// quitting and the next launch starts it.
fn install_ready(app: &AppHandle, ready: &Ready, relaunch: bool) -> Result<(), Failure> {
    let from = current(app);
    store(app, |s| s.installing = Some(Installing { from: from.clone(), to: ready.version.clone(), at: now() }));
    let started = Instant::now();
    match &ready.how {
        #[cfg(windows)]
        How::Fast(staged) => {
            let install = install_dir().ok_or_else(|| Failure::Other("the install folder is unknown".into()))?;
            let exe = exe_name();
            let mut last = Instant::now();
            let swap = fast::apply(&install, &exe, &from, staged, &mut |done, total| {
                if last.elapsed() > Duration::from_millis(100) || done == total {
                    last = Instant::now();
                    patch_ui(app, json!({ "progress": done as f64 / total.max(1) as f64 }));
                }
            })
            .map_err(Failure::io)?;
            set_uninstall_version(app, &ready.version);
            log(app, format!("installed {} by swap in {:.2} s ({} entries, runtime {})", ready.version, started.elapsed().as_secs_f64(), swap.entries.len(), if staged.runtime.is_some() { "changed" } else { "kept" }));
            if !relaunch {
                return Ok(());
            }
            patch_ui(app, json!({ "phase": "restart", "progress": Value::Null, "detail": "" }));
            let pid = std::process::id();
            // The token goes along: the dashboard window and copied phone links reconnect to the new version instead of
            // asking for a token that changed (boot reads it back). None at startup, where no window or phone was open.
            let token = app.try_state::<Shell>().map(|shell| shell.token.clone());
            let mut command = std::process::Command::new(install.join(&exe));
            command.args(["--omp-updated".to_owned(), format!("--omp-wait-pid={pid}")]).current_dir(&install);
            if let Some(token) = token {
                command.env("OMP_WEB_DESKTOP_TOKEN", token);
            }
            let spawned = command.spawn();
            if let Err(e) = spawned {
                // Never leave a version installed that cannot be started from here: put the old one back.
                let _ = fast::rollback(&install, &swap, &e.to_string());
                set_uninstall_version(app, &from);
                return Err(Failure::Other(format!("the new version could not be started: {e}")));
            }
            app.exit(0);
            Ok(())
        }
        How::Package(file) => {
            let update = app.state::<Shell>().update.lock().clone().filter(|u| u.version == ready.version).ok_or_else(|| Failure::Other("the update is no longer offered; check again".into()))?;
            let bytes = fs::read(file).map_err(Failure::io)?;
            #[cfg(windows)]
            {
                // The installer runs silently (installMode "quiet"), then starts the app when relaunch is set; on
                // success install() exits this process. The app it starts inherits the token below.
                let update = update.restart_after_install(relaunch);
                log(app, format!("installing {} with the installer", ready.version));
                let token = if relaunch { app.try_state::<Shell>().map(|shell| shell.token.clone()) } else { None };
                if let Some(token) = &token {
                    std::env::set_var("OMP_WEB_DESKTOP_TOKEN", token);
                }
                let installed = update.install(bytes).map_err(|e| install_error(e.to_string()));
                if installed.is_err() && token.is_some() {
                    std::env::remove_var("OMP_WEB_DESKTOP_TOKEN");
                }
                installed?;
                Ok(())
            }
            #[cfg(not(windows))]
            {
                update.install(bytes).map_err(|e| install_error(e.to_string()))?;
                log(app, format!("installed {} in {:.2} s", ready.version, started.elapsed().as_secs_f64()));
                let _ = fs::remove_file(file);
                if relaunch {
                    patch_ui(app, json!({ "phase": "restart", "progress": Value::Null, "detail": "" }));
                    // app.restart() runs the new binary with this process's environment: the token comes along.
                    if let Some(shell) = app.try_state::<Shell>() {
                        std::env::set_var("OMP_WEB_DESKTOP_TOKEN", shell.token.clone());
                    }
                    app.restart();
                }
                Ok(())
            }
        }
    }
}

fn install_error(text: String) -> Failure {
    let lower = text.to_lowercase();
    if lower.contains("signature") {
        Failure::Signature(text)
    } else {
        Failure::Other(text)
    }
}

/// Quit with an update ready: install it on the way out (no window; the next launch says "Updated to X").
pub fn apply_on_quit(app: &AppHandle) {
    CANCEL.store(true, Ordering::SeqCst);
    let Some(ready) = FLOW.lock().ready.clone() else { return };
    log(app, format!("installing {} on quit", ready.version));
    if let Err(e) = install_ready(app, &ready, false) {
        log(app, format!("install on quit failed: {e:?}"));
        store(app, |s| s.installing = None);
    }
}

/// The companion reported a session stopped during an update quit.
pub fn saving(app: &AppHandle, done: u64, total: u64) {
    if !FLOW.lock().applying {
        return;
    }
    let detail = if total > 1 { format!("{} of {} sessions saved", done.min(total - 1), total - 1) } else { "Saving sessions".into() };
    patch_ui(app, json!({ "progress": done as f64 / total.max(1) as f64, "detail": detail }));
}

#[cfg(windows)]
fn set_uninstall_version(app: &AppHandle, version: &str) {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ};
    let product = app.config().product_name.clone().unwrap_or_else(|| TITLE.into());
    let key: Vec<u16> = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{product}").encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = "DisplayVersion".encode_utf16().chain(Some(0)).collect();
    let value: Vec<u16> = version.encode_utf16().chain(Some(0)).collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut hkey) == 0 {
            RegSetValueExW(hkey, name.as_ptr(), 0, REG_SZ, value.as_ptr().cast(), (value.len() * 2) as u32);
            RegCloseKey(hkey);
        }
    }
}

// ---------- startup ----------

#[derive(PartialEq)]
pub enum Boot {
    Continue,
    Exit,
}

/// Before the companion starts: finish or undo an interrupted swap, roll back a version that keeps failing to start,
/// install an update prepared by an earlier run, and show "Updated to X" after an update.
pub fn startup(app: &AppHandle) -> Boot {
    if cfg!(debug_assertions) {
        return Boot::Continue;
    }
    let version = current(app);
    #[cfg(windows)]
    if let Some(install) = install_dir() {
        match fast::recover(&install) {
            Ok(Some(swap)) => log(app, format!("an update to {} was interrupted; {} was put back", swap.to, swap.from)),
            Ok(None) => {}
            Err(e) => log(app, format!("could not undo an interrupted update: {e}")),
        }
        match fast::note_start(&install, &version) {
            fast::Start::RollBack(swap) => {
                log(app, format!("{version} did not start {} times; putting {} back", fast::MAX_ATTEMPTS, swap.from));
                return roll_back(app, &install, &swap, "it did not start");
            }
            fast::Start::Unconfirmed(swap) => {
                log(app, format!("start {} of {version} (from {})", swap.attempts, swap.from));
                FLOW.lock().unconfirmed = true;
            }
            fast::Start::Normal => {}
        }
        if let Some(staged) = fast::staged(&install) {
            let failed = fast::failed(&install).is_some_and(|f| f.version == staged.version);
            let updated = std::env::args().any(|a| a == "--omp-updated");
            if fast::newer(&staged.version, &version) && !failed && !updated {
                let ready = Ready { version: staged.version.clone(), notes: String::new(), size: String::new(), how: How::Fast(staged) };
                set_ui(app, json!({ "state": "applying", "install": true, "version": ready.version, "current": version, "phases": ["install", "restart"], "phase": "install", "progress": 0.0 }));
                show(app, true);
                {
                    let mut flow = FLOW.lock();
                    flow.applying = true;
                }
                log(app, format!("installing {} prepared by an earlier run", ready.version));
                match install_ready(app, &ready, true) {
                    Ok(()) => return Boot::Exit,
                    Err(e) => {
                        log(app, format!("could not install {} at start: {e:?}", ready.version));
                        store(app, |s| s.installing = None);
                        let mut flow = FLOW.lock();
                        flow.applying = false;
                        flow.ready = Some(ready);
                        drop(flow);
                        close_window(app);
                    }
                }
            }
        }
    }
    let saved = load(app);
    if let Some(done) = saved.installing.clone() {
        store(app, |s| s.installing = None);
        if done.to == version && now().saturating_sub(done.at) < UPDATED_WINDOW {
            log(app, format!("updated from {} to {version}", done.from));
            FLOW.lock().updated_at = Some(done.at);
            set_ui(app, json!({ "state": "updated", "version": version, "from": done.from }));
            show(app, true);
        } else if done.to != version && now().saturating_sub(done.at) < UPDATED_WINDOW {
            log(app, format!("the update to {} did not finish; still {version}", done.to));
        }
    }
    Boot::Continue
}

#[cfg(windows)]
fn roll_back(app: &AppHandle, install: &Path, swap: &fast::Swap, why: &str) -> Boot {
    match fast::rollback(install, swap, why) {
        Ok(()) => {
            set_uninstall_version(app, &swap.from);
            store(app, |s| s.installing = None);
            let pid = std::process::id();
            let started = std::process::Command::new(install.join(exe_name())).arg(format!("--omp-wait-pid={pid}")).current_dir(install).spawn();
            if let Err(e) = started {
                error_dialog(app, format!("OMP Control Room {} could not start, so {} was put back, but it did not start either: {e}\n\nStart OMP Control Room again.", swap.to, swap.from));
            }
        }
        Err(e) => {
            log(app, format!("rollback failed: {e}"));
            error_dialog(app, format!("OMP Control Room {} could not start, and the previous version could not be put back: {e}\n\nInstall OMP Control Room again from its website; your sessions and settings are kept.", swap.to));
        }
    }
    app.exit(0);
    Boot::Exit
}

/// The companion of a version swapped in moments ago did not start: put the previous version back and start that.
/// Returns true when it took over (the app exits).
pub fn companion_failed(app: &AppHandle, error: &str) -> bool {
    #[cfg(windows)]
    {
        if !FLOW.lock().unconfirmed {
            return false;
        }
        let Some(install) = install_dir() else { return false };
        let Some(swap) = fast::unconfirmed(&install) else { return false };
        log(app, format!("the companion of {} did not start: {error}", swap.to));
        roll_back(app, &install, &swap, error) == Boot::Exit
    }
    #[cfg(not(windows))]
    {
        let _ = (app, error);
        false
    }
}

/// The dashboard loaded: this version works. Confirm a fresh swap, report a rolled-back one, clean up in the background.
pub fn dashboard_ready(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let updated_at = FLOW.lock().updated_at.take();
        if let Some(at) = updated_at {
            log(&app, format!("dashboard of the new version {:.1} s after the install began", now().saturating_sub(at) as f64 / 1000.0));
        }
        if FLOW.lock().ui["state"] == "updated" {
            thread::sleep(Duration::from_millis(1500));
            close_window(&app);
        }
        #[cfg(windows)]
        if let Some(install) = install_dir() {
            let confirmed = std::mem::take(&mut FLOW.lock().unconfirmed);
            if confirmed {
                fast::confirm(&install);
                log(&app, "confirmed");
            }
            if let Some(failed) = fast::failed(&install).filter(|f| !f.reported) {
                fast::mark_reported(&install);
                let body = format!("OMP Control Room {} could not start ({}), so this version was put back. It will be offered again through the installer.", failed.version, failed.error);
                let _ = app.notification().builder().title(TITLE).body(body).show();
            }
            if cfg!(not(debug_assertions)) {
                let started = Instant::now();
                fast::cleanup(&install, &current(&app), confirmed.then_some(&[][..]));
                log(&app, format!("cleanup in {:.1} s", started.elapsed().as_secs_f64()));
            }
        }
        #[cfg(not(windows))]
        if let Ok(dir) = download_dir(&app) {
            if load(&app).installing.is_none() && FLOW.lock().job.is_none() {
                let _ = fs::remove_dir_all(dir);
            }
        }
    });
}

/// Blocks until the old process (which swapped this version in and is exiting) is gone, so the single-instance check
/// does not mistake it for a running copy. At most 30 s.
#[cfg(windows)]
pub fn wait_for_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() {
            WaitForSingleObject(handle, 30_000);
            CloseHandle(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A file signed with a throwaway key by `tauri signer sign --app-version 1.2.3`, as release.yml signs the archives.
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRGQjJDM0FENjcxREQ4OEEKUldTSzJCMW5yY095VDRxWVpPRVZ2NXUvWGlYQnp4WG0zbklRdXF5Qmg1TUZBbFpHbmdkL2FsbGMK";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTSzJCMW5yY095VDVwMXNLTmxTcVpPaGdOS2xVdWdJTlQyQ0RycTQ2NHZnN1A4eXdsd2lVWjkySTdBRXg5dlR1Tzk1MVpVcUJ5cnlTTG9VaFN3Si9ocFVMWlFJeU1hNEFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0OTYzMTQ5CWZpbGU6b21wLWNvbnRyb2wtcm9vbV8xLjIuM194NjQtYXBwLnRhci5icgl2ZXJzaW9uOjEuMi4zCkVZZkJNUWR1dDJ5MnVETTJpbWpmb05mQlZLNUp3ekx2YUJSS0VjSXY5ZEpqZHpDRmlGd1RINzlFKzhSY0MyTmxrdU5KNmpXcE5YWW1hL0Z2USt4Q0FBPT0K";
    const SIGNED: &[u8] = b"OMP fast update fixture\n";
    const NAME: &str = "omp-control-room_1.2.3_x64-app.tar.br";

    fn fixture(content: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-verify-{}-{}", std::process::id(), now()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(NAME);
        fs::write(&file, content).unwrap();
        file
    }

    fn artifact(file: &str, signed_name: bool) -> Artifact {
        Artifact { url: Url::parse("http://127.0.0.1/x").unwrap(), signature: SIGNATURE.into(), size: None, file: file.into(), signed_name }
    }

    fn check(content: &[u8], art: &Artifact, version: &str) -> Result<(), Failure> {
        let key = minisign_verify::PublicKey::decode(&b64_text(PUBKEY).unwrap()).unwrap();
        let file = fixture(content);
        let result = verify(&key, &file, art, version, &mut |_, _| {});
        let _ = fs::remove_dir_all(file.parent().unwrap());
        result
    }

    #[test]
    fn a_signed_archive_passes_only_under_its_own_name_and_version() {
        assert!(check(SIGNED, &artifact(NAME, true), "1.2.3").is_ok());
        let mut changed = SIGNED.to_vec();
        changed[0] ^= 1;
        assert!(matches!(check(&changed, &artifact(NAME, true), "1.2.3"), Err(Failure::Signature(_))), "a changed byte");
        assert!(matches!(check(SIGNED, &artifact(NAME, true), "1.2.4"), Err(Failure::Signature(_))), "offered as another version");
        let runtime = "omp-control-room_runtime-00ff_x64.tar.br";
        assert!(matches!(check(SIGNED, &artifact(runtime, true), "1.2.3"), Err(Failure::Signature(_))), "offered as another archive");
        // Packages (the installer, the .app.tar.gz) are saved under another name; their version still has to match.
        assert!(check(SIGNED, &artifact("1.2.3-setup.exe", false), "1.2.3").is_ok());
        assert!(matches!(check(SIGNED, &artifact("1.2.4-setup.exe", false), "1.2.4"), Err(Failure::Signature(_))));
    }

    fn fetch(url: &str) -> Failure {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().unwrap();
        let error = tauri::async_runtime::block_on(async { client.get(url).send().await }).expect_err("the request should fail");
        Failure::network(chain(&error))
    }

    #[test]
    fn network_errors_tell_offline_from_an_unreachable_server() {
        // .invalid never resolves (RFC 2606): what a machine without network sees for any host.
        assert!(matches!(fetch("http://omp-update.invalid/latest.json"), Failure::Offline(_)));
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(matches!(fetch(&format!("http://127.0.0.1:{port}/latest.json")), Failure::Unreachable(_)), "nothing listens there");
    }
}
