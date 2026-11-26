//! Port of `apps/server/src/ai/*` and `config/ai.config.ts` (Wave 3).
//!
//! - `config`: `AI_CONFIG`
//! - `ollama`: `ollama.client.ts` (URL/model from `services::settings`)
//! - `prompts`: `prompts/financial-advisor.ts` (byte-identical text)
//! - `tools`: `tools/index.ts` + `tools/calculator.ts`
//! - `service`: `ai.service.ts` (streaming chat with the tool-calling loop)
//! - `harness`: `chat-harness.ts` (per-conversation generation state)
//! - `memory`: `chat-memory.ts` (encrypted files in `DATA_DIR/chat-memories`)
//! - `context`: `context.builder.ts` (unused by Node, ported for completeness)
//! - `intl`, `js`: the JS / Intl semantics the above depend on

pub mod config;
pub mod context;
pub mod harness;
pub mod intl;
pub mod js;
pub mod memory;
pub mod ollama;
pub mod prompts;
pub mod service;
pub mod tools;
