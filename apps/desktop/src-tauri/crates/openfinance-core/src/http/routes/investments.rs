//! Port of `apps/server/src/routes/investments.ts`, mounted at `/api/investments`.
//! Owner: Wave 2 (investments).
//!
//! Hono runs the first registered route whose pattern matches the
//! `decodeURI`d path, so literal segments overlap with `:id` in ways axum's
//! router (static segments always win) cannot express: `GET
//! /documents/documents` lists the documents of investment "documents",
//! `POST /documents/refresh-price` refreshes investment "documents",
//! `PATCH /portfolio-summary` updates investment "portfolio-summary", and so
//! on. Everything below `/` therefore goes through [`dispatch`], which tries
//! the Node routes in registration order on the decoded segments and falls
//! back to Hono's 404.

pub mod schemas;

use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::http::routes::documents::{self as documents_routes, hono, UploadParent};
use crate::json::parse_body;
use crate::services::{document, investment};
use crate::state::AppState;

/// `handleError` in investments.ts: only 404 passes through (a service's
/// 400 and 422 become 500s, QUIRKS.md Wave 2 investments).
const PASSTHROUGH: &[u16] = &[404];

const PREFIX: &str = "/api/investments";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{*rest}", any(dispatch))
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/// `decodeURI` (`keep_reserved`) or `decodeURIComponent`; `None` on a URIError.
fn js_decode(s: &str, keep_reserved: bool) -> Option<String> {
    let b = s.as_bytes();
    let hex = |i: usize| -> Option<u8> {
        let h = b.get(i + 1..i + 3)?;
        u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    };
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i)?;
        if first < 0x80 {
            if keep_reserved && b";/?:@&=+$,#".contains(&first) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let n = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut seq = vec![first];
        for k in 1..n {
            let at = i + 3 * k;
            if b.get(at) != Some(&b'%') {
                return None;
            }
            let byte = hex(at)?;
            if byte & 0xC0 != 0x80 {
                return None;
            }
            seq.push(byte);
        }
        std::str::from_utf8(&seq).ok()?;
        out.extend_from_slice(&seq);
        i += 3 * n;
    }
    String::from_utf8(out).ok()
}

/// Hono `tryDecodeURI`: on a URIError, each run of `%XX` escapes is decoded
/// on its own and kept as-is when it still fails.
fn try_decode_uri(s: &str) -> String {
    if let Some(d) = js_decode(s, true) {
        return d;
    }
    let b = s.as_bytes();
    let is_escape = |i: usize| {
        b.get(i) == Some(&b'%')
            && b.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
            && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
    };
    let mut out = String::with_capacity(s.len());
    let (mut i, mut plain) = (0, 0);
    while i < b.len() {
        if is_escape(i) {
            out.push_str(&s[plain..i]);
            let start = i;
            while is_escape(i) {
                i += 3;
            }
            let run = &s[start..i];
            out.push_str(&js_decode(run, true).unwrap_or_else(|| run.to_string()));
            plain = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[plain..]);
    out
}

/// The path below the mount point as Hono's router sees it (`getPath`:
/// `tryDecodeURI` with `%25` protected), split into segments.
fn routed_segments(raw_path: &str) -> Vec<String> {
    let rest = raw_path.strip_prefix(PREFIX).unwrap_or(raw_path);
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let path = if raw_path.contains('%') {
        let protected = rest.replace("%25", "%2525");
        try_decode_uri(&protected)
    } else {
        rest.to_string()
    };
    path.split('/').map(str::to_string).collect()
}

/// `c.req.param(name)`: the routed segment, `decodeURIComponent`ed when it
/// still holds a `%`.
fn param(segment: &str) -> String {
    if segment.contains('%') {
        hono::try_decode_component(segment)
    } else {
        segment.to_string()
    }
}

/// Every route below `/`, in investments.ts registration order.
async fn dispatch(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let segs = routed_segments(uri.path());
    // Hono's `:param` never matches an empty segment.
    if segs.iter().any(String::is_empty) {
        return crate::http::not_found().await;
    }
    let s: Vec<&str> = segs.iter().map(String::as_str).collect();
    let get = method == Method::GET || method == Method::HEAD;
    let post = method == Method::POST;
    let query = uri.query();
    match s.as_slice() {
        [id] if method == Method::PATCH => respond(update(&state, param(id), &body).await),
        [id] if method == Method::DELETE => respond(delete(&state, param(id)).await),
        [id, "refresh-price"] if post => respond(refresh_price(&state, param(id)).await),
        [id, "price-history"] if get => respond(price_history(&state, param(id), query).await),
        [id, "value-history"] if get => respond(value_history(&state, param(id)).await),
        [id, "value-history", entry] if method == Method::PATCH => {
            respond(set_contribution(&state, param(id), param(entry), &body).await)
        }
        [id, "value-history", "bulk-contributions"] if post => {
            respond(bulk_contributions(&state, param(id), &body).await)
        }
        ["portfolio-summary"] if get => respond(portfolio_summary(&state).await),
        [id, "documents"] if post => {
            documents_routes::upload(&state, &headers, &body, UploadParent::Investment(param(id)))
                .await
        }
        [id, "documents"] if get => respond(list_documents(&state, param(id)).await),
        ["documents", doc] if get => documents_routes::download(&state, param(doc)).await,
        ["documents", doc] if method == Method::DELETE => {
            respond(documents_routes::remove(&state, param(doc)).await)
        }
        _ => crate::http::not_found().await,
    }
}

fn respond<T: IntoResponse>(r: ApiResult<T>) -> Response {
    match r {
        Ok(v) => v.into_response(),
        Err(e) => e.into_response(),
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /api/investments?asset_type=&sort=
async fn list(State(state): State<AppState>, uri: axum::http::Uri) -> ApiResult<Json<Value>> {
    let filters = investment::InvestmentFilters {
        asset_type: hono::query_param(uri.query(), "asset_type"),
        sort: hono::query_param(uri.query(), "sort"),
    };
    let investments = state
        .db(move |conn| investment::list_investments(conn, &filters))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "investments": investments })))
}

