//! Port of `apps/server/src/services/recurring.service.ts`.
//! Owner: Wave 1 (budget). TODO(wave 1): port this service.

use crate::error::ApiResult;
use crate::state::AppState;

/// `applyDueRecurring()`: returns how many transactions were created.
/// Called by `jobs.rs` on startup. Stub: does nothing yet.
pub async fn apply_due_recurring(_state: &AppState) -> ApiResult<u64> {
    // TODO(wave 1): port applyDueRecurring.
    Ok(0)
}
