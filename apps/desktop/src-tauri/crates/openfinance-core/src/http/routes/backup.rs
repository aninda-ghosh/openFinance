//! Port of `apps/server/src/routes/backup.ts`, mounted at `/api/backup`.
//! Owner: Wave 1 (data).
//!
//! - `GET /export`: every user table as `backup-data.json` (exactly the text
//!   `JSON.stringify(backupData, null, 2)` produces) plus each uploaded
//!   document, decrypted, as `documents/<file>`, zipped and then FWB1-encrypted
//!   with the user's `backup_key` (or, on desktop, a key derived from the
//!   passcode with username "desktop").
//! - `POST /import`: the reverse, accepting FWB1 or plain ZIPs, running the
//!   migration pipeline (`restore.rs`) and restoring atomically, then writing
//!   the documents (re-encrypted with OFE1) and refreshing exchange rates.

mod archive;
mod jsdate;
mod jsjson;
mod jsonparse;
mod restore;
mod tables;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::documents::hono::header_string;
use crate::crypto;
use crate::json::{from_sql, string_to_number};
use crate::services::document::{self, nodepath};
use crate::services::exchange_rate;
use crate::state::AppState;

pub use archive::Archive;
pub use jsjson::{number_to_string, stringify_pretty};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/export", get(export))
        .route("/import", post(import))
}

fn json_error(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

// ── Export ───────────────────────────────────────────────────────────────────

/// drizzle's boolean column decoding: `Number(value) === 1`.
fn boolean_from_sql(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    let n = match v {
        ValueRef::Null => return Value::Null,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => f,
        ValueRef::Text(t) | ValueRef::Blob(t) => string_to_number(&String::from_utf8_lossy(t)),
    };
    Value::Bool(n == 1.0)
}

/// `db.select().from(table)`: every row, columns in schema order.
fn select_all(conn: &Connection, table: &tables::Table) -> rusqlite::Result<Vec<Value>> {
    let cols = table
        .columns
        .iter()
        .map(|c| format!("\"{}\"", c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!("select {cols} from \"{}\"", table.name))?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = Map::new();
        for (i, col) in table.columns.iter().enumerate() {
            let v = row.get_ref(i)?;
            let value = if col.boolean {
                boolean_from_sql(v)
            } else {
                from_sql(v)
            };
            obj.insert(col.name.to_string(), value);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

/// `const [userRow] = await db.select({ backup_key: users.backup_key }).from(users).limit(1)`.
fn first_user_field(conn: &Connection, column: &str) -> rusqlite::Result<Option<Value>> {
    let mut stmt = conn.prepare(&format!("select \"{column}\" from \"users\" limit 1"))?;
    let mut rows = stmt.query([])?;
    Ok(match rows.next()? {
        Some(row) => Some(from_sql(row.get_ref(0)?)),
        None => None,
    })
}

/// The export's data object, in Node's key order.
pub fn export_data(conn: &Connection) -> rusqlite::Result<Map<String, Value>> {
    let mut data = Map::new();
    for table in tables::EXPORT_ORDER {
        data.insert(table.name.to_string(), Value::Array(select_all(conn, &table)?));
    }
    Ok(data)
}

/// Builds the (possibly encrypted) export file. Runs on the blocking pool.
fn build_export(state: &AppState) -> Result<Vec<u8>, String> {
    let (data, backup_key) = state
        .db_blocking(|conn| {
            let data = export_data(conn)?;
            let key = first_user_field(conn, "backup_key")?;
            Ok((data, key))
        })
        .map_err(|e| e.to_string())?;
    let backup = json!({
        "version": "1",
        "exported_at": crate::js::now_iso(),
        "data": data,
    });
    let mut files = vec![(
        "backup-data.json".to_string(),
        stringify_pretty(&backup).map_err(|e| e.to_string())?,
    )];

    let docs_dir = document::uploads_dir_of(state);
    if document::exists_sync(&docs_dir) {
        for file in document::read_dir_sorted(&docs_dir).map_err(|e| e.to_string())? {
            let path = nodepath::join(&docs_dir, &file);
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if meta.is_file() {
                let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
                let plain = state.file_crypto().decrypt_buffer(&raw);
                files.push((nodepath::join_str(&["documents", &file]), plain));
            }
        }
    }
    let zip = archive::write(&files)?;

    // Seamless encryption with the user's backup_key, or the desktop fallback.
    let config = state.config();
    let key = match backup_key {
        Some(Value::String(k)) if !k.is_empty() => Some(Some(k)),
        // A truthy non-string key makes `Buffer.from(key, "hex")` throw inside
        // encryptBackup, which then returns the ZIP unencrypted.
        Some(v) if crate::json::truthy(Some(&v)) => Some(None),
        _ => match config.db_key.as_deref() {
            Some(k) if config.desktop && !k.is_empty() => {
                Some(Some(crypto::derive_backup_key(k, "desktop")))
            }
            _ => None,
        },
    };
    Ok(match key {
        Some(Some(k)) => crypto::encrypt_backup(&zip, &k),
        Some(None) | None => zip,
    })
}

/// GET /api/backup/export
async fn export(State(state): State<AppState>) -> Response {
    let s = state.clone();
    let built = tokio::task::spawn_blocking(move || build_export(&s))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    match built {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            resp.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"openfinance-backup.ofb\""),
            );
            resp
        }
        Err(err) => {
            tracing::error!("Export failed: {err}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Export failed" }))
        }
    }
}

