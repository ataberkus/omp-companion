// OMP Control Room desktop shell: runs the companion through the bundled Node.js and shows the dashboard.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use host::Host;
use parking_lot::Mutex;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const TITLE: &str = "OMP Control Room";

struct Shell {
    host: Host,
    port: u16,
    token: String,
    lan: Mutex<bool>,
    links: Mutex<Vec<(String, String)>>,
    quitting: AtomicBool,
    host_closed: AtomicBool,
    told_about_tray: AtomicBool,
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
    let node = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("node.exe");
    Ok((dunce::simplified(&node).to_path_buf(), dunce::simplified(&script).to_path_buf()))
}

fn boot(app: AppHandle) {
    let on_exit = {
        let app = app.clone();
        move |tail: String| {
            if app.try_state::<Shell>().is_some_and(|s| s.quitting.load(Ordering::SeqCst)) {
                return;
            }
            error_dialog(&app, format!("The companion stopped unexpectedly.\n\n{tail}"));
            app.exit(1);
        }
    };
    let started = paths(&app).and_then(|(node, script)| host::spawn(&node, &script, on_exit));
    let (host, ready) = match started {
        Ok(started) => started,
        Err(e) => {
            error_dialog(&app, e);
            app.exit(1);
            return;
        }
    };
    let links = fetch_links(&host);
    app.manage(Shell {
        host,
        port: ready.port,
        token: ready.token,
        lan: Mutex::new(false),
        links: Mutex::new(links),
        quitting: AtomicBool::new(false),
        host_closed: AtomicBool::new(false),
        told_about_tray: AtomicBool::new(false),
    });
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = create_tray(&handle) {
            eprintln!("tray: {e}");
        }
        create_main(&handle);
    });
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
    let url: Url = format!("http://127.0.0.1:{}/#token={}", shell.port, shell.token).parse().unwrap();
    // Shown on the first finished load only: no white flash, and later reloads don't pop a window hidden in the tray.
    let shown = Arc::new(AtomicBool::new(false));
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(TITLE)
        .inner_size(1400.0, 900.0)
        .visible(false)
        .on_navigation(nav_guard(app.clone(), shell.port))
        .on_new_window(new_window_handler(app.clone(), shell.port))
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

fn build_menu(app: &AppHandle, lan: bool, links: &[(String, String)]) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let lan_item = CheckMenuItem::with_id(app, "lan", "Allow phones on my network", true, lan, None::<&str>)?;
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
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &lan_item, &copy, &separator, &quit])
}

fn refresh_menu(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let lan = *shell.lan.lock();
    let links = shell.links.lock().clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("main"), build_menu(&handle, lan, &links)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn toggle_lan(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let on = !*shell.lan.lock();
    match shell.host.request(json!({ "cmd": "lan", "on": on }), Duration::from_secs(15)) {
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
    *shell.links.lock() = fetch_links(&shell.host);
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
        "quit" => quit(&app, true),
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
    let menu = build_menu(app, *shell.lan.lock(), &shell.links.lock())?;
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
        let busy = shell
            .host
            .request(json!({ "cmd": "busy" }), Duration::from_secs(10))
            .ok()
            .and_then(|r| r["busy"].as_u64())
            .unwrap_or(0);
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
    let _ = app.remove_tray_by_id("main");
    // close() pauses running sessions, saves workspace.json and stops every OMP process.
    let _ = shell.host.request(json!({ "cmd": "quit" }), Duration::from_secs(120));
    shell.host.wait_exit(Duration::from_secs(10));
    shell.host_closed.store(true, Ordering::SeqCst);
    app.exit(0);
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
        // First: a second instance focuses the first and never reaches setup or the Node spawn.
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
        .setup(|app| {
            let handle = app.handle().clone();
            // Off the main thread: boot waits for Node and may show blocking dialogs.
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
                    shell.host.send_quit();
                    shell.host.wait_exit(Duration::from_secs(5));
                }
            }
        }
        _ => {}
    });
}
