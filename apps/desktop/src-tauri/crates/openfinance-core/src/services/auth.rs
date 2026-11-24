//! Port of `apps/server/src/services/auth.service.ts` (Wave 0): key derivation only.
//!
//! The JWT register/login flow (`/api/auth/*`) is self-hosted only: the desktop
//! build renders `PasswordGate`, never `LoginGate`, and the auth middleware is
//! skipped when `OPENFINANCE_DESKTOP=true`. It is not ported (see STATUS.md).

pub use crate::crypto::derive_backup_key;
