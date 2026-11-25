//! Port of `apps/server/src/ai/chat-harness.ts`: one background generation
//! per conversation, its accumulated state, and the listeners (SSE streams)
//! attached to it. Like Node's singleton, it is process-wide.
//!
//! Node behaviours kept on purpose (QUIRKS.md, Wave 3):
//! - `addListener` only attaches to a generation that already exists, and the
//!   routes call it *before* starting a new one, so the stream that starts a
//!   generation never receives its events;
//! - a finished generation stays for 15 s, during which a new message for the
//!   same conversation re-attaches to it instead of starting another.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::js::{value_to_string, JsError};
use super::ollama::CONNECTION_ERROR;
use super::service;
use crate::state::AppState;

/// How long a finished generation stays visible.
const RETAIN_AFTER_DONE: Duration = Duration::from_millis(15_000);

/// `GenerationEvent`.
#[derive(Debug, Clone, PartialEq)]
pub enum GenerationEvent {
    /// A token (any truthy JSON value, as Ollama sent it).
    Token(Value),
    /// `{ name, params, result }` (keys absent when `undefined`).
    Tool(Value),
    Done,
    Error(String),
}

/// `ActiveGenerationState`.
#[derive(Debug, Clone, Default)]
pub struct ActiveGenerationState {
    pub conversation_id: String,
    pub accumulated_text: String,
    pub tool_calls: Vec<Value>,
    pub is_done: bool,
    pub error: Option<String>,
}

impl ActiveGenerationState {
    /// The JSON the routes return (`error` only when set).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("conversationId".into(), json!(self.conversation_id));
        m.insert("accumulatedText".into(), json!(self.accumulated_text));
        m.insert("toolCalls".into(), Value::Array(self.tool_calls.clone()));
        m.insert("isDone".into(), json!(self.is_done));
        if let Some(e) = &self.error {
            m.insert("error".into(), json!(e));
        }
        Value::Object(m)
    }
}

struct Generation {
    id: u64,
    state: ActiveGenerationState,
    listeners: Vec<(u64, UnboundedSender<GenerationEvent>)>,
}

#[derive(Default)]
struct Harness {
    next_id: u64,
    active: HashMap<String, Generation>,
}

static HARNESS: LazyLock<Mutex<Harness>> = LazyLock::new(|| Mutex::new(Harness::default()));

fn lock() -> MutexGuard<'static, Harness> {
    match HARNESS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// `isGenerating(conversationId)`.
pub fn is_generating(conversation_id: &str) -> bool {
    lock().active.contains_key(conversation_id)
}

/// `getActiveState(conversationId)`.
pub fn get_active_state(conversation_id: &str) -> Option<ActiveGenerationState> {
    lock().active.get(conversation_id).map(|g| g.state.clone())
}

/// A listener handle; dropping it is `unsubscribe()`.
pub struct Listener {
    conversation_id: String,
    id: Option<u64>,
    pub events: Option<UnboundedReceiver<GenerationEvent>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            if let Some(g) = lock().active.get_mut(&self.conversation_id) {
                g.listeners.retain(|(l, _)| *l != id);
            }
        }
    }
}

/// `addListener(conversationId, listener)`: attaches to an existing
/// generation and replays its state (text so far as one token, the tool
/// calls, then the error or `done`). Without a generation nothing is
/// attached and `events` is `None`.
pub fn add_listener(conversation_id: &str) -> Listener {
    let mut h = lock();
    h.next_id += 1;
    let id = h.next_id;
    let Some(gen) = h.active.get_mut(conversation_id) else {
        return Listener {
            conversation_id: conversation_id.to_string(),
            id: None,
            events: None,
        };
    };
    let (tx, rx) = unbounded_channel();
    let s = &gen.state;
    if !s.accumulated_text.is_empty() {
        let _ = tx.send(GenerationEvent::Token(Value::String(
            s.accumulated_text.clone(),
        )));
    }
    for tc in &s.tool_calls {
        let _ = tx.send(GenerationEvent::Tool(tc.clone()));
    }
    if let Some(e) = &s.error {
        let _ = tx.send(GenerationEvent::Error(e.clone()));
    } else if s.is_done {
        let _ = tx.send(GenerationEvent::Done);
    }
    gen.listeners.push((id, tx));
    Listener {
        conversation_id: conversation_id.to_string(),
        id: Some(id),
        events: Some(rx),
    }
}

