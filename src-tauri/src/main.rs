// OMP Control Room desktop shell: runs the companion through the bundled Bun and shows the dashboard.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use host::{Host, Ready};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::StateFlags;

const TITLE: &str = "OMP Control Room";
// OMP runs inside the companion, so an OMP crash ends it: the shell restarts it, but gives up after this many crashes
// within RESTART_WINDOW (something is broken for good, and restarting would only lose the error).
const RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(600);
const RESTART_DELAYS: [u64; RESTARTS] = [1, 5, 15];
// The watchdog asks the companion every PING_EVERY; this many unanswered asks in a row mean it is stuck.
const PING_EVERY: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(15);
const PING_MISSES: u32 = 3;
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 3600);

struct Shell {
    // Replaced when the companion is restarted after a crash.
    host: Mutex<Arc<Host>>,
    port: u16,
    token: String,
    lan: Mutex<bool>,
    screen: Mutex<bool>,
    // Address of the device viewing and controlling this PC, shown in the tray while it is connected.
    viewer: Mutex<Option<String>>,
    links: Mutex<Vec<(String, String)>>,
    quitting: AtomicBool,
    host_closed: AtomicBool,
    told_about_tray: AtomicBool,
    // When the companion stopped unexpectedly, for the restart limit.
    crashes: Mutex<Vec<Instant>>,
    // Set by the watchdog before it kills a companion that stopped answering.
    hung: AtomicBool,
    // A newer signed release found by the update check; the tray offers to install it.
    update: Mutex<Option<Update>>,
    updating: AtomicBool,
}

impl Shell {
    fn host(&self) -> Arc<Host> {
        self.host.lock().clone()
    }
}

static POPUPS: AtomicU64 = AtomicU64::new(0);

fn error_dialog(app: &AppHandle, message: impl Into<String>) {
    app.dialog().message(message).title(TITLE).kind(MessageDialogKind::Error).blocking_show();
}

fn fetch_links(host: &Host) -> Vec<(String, String)> {
    let Ok(reply) = host.request(json!({ "cmd": "links" }), Duration::from_secs(15)) else { return Vec::new() };
    reply["links"]
        .as_array()
        .map(|links| {
            links
                .iter()
                .filter_map(|l| Some((l["label"].as_str()?.to_owned(), l["url"].as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let script = if cfg!(debug_assertions) {
        // Development runs the live repo files.
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../desktop/host.mjs")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("desktop/host.mjs")
    };
    // tauri-build copies externalBin next to the executable without the target-triple suffix.
    let bun = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("bun.exe");
    Ok((dunce::simplified(&bun).to_path_buf(), dunce::simplified(&script).to_path_buf()))
}

// Sessions that finished, failed or ask a question; the dashboard shows them itself when the window is in front.
// Screen viewers always notify: someone controlling this PC must never go unnoticed by the person sitting at it.
fn on_event(app: AppHandle) -> impl Fn(Value) + Send + 'static {
    move |msg: Value| match msg["event"].as_str() {
        Some("attention") => {
            let title = msg["title"].as_str().unwrap_or(TITLE).to_owned();
            let body = msg["body"].as_str().unwrap_or_default().to_owned();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let in_front = handle.get_webview_window("main").is_some_and(|w| {
                    w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
                });
                if !in_front {
                    let _ = handle.notification().builder().title(title).body(body).show();
                }
            });
        }
        Some("screen") => {
            let Some(shell) = app.try_state::<Shell>() else { return };
            let viewer = msg["address"].as_str().map(str::to_owned);
            // Turning sharing off in the tray also ends the view; the person who clicked it needs no toast for that.
            let body = match &viewer {
                Some(address) => Some(format!("{address} is now viewing and controlling this PC. Turn off screen sharing in the tray to stop it.")),
                None if *shell.screen.lock() => Some("Nobody is viewing this PC's screen anymore.".to_owned()),
                None => None,
            };
            *shell.viewer.lock() = viewer;
            if let Some(body) = body {
                let _ = app.notification().builder().title(TITLE).body(body).show();
            }
            refresh_menu(&app);
        }
        _ => {}
    }
}

// The companion ended without being asked to (a crash, OMP taking the process down, the watchdog): restart it.
fn on_exit(app: AppHandle) -> impl FnOnce(String) + Send + 'static {
    move |tail: String| {
        let Some(shell) = app.try_state::<Shell>() else {
            // Before the shell took over the host, as at startup: nothing to restart into yet.
            error_dialog(&app, format!("The companion stopped unexpectedly.\n\n{tail}"));
            app.exit(1);
            return;
        };
        if shell.quitting.load(Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        thread::spawn(move || recover(&app, tail));
    }
}

fn spawn_host(app: &AppHandle, restart_token: Option<&str>) -> Result<(Host, Ready), String> {
    let (bun, script) = paths(app)?;
    host::spawn(&bun, &script, restart_token, on_event(app.clone()), on_exit(app.clone()))
}

fn main_url(shell: &Shell) -> Url {
    format!("http://127.0.0.1:{}/#token={}", shell.port, shell.token).parse().unwrap()
}

fn boot(app: AppHandle) {
    let (host, ready) = match spawn_host(&app, None) {
        Ok(started) => started,
        Err(e) => {
            error_dialog(&app, e);
            app.exit(1);
            return;
        }
    };
    let links = fetch_links(&host);
    app.manage(Shell {
        host: Mutex::new(Arc::new(host)),
        port: ready.port,
        token: ready.token,
        lan: Mutex::new(false),
        screen: Mutex::new(false),
        viewer: Mutex::new(None),
        links: Mutex::new(links),
        quitting: AtomicBool::new(false),
        host_closed: AtomicBool::new(false),
        told_about_tray: AtomicBool::new(false),
        crashes: Mutex::new(Vec::new()),
        hung: AtomicBool::new(false),
        update: Mutex::new(None),
        updating: AtomicBool::new(false),
    });
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = create_tray(&handle) {
            eprintln!("tray: {e}");
        }
        create_main(&handle);
    });
    let handle = app.clone();
    thread::spawn(move || watchdog(handle));
    // Development builds run the repo's files; only installed releases update themselves.
    if !cfg!(debug_assertions) {
        thread::spawn(move || update_loop(app));
    }
}

