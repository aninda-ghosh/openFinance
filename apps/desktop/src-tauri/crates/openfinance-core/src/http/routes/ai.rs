//! Port of `apps/server/src/routes/ai.ts`, mounted at `/api/ai` (Wave 3).

mod sse;

use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use super::policies::hono;
use crate::ai::config::SINGLETON_CONV_ID;
use crate::ai::{harness, memory, service};
use crate::error::{ApiError, ApiResult};
use crate::ids::nanoid;
use crate::js::{js_trim, now_iso};
use crate::json::{body_or_empty_object, field, from_sql, parse_body};
use crate::services::settings::{get_ai_settings, update_ai_settings, AiSettingsInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/settings", get(get_settings).put(put_settings))
        .route("/status", get(status))
        .route("/generating", get(singleton_generating))
        .route(
            "/conversations/{id}/generating",
            get(conversation_generating),
        )
        .route("/start-ollama", post(start_ollama))
        .route("/messages", get(singleton_messages))
        .route("/clear", post(clear))
        .route("/chat", get(singleton_chat))
        .route(
            "/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route("/conversations/{id}", delete(delete_conversation))
        .route("/conversations/{id}/messages", get(conversation_messages))
        .route("/conversations/{id}/audit", get(audit))
        .route(
            "/conversations/{id}/chat",
            get(conversation_chat_get).post(conversation_chat_post),
        )
}

/// `handleError`: 404 passes through, everything else is a logged 500.
fn handled(e: ApiError) -> ApiError {
    e.handled(&[404])
}

/// An uncaught exception in a handler: Hono's default error response.
fn uncaught() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "Internal Server Error",
    )
        .into_response()
}

/// `c.req.param("id")` (`/api/ai/conversations/:id/...`).
fn conv_id(uri: &axum::http::Uri) -> String {
    hono::param(uri.path(), 4)
}

fn query(uri: &axum::http::Uri, key: &str) -> Option<String> {
    hono::query(uri.query(), key)
}

// ─── Ollama settings ──────────────────────────────────────────────────────────

async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    Json(json!(get_ai_settings(&state)))
}

/// `body.x` as `updateAiSettings` reads it: absent → `None`, null → `Some(None)`,
/// a string → `Some(Some)`; anything else throws on `.trim()` (`Err`).
fn setting_input(body: &Value, key: &str) -> Result<Option<Option<String>>, ()> {
    match field(body, key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(Value::Bool(false)) => Err(()),
        Some(_) => Err(()),
    }
}

async fn put_settings(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let internal = || ApiError::internal("invalid settings body");
    let body = parse_body(&body).ok_or_else(internal)?;
    if body.is_null() {
        return Err(ApiError::internal(
            "TypeError: Cannot read properties of null (reading 'ollama_url')",
        ));
    }
    let url = setting_input(&body, "ollama_url").map_err(|_| internal())?;
    if let Some(Some(u)) = &url {
        let t = js_trim(u);
        let lower = t.to_ascii_lowercase();
        if !t.is_empty() && !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(ApiError::bad_request(
                "Ollama URL must start with http:// or https://",
            ));
        }
    }
    let model = setting_input(&body, "ollama_model").map_err(|_| internal())?;
    let settings = update_ai_settings(
        &state,
        AiSettingsInput {
            ollama_url: url,
            ollama_model: model,
        },
    )
    .await
    .map_err(handled)?;
    Ok(Json(json!(settings)))
}

// ─── Status ───────────────────────────────────────────────────────────────────

async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(service::get_status(&state).await.map_err(handled)?))
}

// ─── Generating status ────────────────────────────────────────────────────────

fn generating_json(conversation_id: &str) -> Json<Value> {
    let generating = harness::is_generating(conversation_id);
    let state = harness::get_active_state(conversation_id)
        .map(|s| s.to_json())
        .unwrap_or(Value::Null);
    Json(json!({ "generating": generating, "state": state }))
}

async fn singleton_generating() -> Json<Value> {
    generating_json(SINGLETON_CONV_ID)
}

async fn conversation_generating(OriginalUri(uri): OriginalUri) -> Json<Value> {
    generating_json(&conv_id(&uri))
}

// ─── Start Ollama ─────────────────────────────────────────────────────────────

/// Common install locations: a bundled macOS app has a stripped PATH.
const EXTRA_PATHS: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

