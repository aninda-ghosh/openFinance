//! Port of `apps/server/src/services/price.service.ts`.
//! Owner: Wave 2 (investments). TODO(wave 2): port this service.
//!
//! Notes from Wave 0: every outbound fetch must fail like a network error when
//! `state.config().no_network` is set (Node: `OPENFINANCE_NO_NETWORK=1` makes
//! `fetchWithTimeout` throw `TypeError: fetch failed`). Use `state.http()`.