// Restarts a companion that stopped unexpectedly on the same port and token, so the open window and copied phone
// links keep working. Its sessions come back paused, as after a quit.
fn recover(app: &AppHandle, mut reason: String) {
    let shell = app.state::<Shell>();
    let hung = shell.hung.swap(false, Ordering::SeqCst);
    let headline = if hung { "The companion stopped responding and was stopped." } else { "The companion exited without an error message." };
    if reason.trim().is_empty() {
        reason = headline.to_owned();
    } else if hung {
        reason = format!("{headline}\n\n{reason}");
    }
    loop {
        let log = log_crash(app, &reason);
        let crashes = {
            let mut crashes = shell.crashes.lock();
            crashes.retain(|at| at.elapsed() < RESTART_WINDOW);
            crashes.push(Instant::now());
            crashes.len()
        };
        if crashes > RESTARTS {
            shell.quitting.store(true, Ordering::SeqCst);
            let log = log.map(|p| format!("\n\nDetails: {}", p.display())).unwrap_or_default();
            error_dialog(
                app,
                format!("The companion stopped unexpectedly {crashes} times within 10 minutes, so OMP Control Room is closing. Sessions that were running are paused.{log}\n\n{}", reason.trim()),
            );
            app.exit(1);
            return;
        }
        thread::sleep(Duration::from_secs(RESTART_DELAYS[crashes - 1]));
        if shell.quitting.load(Ordering::SeqCst) {
            return;
        }
        match spawn_host(app, Some(&shell.token)) {
            Ok((host, ready)) if ready.port == shell.port => return adopt(app, host, log),
            Ok((host, ready)) => {
                host.send_quit();
                host.wait_exit(Duration::from_secs(10));
                reason = format!("The restarted companion listened on port {} instead of {}.", ready.port, shell.port);
            }
            Err(e) => reason = e,
        }
    }
}

