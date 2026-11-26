//! The openFinance desktop app: the window, plus unlock / wipe / quit for the
//! backend, which runs in this process (see [`backend`]), and unlock with
//! Touch ID (see [`touch_id`]).

pub mod backend;
mod logging;
pub mod touch_id;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::{Manager, RunEvent};
use zeroize::Zeroizing;

use backend::{Backend, StartError};
use touch_id::{PlatformTouchId, StartFailure, Status, TouchIdError};

/// What `spawn_server` rejects with when the passcode does not open the
/// database. `PasswordGate.tsx` shows its "Wrong password" state for it.
const WRONG_PASSWORD: &str = "wrong_password";

struct Host {
    db_path: PathBuf,
    /// The running backend. The mutex is held for a whole unlock, wipe or
    /// quit, so those never interleave.
    backend: Arc<Mutex<Option<Backend>>>,
    touch_id: Arc<PlatformTouchId>,
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

/// Stops any previous backend and starts one with `passcode`. Shared by the
/// typed-passcode and Touch ID unlocks. The passcode is never logged.
async fn start_backend(host: &Host, passcode: Zeroizing<String>) -> Result<(), StartFailure> {
    let slot = Arc::clone(&host.backend);
    // `Config` keeps its own copy for the life of the backend (it needs the
    // key); that copy is outside this feature's control.
    let config = backend::desktop_config(&host.db_path, passcode.to_string());
    drop(passcode);
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
                Err(StartFailure::WrongPasscode)
            }
            Err(err) => {
                tracing::error!("[unlock] {err}");
                Err(StartFailure::Other(err.to_string()))
            }
        }
    })
    .await
    .map_err(|err| StartFailure::Other(err.to_string()))?
}

/// Opens the database with the user's passcode and starts the API on
/// 127.0.0.1:3001. Resolves once the server is listening; rejects with
/// `"wrong_password"` when the passcode does not open the database, or with
/// a message for any other failure. A previous backend (an earlier unlock) is
/// stopped first. The passcode is never logged.
///
/// After a successful unlock the passcode may be kept in memory (Rust only)
/// for up to [`touch_id::PENDING_TTL`], so `touch_id_enable` can store it if
/// the user accepts the "Unlock with Touch ID next time?" prompt.
#[tauri::command]
async fn spawn_server(password: String, host: tauri::State<'_, Host>) -> Result<(), String> {
    let password = Zeroizing::new(password);
    match start_backend(&host, password.clone()).await {
        Ok(()) => {
            host.touch_id.after_passcode_unlock(&password);
            drop(password);
            let touch_id = Arc::clone(&host.touch_id);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(touch_id::PENDING_TTL).await;
                touch_id.expire_pending();
            });
            Ok(())
        }
        Err(StartFailure::WrongPasscode) => Err(WRONG_PASSWORD.to_string()),
        Err(StartFailure::Other(msg)) => Err(msg),
    }
}

/// Stops the backend (closing the database), deletes the database, uploads
/// and chat memories, the Touch ID keychain item and settings, then restarts
/// the app.
#[tauri::command]
async fn wipe_database(host: tauri::State<'_, Host>, app: tauri::AppHandle) -> Result<(), String> {
    let slot = Arc::clone(&host.backend);
    let db_path = host.db_path.clone();
    let touch_id = Arc::clone(&host.touch_id);
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = lock(&slot);
        if let Some(running) = current.take() {
            running.shutdown();
        }
        backend::wipe_files(&db_path);
        touch_id.wipe();
    })
    .await
    .map_err(|err| err.to_string())?;

    // Restart the application to start fresh.
    app.request_restart();
    Ok(())
}

/// Touch ID availability, whether it is on, and whether to show the
/// "Unlock with Touch ID next time?" prompt now. Never contains the passcode.
#[tauri::command]
fn touch_id_status(host: tauri::State<'_, Host>) -> Status {
    host.touch_id.status()
}

/// "Enable" on the prompt: one Touch ID check, then stores the passcode typed
/// at the last unlock (kept in Rust) in the login keychain. Rejects with a
/// code: `cancelled`, `no_pending_passcode`, `unavailable`, `lockout`,
/// `keychain`, `failed`.
#[tauri::command]
async fn touch_id_enable(host: tauri::State<'_, Host>) -> Result<(), String> {
    let touch_id = Arc::clone(&host.touch_id);
    touch_id.enable_from_pending().await.map_err(log_code)
}

/// "Not now" (`remember: true`, never asked again) or the prompt closed
/// without an answer (`remember: false`). Wipes the kept passcode.
#[tauri::command]
fn touch_id_dismiss(remember: bool, host: tauri::State<'_, Host>) -> Result<(), String> {
    host.touch_id.dismiss_offer(remember).map_err(log_code)
}

/// Settings → turn on: verifies `password` against the database (a separate
/// connection; the running backend is not touched), then one Touch ID check,
/// then stores it. Rejects with `wrong_password` or the codes of
/// `touch_id_enable`.
#[tauri::command]
async fn touch_id_enable_with_password(
    password: String,
    host: tauri::State<'_, Host>,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    let db_path = host.db_path.clone();
    let candidate = password.clone();
    let verified = tauri::async_runtime::spawn_blocking(move || {
        backend::verify_passcode(&db_path, &candidate)
    })
    .await
    .map_err(|err| err.to_string())?;
    match verified {
        Ok(true) => {}
        Ok(false) => return Err(TouchIdError::WrongPassword.code()),
        Err(err) => return Err(log_code(TouchIdError::Failed(err))),
    }
    let touch_id = Arc::clone(&host.touch_id);
    touch_id.enable(password).await.map_err(log_code)
}

/// Settings → turn off: deletes the keychain item and the domain-state hash.
#[tauri::command]
fn touch_id_disable(host: tauri::State<'_, Host>) -> Result<(), String> {
    host.touch_id.disable().map_err(log_code)
}

/// Touch ID check, then reads the passcode from the keychain and unlocks
/// through the same path as `spawn_server`. The passcode never leaves Rust.
/// Rejects with `cancelled`, `lockout`, `unavailable`, `not_enabled`,
/// `biometry_changed` / `invalidated` (the stored passcode was deleted and the
/// feature turned off), `keychain` or `failed`.
#[tauri::command]
async fn unlock_with_touch_id(host: tauri::State<'_, Host>) -> Result<(), String> {
    let touch_id = Arc::clone(&host.touch_id);
    let host = host.inner();
    touch_id
        .unlock(|passcode| start_backend(host, passcode))
        .await
        .map_err(log_code)
}

fn log_code(err: TouchIdError) -> String {
    match &err {
        TouchIdError::Cancelled => {}
        TouchIdError::Keychain(detail) | TouchIdError::Failed(detail) => {
            tracing::warn!("[touch-id] {}: {detail}", err.code());
        }
        other => tracing::info!("[touch-id] {}", other.code()),
    }
    err.code()
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
                touch_id: Arc::new(touch_id::platform(&app_data_dir)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_new_db,
            spawn_server,
            wipe_database,
            touch_id_status,
            touch_id_enable,
            touch_id_dismiss,
            touch_id_enable_with_password,
            touch_id_disable,
            unlock_with_touch_id
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
