//! Process-wide state: configuration, the single database connection, the
//! file-crypto settings and the AI settings cache. Owned by Wave 0.
//!
//! The connection lives behind one mutex and is only touched from
//! `spawn_blocking`, through [`AppState::db`] / [`AppState::transaction`].
//! A closure holds the connection for its whole run, so nothing else can
//! interleave with it; this is the serialisation `runTransaction` gives Node.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use rusqlite::Connection;

use crate::crypto::FileCrypto;
use crate::db::{self, OpenError};
use crate::error::{ApiError, ApiResult};
use crate::services::settings::AiSettingsCache;

/// Everything the Node server read from `process.env`, resolved once.
#[derive(Clone)]
pub struct Config {
    /// `DB_PATH` (or `./openfinance.db`).
    pub db_path: PathBuf,
    /// `OPENFINANCE_DB_KEY`: the passcode. Never log it.
    pub db_key: Option<String>,
    /// `OPENFINANCE_DESKTOP === "true"`.
    pub desktop: bool,
    /// `OPENFINANCE_NO_NETWORK === "1"`: test-only, outbound fetches fail.
    pub no_network: bool,
    /// `ENCRYPTION_KEY` (self-hosted file key). Never log it.
    pub encryption_key: Option<String>,
    /// `OLLAMA_URL` / `OLLAMA_MODEL`.
    pub ollama_url_env: Option<String>,
    pub ollama_model_env: Option<String>,
    /// `DATA_DIR` (see `paths.rs`).
    pub data_dir: PathBuf,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("db_path", &self.db_path)
            .field("db_key", &self.db_key.as_ref().map(|_| "<redacted>"))
            .field("desktop", &self.desktop)
            .field("no_network", &self.no_network)
            .field(
                "encryption_key",
                &self.encryption_key.as_ref().map(|_| "<redacted>"),
            )
            .field("ollama_url_env", &self.ollama_url_env)
            .field("ollama_model_env", &self.ollama_model_env)
            .field("data_dir", &self.data_dir)
            .finish()
    }
}

impl Config {
    /// Reads the same environment variables as the Node server.
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let db_path_env = var("DB_PATH");
        Self {
            db_path: crate::paths::db_path(db_path_env.as_deref(), &cwd),
            db_key: var("OPENFINANCE_DB_KEY"),
            desktop: var("OPENFINANCE_DESKTOP").as_deref() == Some("true"),
            no_network: var("OPENFINANCE_NO_NETWORK").as_deref() == Some("1"),
            encryption_key: var("ENCRYPTION_KEY"),
            ollama_url_env: var("OLLAMA_URL"),
            ollama_model_env: var("OLLAMA_MODEL"),
            data_dir: crate::paths::data_dir(db_path_env.as_deref(), &cwd),
        }
    }
}

struct Inner {
    conn: Mutex<Connection>,
    config: Config,
    file_crypto: FileCrypto,
    ai_settings: RwLock<AiSettingsCache>,
    http: reqwest::Client,
}

/// Cheap to clone; pass it to handlers via axum `State`.
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    /// Opens the database with the configured passcode, applies the PRAGMAs and
    /// runs the schema bootstrap, like Node's module initialisation.
    pub fn open(config: Config) -> Result<Self, OpenError> {
        let conn = db::open(&config.db_path, config.db_key.as_deref())?;
        db::bootstrap::bootstrap_schema(&conn)?;
        tracing::info!("[startup] Schema migrations complete.");
        Ok(Self::from_connection(conn, config))
    }

    /// Wraps an already-open (and bootstrapped) connection. Used by tests.
    pub fn from_connection(conn: Connection, config: Config) -> Self {
        let file_crypto = FileCrypto::new(
            crate::crypto::resolve_file_encryption_key(
                config.db_key.as_deref(),
                config.encryption_key.as_deref(),
            ),
            config.desktop,
        );
        let http = reqwest::Client::builder().build().unwrap_or_else(|err| {
            tracing::warn!("could not build the HTTP client ({err}); using defaults");
            reqwest::Client::new()
        });
        Self(Arc::new(Inner {
            conn: Mutex::new(conn),
            config,
            file_crypto,
            ai_settings: RwLock::new(AiSettingsCache::default()),
            http,
        }))
    }

    pub fn config(&self) -> &Config {
        &self.0.config
    }

    /// `getFileEncryptionKey()` + `OPENFINANCE_DESKTOP`, for OFE1 documents
    /// and chat memories.
    pub fn file_crypto(&self) -> &FileCrypto {
        &self.0.file_crypto
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.0.http
    }

    pub(crate) fn ai_settings_cache(&self) -> &RwLock<AiSettingsCache> {
        &self.0.ai_settings
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        match self.0.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                // A closure panicked while holding the connection. Undo any
                // transaction it left open so the next caller starts clean.
                let guard = poisoned.into_inner();
                if !guard.is_autocommit() {
                    let _ = guard.execute_batch("ROLLBACK");
                }
                guard
            }
        }
    }

    /// Runs `f` with the connection on the blocking pool. Statements run in
    /// autocommit mode unless `f` opens a transaction (see [`db::run_transaction`]).
    pub async fn db<T, F>(&self, f: F) -> ApiResult<T>
    where
        F: FnOnce(&Connection) -> ApiResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = state.lock();
            f(&conn)
        })
        .await?
    }

    /// `runTransaction(cb)`: runs `f` inside BEGIN/COMMIT, rolling back when it
    /// returns `Err`. Calls are serialised; nested calls join the outer one.
    pub async fn transaction<T, F>(&self, f: F) -> ApiResult<T>
    where
        F: FnOnce(&Connection) -> ApiResult<T> + Send + 'static,
        T: Send + 'static,
    {
        self.db(move |conn| db::run_transaction(conn, f)).await
    }

    /// Synchronous access for code that is already off the async runtime
    /// (startup, tests). Do not call from an async handler.
    pub fn db_blocking<T>(&self, f: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        let conn = self.lock();
        f(&conn)
    }
}

impl From<OpenError> for ApiError {
    fn from(err: OpenError) -> Self {
        ApiError::internal(err)
    }
}
