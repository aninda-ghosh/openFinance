//! Port of `apps/server/src/routes/budget.ts`, mounted at `/api/budget`
//! (Wave 1, budget). Validation is `@openfinance/shared/schemas` ported to
//! [`zod`]; `handleError` passes 404 and 400 through.

mod schemas;
mod zod;

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::json::{field, parse_body};
use crate::services::{budget, bulk, recurring};
use crate::state::AppState;

/// `handleError` in budget.ts: 404 and 400 keep their status and message.
const PASSTHROUGH: &[u16] = &[404, 400];

const MONTH_REQUIRED: &str = "month query param required (YYYY-MM)";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/accounts", get(list_accounts).post(create_account))
        .route(
            "/accounts/{id}",
            patch(update_account).delete(delete_account),
        )
        .route("/envelopes", get(list_envelopes).post(create_envelope))
        // Hono falls through from these static paths to `/envelopes/:id`.
        .route(
            "/envelopes/copy-previous",
            post(copy_previous)
                .patch(update_envelope)
                .delete(delete_envelope),
        )
        .route(
            "/envelopes/clear-budget",
            post(clear_budget)
                .patch(update_envelope)
                .delete(delete_envelope),
        )
        .route(
            "/envelopes/{id}",
            patch(update_envelope).delete(delete_envelope),
        )
        .route("/envelopes/{id}/reclaim", post(reclaim_envelope))
        .route("/envelope-groups", get(list_groups).post(create_group))
        .route(
            "/envelope-groups/{id}",
            patch(update_group).delete(delete_group),
        )
        .route(
            "/transactions",
            get(list_transactions).post(create_transaction),
        )
        .route(
            "/transactions/transfer",
            post(create_transfer)
                .patch(update_transaction)
                .delete(delete_transaction),
        )
        .route(
            "/transactions/bulk",
            post(create_bulk)
                .patch(update_transaction)
                .delete(delete_transaction),
        )
        .route("/transactions/bulk/preview", post(preview_bulk))
        .route(
            "/transactions/{id}",
            patch(update_transaction).delete(delete_transaction),
        )
        .route("/import", post(import_csv))
        .route("/reports/summary", get(monthly_summary))
        .route("/reports/envelope-trends/{id}", get(envelope_trends))
        .route("/recurring", get(list_recurring).post(create_recurring))
        .route(
            "/recurring/apply-due",
            post(apply_due)
                .patch(update_recurring)
                .delete(delete_recurring),
        )
        .route(
            "/recurring/{id}",
            patch(update_recurring).delete(delete_recurring),
        )
        .route("/maintenance/misfiled", get(find_misfiled))
        .route("/maintenance/misfiled/repair", post(repair_misfiled))
}

// ─── Request helpers (Hono semantics) ────────────────────────────────────────

/// `decodeURIComponent(s)`; `None` where JS throws a URIError.
fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        // A run of %XX escapes must decode to complete UTF-8 characters.
        let mut run: Vec<u8> = Vec::new();
        while i < b.len() && b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            run.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        }
        std::str::from_utf8(&run).ok()?;
        out.extend(run);
    }
    String::from_utf8(out).ok()
}

/// Hono's `tryDecode(str, decodeURIComponent)`: on failure, decode each run
/// of `%XX` escapes on its own and keep the runs that fail.
fn try_decode(s: &str) -> String {
    if let Some(d) = decode_uri_component(s) {
        return d;
    }
    let b = s.as_bytes();
    let is_escape = |i: usize| {
        i + 2 < b.len()
            && b[i] == b'%'
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
    };
    let mut out = String::new();
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if is_escape(i) {
            let start = i;
            while is_escape(i) {
                i += 3;
            }
            out.push_str(&s[last..start]);
            let run = &s[start..i];
            out.push_str(&decode_uri_component(run).unwrap_or_else(|| run.to_string()));
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[last..]);
    out
}

/// Hono's `_decodeURI` for query names and values.
fn decode_query_part(s: &str) -> String {
    if !s.contains(['%', '+']) {
        return s.to_string();
    }
    let s = s.replace('+', " ");
    if s.contains('%') {
        try_decode(&s)
    } else {
        s
    }
}

