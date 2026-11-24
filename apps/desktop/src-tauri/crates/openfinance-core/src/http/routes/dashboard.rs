//! Port of `apps/server/src/routes/dashboard.ts`, mounted at `/api/dashboard`.
//! Owner: Wave 2 (dashboard). TODO(wave 2): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
