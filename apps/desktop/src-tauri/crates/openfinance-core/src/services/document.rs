//! Port of `apps/server/src/services/document.service.ts`.
//! Owner: Wave 1 (data). TODO(wave 1): port this service.
//!
//! Notes from Wave 0: `UPLOADS_DIR` is `state.config().data_dir/uploads/documents`;
//! use `state.file_crypto()` for OFE1 (it carries the key and the desktop flag).

use crate::error::ApiResult;
use crate::state::AppState;

/// `migratePlaintextDocuments()`: encrypts plaintext uploads (web mode only;
/// returns 0 on desktop). Called by `jobs.rs` on startup. Stub: does nothing yet.
pub fn migrate_plaintext_documents(_state: &AppState) -> ApiResult<u64> {
    // TODO(wave 1): port migratePlaintextDocuments.
    Ok(0)
}