/// POST /api/investments
async fn create(
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let data = schemas::parse(schemas::CREATE_INVESTMENT, parse_body(&body).as_ref())?;
    let inv = state
        .db(move |conn| investment::create_investment(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(inv)?)))
}

/// PATCH /api/investments/:id
async fn update(state: &AppState, id: String, body: &[u8]) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::UPDATE_INVESTMENT, parse_body(body).as_ref())?;
    let inv = state
        .db(move |conn| investment::update_investment(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(inv)?))
}

/// DELETE /api/investments/:id
async fn delete(state: &AppState, id: String) -> ApiResult<Json<Value>> {
    state
        .db(move |conn| investment::delete_investment(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

/// POST /api/investments/:id/refresh-price
async fn refresh_price(state: &AppState, id: String) -> ApiResult<Json<Value>> {
    let result = state
        .db(move |conn| investment::refresh_price(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(result)?))
}

/// GET /api/investments/:id/price-history?from=&to=
async fn price_history(
    state: &AppState,
    id: String,
    query: Option<&str>,
) -> ApiResult<Json<Value>> {
    let from = hono::query_param(query, "from");
    let to = hono::query_param(query, "to");
    let history = state
        .db(move |conn| investment::get_price_history(conn, &id, from.as_deref(), to.as_deref()))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "history": history })))
}

/// GET /api/investments/:id/value-history
async fn value_history(state: &AppState, id: String) -> ApiResult<Json<Value>> {
    let history = state
        .db(move |conn| investment::get_value_history(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "history": history })))
}

/// PATCH /api/investments/:id/value-history/:entryId
async fn set_contribution(
    state: &AppState,
    id: String,
    entry_id: String,
    body: &[u8],
) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::SET_CONTRIBUTION, parse_body(body).as_ref())?;
    let contribution = data
        .get("contribution")
        .and_then(Value::as_f64)
        .ok_or_else(|| ApiError::internal("contribution missing after validation"))?;
    let inv = state
        .db(move |conn| investment::set_entry_contribution(conn, &id, &entry_id, contribution))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(inv)?))
}

/// POST /api/investments/:id/value-history/bulk-contributions
async fn bulk_contributions(state: &AppState, id: String, body: &[u8]) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::BULK_CONTRIBUTION, parse_body(body).as_ref())?;
    let mode = data
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let inv = state
        .db(move |conn| investment::bulk_set_contributions(conn, &id, &mode))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(inv)?))
}

/// GET /api/investments/portfolio-summary
async fn portfolio_summary(state: &AppState) -> ApiResult<Json<Value>> {
    let summary = state
        .db(investment::get_portfolio_summary)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(summary)?))
}

