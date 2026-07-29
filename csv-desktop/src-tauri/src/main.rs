// CSV Grid Editor Plus — Tauri shell.
//
// Deliberately minimal: the Rust layer owns ONLY native desktop concerns —
// window, sidecar process lifecycle, NDJSON line bridge, CLI/file-association
// args, system theme follow + manual override, recent files, native dialogs,
// and config.json persistence. All CSV logic lives in csv-core (Node sidecar).

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Listener, Manager, State, Theme, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const MAX_RECENT: usize = 8;

struct AppState {
    sidecar_stdin: Arc<Mutex<Option<ChildStdin>>>,
    sidecar_child: Arc<Mutex<Option<Child>>>,
    // Commands issued before the sidecar's stdin exists (node.exe is an ~86 MB
    // binary — cold start can take seconds) are queued here and flushed as
    // soon as the pipe is up. Without this the very first 'open' could be
    // dropped silently and the window would sit empty.
    outbox: Arc<Mutex<Vec<Value>>>,
    config: Arc<Mutex<Value>>,
    config_path: PathBuf,
    pending_file: Mutex<Option<String>>,
}

// ── Config persistence ──

fn load_config(path: &PathBuf) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn save_config(path: &PathBuf, cfg: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, s);
    }
}

fn system_is_dark(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .next()
        .and_then(|w| w.theme().ok())
        .map(|t| matches!(t, Theme::Dark))
        .unwrap_or(true)
}

fn resolved_theme(cfg: &Value, system_dark: bool) -> &'static str {
    match cfg.get("theme").and_then(Value::as_str) {
        Some("dark") => "dark",
        Some("light") => "light",
        _ => if system_dark { "dark" } else { "light" },
    }
}

// ── Sidecar lifecycle + NDJSON bridge ──


// Strip the \\?\ verbatim prefix some Tauri path APIs return — it breaks
// CreateProcess' working-directory handling for the sidecar spawn.
fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p
    }
}

fn sidecar_dir(app: &AppHandle) -> PathBuf {
    // Installed (NSIS): resources land in the Tauri resource dir.
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = strip_unc(dir).join("sidecar");
        if candidate.join("main.js").exists() {
            return candidate;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = strip_unc(exe).parent().map(|p| p.to_path_buf()) {
            // Portable zip layout: sidecar/ next to the exe.
            let candidate = dir.join("sidecar");
            if candidate.join("main.js").exists() {
                return candidate;
            }
            // Dev layout: target/{debug,release}/exe → ../../../sidecar.
            let dev = dir.join("../../../sidecar");
            if dev.join("main.js").exists() {
                return dev;
            }
            // Not found anywhere — return the portable location so the spawn
            // error can name the directory the user must create.
            return candidate;
        }
    }
    PathBuf::from("sidecar")
}

fn spawn_sidecar(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dir = sidecar_dir(app);
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });

    // The sidecar's stderr goes to a log file (GUI apps have no console), so a
    // failing engine is diagnosable after the fact.
    let log_path = state.config_path.parent()
        .map(|d| d.join("sidecar-stderr.log"))
        .unwrap_or_else(|| std::env::temp_dir().join("csv-sidecar-stderr.log"));
    let stderr_target: Stdio = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::inherit());

    let child = Command::new(&node)
        .arg(dir.join("main.js"))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr_target)
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            // No silent console-only failures: the app is useless without the
            // engine, so say exactly what is missing and where.
            app.dialog()
                .message(format!(
                    "Cannot start the CSV engine.\n\nExpected files:\n  {}\n  {}\n\nError: {e}\n\nIf you are using the portable version, keep the \"sidecar\" folder next to the exe.",
                    dir.join("node.exe").display(),
                    dir.join("main.js").display()
                ))
                .title("CSV Grid Editor Plus — sidecar missing")
                .blocking_show();
            return;
        }
    };

    let stdout = child.stdout.take().expect("sidecar stdout piped");
    let stdin = child.stdin.take().expect("sidecar stdin piped");
    // Flush any commands queued while node.exe was still starting.
    {
        let mut pending = state.outbox.lock().unwrap();
        let mut stdin_opt = state.sidecar_stdin.lock().unwrap();
        *stdin_opt = Some(stdin);
        let stdin_ref = stdin_opt.as_mut().unwrap();
        for msg in pending.drain(..) {
            if let Ok(s) = serde_json::to_string(&msg) {
                let _ = writeln!(stdin_ref, "{s}");
            }
        }
        let _ = stdin_ref.flush();
    }

    // stdout reader thread: one JSON object per line → forward to the frontend.
    // {type:'persist'} is intercepted — the Rust shell is the single writer
    // of config.json.
    let app_handle = app.clone();
    let stdin_ref = state.sidecar_stdin.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break, // sidecar died
            };
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("type").and_then(Value::as_str) == Some("persist") {
                let st = app_handle.state::<AppState>();
                let key = value.get("key").and_then(Value::as_str).unwrap_or("").to_string();
                if !key.is_empty() {
                    let mut cfg = st.config.lock().unwrap();
                    cfg[key] = value.get("value").cloned().unwrap_or(Value::Null);
                    save_config(&st.config_path, &cfg);
                }
                continue;
            }
            let _ = app_handle.emit("sidecar-out", value);
        }
        // Sidecar exited — drop the stale stdin handle.
        *stdin_ref.lock().unwrap() = None;
    });

    *state.sidecar_child.lock().unwrap() = Some(child);
}

