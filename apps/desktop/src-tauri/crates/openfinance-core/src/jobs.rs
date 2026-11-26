//! Startup jobs and the 15-minute exchange-rate refresh (index.ts). Owned by Wave 0.
//!
//! Node order: bootstrap (done in `AppState::open`), `loadAiSettings`,
//! `migratePlaintextDocuments` (both before listening), then two fire-and-forget
//! tasks, `applyDueRecurring` and the startup rate refresh, plus a
//! `setInterval` refresh every 15 minutes.

use std::time::Duration;

use tokio::task::JoinHandle;

use crate::services::{document, exchange_rate, recurring, settings};
use crate::state::AppState;

pub const RATE_REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// The synchronous part of startup, run before the server listens.
pub async fn run_startup(state: &AppState) {
    if let Err(err) = settings::load_ai_settings(state).await {
        tracing::warn!("[startup] Could not load AI settings: {err}");
    }

    let s = state.clone();
    let migrated =
        tokio::task::spawn_blocking(move || document::migrate_plaintext_documents(&s)).await;
    match migrated {
        Ok(Ok(0)) => {}
        Ok(Ok(n)) => {
            tracing::info!("[startup] Encrypted {n} existing plaintext document(s) at rest.")
        }
        Ok(Err(err)) => tracing::warn!("[startup] Document encryption migration failed: {err}"),
        Err(err) => tracing::warn!("[startup] Document encryption migration failed: {err}"),
    }
}

/// Background tasks. Abort the returned handles (or drop the runtime) to stop
/// them, e.g. when the desktop app locks or quits.
pub struct BackgroundJobs {
    handles: Vec<JoinHandle<()>>,
}

impl BackgroundJobs {
    pub fn abort(&self) {
        for h in &self.handles {
            h.abort();
        }
    }
}

impl Drop for BackgroundJobs {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Starts the fire-and-forget startup tasks and the periodic rate refresh.
pub fn spawn_background(state: &AppState) -> BackgroundJobs {
    let mut handles = Vec::new();

    let s = state.clone();
    handles.push(tokio::spawn(async move {
        match recurring::apply_due_recurring(&s).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("[recurring] Applied {n} due recurring transaction(s)."),
            Err(err) => {
                tracing::warn!("[recurring] Failed to apply due recurring transactions: {err}")
            }
        }
    }));

    let s = state.clone();
    handles.push(tokio::spawn(async move {
        // Node first checks `Object.keys(await getLatestRates()).length === 0`
        // to log "No exchange rates found"; that map always holds the base
        // currency, so the line never prints (QUIRKS.md). A failure of that
        // read rejects the whole IIFE before the refresh.
        if let Err(err) = s.db(exchange_rate::get_latest_rates).await {
            tracing::warn!(
                "[startup] Could not refresh exchange rates: {}",
                message(&err)
            );
            return;
        }
        match exchange_rate::refresh_from_web(&s, None).await {
            Ok(_) => tracing::info!("[startup] Exchange rates refreshed."),
            Err(err) => tracing::warn!(
                "[startup] Could not refresh exchange rates: {}",
                message(&err)
            ),
        }
    }));

    let s = state.clone();
    handles.push(tokio::spawn(async move {
        let start = tokio::time::Instant::now() + RATE_REFRESH_INTERVAL;
        let mut tick = tokio::time::interval_at(start, RATE_REFRESH_INTERVAL);
        loop {
            tick.tick().await;
            match exchange_rate::refresh_from_web(&s, None).await {
                Ok(_) => tracing::info!("[rates] Exchange rates auto-refreshed."),
                Err(err) => tracing::warn!("[rates] Auto-refresh failed: {}", message(&err)),
            }
        }
    }));

    BackgroundJobs { handles }
}

fn message(err: &crate::error::ApiError) -> String {
    match err {
        crate::error::ApiError::Service { message, .. }
        | crate::error::ApiError::Status { message, .. } => message.clone(),
        other => other.to_string(),
    }
}
