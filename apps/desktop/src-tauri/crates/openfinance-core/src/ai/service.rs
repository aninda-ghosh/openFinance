//! Port of `apps/server/src/ai/ai.service.ts`: the streaming chat with its
//! tool-calling loop, the singleton-conversation helpers and the status check.

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

use super::config::{
    MAX_HISTORY_MESSAGES, MAX_TOOL_ITERATIONS, SINGLETON_CONV_ID, TEMPERATURE_ANALYSIS,
    TEMPERATURE_CONVERSATIONAL,
};
use super::js::{get_prop, nullish, stringify, stringify_str, JsError};
use super::{memory, ollama, prompts, tools};
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::now_iso;
use crate::json::from_sql;
use crate::services::settings::get_ollama_model;
use crate::state::AppState;

pub const MESSAGE_COLS: &str = "\"id\", \"conversation_id\", \"role\", \"content\", \"confidence\", \"sources_json\", \"created_at\"";

/// One `ai_messages` row as drizzle returns it.
fn message_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    for (i, k) in [
        "id",
        "conversation_id",
        "role",
        "content",
        "confidence",
        "sources_json",
        "created_at",
    ]
    .iter()
    .enumerate()
    {
        m.insert((*k).to_string(), from_sql(r.get_ref(i)?));
    }
    Ok(Value::Object(m))
}

/// `select * from ai_messages where conversation_id = ? order by created_at`.
pub fn list_messages(conn: &Connection, conversation_id: &str) -> ApiResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "select {MESSAGE_COLS} from \"ai_messages\" where \"ai_messages\".\"conversation_id\" = ? order by \"ai_messages\".\"created_at\""
    ))?;
    let rows = stmt
        .query_map([conversation_id], message_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `select id from ai_messages where conversation_id = ?`.
pub fn message_ids(conn: &Connection, conversation_id: &str) -> ApiResult<Vec<Value>> {
    let mut stmt = conn.prepare(
        "select \"id\" from \"ai_messages\" where \"ai_messages\".\"conversation_id\" = ?",
    )?;
    let rows = stmt
        .query_map([conversation_id], |r| Ok(from_sql(r.get_ref(0)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// `delete from ai_tool_calls where message_id in (...)`.
pub fn delete_tool_calls_for(conn: &Connection, ids: &[Value]) -> ApiResult<()> {
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "delete from \"ai_tool_calls\" where \"ai_tool_calls\".\"message_id\" in ({placeholders})"
    );
    let vals: Vec<rusqlite::types::Value> = ids
        .iter()
        .map(|v| match v {
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            Value::Number(n) => n
                .as_i64()
                .map(rusqlite::types::Value::Integer)
                .unwrap_or_else(|| rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))),
            _ => rusqlite::types::Value::Null,
        })
        .collect();
    conn.execute(&sql, rusqlite::params_from_iter(vals))?;
    Ok(())
}

/// `ensureConversation(conversationId)`.
pub fn ensure_conversation(conn: &Connection, conversation_id: &str) -> ApiResult<()> {
    let exists: Option<Value> = {
        let mut stmt = conn.prepare(
            "select \"id\" from \"ai_conversations\" where \"ai_conversations\".\"id\" = ?",
        )?;
        let mut rows = stmt.query([conversation_id])?;
        match rows.next()? {
            Some(r) => Some(from_sql(r.get_ref(0)?)),
            None => None,
        }
    };
    if exists.is_none() {
        let now = now_iso();
        conn.execute(
            "insert into \"ai_conversations\" (\"id\", \"title\", \"created_at\", \"updated_at\") values (?, ?, ?, ?)",
            params![conversation_id, "New Conversation", now, now_iso()],
        )?;
    }
    Ok(())
}

/// `db.insert(ai_messages).values({ conversation_id, role, content })`.
pub fn insert_message(
    conn: &Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
) -> ApiResult<()> {
    conn.execute(
        &format!("insert into \"ai_messages\" ({MESSAGE_COLS}) values (?, ?, ?, ?, null, null, ?)"),
        params![nanoid(), conversation_id, role, content, now_iso()],
    )?;
    Ok(())
}

/// `loadHistory(conversationId)`: the last 20 messages as `{ role, content }`.
fn load_history(conn: &Connection, conversation_id: &str) -> ApiResult<Vec<Value>> {
    let rows = list_messages(conn, conversation_id)?;
    let start = rows.len().saturating_sub(MAX_HISTORY_MESSAGES);
    Ok(rows[start..]
        .iter()
        .map(|r| json!({ "role": r["role"], "content": r["content"] }))
        .collect())
}

/// What a tool call produced: `executeTool`'s string, or `{ error: String(e) }`.
pub enum ToolOutcome {
    Text(String),
    Error(String),
}

impl ToolOutcome {
    /// `JSON.stringify(result)`: the tool message content.
    fn message_content(&self) -> String {
        match self {
            ToolOutcome::Text(s) => stringify_str(s),
            ToolOutcome::Error(e) => stringify(&json!({ "error": e })),
        }
    }

    /// The harness's `typeof result === "string" ? result : JSON.stringify(result)`.
    pub fn harness_string(&self) -> String {
        match self {
            ToolOutcome::Text(s) => s.clone(),
            ToolOutcome::Error(_) => self.message_content(),
        }
    }
}

/// `onToolCall(name, params, result)`.
pub type OnTool<'a> = &'a mut (dyn FnMut(Option<Value>, Option<Value>, &ToolOutcome) + Send);
/// Each streamed token.
pub type OnToken<'a> = &'a mut (dyn FnMut(Value) + Send);

/// The elements `for (const tc of response.tool_calls)` iterates.
fn iterate_tool_calls(tool_calls: &Value) -> Result<Vec<Value>, JsError> {
    match tool_calls {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(JsError::type_error("response.tool_calls is not iterable")),
    }
}

/// `tool_calls.length === 0`.
fn has_length_zero(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.is_empty(),
        Value::String(s) => s.encode_utf16().count() == 0,
        _ => false,
    }
}

/// `AIService.stream(...)`: saves the user message, runs up to five
/// tool-calling turns, streams the answer, then saves it and appends the
/// exchange to the chat memory.
pub async fn stream(
    state: &AppState,
    conversation_id: &str,
    user_message: &str,
    model: Option<&str>,
    display_currency: &str,
    on_tool: OnTool<'_>,
    on_token: OnToken<'_>,
) -> Result<(), JsError> {
    let conv = conversation_id.to_string();
    let msg = user_message.to_string();
    let history = state
        .db(move |conn| {
            ensure_conversation(conn, &conv)?;
            insert_message(conn, &conv, "user", &msg)?;
            load_history(conn, &conv)
        })
        .await?;

    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 2);
    messages.push(json!({
        "role": "system",
        "content": prompts::financial_advisor_prompt(display_currency),
    }));
    messages.extend(history);
    messages.push(json!({ "role": "user", "content": user_message }));

    for _ in 0..MAX_TOOL_ITERATIONS {
        let response = ollama::chat_with_tools(
            state,
            &messages,
            Some(TEMPERATURE_ANALYSIS),
            Some(tools::ai_tools()),
            model,
        )
        .await?;
        let tool_calls = get_prop(response.as_ref(), "tool_calls")?.cloned();
        let tool_calls = match tool_calls {
            Some(tc) if super::js::truthy(Some(&tc)) && !has_length_zero(&tc) => tc,
            _ => break,
        };
        let content = nullish(get_prop(response.as_ref(), "content")?)
            .cloned()
            .unwrap_or(Value::String(String::new()));
        messages.push(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls,
        }));

        for tc in iterate_tool_calls(&tool_calls)? {
            // `tc.function.name` / `tc.function.arguments`, evaluated inside the try.
            let access = get_prop(Some(&tc), "function").and_then(|f| {
                let name = get_prop(f, "name")?.cloned();
                let args = get_prop(f, "arguments")?.cloned();
                Ok((name, args))
            });
            let outcome = match &access {
                Ok((name, args)) => {
                    match tools::execute_tool(state, name.as_ref(), args.as_ref(), display_currency)
                        .await
                    {
                        Ok(text) => ToolOutcome::Text(text),
                        Err(e) => ToolOutcome::Error(e.to_js_string()),
                    }
                }
                Err(e) => ToolOutcome::Error(e.to_js_string()),
            };
            match access {
                Ok((name, args)) => on_tool(name, args, &outcome),
                Err(_) => tracing::error!("Error in onToolCall callback"),
            }
            messages.push(json!({ "role": "tool", "content": outcome.message_content() }));
        }
    }

    // Stream the final answer with all fetched tool data in context.
    let mut full = String::new();
    {
        let mut forward = |token: Value| {
            full.push_str(&super::js::value_to_string(&token));
            on_token(token);
        };
        ollama::stream(
            state,
            &messages,
            Some(TEMPERATURE_CONVERSATIONAL),
            model,
            &mut forward,
        )
        .await?;
    }

    let conv = conversation_id.to_string();
    let content = full.clone();
    state
        .db(move |conn| insert_message(conn, &conv, "assistant", &content))
        .await?;
    if memory::append_exchange(state, conversation_id, user_message, &full)
        .await
        .is_err()
    {
        // ignored, like `.catch(() => {})`
    }
    Ok(())
}