fn adopt(app: &AppHandle, host: Host, log: Option<PathBuf>) {
    let shell = app.state::<Shell>();
    let host = Arc::new(host);
    let old = std::mem::replace(&mut *shell.host.lock(), host.clone());
    old.wait_exit(Duration::ZERO);
    // Quit started against the old host while this one was starting: stop this one too.
    if shell.quitting.load(Ordering::SeqCst) {
        host.send_quit();
        host.wait_exit(Duration::from_secs(10));
        return;
    }
    // Network access survives the restart. Screen sharing does not: like at every launch, it needs a new OK on this PC.
    if *shell.lan.lock() {
        let on = host.request(json!({ "cmd": "lan", "on": true }), Duration::from_secs(15)).ok().and_then(|r| r["lan"].as_bool());
        *shell.lan.lock() = on.unwrap_or(false);
    }
    *shell.screen.lock() = false;
    *shell.viewer.lock() = None;
    *shell.links.lock() = fetch_links(&host);
    refresh_menu(app);
    let url = main_url(&shell);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.navigate(url);
        }
    });
    let log = log.map(|p| format!(" Details: {}", p.display())).unwrap_or_default();
    let body = format!("The companion stopped unexpectedly and was restarted. Sessions that were running are paused; send them a message to continue.{log}");
    let _ = app.notification().builder().title(TITLE).body(body).show();
}

// A companion whose event loop is stuck answers nothing but never exits; killing it hands it to recover().
fn watchdog(app: AppHandle) {
    let mut misses = 0;
    loop {
        thread::sleep(PING_EVERY);
        let shell = app.state::<Shell>();
        if shell.quitting.load(Ordering::SeqCst) {
            return;
        }
        let host = shell.host();
        // A host that exited is recover()'s; only a running one that doesn't answer counts.
        if host.request(json!({ "cmd": "busy" }), PING_TIMEOUT).is_ok() || !host.running() {
            misses = 0;
            continue;
        }
        misses += 1;
        if misses >= PING_MISSES {
            misses = 0;
            shell.hung.store(true, Ordering::SeqCst);
            host.wait_exit(Duration::ZERO);
        }
    }
}

// Appends to companion-crashes.log in the app's log folder; the previous log is kept as .old once it passes 1 MB.
fn log_crash(app: &AppHandle, reason: &str) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    let file = dir.join("companion-crashes.log");
    if fs::metadata(&file).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = fs::rename(&file, dir.join("companion-crashes.old.log"));
    }
    let mut out = fs::OpenOptions::new().create(true).append(true).open(&file).ok()?;
    writeln!(out, "--- {} UTC, app {}\n{}\n", utc_now(), app.package_info().version, reason.trim()).ok()?;
    Some(file)
}

// YYYY-MM-DD HH:MM:SS from the system clock (days-to-civil conversion, proleptic Gregorian).
fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn check_for_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())
}

// Checks the latest GitHub release shortly after start and then every few hours. Offline or no release: try again later.
fn update_loop(app: AppHandle) {
    thread::sleep(Duration::from_secs(20));
    loop {
        if app.state::<Shell>().quitting.load(Ordering::SeqCst) {
            return;
        }
        match check_for_update(&app) {
            Ok(Some(update)) => offer_update(&app, update, true),
            Ok(None) => {}
            Err(e) => eprintln!("update check: {e}"),
        }
        thread::sleep(UPDATE_EVERY);
    }
}

// Puts "Install update" in the tray; a version the user was already told about is not announced again.
fn offer_update(app: &AppHandle, update: Update, notify: bool) {
    let shell = app.state::<Shell>();
    let version = update.version.clone();
    let known = shell.update.lock().replace(update).is_some_and(|old| old.version == version);
    refresh_menu(app);
    if notify && !known {
        let body = format!("OMP Control Room {version} is available. Choose Install update in the tray menu.");
        let _ = app.notification().builder().title(TITLE).body(body).show();
    }
}