/// GET /api/investments/:id/documents
async fn list_documents(state: &AppState, id: String) -> ApiResult<Json<Value>> {
    let docs = state
        .db(move |conn| document::list_documents(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "documents": docs })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_decodes_like_hono() {
        assert_eq!(routed_segments("/api/investments/a/b"), vec!["a", "b"]);
        assert_eq!(
            routed_segments("/api/investments/%64ocuments/x%2Fy"),
            vec!["documents", "x%2Fy"]
        );
        assert_eq!(routed_segments("/api/investments/x/"), vec!["x", ""]);
        assert_eq!(routed_segments("/api/investments/%E2%zz"), vec!["%E2%zz"]);
        assert_eq!(routed_segments("/api/investments/a%2541"), vec!["a%2541"]);
        assert_eq!(param("a%2541"), "a%41");
        assert_eq!(param("x%2Fy"), "x/y");
        assert_eq!(param("%E2%zz"), "%E2%zz");
    }

    // A successful upload is not compared by the parity harness (its disk name
    // is random), so the upload → list → download → delete round trip through
    // these routes is checked here.

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const PASS: &str = "investments-test-pass";

    fn test_state(dir: &std::path::Path) -> AppState {
        let db_path = dir.join("openfinance.db");
        let config = crate::Config {
            db_path: db_path.clone(),
            db_key: Some(PASS.to_string()),
            desktop: true,
            no_network: true,
            encryption_key: None,
            ollama_url_env: None,
            ollama_model_env: None,
            data_dir: dir.to_path_buf(),
        };
        let conn = crate::db::open(&db_path, Some(PASS)).expect("open db");
        crate::db::bootstrap::bootstrap_schema(&conn).expect("bootstrap");
        AppState::from_connection(conn, config)
    }

    async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let app = crate::http::router(state.clone());
        let resp = app.oneshot(req).await.expect("response");
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec();
        (status, headers, body)
    }

    fn json_of(body: &[u8]) -> Value {
        serde_json::from_slice(body).expect("json")
    }

    #[tokio::test]
    async fn upload_list_download_delete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = test_state(dir.path());

        // An investment whose id collides with the literal "documents" segment.
        state
            .db(|conn| {
                conn.execute(
                    "insert into investments (id, name, asset_type, purchase_value, purchase_date, current_value) values ('documents', 'D', 'stock', 1, '2024-01-01', 1)",
                    [],
                )?;
                Ok(())
            })
            .await
            .expect("seed");

        let boundary = "----invTestBoundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"report ✓.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 test\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"notes\"\r\n\r\nyearly\r\n--{boundary}--\r\n"
        );
        let req = Request::post("/api/investments/documents/documents")
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("req");
        let (status, _, created) = call(&state, req).await;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&created)
        );
        let created = json_of(&created);
        assert_eq!(created["investment_id"], "documents");
        assert_eq!(created["name"], "report ✓.pdf");
        assert_eq!(created["notes"], "yearly");
        assert_eq!(created["mime_type"], "application/pdf");
        assert_eq!(created["file_size"], 13);
        let file_name = created["file_name"].as_str().expect("file_name");
        assert!(file_name.starts_with("doc_") && file_name.ends_with(".pdf"));
        let doc_id = created["id"].as_str().expect("id").to_string();

        // GET /documents/documents lists investment "documents" (route order).
        let req = Request::get("/api/investments/documents/documents")
            .body(Body::empty())
            .expect("req");
        let (status, _, listed) = call(&state, req).await;
        assert_eq!(status, StatusCode::OK);
        let listed = json_of(&listed);
        assert_eq!(listed["documents"].as_array().map(Vec::len), Some(1));
        assert_eq!(listed["documents"][0]["id"], doc_id.as_str());

        let req = Request::get(format!("/api/investments/documents/{doc_id}"))
            .body(Body::empty())
            .expect("req");
        let (status, headers, bytes) = call(&state, req).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, b"%PDF-1.4 test");
        assert_eq!(
            headers
                .get("content-disposition")
                .and_then(|v| v.to_str().ok()),
            Some("inline; filename=\"report%20%E2%9C%93.pdf\"")
        );

        let req = Request::delete(format!("/api/investments/documents/{doc_id}"))
            .body(Body::empty())
            .expect("req");
        let (status, _, _) = call(&state, req).await;
        assert_eq!(status, StatusCode::OK);
        let req = Request::get("/api/investments/documents/documents")
            .body(Body::empty())
            .expect("req");
        let (_, _, listed) = call(&state, req).await;
        assert_eq!(json_of(&listed)["documents"], json!([]));
    }

    #[tokio::test]
    async fn unmatched_paths_are_hono_404s() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = test_state(dir.path());
        for (method, path) in [
            ("GET", "/api/investments/"),
            ("GET", "/api/investments/x"),
            ("PUT", "/api/investments/x"),
            ("POST", "/api/investments/x/value-history/y"),
            ("GET", "/api/investments/x//documents"),
            ("POST", "/api/investments/documents/x"),
        ] {
            let req = Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .expect("req");
            let (status, headers, body) = call(&state, req).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert_eq!(body, b"404 Not Found", "{method} {path}");
            assert_eq!(
                headers.get("content-type").and_then(|v| v.to_str().ok()),
                Some("text/plain; charset=UTF-8")
            );
        }
    }
}
