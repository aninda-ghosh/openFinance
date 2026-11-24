//! Standalone openFinance server (used by the parity harness and for local
//! runs). Reads the same environment as the Node server:
//! `DB_PATH`, `OPENFINANCE_DB_KEY`, `PORT`, `OPENFINANCE_DESKTOP`,
//! `OPENFINANCE_NO_NETWORK` (plus `ENCRYPTION_KEY`, `OLLAMA_URL`, `OLLAMA_MODEL`).
//!
//! Exit codes: 13 when the passcode does not open the database (like Node),
//! 1 for any other startup failure.

use std::net::SocketAddr;
use std::process::ExitCode;

use openfinance_core::db::{OpenError, WRONG_KEY_EXIT_CODE};
use openfinance_core::{AppState, Config};

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();

    let config = Config::from_env();
    if !config.desktop {
        // Self-hosted mode needs the JWT auth layer, which is not ported.
        eprintln!("openfinance-server only supports desktop mode; set OPENFINANCE_DESKTOP=true");
        return ExitCode::from(1);
    }

    let port: u16 = match std::env::var("PORT") {
        Err(_) => 3001,
        Ok(p) => match p.trim().parse() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("invalid PORT: {p}");
                return ExitCode::from(1);
            }
        },
    };

    let state = match AppState::open(config) {
        Ok(state) => state,
        Err(OpenError::WrongKey(err)) => {
            eprintln!("[db] Could not open the database with the supplied passcode: {err}");
            return ExitCode::from(WRONG_KEY_EXIT_CODE as u8);
        }
        Err(err) => {
            eprintln!("[db] {err}");
            return ExitCode::from(1);
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("could not start the async runtime: {err}");
            return ExitCode::from(1);
        }
    };

    runtime.block_on(async move {
        // Desktop: this Mac only.
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(err) => {
                eprintln!("could not listen on {addr}: {err}");
                return ExitCode::from(1);
            }
        };
        tracing::info!("openFinance server running on http://127.0.0.1:{port}");
        match openfinance_core::serve(state, listener, shutdown_signal()).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("server error: {err}");
                ExitCode::from(1)
            }
        }
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}