/// `spawn("ollama", ["serve"], { detached: true, stdio: "ignore", env })`
/// followed by `unref()`: a new process group, no stdio, reaped in the
/// background. `Err` when the spawn fails (Node: `child.pid == null`).
fn spawn_ollama_serve() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let path = format!(
        "{EXTRA_PATHS}:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = Command::new("ollama")
        .arg("serve")
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    // Reap it whenever it exits so it never lingers as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

async fn start_ollama(State(state): State<AppState>) -> Response {
    let could_not = || {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "started": false,
                "message": "Could not start Ollama — make sure it is installed and on PATH",
            })),
        )
            .into_response()
    };
    let connected = |v: &Value| v.get("connected") == Some(&Value::Bool(true));
    match service::get_status(&state).await {
        Ok(s) if connected(&s) => {
            return Json(json!({ "started": true, "message": "Ollama is already running" }))
                .into_response()
        }
        Ok(_) => {}
        Err(_) => return could_not(),
    }

    if let Err(err) = spawn_ollama_serve() {
        tracing::error!("[start-ollama] spawn error: {err}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "started": false,
                "message": "Failed to spawn Ollama — is it installed?",
            })),
        )
            .into_response();
    }

    // Give it up to 8s to become reachable.
    let deadline = Instant::now() + Duration::from_millis(8000);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(600)).await;
        match service::get_status(&state).await {
            Ok(s) if connected(&s) => {
                return Json(json!({ "started": true, "message": "Ollama started successfully" }))
                    .into_response()
            }
            Ok(_) => {}
            Err(_) => return could_not(),
        }
    }
    Json(json!({
        "started": false,
        "message": "Ollama launched but did not respond in time — it may still be starting up",
    }))
    .into_response()
}

// ─── Singleton chat ───────────────────────────────────────────────────────────

async fn singleton_messages(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let messages = service::get_singleton_messages(&state)
        .await
        .map_err(handled)?;
    Ok(Json(json!({ "messages": messages })))
}

async fn clear(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    service::clear_singleton(&state).await.map_err(handled)?;
    Ok(Json(json!({ "success": true })))
}

async fn singleton_chat(State(state): State<AppState>, OriginalUri(uri): OriginalUri) -> Response {
    let message = query(&uri, "message");
    let model = query(&uri, "model").filter(|m| !m.is_empty());
    let currency = query(&uri, "currency")
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "INR".into());
    let conversation_id = SINGLETON_CONV_ID;
    let is_gen = harness::is_generating(conversation_id);
    let trimmed = message.as_deref().map(js_trim).unwrap_or("").to_string();
    if trimmed.is_empty() && !is_gen {
        return ApiError::bad_request("message query param required").into_response();
    }
    let listener = harness::add_listener(conversation_id);
    if !trimmed.is_empty() && !is_gen {
        harness::get_or_create_generation(&state, conversation_id, &trimmed, model, &currency);
    }
    sse::response(listener)
}

// ─── Conversations ────────────────────────────────────────────────────────────

