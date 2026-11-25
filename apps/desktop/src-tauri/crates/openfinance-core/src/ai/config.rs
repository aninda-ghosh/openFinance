//! Port of `apps/server/src/config/ai.config.ts` (`AI_CONFIG`). The Ollama
//! endpoint and model are runtime settings (`services::settings`).

/// `temperature.analysis`: tool-calling turns.
pub const TEMPERATURE_ANALYSIS: f64 = 0.1;
/// `temperature.conversational`: the streamed answer.
pub const TEMPERATURE_CONVERSATIONAL: f64 = 0.4;
/// `maxTokens` (unused by Node too).
pub const MAX_TOKENS: u32 = 4096;
/// `contextWindow`: sent as `options.num_ctx`.
pub const CONTEXT_WINDOW: u32 = 16384;
/// `maxToolIterations`.
pub const MAX_TOOL_ITERATIONS: usize = 5;
/// `singletonConvId`: the single persistent conversation.
pub const SINGLETON_CONV_ID: &str = "__singleton__";
/// `maxHistoryMessages`: DB history sent to the model.
pub const MAX_HISTORY_MESSAGES: usize = 20;
