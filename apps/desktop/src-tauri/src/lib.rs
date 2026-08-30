use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct AppState {
    db_path: PathBuf,
    /// Where the sidecar's output is mirrored, for diagnosing a failed start.
    log_path: PathBuf,
    /// The running server process, so we can stop it when the app quits.
    server: Option<CommandChild>,
}

/// Returns true on first launch (no database file yet → "Set a password" UI).
/// Returns false when the database already exists → "Unlock" UI.
#[tauri::command]
fn is_new_db(state: tauri::State<Mutex<AppState>>) -> bool {
    !state.lock().unwrap().db_path.exists()
}

/// Drains the sidecar's stdout/stderr channel and mirrors it to a log file.
///
/// Draining matters on its own: Tauri buffers these events in an unbounded
/// channel, so a long-running server nobody reads from would grow in memory
/// forever. Writing them down matters because a sidecar that dies on startup is
/// otherwise invisible — the UI just reports that the server took too long.
fn drain_output(mut rx: tauri::async_runtime::Receiver<CommandEvent>, log_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // Start each run with a fresh log so it always describes the current attempt.
        let _ = std::fs::write(&log_path, b"");

        let record = |text: &str| {
            eprint!("{text}");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = file.write_all(text.as_bytes());
            }
        };

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    record(&format!("[server] {}", String::from_utf8_lossy(&line)));
                }
                CommandEvent::Error(err) => record(&format!("[server] error: {err}\n")),
                CommandEvent::Terminated(payload) => {
                    record(&format!("[server] exited with {:?}\n", payload.code));
                }
                _ => {}
            }
        }
    });
}

/// Spawn the server with the user-supplied password as the database encryption key.
/// Production: runs the compiled sidecar binary.
/// Dev: runs `pnpm dev` in the server workspace via bash.
#[tauri::command]
fn spawn_server(
    password: String,
    state: tauri::State<Mutex<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (db_path, log_path) = {
        let guard = state.lock().unwrap();
        (guard.db_path.clone(), guard.log_path.clone())
    };
    let db_path_str = db_path.to_str().unwrap().to_string();

    #[cfg(not(dev))]
    {
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let index_js_path = resource_dir.join("binaries/server-bundle/index.js");
        let index_js_str = index_js_path
            .to_str()
            .ok_or("Invalid resource path")?
            .to_string();

        let (rx, child) = app
            .shell()
            .sidecar("server")
            .map_err(|e| e.to_string())?
            .arg(&index_js_str)
            .env("OPENFINANCE_DB_KEY", &password)
            .env("DB_PATH", &db_path_str)
            .env("OPENFINANCE_DESKTOP", "true")
            .env("NODE_ENV", "production")
            .env("PORT", "3001")
            .spawn()
            .map_err(|e| e.to_string())?;

        drain_output(rx, log_path.clone());

        // Replace any previous process (a failed unlock attempt) before storing
        // the new one, so we never leak a server holding the database open.
        let mut guard = state.lock().unwrap();
        if let Some(previous) = guard.server.take() {
            let _ = previous.kill();
        }
        guard.server = Some(child);
    }

    #[cfg(dev)]
    {
        // If the server is already running (started by dev:all concurrently), skip spawning.
        // PasswordGate's health-poll loop will detect it and unlock automatically.
        let already_running = std::net::TcpStream::connect_timeout(
            &"127.0.0.1:3001".parse().unwrap(),
            std::time::Duration::from_millis(300),
        )
        .is_ok();

        if already_running {
            return Ok(());
        }

        // CARGO_MANIFEST_DIR = apps/desktop/src-tauri
        // Go up 3 levels to reach the monorepo root, then into apps/server.
        let server_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap() // apps/desktop
            .parent()
            .unwrap() // apps
            .parent()
            .unwrap() // monorepo root
            .join("apps/server")
            .canonicalize()
            .map_err(|e| e.to_string())?;

        let script = format!("cd '{}' && pnpm dev", server_dir.display());
        let (rx, child) = app
            .shell()
            .command("bash")
            .args(["-c", &script])
            .env("OPENFINANCE_DB_KEY", &password)
            .env("DB_PATH", &db_path_str)
            .env("OPENFINANCE_DESKTOP", "true")
            .env("PORT", "3001")
            .spawn()
            .map_err(|e| e.to_string())?;

        drain_output(rx, log_path.clone());

        let mut guard = state.lock().unwrap();
        if let Some(previous) = guard.server.take() {
            let _ = previous.kill();
        }
        guard.server = Some(child);
    }

    Ok(())
}

#[tauri::command]
#[allow(unreachable_code)]
fn wipe_database(state: tauri::State<Mutex<AppState>>, app: tauri::AppHandle) -> Result<(), String> {
    let db_path = {
        let mut guard = state.lock().unwrap();
        // Stop the server first — it holds the database open.
        if let Some(server) = guard.server.take() {
            let _ = server.kill();
        }
        guard.db_path.clone()
    };

    // Delete database files
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-journal"));

    // Delete associated uploads and chat-memories folders
    if let Some(parent) = db_path.parent() {
        let uploads_dir = parent.join("uploads");
        let memories_dir = parent.join("chat-memories");
        let _ = std::fs::remove_dir_all(&uploads_dir);
        let _ = std::fs::remove_dir_all(&memories_dir);
    }

    // Restart the application to start fresh
    app.restart();

    Ok(())
}

/// Stops the sidecar. Called when the app is quitting so no orphaned server is
/// left holding the database file and port 3001.
fn stop_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Mutex<AppState>>() {
        if let Some(server) = state.lock().unwrap().server.take() {
            let _ = server.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched — focus the existing window and let the new process exit
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

            let db_path = app_data_dir.join("openfinance.db");
            let log_path = app_data_dir.join("server.log");
            app.manage(Mutex::new(AppState {
                db_path,
                log_path,
                server: None,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_new_db,
            spawn_server,
            wipe_database
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            stop_server(app_handle);
        }
    });
}