fn send_to_sidecar(app: &AppHandle, value: &Value) {
    let state = app.state::<AppState>();
    let mut guard = state.sidecar_stdin.lock().unwrap();
    match guard.as_mut() {
        Some(stdin) => {
            if let Ok(s) = serde_json::to_string(value) {
                let _ = writeln!(stdin, "{s}");
                let _ = stdin.flush();
            }
        }
        None => {
            // Sidecar still starting (or crashed) — queue so nothing is lost.
            state.outbox.lock().unwrap().push(value.clone());
        }
    }
}

// ── Commands (invoked from the frontend) ──

#[tauri::command]
fn get_config(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let mut out = cfg.as_object().cloned().unwrap_or_default();
    out.entry("largeFileMode".to_string()).or_insert(json!("ask"));
    out.entry("headRows".to_string()).or_insert(json!(1000));
    out.insert("themeResolved".to_string(), json!(resolved_theme(&cfg, system_is_dark(&app))));
    Value::Object(out)
}

#[tauri::command]
fn get_pending_file(state: State<AppState>) -> Option<String> {
    state.pending_file.lock().unwrap().clone()
}

#[tauri::command]
fn save_export_file(app: AppHandle, filename: String, text: String) -> Option<String> {
    let target = app.dialog().file().set_file_name(&filename).blocking_save_file()?;
    let path = target.into_path().ok()?;
    std::fs::write(&path, text.as_bytes()).ok()?;
    Some(path.to_string_lossy().to_string())
}

// ── Recent files + menu ──

fn add_recent(state: &AppState, path: &str) {
    let mut cfg = state.config.lock().unwrap();
    let mut recent: Vec<String> = cfg
        .get("recentFiles")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    recent.retain(|p| p != path);
    recent.insert(0, path.to_string());
    recent.truncate(MAX_RECENT);
    cfg["recentFiles"] = json!(recent);
    save_config(&state.config_path, &cfg);
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().unwrap().clone();
    let recent: Vec<String> = cfg
        .get("recentFiles")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut recent_sub = SubmenuBuilder::new(app, "Recent Files");
    if recent.is_empty() {
        recent_sub = recent_sub.item(&MenuItemBuilder::with_id("recent-none", "(empty)").enabled(false).build(app)?);
    } else {
        for (i, p) in recent.iter().enumerate() {
            recent_sub = recent_sub.item(&MenuItemBuilder::with_id(format!("recent-{i}"), p).build(app)?);
        }
    }

    let theme_mode = cfg.get("theme").and_then(Value::as_str).unwrap_or("system").to_string();
    let theme_sub = SubmenuBuilder::new(app, "Theme")
        .item(&CheckMenuItemBuilder::with_id("theme-system", "Follow System").checked(theme_mode == "system").build(app)?)
        .item(&CheckMenuItemBuilder::with_id("theme-dark", "Dark").checked(theme_mode == "dark").build(app)?)
        .item(&CheckMenuItemBuilder::with_id("theme-light", "Light").checked(theme_mode == "light").build(app)?)
        .build()?;

    let file_sub = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("file-open", "Open CSV…").build(app)?)
        .item(&recent_sub.build()?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Exit"))?)
        .build()?;

    MenuBuilder::new(app).items(&[&file_sub, &theme_sub]).build()
}

