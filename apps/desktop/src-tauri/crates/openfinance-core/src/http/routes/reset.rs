//! Port of `apps/server/src/routes/reset.ts`, mounted at `/api/reset`.
//! Owner: Wave 1 (data). TODO(wave 1): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
