//! The in-process backend: opens the encrypted database and serves the
//! `openfinance-core` router on `127.0.0.1`, replacing the Node sidecar.
//!
//! This module has no Tauri dependency so the unlock / shutdown / wipe
//! lifecycle can be tested on its own (`tests/lifecycle.rs`).
//!
//! The backend runs on its **own** tokio runtime. Shutting that runtime down
//! is what guarantees nothing outlives a lock, wipe or quit: the background
//! jobs, any AI generation still streaming, and every connection task are
//! dropped with it, and with them the last [`AppState`] handles, so the
//! SQLite connection closes (which checkpoints the WAL into the database file).

use std::fmt;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openfinance_core::db::OpenError;
use openfinance_core::{AppState, Config};
use tokio::net::{TcpListener, TcpSocket};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The port the UI talks to (`BASE_URL` in `apps/desktop/src/lib/api.ts`).
pub const DEFAULT_PORT: u16 = 3001;

/// `127.0.0.1:3001`: this Mac only, like the Node server in desktop mode.
pub fn default_addr() -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))
}

/// How long in-flight requests get to finish once shutdown starts. Long-lived
/// responses (an AI chat stream) are cut off after this.
const GRACEFUL_TIMEOUT: Duration = Duration::from_secs(3);

/// How long `spawn_blocking` work (a database call already running) gets to
/// finish when the runtime is torn down.
const RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Why an unlock attempt failed. Nothing is left open in any case.
#[derive(Debug)]
pub enum StartError {
    /// The passcode does not decrypt the database (Node exited with 13).
    WrongPasscode,
    /// Any other failure opening or bootstrapping the database.
    Database(String),
    /// The async runtime could not be created.
    Runtime(io::Error),
    /// The port could not be bound (e.g. another copy of the server holds it).
    Listen { addr: SocketAddr, source: io::Error },
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongPasscode => f.write_str("the passcode does not open the database"),
            Self::Database(msg) => write!(f, "could not open the database: {msg}"),
            Self::Runtime(err) => write!(f, "could not start the async runtime: {err}"),
            Self::Listen { addr, source } => write!(f, "could not listen on {addr}: {source}"),
        }
    }
}

impl std::error::Error for StartError {}

/// The configuration the Node sidecar received: `DB_PATH`, the passcode as
/// `OPENFINANCE_DB_KEY` and `OPENFINANCE_DESKTOP=true`. Everything else
/// (`ENCRYPTION_KEY`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OPENFINANCE_NO_NETWORK`)
/// comes from the app's environment, which the sidecar inherited.
pub fn desktop_config(db_path: &Path, passcode: String) -> Config {
    let mut config = Config::from_env();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let db_path_str = db_path.to_string_lossy();
    config.data_dir = openfinance_core::paths::data_dir(Some(&db_path_str), &cwd);
    config.db_path = db_path.to_path_buf();
    config.db_key = Some(passcode);
    config.desktop = true;
    config
}

/// A running backend. Dropping it (or calling [`Backend::shutdown`]) stops it
/// and blocks until the port is released and the database is closed.
pub struct Backend {
    addr: SocketAddr,
    parts: Option<Running>,
}

struct Running {
    runtime: Runtime,
    shutdown: oneshot::Sender<()>,
    server: JoinHandle<io::Result<()>>,
}

impl Backend {
    /// Opens the database with `config.db_key`, runs the schema bootstrap, and
    /// serves the API on `addr` (port 0 picks a free port). Startup jobs run
    /// exactly as in `openfinance-server`: `openfinance_core::serve` loads the
    /// AI settings and migrates plaintext documents before accepting
    /// requests, then starts the recurring / exchange-rate background tasks.
    ///
    /// Blocking (key derivation, bootstrap): call it off the async runtime.
    /// On error nothing stays open: no connection, no listener, no runtime.
    pub fn start(config: Config, addr: SocketAddr) -> Result<Self, StartError> {
        let state = AppState::open(config).map_err(|err| match err {
            OpenError::WrongKey(_) => StartError::WrongPasscode,
            other => StartError::Database(other.to_string()),
        })?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("openfinance-backend")
            .build()
            .map_err(StartError::Runtime)?;

        let listener = {
            let _entered = runtime.enter();
            bind(addr)
        };
        let listener = match listener {
            Ok(listener) => listener,
            Err(source) => {
                // Nothing was spawned yet; `state` (the connection) drops here.
                runtime.shutdown_background();
                return Err(StartError::Listen { addr, source });
            }
        };
        let addr = listener.local_addr().unwrap_or(addr);

        let (shutdown, signal) = oneshot::channel::<()>();
        let server = runtime.spawn(openfinance_core::serve(state, listener, async move {
            // Resolves on `send` and also if the sender is dropped.
            let _ = signal.await;
        }));
        tracing::info!("openFinance server running on http://{addr}");

        Ok(Self {
            addr,
            parts: Some(Running {
                runtime,
                shutdown,
                server,
            }),
        })
    }

