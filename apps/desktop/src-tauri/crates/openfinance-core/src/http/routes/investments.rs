//! Port of `apps/server/src/routes/investments.ts`, mounted at `/api/investments`.
//! Owner: Wave 2 (investments). TODO(wave 2): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
