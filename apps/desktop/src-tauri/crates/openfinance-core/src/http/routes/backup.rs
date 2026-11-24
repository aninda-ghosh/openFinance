//! Port of `apps/server/src/routes/backup.ts`, mounted at `/api/backup`.
//! Owner: Wave 1 (data). TODO(wave 1): port these routes.
//!
//! Notes from Wave 0: the parity harness seeds every run with
//! `POST /api/backup/import` against **Node only**, so the Rust import is not
//! needed for seeding; it still needs its own scenarios. FWB1 helpers and
//! `derive_backup_key` are in `crate::crypto`.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