fn check_now(app: &AppHandle) {
    match check_for_update(app) {
        Ok(Some(update)) => {
            offer_update(app, update, false);
            install_update(app);
        }
        Ok(None) => {
            app.dialog()
                .message(format!("OMP Control Room {} is up to date.", app.package_info().version))
                .title(TITLE)
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(e) => error_dialog(app, format!("Could not check for updates\n\n{e}")),
    }
}

fn busy_sessions(shell: &Shell) -> u64 {
    shell.host().request(json!({ "cmd": "busy" }), Duration::from_secs(10)).ok().and_then(|r| r["busy"].as_u64()).unwrap_or(0)
}

// Download first (the app keeps working meanwhile), then stop the companion as on Quit, then run the installer,
// which closes the app, replaces its files and starts the new version.
fn install_update(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let Some(update) = shell.update.lock().clone() else { return };
    if shell.quitting.load(Ordering::SeqCst) || shell.updating.swap(true, Ordering::SeqCst) {
        return;
    }
    let busy = busy_sessions(&shell);
    let mut message = format!("Install OMP Control Room {}? The app closes, installs the update and starts again.", update.version);
    if busy > 0 {
        let working = if busy == 1 { "1 session is still working; it".to_owned() } else { format!("{busy} sessions are still working; they") };
        message.push_str(&format!(" {working} will be paused, and you can continue by sending a message after the update."));
    }
    if let Some(notes) = update.body.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let notes: String = notes.chars().take(1500).collect();
        message.push_str(&format!("\n\n{notes}"));
    }
    let confirmed = app
        .dialog()
        .message(message)
        .title(TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Not now".into()))
        .blocking_show();
    if !confirmed {
        shell.updating.store(false, Ordering::SeqCst);
        return;
    }
    let tray = app.tray_by_id("main");
    let mut shown = 0;
    let mut received = 0usize;
    let progress = |chunk: usize, total: Option<u64>| {
        received += chunk;
        let Some(total) = total.filter(|t| *t > 0) else { return };
        let percent = (received as u64 * 100 / total).min(100);
        if percent >= shown + 5 {
            shown = percent;
            if let Some(tray) = &tray {
                let _ = tray.set_tooltip(Some(format!("{TITLE} — downloading update {percent} %")));
            }
        }
    };
    // download() checks the signature against the public key in tauri.conf.json before returning the bytes.
    let bytes = match tauri::async_runtime::block_on(update.download(progress, || {})) {
        Ok(bytes) => bytes,
        Err(e) => {
            shell.updating.store(false, Ordering::SeqCst);
            refresh_menu(app);
            return error_dialog(app, format!("Could not download the update\n\n{e}"));
        }
    };
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    stop_companion(app);
    // On success the installer takes over and this process exits.
    if let Err(e) = update.install(bytes) {
        error_dialog(app, format!("Could not install the update. Sessions were paused and saved; start OMP Control Room again to keep using this version.\n\n{e}"));
        app.exit(1);
    }
}

fn same_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

// Own-origin pages stay in the app (they inherit the token through sessionStorage),
// web links go to the default browser, anything else is refused.
fn nav_guard(app: AppHandle, port: u16) -> impl Fn(&Url) -> bool + Send + 'static {
    move |url| {
        if same_origin(url, port) || url.as_str() == "about:blank" {
            return true;
        }
        open_external(&app, url);
        false
    }
}

fn new_window_handler(app: AppHandle, port: u16) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<Wry> + Send + Sync + 'static {
    move |url, features| {
        if !same_origin(&url, port) {
            open_external(&app, &url);
            return NewWindowResponse::Deny;
        }
        let label = format!("popup-{}", POPUPS.fetch_add(1, Ordering::Relaxed) + 1);
        // The webview hands the popup its opener relationship; the dashboard then loads `url` into it.
        let built = WebviewWindowBuilder::new(&app, label, WebviewUrl::External("about:blank".parse().unwrap()))
            .window_features(features)
            .title(TITLE)
            .on_navigation(nav_guard(app.clone(), port))
            .on_new_window(new_window_handler(app.clone(), port))
            .build();
        match built {
            Ok(window) => NewWindowResponse::Create { window },
            Err(_) => NewWindowResponse::Deny,
        }
    }
}