fn open_path(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    add_recent(&state, &path);
    if let Ok(menu) = build_menu(app) {
        let _ = app.set_menu(menu);
    }
    *state.pending_file.lock().unwrap() = Some(path.clone());
    let _ = app.emit("open-file", path);
}

fn set_theme_mode(app: &AppHandle, mode: &str) {
    let state = app.state::<AppState>();
    {
        let mut cfg = state.config.lock().unwrap();
        cfg["theme"] = json!(mode);
        save_config(&state.config_path, &cfg);
    }
    let theme = match mode {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    for window in app.webview_windows().values() {
        let _ = window.set_theme(theme);
    }
    let cfg = state.config.lock().unwrap().clone();
    let resolved = resolved_theme(&cfg, system_is_dark(app));
    let _ = app.emit("theme-changed", resolved);
    if let Ok(menu) = build_menu(app) {
        let _ = app.set_menu(menu);
    }
}

fn csv_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| {
        let l = a.to_lowercase();
        l.ends_with(".csv") || l.ends_with(".tsv")
    }).cloned()
}

// ── Entry ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second launch (e.g. double-clicking another CSV): forward the
            // path to the running instance and raise its window.
            if let Some(path) = csv_arg(&args) {
                open_path(app, path);
            }
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let config = load_config(&config_path);
            let initial_file = csv_arg(&std::env::args().collect::<Vec<_>>());

            app.manage(AppState {
                sidecar_stdin: Arc::new(Mutex::new(None)),
                sidecar_child: Arc::new(Mutex::new(None)),
                outbox: Arc::new(Mutex::new(Vec::new())),
                config: Arc::new(Mutex::new(config)),
                config_path,
                pending_file: Mutex::new(initial_file),
            });

            if let Ok(menu) = build_menu(&app.handle()) {
                app.set_menu(menu)?;
            }

            // Frontend → sidecar bridges. 'sidecar-in' carries webview-protocol
            // messages (wrapped as {cmd:'msg'}); 'host-cmd' carries session
            // commands verbatim.
            let handle = app.handle().clone();
            app.listen("sidecar-in", move |event| {
                if let Ok(msg) = serde_json::from_str::<Value>(event.payload()) {
                    send_to_sidecar(&handle, &json!({ "cmd": "msg", "msg": msg }));
                }
            });
            let handle = app.handle().clone();
            app.listen("host-cmd", move |event| {
                if let Ok(cmd) = serde_json::from_str::<Value>(event.payload()) {
                    send_to_sidecar(&handle, &cmd);
                }
            });

            spawn_sidecar(&app.handle());
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "file-open" {
                let state = app.state::<AppState>();
                let start_dir = state.config.lock().unwrap()
                    .get("recentFiles")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                let mut dialog = app.dialog().file().add_filter("CSV / TSV", &["csv", "tsv"]);
                if let Some(dir) = start_dir {
                    dialog = dialog.set_directory(dir);
                }
                if let Some(file) = dialog.blocking_pick_file() {
                    if let Ok(path) = file.into_path() {
                        open_path(app, path.to_string_lossy().to_string());
                    }
                }
            } else if let Some(idx) = id.strip_prefix("recent-") {
                if let Ok(i) = idx.parse::<usize>() {
                    let state = app.state::<AppState>();
                    let path = state.config.lock().unwrap()
                        .get("recentFiles")
                        .and_then(Value::as_array)
                        .and_then(|a| a.get(i))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    if let Some(p) = path {
                        open_path(app, p);
                    }
                }
            } else if let Some(mode) = id.strip_prefix("theme-") {
                set_theme_mode(app, mode);
            }
        })
        .on_window_event(|window, event| {
            // Follow-live: when the OS theme flips and the user chose "Follow
            // System", push the new resolved theme to the frontend.
            if let WindowEvent::ThemeChanged(theme) = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let cfg = state.config.lock().unwrap().clone();
                let mode = cfg.get("theme").and_then(Value::as_str).unwrap_or("system");
                if mode == "system" {
                    let resolved = if matches!(theme, Theme::Dark) { "dark" } else { "light" };
                    let _ = app.emit("theme-changed", resolved);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_config, get_pending_file, save_export_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