async fn list_conversations(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = state
        .db(|conn| {
            let mut stmt = conn.prepare(
                "select \"id\", \"title\", \"created_at\", \"updated_at\" from \"ai_conversations\" order by \"ai_conversations\".\"updated_at\"",
            )?;
            let rows = stmt
                .query_map([], conversation_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(handled)?;
    Ok(Json(json!({ "conversations": rows })))
}

fn conversation_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    for (i, k) in ["id", "title", "created_at", "updated_at"]
        .iter()
        .enumerate()
    {
        m.insert((*k).to_string(), from_sql(r.get_ref(i)?));
    }
    Ok(Value::Object(m))
}

async fn create_conversation(State(state): State<AppState>, body: Bytes) -> Response {
    let body = body_or_empty_object(&body);
    if body.is_null() {
        return uncaught(); // `null.title`
    }
    let title = match field(&body, "title") {
        None | Some(Value::Null) => Value::String("New Conversation".into()),
        Some(v) => v.clone(),
    };
    let title =
        match title {
            Value::String(s) if s.encode_utf16().count() >= 1 => s,
            Value::String(_) => return ApiError::validation(json!([{
                "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
                "path": ["title"], "message": "Too small: expected string to have >=1 characters"
            }]))
            .into_response(),
            _ => {
                return ApiError::validation(json!([{
                    "expected": "string", "code": "invalid_type", "path": ["title"],
                    "message": "Invalid input: expected string"
                }]))
                .into_response()
            }
        };
    let result = state
        .db(move |conn| {
            let id = nanoid();
            let (c, u) = (now_iso(), now_iso());
            conn.execute(
                "insert into \"ai_conversations\" (\"id\", \"title\", \"created_at\", \"updated_at\") values (?, ?, ?, ?)",
                rusqlite::params![id, title, c, u],
            )?;
            Ok(json!({ "id": id, "title": title, "created_at": c, "updated_at": u }))
        })
        .await;
    match result {
        Ok(row) => (StatusCode::CREATED, Json(row)).into_response(),
        Err(e) => handled(e).into_response(),
    }
}

async fn delete_conversation(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = conv_id(&uri);
    let conv = id.clone();
    let deleted = state
        .db(move |conn| {
            // FK order: tool_calls → messages → conversation
            let ids = service::message_ids(conn, &conv)?;
            if !ids.is_empty() {
                service::delete_tool_calls_for(conn, &ids)?;
                conn.execute(
                    "delete from \"ai_messages\" where \"ai_messages\".\"conversation_id\" = ?",
                    [&conv],
                )?;
            }
            let n = conn.execute(
                "delete from \"ai_conversations\" where \"ai_conversations\".\"id\" = ?",
                [&conv],
            )?;
            Ok(n)
        })
        .await
        .map_err(handled)?;
    if deleted == 0 {
        return Err(ApiError::not_found("Conversation not found"));
    }
    memory::delete_memory(&state, &id).await;
    Ok(Json(json!({ "success": true })))
}

async fn conversation_messages(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = conv_id(&uri);
    let messages = state
        .db(move |conn| service::list_messages(conn, &id))
        .await
        .map_err(handled)?;
    Ok(Json(json!({ "messages": messages })))
}

async fn audit(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = conv_id(&uri);
    let calls = state
        .db(move |conn| {
            let ids = service::message_ids(conn, &id)?;
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            let mut stmt = conn.prepare(
                "select \"id\", \"message_id\", \"tool_name\", \"params_json\", \"result_json\", \"called_at\" from \"ai_tool_calls\"",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let mut m = Map::new();
                    for (i, k) in [
                        "id",
                        "message_id",
                        "tool_name",
                        "params_json",
                        "result_json",
                        "called_at",
                    ]
                    .iter()
                    .enumerate()
                    {
                        m.insert((*k).to_string(), from_sql(r.get_ref(i)?));
                    }
                    Ok(Value::Object(m))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .filter(|tc| ids.contains(&tc["message_id"]))
                .collect())
        })
        .await
        .map_err(handled)?;
    Ok(Json(json!({ "tool_calls": calls })))
}

// ─── Conversation chat (SSE) ──────────────────────────────────────────────────

/// `handleChatStream(c, message)`.
fn handle_chat_stream(state: &AppState, conversation_id: &str, message: &str) -> Response {
    if message.is_empty() {
        return ApiError::validation(json!([{
            "origin": "string", "code": "too_small", "minimum": 1, "inclusive": true,
            "path": ["content"], "message": "Too small: expected string to have >=1 characters"
        }]))
        .into_response();
    }
    let is_gen = harness::is_generating(conversation_id);
    let listener = harness::add_listener(conversation_id);
    if !js_trim(message).is_empty() && !is_gen {
        harness::get_or_create_generation(state, conversation_id, message, None, "INR");
    }
    sse::response(listener)
}

async fn conversation_chat_get(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let id = conv_id(&uri);
    let message = query(&uri, "message");
    let is_gen = harness::is_generating(&id);
    if message.as_deref().map(js_trim).unwrap_or("").is_empty() && !is_gen {
        return ApiError::bad_request("message query param required").into_response();
    }
    handle_chat_stream(&state, &id, message.as_deref().unwrap_or(""))
}

async fn conversation_chat_post(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    let id = conv_id(&uri);
    let body = parse_body(&body).unwrap_or(Value::Null);
    let message = match field(&body, "message") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return uncaught(), // `.trim` is not a function
    };
    match message {
        Some(m) if !js_trim(&m).is_empty() => handle_chat_stream(&state, &id, &m),
        _ => ApiError::bad_request("message body field required").into_response(),
    }
}