/// `c.req.query()`: every parameter, the first occurrence winning.
fn query_map(raw: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(raw) = raw else {
        return out;
    };
    for part in raw.split('&') {
        let (name, value) = match part.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (part, None),
        };
        let name = decode_query_part(name);
        if name.is_empty() || out.contains_key(&name) {
            continue;
        }
        let value = value.map(decode_query_part).unwrap_or_default();
        out.insert(name, Value::String(value));
    }
    out
}

/// `c.req.query(name)`.
fn query(raw: &Option<String>, name: &str) -> Option<String> {
    query_map(raw.as_deref())
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `c.req.param(...)` for the path segment at `index` (Hono decodes it).
fn param(uri: &Uri, index: usize) -> String {
    let seg = uri.path().split('/').nth(index).unwrap_or_default();
    if seg.contains('%') {
        try_decode(seg)
    } else {
        seg.to_string()
    }
}

/// `await c.req.json().catch(() => null)`.
fn body_or_null(body: &Bytes) -> Value {
    parse_body(body).unwrap_or(Value::Null)
}

fn ok<T: Serialize>(status: StatusCode, value: &T) -> ApiResult<Response> {
    Ok((status, Json(serde_json::to_value(value)?)).into_response())
}

fn from_parsed<T: DeserializeOwned>(v: Value) -> ApiResult<T> {
    Ok(serde_json::from_value(v)?)
}

fn object(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Validates `body` against `schema`, or answers `400 Validation failed`.
fn validate(schema: &zod::Schema, body: &Value) -> ApiResult<Value> {
    schema
        .safe_parse(body)
        .map_err(|issues| ApiError::validation(zod::details(&issues)))
}

/// A `YYYY-MM` month as the regex sees it (`regex.test` stringifies).
fn month_of(v: Option<&Value>) -> Option<String> {
    let s = match v? {
        Value::String(s) => s.clone(),
        // better-sqlite3 flattens a one-element array into its value.
        Value::Array(items) if items.len() == 1 => items[0].as_str()?.to_string(),
        _ => return None,
    };
    zod::is_year_month(&s).then_some(s)
}

/// An uncaught TypeError in a Hono handler: Hono's default error handler.
fn uncaught() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "Internal Server Error",
    )
        .into_response()
}

// ─── Accounts ────────────────────────────────────────────────────────────────

async fn list_accounts(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let accounts = state
        .db(budget::list_accounts)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "accounts": accounts })))
}

async fn create_account(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let data = validate(&schemas::create_account(), &body_or_null(&body))?;
    let data: budget::CreateAccount = from_parsed(data)?;
    let account = state
        .db(move |conn| budget::create_account(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::CREATED, &account)
}

async fn update_account(
    State(state): State<AppState>,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let data = object(validate(&schemas::update_account(), &body_or_null(&body))?);
    let id = param(&uri, 2);
    let account = state
        .db(move |conn| budget::update_account(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &account)
}

async fn delete_account(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    state
        .db(move |conn| budget::delete_account(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

// ─── Envelopes ───────────────────────────────────────────────────────────────

async fn list_envelopes(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<Value>> {
    let month = query(&raw, "month")
        .filter(|m| zod::is_year_month(m))
        .ok_or_else(|| ApiError::bad_request(MONTH_REQUIRED))?;
    let envelopes = state
        .db(move |conn| budget::list_envelopes(conn, &month))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "envelopes": envelopes })))
}

async fn copy_previous(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let body = body_or_null(&body);
    let month =
        month_of(field(&body, "month")).ok_or_else(|| ApiError::bad_request(MONTH_REQUIRED))?;
    let result = state
        .db(move |conn| budget::copy_previous_month_budget(conn, &month))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(result))
}

async fn clear_budget(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let body = body_or_null(&body);
    let month =
        month_of(field(&body, "month")).ok_or_else(|| ApiError::bad_request(MONTH_REQUIRED))?;
    let result = state
        .db(move |conn| budget::clear_month_budget(conn, &month))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(result))
}