/// `getSingletonMessages()`.
pub async fn get_singleton_messages(state: &AppState) -> ApiResult<Vec<Value>> {
    state
        .db(|conn| {
            ensure_conversation(conn, SINGLETON_CONV_ID)?;
            list_messages(conn, SINGLETON_CONV_ID)
        })
        .await
}

/// `clearSingleton()`: tool calls and messages, then the memory file.
pub async fn clear_singleton(state: &AppState) -> ApiResult<()> {
    state
        .db(|conn| {
            let ids = message_ids(conn, SINGLETON_CONV_ID)?;
            if !ids.is_empty() {
                delete_tool_calls_for(conn, &ids)?;
                conn.execute(
                    "delete from \"ai_messages\" where \"ai_messages\".\"conversation_id\" = ?",
                    [SINGLETON_CONV_ID],
                )?;
            }
            Ok(())
        })
        .await?;
    memory::delete_memory(state, SINGLETON_CONV_ID).await;
    Ok(())
}

/// `getStatus()`: `{ connected, model, model_available, available_models }`.
/// A non-string model name makes `m.startsWith` throw (→ 500), as in Node.
pub async fn get_status(state: &AppState) -> ApiResult<Value> {
    let (connected, models) = tokio::join!(ollama::ping(state), ollama::list_models(state));
    let model = get_ollama_model(state);
    let mut available = false;
    if connected {
        for m in &models {
            match m {
                Value::String(s) if s == &model || s.starts_with(&model) => {
                    available = true;
                    break;
                }
                Value::String(_) => {}
                _ => {
                    return Err(ApiError::internal(
                        "TypeError: m.startsWith is not a function",
                    ))
                }
            }
        }
    }
    Ok(json!({
        "connected": connected,
        "model": model,
        "model_available": available,
        "available_models": models,
    }))
}
