//! Port of `apps/server/src/ai/*` and `config/ai.config.ts`.
//! Owner: Wave 3 (ai). TODO(wave 3): port the Ollama client, tools, chat
//! harness, context builder and chat memory. Add submodules here as needed.
//!
//! Notes from Wave 0: the Ollama URL/model come from
//! `services::settings::{get_ollama_url, get_ollama_model, get_ai_settings,
//! update_ai_settings}`; chat memories live in `state.config().data_dir/chat-memories`
//! and are OFE1 strings via `state.file_crypto()`.