async fn create_envelope(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let data = validate(&schemas::create_envelope(), &body_or_null(&body))?;
    let data: budget::CreateEnvelope = from_parsed(data)?;
    let envelope = state
        .db(move |conn| budget::create_envelope(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::CREATED, &envelope)
}

async fn update_envelope(
    State(state): State<AppState>,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let data = object(validate(&schemas::update_envelope(), &body_or_null(&body))?);
    let id = param(&uri, 2);
    let envelope = state
        .db(move |conn| budget::update_envelope(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &envelope)
}

async fn reclaim_envelope(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    let result = state
        .db(move |conn| budget::reclaim_envelope_to_pool(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(result))
}

async fn delete_envelope(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    state
        .db(move |conn| budget::delete_envelope(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

async fn list_groups(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let groups = state
        .db(budget::list_envelope_groups)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "groups": groups })))
}

/// `body?.name?.trim()`: `Err(())` where JS throws (a non-string name).
fn group_name(body: &Value) -> Result<Option<String>, ()> {
    match field(body, "name") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = crate::js::js_trim(s);
            Ok((!t.is_empty()).then(|| t.to_string()))
        }
        Some(_) => Err(()),
    }
}

async fn create_group(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let Ok(name) = group_name(&body_or_null(&body)) else {
        return Ok(uncaught());
    };
    let name = name.ok_or_else(|| ApiError::bad_request("name required"))?;
    let group = state
        .db(move |conn| budget::create_envelope_group(conn, &name))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::CREATED, &group)
}

async fn update_group(State(state): State<AppState>, uri: Uri, body: Bytes) -> ApiResult<Response> {
    let Ok(name) = group_name(&body_or_null(&body)) else {
        return Ok(uncaught());
    };
    let name = name.ok_or_else(|| ApiError::bad_request("name required"))?;
    let id = param(&uri, 2);
    let group = state
        .db(move |conn| budget::update_envelope_group(conn, &id, &name))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &group)
}

async fn delete_group(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    state
        .db(move |conn| budget::delete_envelope_group(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

// ─── Transactions ────────────────────────────────────────────────────────────

async fn list_transactions(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Response> {
    let raw = Value::Object(query_map(raw.as_deref()));
    let filters = schemas::transaction_filters()
        .safe_parse(&raw)
        .map_err(|issues| {
            ApiError::body(
                StatusCode::BAD_REQUEST,
                json!({ "error": "Invalid filters", "details": zod::details(&issues) }),
            )
        })?;
    let filters: budget::TransactionFilters = from_parsed(filters)?;
    let result = state
        .db(move |conn| budget::list_transactions(conn, &filters))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &result)
}

fn duplicate() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "skipped": true, "reason": "duplicate" })),
    )
        .into_response()
}

