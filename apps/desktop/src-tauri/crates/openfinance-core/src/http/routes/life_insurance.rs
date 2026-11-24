//! Port of `apps/server/src/routes/life-insurance.ts`, mounted at `/api/life-insurance`.
//! Owner: Wave 1 (policies). TODO(wave 1): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
