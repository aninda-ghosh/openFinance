//! One module per Node route file. Each exposes `router()`, mounted by
//! `http/mod.rs` at the same prefix as `app.route(...)` in `index.ts`.
//! `routes/auth.ts` is self-hosted only and not ported (the app is desktop-only).

pub mod ai;
pub mod backup;
pub mod budget;
pub mod dashboard;
pub mod documents;
pub mod exchange_rates;
pub mod investments;
pub mod life_insurance;
pub mod policies;
pub mod reset;
