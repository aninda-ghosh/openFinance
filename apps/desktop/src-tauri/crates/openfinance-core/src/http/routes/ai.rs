//! Port of `apps/server/src/routes/ai.ts`, mounted at `/api/ai`.
//! Owner: Wave 3 (ai). TODO(wave 3): port these routes.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
