//! Port of `apps/server/src/routes/budget.ts`, mounted at `/api/budget`.
//! Owner: Wave 1 (budget). TODO(wave 1): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