fn create_main(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let url = main_url(&shell);
    // Shown on the first finished load only: no white flash, and later reloads don't pop a window hidden in the tray.
    let shown = Arc::new(AtomicBool::new(false));
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(TITLE)
        .inner_size(1400.0, 900.0)
        .visible(false)
        .on_navigation(nav_guard(app.clone(), shell.port))
        .on_new_window(new_window_handler(app.clone(), shell.port))
        // The dashboard badges document.title with sessions that need attention; the taskbar shows it.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished && !shown.swap(true, Ordering::SeqCst) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build();
    if let Err(e) = built {
        error_dialog(app, format!("Could not open the window: {e}"));
    }
}

fn show_main(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        // A page-side window.close() destroys the window; rebuild it instead of leaving a windowless app.
        None if app.try_state::<Shell>().is_some() => create_main(app),
        None => {}
    }
}

// The tray's update entry; development builds have none (they run the repo's files).
enum UpdateItem {
    Hidden,
    Check,
    Install(String),
    Installing,
}

fn update_item(shell: &Shell) -> UpdateItem {
    if cfg!(debug_assertions) {
        UpdateItem::Hidden
    } else if shell.updating.load(Ordering::SeqCst) {
        UpdateItem::Installing
    } else {
        shell.update.lock().as_ref().map_or(UpdateItem::Check, |u| UpdateItem::Install(u.version.clone()))
    }
}

fn build_menu(app: &AppHandle, lan: bool, screen: bool, viewer: Option<&str>, links: &[(String, String)], update: &UpdateItem) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let lan_item = CheckMenuItem::with_id(app, "lan", "Allow phones on my network", true, lan, None::<&str>)?;
    let screen_label = match viewer {
        Some(address) => format!("Allow screen sharing and control ({address} is viewing)"),
        None => "Allow screen sharing and control".to_owned(),
    };
    let screen_item = CheckMenuItem::with_id(app, "screen", screen_label, true, screen, None::<&str>)?;
    let link_items: Vec<MenuItem<Wry>> = if links.is_empty() {
        vec![MenuItem::new(app, "No network address found", false, None::<&str>)?]
    } else {
        links
            .iter()
            .enumerate()
            .map(|(i, (label, _))| MenuItem::with_id(app, format!("link:{i}"), label, true, None::<&str>))
            .collect::<tauri::Result<_>>()?
    };
    let link_refs: Vec<&dyn IsMenuItem<Wry>> = link_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
    let copy = Submenu::with_items(app, "Copy phone link", lan, &link_refs)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let update_item = match update {
        UpdateItem::Hidden => None,
        UpdateItem::Check => Some(MenuItem::with_id(app, "check_update", "Check for updates", true, None::<&str>)?),
        UpdateItem::Install(version) => Some(MenuItem::with_id(app, "update", format!("Install update {version}…"), true, None::<&str>)?),
        UpdateItem::Installing => Some(MenuItem::new(app, "Installing update…", false, None::<&str>)?),
    };
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&open, &lan_item, &copy, &screen_item, &separator];
    if let Some(item) = &update_item {
        items.push(item);
    }
    items.push(&quit);
    Menu::with_items(app, &items)
}

fn refresh_menu(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let lan = *shell.lan.lock();
    let screen = *shell.screen.lock();
    let viewer = shell.viewer.lock().clone();
    let links = shell.links.lock().clone();
    let update = update_item(&shell);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("main"), build_menu(&handle, lan, screen, viewer.as_deref(), &links, &update)) {
            let _ = tray.set_menu(Some(menu));
            let tooltip = match &viewer {
                Some(address) => format!("{TITLE} — {address} is viewing this PC"),
                None => TITLE.to_owned(),
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
    });
}