async fn create_transaction(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let data = validate(&schemas::create_transaction(), &body_or_null(&body))?;
    let data: budget::CreateTransaction = from_parsed(data)?;
    let txn = state
        .db(move |conn| budget::create_transaction(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    match txn {
        None => Ok(duplicate()),
        Some(t) => ok(StatusCode::CREATED, &t),
    }
}

async fn update_transaction(
    State(state): State<AppState>,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Response> {
    let data = object(validate(
        &schemas::update_transaction(),
        &body_or_null(&body),
    )?);
    let id = param(&uri, 2);
    let txn = state
        .db(move |conn| budget::update_transaction(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &txn)
}

async fn create_transfer(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let mut data = object(validate(&schemas::create_transfer(), &body_or_null(&body))?);
    if !data.contains_key("to_amount") {
        let amount = data.get("amount").cloned().unwrap_or(Value::Null);
        data.insert("to_amount".into(), amount);
    }
    let data: budget::CreateTransfer = from_parsed(Value::Object(data))?;
    let result = state
        .db(move |conn| budget::create_transfer(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    match result {
        None => Ok(duplicate()),
        Some(t) => ok(StatusCode::CREATED, &t),
    }
}

async fn preview_bulk(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let data = validate(&schemas::bulk_preview(), &body_or_null(&body))?;
    let data: bulk::BulkPreviewRequest = from_parsed(data)?;
    let result = state
        .db(move |conn| bulk::preview_bulk(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(result))
}

fn row_errors(rows: Vec<bulk::BulkRowError>) -> ApiError {
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|r| json!({ "index": r.index, "message": r.message }))
        .collect();
    ApiError::body(
        StatusCode::BAD_REQUEST,
        json!({ "error": "Some rows need attention", "rows": rows }),
    )
}

async fn create_bulk(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let data = match schemas::bulk_create().safe_parse(&body_or_null(&body)) {
        Ok(d) => d,
        Err(issues) => {
            // Point each problem at its row so the grid can highlight it.
            let rows: Vec<Value> = issues
                .iter()
                .filter_map(|i| match i.path.as_slice() {
                    [zod::Seg::Key("rows"), zod::Seg::Index(index), ..] => {
                        Some(json!({ "index": index, "message": i.message }))
                    }
                    _ => None,
                })
                .collect();
            let error = if rows.is_empty() {
                "Validation failed"
            } else {
                "Some rows need attention"
            };
            return Err(ApiError::body(
                StatusCode::BAD_REQUEST,
                json!({ "error": error, "rows": rows }),
            ));
        }
    };
    let data: bulk::BulkCreateRequest = from_parsed(data)?;
    let result = state
        .db(move |conn| Ok(bulk::create_bulk(conn, &data)))
        .await?;
    match result {
        Ok(v) => Ok((StatusCode::CREATED, Json(v)).into_response()),
        Err(bulk::BulkError::Rows(rows)) => Err(row_errors(rows)),
        Err(bulk::BulkError::Api(e)) => Err(e.handled(PASSTHROUGH)),
    }
}

async fn delete_transaction(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    state
        .db(move |conn| budget::delete_transaction(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

// ─── CSV import ──────────────────────────────────────────────────────────────

async fn import_csv(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
    body: Bytes,
) -> ApiResult<Response> {
    let account_id = query(&raw, "account_id")
        .filter(|a| !a.is_empty())
        .ok_or_else(|| ApiError::bad_request("account_id query param required"))?;
    let result = state
        .db(move |conn| budget::import_csv(conn, &body, &account_id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &result)
}

// ─── Reports ─────────────────────────────────────────────────────────────────

async fn monthly_summary(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Response> {
    let month = query(&raw, "month")
        .filter(|m| zod::is_year_month(m))
        .ok_or_else(|| ApiError::bad_request(MONTH_REQUIRED))?;
    let summary = state
        .db(move |conn| budget::get_monthly_summary(conn, &month))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    ok(StatusCode::OK, &summary)
}

async fn envelope_trends(
    State(state): State<AppState>,
    uri: Uri,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<Value>> {
    // `Number(c.req.query("months") ?? 6)`
    let months = query(&raw, "months").map_or(6.0, |m| crate::json::string_to_number(&m));
    let id = param(&uri, 3);
    let trends = state
        .db(move |conn| budget::get_envelope_trends(conn, &id, months))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "trends": trends })))
}

// ─── Recurring ───────────────────────────────────────────────────────────────

async fn list_recurring(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = state
        .db(recurring::list_recurring)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "recurring": rows })))
}

async fn create_recurring(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let data = object(validate(
        &schemas::create_recurring(),
        &body_or_null(&body),
    )?);
    let row = state
        .db(move |conn| recurring::create_recurring(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok((StatusCode::CREATED, Json(row)).into_response())
}

async fn update_recurring(
    State(state): State<AppState>,
    uri: Uri,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let data = object(validate(
        &schemas::update_recurring(),
        &body_or_null(&body),
    )?);
    let id = param(&uri, 2);
    let row = state
        .db(move |conn| recurring::update_recurring(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(row))
}

async fn delete_recurring(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let id = param(&uri, 2);
    state
        .db(move |conn| recurring::delete_recurring(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

async fn apply_due(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let count = recurring::apply_due_recurring(&state)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "applied": count })))
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

async fn find_misfiled(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows = state
        .db(budget::find_misfiled_transactions)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "count": rows.len(), "transactions": rows })))
}

async fn repair_misfiled(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let result = state
        .db(budget::repair_misfiled_transactions)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing_like_hono() {
        let q = query_map(Some(
            "month=2026-05&month=2026-06&a+b=c%20d&flag&=x&bad=%E0%A4&ok=%41",
        ));
        assert_eq!(q.get("month"), Some(&json!("2026-05")));
        assert_eq!(q.get("a b"), Some(&json!("c d")));
        assert_eq!(q.get("flag"), Some(&json!("")));
        assert_eq!(q.get("bad"), Some(&json!("%E0%A4")));
        assert_eq!(q.get("ok"), Some(&json!("A")));
        assert!(!q.contains_key(""));
        assert_eq!(try_decode("%41%E0%A4x%42"), "%41%E0%A4xB");
        assert_eq!(try_decode("%41x%E0%A4"), "Ax%E0%A4");
        assert_eq!(try_decode("100%"), "100%");
    }
}
