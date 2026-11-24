//! Port of `apps/server/src/routes/policies.ts`, mounted at `/api/policies`.
//! Owner: Wave 1 (policies).
//!
//! Path parameters are read from the raw request path and decoded the way
//! Hono does (`c.req.param()`), and query values the way `c.req.query()`
//! does, so malformed escapes behave like Node instead of axum's 400.

use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::json::{field, parse_body, string_to_number, truthy};
use crate::services::policy::{self as policy_service, schemas};
use crate::state::AppState;

/// `handleError` in policies.ts: only 404 passes through.
const PASSTHROUGH: &[u16] = &[404];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        // Hono matches PATCH/DELETE "/:id" for these too; axum's static
        // segment would otherwise shadow them.
        .route("/timeline", get(timeline).patch(update).delete(delete))
        .route("/alerts", get(alerts).patch(update).delete(delete))
        .route("/{id}", patch(update).delete(delete))
        .route(
            "/{id}/payouts/generate",
            post(generate_payouts).patch(update_payout),
        )
        .route("/{id}/payouts", get(get_payouts).post(add_payout))
        .route("/{id}/payouts/{payout_id}", patch(update_payout))
        .route(
            "/{id}/payouts/{payout_id}/mark-received",
            post(mark_received),
        )
}

/// GET /api/policies
async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let policies = state
        .db(policy_service::list_policies)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "policies": policies })))
}

/// POST /api/policies
async fn create(
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let data = schemas::parse(schemas::CREATE_POLICY, parse_body(&body).as_ref())?;
    let policy = state
        .db(move |conn| policy_service::create_policy(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(policy)?)))
}

/// PATCH /api/policies/:id
async fn update(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::UPDATE_POLICY, parse_body(&body).as_ref())?;
    let id = hono::param(uri.path(), 3);
    let policy = state
        .db(move |conn| policy_service::update_policy(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(policy)?))
}

/// DELETE /api/policies/:id
async fn delete(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = hono::param(uri.path(), 3);
    state
        .db(move |conn| policy_service::delete_policy(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}

/// POST /api/policies/:id/payouts/generate
async fn generate_payouts(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let body = parse_body(&body).unwrap_or(Value::Null);
    let required = ["start_date", "end_date", "amount", "frequency", "label"];
    if !required.iter().all(|k| truthy(field(&body, k))) {
        return Err(ApiError::bad_request(
            "start_date, end_date, amount, frequency, label are required",
        ));
    }
    let id = hono::param(uri.path(), 3);
    let count = state
        .db(move |conn| policy_service::generate_payouts(conn, &id, &body))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "created": count })))
}

/// GET /api/policies/:id/payouts
async fn get_payouts(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = hono::param(uri.path(), 3);
    let payouts = state
        .db(move |conn| policy_service::get_payouts(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "payouts": payouts })))
}

/// POST /api/policies/:id/payouts
async fn add_payout(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let data = schemas::parse(schemas::CREATE_PAYOUT, parse_body(&body).as_ref())?;
    let id = hono::param(uri.path(), 3);
    let payout = state
        .db(move |conn| policy_service::add_payout(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(payout)?)))
}

/// PATCH /api/policies/:id/payouts/:payoutId
async fn update_payout(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::UPDATE_PAYOUT, parse_body(&body).as_ref())?;
    let id = hono::param(uri.path(), 3);
    let payout_id = hono::param(uri.path(), 5);
    let payout = state
        .db(move |conn| policy_service::update_payout(conn, &id, &payout_id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(payout)?))
}

/// POST /api/policies/:id/payouts/:payoutId/mark-received
async fn mark_received(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = hono::param(uri.path(), 3);
    let payout_id = hono::param(uri.path(), 5);
    let payout = state
        .db(move |conn| policy_service::mark_payout_received(conn, &id, &payout_id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(payout)?))
}

/// GET /api/policies/timeline?years=5
async fn timeline(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let years = hono::query(uri.query(), "years").map_or(5.0, |s| string_to_number(&s));
    let events = state
        .db(move |conn| policy_service::get_timeline(conn, years))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "events": events })))
}

/// GET /api/policies/alerts?days=30
async fn alerts(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let days = hono::query(uri.query(), "days").map_or(30.0, |s| string_to_number(&s));
    let alerts = state
        .db(move |conn| policy_service::get_upcoming_alerts(conn, days))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "alerts": alerts })))
}

/// Hono's request helpers (`hono/dist/utils/url.js`, `request.js`), shared
/// with `life_insurance.rs`.
pub(super) mod hono {
    /// `decodeURIComponent` (`keep_reserved = false`) or `decodeURI`
    /// (`true`: escapes of `;/?:@&=+$,#` are kept). `None` is a URIError.
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