// ── Import ───────────────────────────────────────────────────────────────────

enum Imported {
    Done,
    Reply(Response),
}

const MAGIC: &[u8; 4] = b"FWB1";

/// Decrypts an FWB1 backup like the route: the stored backup_key first, then
/// the `x-backup-password` header with each candidate username.
fn decrypt_import(state: &AppState, headers: &HeaderMap, raw: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let stored = state
        .db_blocking(|conn| Ok(first_user_field(conn, "backup_key")?))
        .map_err(|e| e.to_string())?;
    if crate::json::truthy(stored.as_ref()) {
        if let Some(Value::String(key)) = &stored {
            if let Ok(Some(d)) = crypto::decrypt_backup(raw, key) {
                return Ok(Some(d));
            }
        }
    }
    let Some(password) = header_string(headers, "x-backup-password").filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let header_user = header_string(headers, "x-backup-username").filter(|u| !u.is_empty());
    let db_user = state
        .db_blocking(|conn| Ok(first_user_field(conn, "username")?))
        .map_err(|e| e.to_string())?;
    let mut candidates: Vec<String> = Vec::new();
    let mut add = |u: String| {
        if !candidates.contains(&u) {
            candidates.push(u);
        }
    };
    if let Some(u) = header_user {
        add(u);
    }
    match db_user {
        Some(Value::String(u)) if !u.is_empty() => add(u),
        _ => {}
    }
    add("desktop".to_string());
    for user in candidates {
        let key = crypto::derive_backup_key(&password, &user);
        if let Ok(Some(d)) = crypto::decrypt_backup(raw, &key) {
            return Ok(Some(d));
        }
    }
    Ok(None)
}

fn run_import(state: &AppState, headers: &HeaderMap, body: Vec<u8>) -> Result<Imported, String> {
    let mut raw = body;
    if raw.starts_with(MAGIC) {
        match decrypt_import(state, headers, &raw)? {
            Some(d) => raw = d,
            None => {
                return Ok(Imported::Reply(json_error(
                    StatusCode::BAD_REQUEST,
                    json!({
                        "error": "DECRYPTION_REQUIRED",
                        "message": "This backup is encrypted. Provide the password used to create it via the x-backup-password header.",
                    }),
                )))
            }
        }
    }

    let mut zip = Archive::open(raw)?;
    let Some(json_entry) = zip.entry("backup-data.json") else {
        return Ok(Imported::Reply(json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid backup ZIP: backup-data.json not found" }),
        )));
    };
    let text = zip.data(&json_entry)?;
    let parsed = jsonparse::parse(&String::from_utf8_lossy(&text))?;
    let data = match &parsed {
        Value::Object(o) => o.get("data").cloned(),
        _ => None,
    };
    let Some(data) = data.filter(|d| crate::json::truthy(Some(d))) else {
        return Ok(Imported::Reply(json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid backup file" }),
        )));
    };

    let prepared = restore::prepare(data).map_err(|e| e.0)?;
    state
        .db_blocking(|conn| {
            crate::db::run_transaction(conn, |conn| {
                restore::restore(conn, &prepared).map_err(|e| crate::error::ApiError::internal(e.0))
            })
        })
        .map_err(|e| e.to_string())?;

    // Documents go to disk after the restore commits.
    let docs_dir = document::uploads_dir_of(state);
    if !document::exists_sync(&docs_dir) {
        std::fs::create_dir_all(&docs_dir).map_err(|e| e.to_string())?;
    }
    let entries = zip.entries().to_vec();
    for entry in entries {
        if entry.name.starts_with("documents/") && !entry.is_directory() {
            let file_name = nodepath::basename(&entry.name);
            if !file_name.is_empty() {
                let data = zip.data(&entry)?;
                let encrypted = state.file_crypto().encrypt_buffer(&data);
                std::fs::write(nodepath::join(&docs_dir, &file_name), encrypted)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(Imported::Done)
}

/// POST /api/backup/import (raw body: an FWB1 or plain ZIP backup).
async fn import(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let s = state.clone();
    let result = tokio::task::spawn_blocking(move || run_import(&s, &headers, body.to_vec()))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    match result {
        Ok(Imported::Reply(resp)) => resp,
        Ok(Imported::Done) => {
            // Flush and reset exchange rates to the base currency.
            if let Err(err) = exchange_rate::refresh_from_web(&state, None).await {
                tracing::warn!("Failed to refresh exchange rates after import: {err}");
            }
            Json(json!({ "success": true })).into_response()
        }
        Err(err) => {
            tracing::error!("Import failed: {err}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Import failed" }))
        }
    }
}
