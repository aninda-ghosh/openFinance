//! openFinance backend: the API server the desktop app runs in-process. A
//! port of the former Node server (Hono/Drizzle, `apps/server` up to
//! `1502e08`); see this crate's README.md.

pub mod ai;
pub mod crypto;
pub mod db;
pub mod error;
pub mod http;
pub mod ids;
pub mod jobs;
pub mod js;
pub mod json;
pub mod paths;
pub mod services;
pub mod state;

pub use error::{ApiError, ApiResult};
pub use state::{AppState, Config};

/// Runs startup jobs, starts the background tasks and serves the API on
/// `listener` until `shutdown` resolves. Used by the Tauri app in-process
/// (`src/backend.rs`).
pub async fn serve(
    state: AppState,
    listener: tokio::net::TcpListener,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    jobs::run_startup(&state).await;
    let background = jobs::spawn_background(&state);
    let app = http::router(state);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;
    background.abort();
    result
}
