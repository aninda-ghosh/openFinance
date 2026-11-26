//! The openFinance desktop app: the window, plus unlock / wipe / quit for the
//! backend, which runs in this process (see [`backend`]).

pub mod backend;
mod logging;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::{Manager, RunEvent};

use backend::{Backend, StartError};

/// What `spawn_server` rejects with when the passcode does not open the
/// database. `PasswordGate.tsx` shows its "Wrong password" state for it.
const WRONG_PASSWORD: &str = "wrong_password";

struct Host {
    db_path: PathBuf,
    /// The running backend. The mutex is held for a whole unlock, wipe or
    /// quit, so those never interleave.
    backend: Arc<Mutex<Option<Backend>>>,
}

/// A panic while the lock was held can't leave the slot inconsistent (it
/// only ever holds a whole `Backend` or nothing), so poisoning is ignored.
fn lock(slot: &Mutex<Option<Backend>>) -> MutexGuard<'_, Option<Backend>> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Returns true on first launch (no database file yet → "Set a password" UI).
/// Returns false when the database already exists → "Unlock" UI.
#[tauri::command]
fn is_new_db(host: tauri::State<'_, Host>) -> bool {
    !host.db_path.exists()
}

/// Opens the database with the user's passcode and starts the API on
/// 127.0.0.1:3001. Resolves once the server is listening; rejects with
/// `"wrong_password"` when the passcode does not open the database, or with
/// a message for any other failure. A previous backend (an earlier unlock) is
/// stopped first. The passcode is never logged.
#[tauri::command]
async fn spawn_server(password: String, host: tauri::State<'_, Host>) -> Result<(), String> {
    let slot = Arc::clone(&host.backend);
    let config = backend::desktop_config(&host.db_path, password);
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = lock(&slot);
        if let Some(previous) = current.take() {
            previous.shutdown();
        }
        match Backend::start(config, backend::default_addr()) {
            Ok(started) => {
                *current = Some(started);
                Ok(())
            }
            Err(StartError::WrongPasscode) => {
                tracing::warn!("[unlock] the passcode does not open the database");
                Err(WRONG_PASSWORD.to_string())
            }
            Err(err) => {
                tracing::error!("[unlock] {err}");
                Err(err.to_string())
            }
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Stops the backend (closing the database), deletes the database, uploads
/// and chat memories, then restarts the app.
#[tauri::command]
async fn wipe_database(host: tauri::State<'_, Host>, app: tauri::AppHandle) -> Result<(), String> {
    let slot = Arc::clone(&host.backend);
    let db_path = host.db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = lock(&slot);
        if let Some(running) = current.take() {
            running.shutdown();
        }
        backend::wipe_files(&db_path);
    })
    .await
    .map_err(|err| err.to_string())?;

    // Restart the application to start fresh.
    app.request_restart();
    Ok(())
}

/// Stops the backend when the app quits, so nothing keeps port 3001 or the
/// database open.
fn stop_backend(app: &tauri::AppHandle) {
    if let Some(host) = app.try_state::<Host>() {
        let running = lock(&host.backend).take();
        if let Some(running) = running {
            running.shutdown();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched — focus the existing window and let the new process exit
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            logging::init(&app_data_dir.join("server.log"));

            app.manage(Host {
                db_path: app_data_dir.join("openfinance.db"),
                backend: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_new_db,
            spawn_server,
            wipe_database
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(err) => {
            eprintln!("error while building tauri application: {err}");
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            stop_backend(app_handle);
        }
    });
}