    /// `tryDecode(str, decoder)`: on a URIError, decode each run of `%XX`
    /// escapes on its own and keep the runs that still fail.
    fn try_decode(s: &str, keep_reserved: bool) -> String {
        if let Some(d) = js_decode(s, keep_reserved) {
            return d;
        }
        let b = s.as_bytes();
        let is_escape = |i: usize| {
            b.get(i) == Some(&b'%')
                && b.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
        };
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        let mut plain_start = 0;
        while i < b.len() {
            if is_escape(i) {
                out.push_str(&s[plain_start..i]);
                let start = i;
                while is_escape(i) {
                    i += 3;
                }
                let run = &s[start..i];
                match js_decode(run, keep_reserved) {
                    Some(d) => out.push_str(&d),
                    None => out.push_str(run),
                }
                plain_start = i;
            } else {
                i += 1;
            }
        }
        out.push_str(&s[plain_start..]);
        out
    }

    /// `c.req.param(...)` for segment `index` of the raw request path
    /// (`/api/<prefix>/<index 3>/...`): Hono decodes the path with
    /// `decodeURI` (protecting `%25`) and then the param with `decodeURIComponent`.
    pub fn param(path: &str, index: usize) -> String {
        let raw = path.split('/').nth(index).unwrap_or("");
        let p = if raw.contains('%') {
            let protected = if raw.contains("%25") {
                raw.replace("%25", "%2525")
            } else {
                raw.to_string()
            };
            try_decode(&protected, true)
        } else {
            raw.to_string()
        };
        if p.contains('%') {
            try_decode(&p, false)
        } else {
            p
        }
    }

    /// `_decodeURI(value)` for query strings: `+` is a space.
    fn decode_query_value(v: &str) -> String {
        if !v.contains(['%', '+']) {
            return v.to_string();
        }
        let v = v.replace('+', " ");
        if v.contains('%') {
            try_decode(&v, false)
        } else {
            v
        }
    }

    /// `c.req.query(key)` for a key without `%`/`+`; `query` is the raw
    /// query string (everything after the first `?`).
    pub fn query(query: Option<&str>, key: &str) -> Option<String> {
        let q = query?;
        // Fast path: scan for `key` right after `?` or after `&`.
        let url = format!("?{q}");
        let bytes = url.as_bytes();
        let mut at = if url[1..].starts_with(key) {
            Some(0)
        } else {
            url.get(1..)
                .and_then(|s| s.find(&format!("&{key}")))
                .map(|i| i + 1)
        };
        while let Some(i) = at {
            let after = i + key.len() + 1;
            match bytes.get(after) {
                Some(b'=') => {
                    let start = after + 1;
                    let end = url[start..].find('&').map_or(url.len(), |e| start + e);
                    return Some(decode_query_value(&url[start..end]));
                }
                Some(b'&') | None => return Some(String::new()),
                Some(_) => {
                    at = url
                        .get(i + 1..)
                        .and_then(|s| s.find(&format!("&{key}")))
                        .map(|j| i + 1 + j);
                }
            }
        }
        if !url.contains(['%', '+']) {
            return None;
        }
        // Slow path: decode every name, first occurrence wins.
        for part in q.split('&') {
            let (name, value) = match part.find('=') {
                Some(e) => (&part[..e], Some(&part[e + 1..])),
                None => (part, None),
            };
            let name = decode_query_value(name);
            if name.is_empty() {
                continue;
            }
            if name == key {
                return Some(value.map(decode_query_value).unwrap_or_default());
            }
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn params_decode_like_hono() {
            assert_eq!(param("/api/policies/abc", 3), "abc");
            assert_eq!(param("/api/policies/a%20b", 3), "a b");
            assert_eq!(param("/api/policies/a%2Fb", 3), "a/b");
            assert_eq!(param("/api/policies/%25", 3), "%");
            assert_eq!(param("/api/policies/%FF", 3), "%FF");
            assert_eq!(param("/api/policies/%E2%82%AC%FF", 3), "%E2%82%AC%FF");
            assert_eq!(param("/api/policies/%E2%82%AC-%FF", 3), "€-%FF");
            assert_eq!(param("/api/policies/x/payouts/p%31", 5), "p1");
        }

        #[test]
        fn query_like_hono() {
            assert_eq!(query(Some("years=2"), "years").as_deref(), Some("2"));
            assert_eq!(
                query(Some("a=1&years=3&years=4"), "years").as_deref(),
                Some("3")
            );
            assert_eq!(
                query(Some("yearsX=1&years=7"), "years").as_deref(),
                Some("7")
            );
            assert_eq!(query(Some("years"), "years").as_deref(), Some(""));
            assert_eq!(query(Some("years&x=1"), "years").as_deref(), Some(""));
            assert_eq!(query(Some("x=1"), "years"), None);
            assert_eq!(query(None, "years"), None);
            assert_eq!(query(Some("years=1%2B1"), "years").as_deref(), Some("1+1"));
            assert_eq!(query(Some("years=+2"), "years").as_deref(), Some(" 2"));
            assert_eq!(query(Some("%79ears=9"), "years").as_deref(), Some("9"));
            assert_eq!(query(Some("days=%"), "days").as_deref(), Some("%"));
        }
    }
}