/// Applies `update` to the generation's state and sends `event` to every listener.
fn broadcast(
    conversation_id: &str,
    gen_id: u64,
    update: impl FnOnce(&mut ActiveGenerationState),
    event: GenerationEvent,
) {
    let mut h = lock();
    if let Some(g) = h.active.get_mut(conversation_id).filter(|g| g.id == gen_id) {
        update(&mut g.state);
        for (_, tx) in &g.listeners {
            let _ = tx.send(event.clone());
        }
    }
}

/// `getOrCreateGeneration(conversationId, message, model, currency)`:
/// starts the generation in the background unless one exists.
pub fn get_or_create_generation(
    state: &AppState,
    conversation_id: &str,
    message: &str,
    model: Option<String>,
    currency: &str,
) {
    let gen_id = {
        let mut h = lock();
        if h.active.contains_key(conversation_id) {
            return;
        }
        h.next_id += 1;
        let id = h.next_id;
        h.active.insert(
            conversation_id.to_string(),
            Generation {
                id,
                state: ActiveGenerationState {
                    conversation_id: conversation_id.to_string(),
                    ..ActiveGenerationState::default()
                },
                listeners: Vec::new(),
            },
        );
        id
    };

    let state = state.clone();
    let conv = conversation_id.to_string();
    let message = message.to_string();
    let currency = currency.to_string();
    tokio::spawn(async move {
        let c1 = conv.clone();
        let mut on_tool =
            |name: Option<Value>, params: Option<Value>, outcome: &service::ToolOutcome| {
                let mut tc = Map::new();
                if let Some(n) = name {
                    tc.insert("name".into(), n);
                }
                if let Some(p) = params {
                    tc.insert("params".into(), p);
                }
                tc.insert("result".into(), Value::String(outcome.harness_string()));
                let tc = Value::Object(tc);
                let pushed = tc.clone();
                broadcast(
                    &c1,
                    gen_id,
                    |s| s.tool_calls.push(pushed),
                    GenerationEvent::Tool(tc),
                );
            };
        let c2 = conv.clone();
        let mut on_token = |token: Value| {
            let text = value_to_string(&token);
            broadcast(
                &c2,
                gen_id,
                |s| s.accumulated_text.push_str(&text),
                GenerationEvent::Token(token),
            );
        };
        let result: Result<(), JsError> = service::stream(
            &state,
            &conv,
            &message,
            model.as_deref(),
            &currency,
            &mut on_tool,
            &mut on_token,
        )
        .await;
        match result {
            Ok(()) => broadcast(&conv, gen_id, |s| s.is_done = true, GenerationEvent::Done),
            Err(err) => {
                tracing::error!("[Harness Background Error]: {}", err.name);
                let msg = if err.name == CONNECTION_ERROR {
                    "AI service unavailable — Ollama is not running".to_string()
                } else {
                    err.message
                };
                let m = msg.clone();
                broadcast(
                    &conv,
                    gen_id,
                    |s| {
                        s.error = Some(m);
                        s.is_done = true;
                    },
                    GenerationEvent::Error(msg),
                );
            }
        }
        // Keep the finished generation for late or re-attaching clients.
        tokio::time::sleep(RETAIN_AFTER_DONE).await;
        let mut h = lock();
        if h.active.get(&conv).is_some_and(|g| g.id == gen_id) {
            h.active.remove(&conv);
        }
    });
}
