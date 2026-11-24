//! openFinance backend: a Rust port of `apps/server` (Node/Hono/Drizzle).
//! Module list owned by Wave 0; see docs/rust-port/PLAN.md and STATUS.md.

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
/// `listener` until `shutdown` resolves. Used by the standalone binary and,
/// from Wave 4, by the Tauri app in-process.
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