    /// The address actually bound.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stops accepting connections, lets in-flight requests finish (aborting
    /// them after a timeout), stops the background jobs, and closes the
    /// database. Returns once the port is free.
    pub fn shutdown(mut self) -> Shutdown {
        self.stop()
    }

    fn stop(&mut self) -> Shutdown {
        let Some(running) = self.parts.take() else {
            return Shutdown::Graceful;
        };
        // A runtime can't be shut down (or blocked on) from inside an async
        // context, and callers may be on one (a Tauri command thread), so do
        // it on a plain thread and wait for it.
        let stopper = std::thread::Builder::new()
            .name("openfinance-backend-shutdown".into())
            .spawn(move || running.stop());
        match stopper {
            Ok(handle) => handle.join().unwrap_or_else(|_| {
                tracing::error!("[shutdown] the shutdown thread panicked");
                Shutdown::Failed
            }),
            Err(err) => {
                tracing::error!("[shutdown] could not start the shutdown thread: {err}");
                Shutdown::Failed
            }
        }
    }
}

/// How a shutdown went. The port is released and the database closed by the
/// time [`Backend::shutdown`] returns in every case (for `Failed`, by the
/// runtime being dropped while unwinding).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shutdown {
    /// Every in-flight request finished.
    Graceful,
    /// Requests were still running after the grace period and were cut off.
    Aborted,
    /// Something went wrong while stopping (logged).
    Failed,
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Running {
    fn stop(self) -> Shutdown {
        let Running {
            runtime,
            shutdown,
            server,
        } = self;
        // Stop accepting; axum then closes idle keep-alive connections and
        // waits for in-flight requests.
        let _ = shutdown.send(());
        let abort = server.abort_handle();
        // The timer must be created inside the runtime, hence the async block.
        let finished =
            runtime.block_on(async move { tokio::time::timeout(GRACEFUL_TIMEOUT, server).await });
        let outcome = match finished {
            Ok(Ok(Ok(()))) => {
                tracing::info!("[shutdown] server stopped");
                Shutdown::Graceful
            }
            Ok(Ok(Err(err))) => {
                tracing::warn!("[shutdown] server error: {err}");
                Shutdown::Failed
            }
            Ok(Err(err)) => {
                tracing::warn!("[shutdown] server task failed: {err}");
                Shutdown::Failed
            }
            Err(_) => {
                tracing::warn!(
                    "[shutdown] requests still running after {GRACEFUL_TIMEOUT:?}; aborting them"
                );
                abort.abort();
                Shutdown::Aborted
            }
        };
        // Drops every remaining task (connections, background jobs, AI
        // generations) and with them the last database handles.
        runtime.shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT);
        outcome
    }
}

/// Like `tokio::net::TcpListener::bind` (which `openfinance-server` uses):
/// `SO_REUSEADDR`, so a restart is not blocked by connections from the
/// previous run still in TIME_WAIT.
fn bind(addr: SocketAddr) -> io::Result<TcpListener> {
    let socket = if addr.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    socket.listen(1024)
}

/// Deletes the database and everything stored next to it, as the sidecar
/// build did: the database file and its `-wal`, `-shm` and `-journal`
/// companions, and the `uploads` and `chat-memories` folders. Stop the
/// backend first. Missing files are not an error.
pub fn wipe_files(db_path: &Path) {
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    let _ = std::fs::remove_file(db_path.with_extension("db-journal"));
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::remove_dir_all(parent.join("uploads"));
        let _ = std::fs::remove_dir_all(parent.join("chat-memories"));
    }
}