fn toggle_lan(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let on = !*shell.lan.lock();
    match shell.host().request(json!({ "cmd": "lan", "on": on }), Duration::from_secs(15)) {
        Ok(reply) => *shell.lan.lock() = reply["lan"].as_bool().unwrap_or(false),
        Err(e) => {
            *shell.lan.lock() = false;
            app.dialog()
                .message(format!("Could not change network access\n\n{e}"))
                .title(TITLE)
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
    *shell.links.lock() = fetch_links(&shell.host());
    refresh_menu(app);
}

// Off at every launch, like network access. Turning it off ends a running view at once.
fn toggle_screen(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let on = !*shell.screen.lock();
    // Off goes into effect here, before the request: the host reports the dropped viewer ahead of its reply.
    if !on {
        *shell.screen.lock() = false;
    }
    match shell.host().request(json!({ "cmd": "screen", "on": on }), Duration::from_secs(15)) {
        Ok(reply) => *shell.screen.lock() = reply["screen"].as_bool().unwrap_or(false),
        Err(e) => {
            *shell.screen.lock() = false;
            app.dialog()
                .message(format!("Could not change screen sharing\n\n{e}"))
                .title(TITLE)
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
    refresh_menu(app);
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_owned();
    if id == "open" {
        return show_main(app);
    }
    // Off the event loop: requests and dialogs below block.
    let app = app.clone();
    thread::spawn(move || match id.as_str() {
        "lan" => toggle_lan(&app),
        "screen" => toggle_screen(&app),
        "quit" => quit(&app, true),
        "update" => install_update(&app),
        "check_update" => check_now(&app),
        _ => {
            let Some(i) = id.strip_prefix("link:").and_then(|i| i.parse::<usize>().ok()) else { return };
            let url = app.state::<Shell>().links.lock().get(i).map(|(_, url)| url.clone());
            if let Some(url) = url {
                let _ = app.clipboard().write_text(url);
            }
        }
    });
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let menu = build_menu(app, *shell.lan.lock(), *shell.screen.lock(), shell.viewer.lock().as_deref(), &shell.links.lock(), &update_item(&shell))?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(TITLE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn quit(app: &AppHandle, confirm: bool) {
    let shell = app.state::<Shell>();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if confirm {
        let busy = busy_sessions(&shell);
        if busy > 0 {
            let message = if busy == 1 {
                "1 session is still working. Quit and stop it?".to_owned()
            } else {
                format!("{busy} sessions are still working. Quit and stop them?")
            };
            // No parent window: it may be hidden in the tray, and a dialog owned by a hidden window can stay invisible.
            let confirmed = app
                .dialog()
                .message(message)
                .title(TITLE)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
                .blocking_show();
            if !confirmed {
                shell.quitting.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
    stop_companion(app);
    app.exit(0);
}

// Quit and updates: the tray goes first so nothing starts new work, then close() pauses running sessions, saves
// workspace.json and stops every OMP session.
fn stop_companion(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let _ = app.remove_tray_by_id("main");
    let host = shell.host();
    let _ = host.request(json!({ "cmd": "quit" }), Duration::from_secs(120));
    host.wait_exit(Duration::from_secs(10));
    shell.host_closed.store(true, Ordering::SeqCst);
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != "main" {
        return;
    }
    let Some(shell) = window.try_state::<Shell>() else { return };
    if shell.quitting.load(Ordering::SeqCst) {
        return;
    }
    // Closing hides to the tray so running agents keep working; Quit lives in the tray menu.
    api.prevent_close();
    let _ = window.hide();
    if !shell.told_about_tray.swap(true, Ordering::SeqCst) {
        let _ = window.app_handle().notification().builder().title(TITLE).body("Still running in the tray.").show();
    }
}

fn main() {
    let app = tauri::Builder::default()
        // First: a second instance focuses the first and never reaches setup or the Bun spawn.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        // VISIBLE excluded: quitting while hidden in the tray must not start the next launch invisible.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            // Off the main thread: boot waits for Bun and may show blocking dialogs.
            thread::spawn(move || boot(handle));
            Ok(())
        })
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("failed to build the app");
    app.run(|app, event| match event {
        // Hidden or extra windows closing must never end the app; only app.exit() does.
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        // Also reached on Windows logoff/shutdown: save sessions and stop OMP without asking.
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Shell>() {
                if !shell.host_closed.load(Ordering::SeqCst) {
                    shell.quitting.store(true, Ordering::SeqCst);
                    let host = shell.host();
                    host.send_quit();
                    host.wait_exit(Duration::from_secs(5));
                }
            }
        }
        _ => {}
    });
}
