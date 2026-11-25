//! HTTP surface: the axum equivalent of the Hono app in `apps/server/src/index.ts`.
//! Owned by Wave 0. Later waves only edit their own `routes/<domain>.rs`.
//!
//! Middleware order matches Node: CORS → desktop origin guard → request log →
//! routes. Unknown paths *and* known paths with the wrong method answer like
//! Hono: `404 text/plain "404 Not Found"`.
//!
//! Like Hono, routing uses the `decodeURI`d path (see [`hono_route_path`]),
//! so `/api/policies/%74imeline` reaches the timeline. Handlers that read
//! `OriginalUri` still see the raw path.

pub mod routes;

use std::time::Instant;

use axum::extract::OriginalUri;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::uri::PathAndQuery;
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::state::AppState;

/// Origins the desktop app's own window uses (index.ts `DESKTOP_ORIGINS`).
pub const DESKTOP_ORIGINS: [&str; 4] = [
    "tauri://localhost",      // packaged app on macOS
    "http://tauri.localhost", // packaged app on Windows
    "http://localhost:1420",  // vite dev server
    "http://127.0.0.1:1420",
];

/// Hono `cors()` default `allowMethods`.
const ALLOW_METHODS: &str = "GET,HEAD,PUT,POST,DELETE,PATCH";

/// Builds the full application router.
pub fn router(state: AppState) -> Router {
    let desktop = state.config().desktop;
    let app = Router::new()
        .route("/health", get(health))
        .nest("/api/budget", routes::budget::router())
        .nest("/api/investments", routes::investments::router())
        .nest("/api/policies", routes::policies::router())
        .nest("/api/life-insurance", routes::life_insurance::router())
        .nest("/api/dashboard", routes::dashboard::router())
        .nest("/api/exchange-rates", routes::exchange_rates::router())
        .nest("/api/ai", routes::ai::router())
        .nest("/api/reset", routes::reset::router())
        .nest("/api/backup", routes::backup::router())
        .nest("/api/documents", routes::documents::router())
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        // Node/Hono has no request body limit (backups, document uploads).
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn(log_requests))
        .layer(middleware::from_fn_with_state(desktop, origin_guard))
        .layer(middleware::from_fn_with_state(desktop, cors))
        .with_state(state);
    // An outer router with no routes: its layer runs before `app` routes,
    // which a layer on `app` itself would not.
    Router::new()
        .fallback_service(app)
        .layer(middleware::map_request(route_on_decoded_path))
}

/// Rewrites the request path to the one Hono's router matches, keeping the
/// raw URI in `OriginalUri` for the handlers that decode params themselves.
async fn route_on_decoded_path(mut req: Request) -> Request {
    if req.extensions().get::<OriginalUri>().is_none() {
        let raw = OriginalUri(req.uri().clone());
        req.extensions_mut().insert(raw);
    }
    if let Some(path) = hono_route_path(req.uri().path()) {
        let path_and_query = match req.uri().query() {
            Some(q) => format!("{path}?{q}"),
            None => path,
        };
        if let Ok(pq) = PathAndQuery::try_from(path_and_query) {
            let mut parts = req.uri().clone().into_parts();
            parts.path_and_query = Some(pq);
            if let Ok(uri) = Uri::from_parts(parts) {
                *req.uri_mut() = uri;
            }
        }
    }
    req
}

/// Hono's `getPath`: a path holding a `%` is routed as
/// `tryDecodeURI(path.replace(/%25/g, "%2525"))`. `None` when that is the raw
/// path. `decodeURI` keeps `/` and the other reserved characters encoded, so
/// the segments stay the same. Characters an `http::Uri` path can't hold
/// (only ever produced by the decoding) are encoded again; route literals
/// never contain them, and params are decoded again by the handlers.
pub fn hono_route_path(raw: &str) -> Option<String> {
    if !raw.contains('%') {
        return None;
    }
    let decoded = try_decode_uri(&raw.replace("%25", "%2525"));
    let mut out = String::with_capacity(decoded.len());
    for c in decoded.chars() {
        match c {
            '\0'..=' ' | '\x7f' | '<' | '>' | '`' | '#' | '?' => {
                out.push_str(&format!("%{:02X}", c as u32));
            }
            c => out.push(c),
        }
    }
    (out != raw).then_some(out)
}

/// JS `decodeURI`: `None` on a URIError. Escapes of `;/?:@&=+$,#` stay as
/// written.
fn decode_uri(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let hex = |i: usize| -> Option<u8> {
        let h = b.get(i + 1..i + 3)?;
        if !h.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
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
            if b";/?:@&=+$,#".contains(&first) {
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
        // Rejects overlong forms, surrogates and code points past U+10FFFF,
        // as `decodeURI` does.
        std::str::from_utf8(&seq).ok()?;
        out.extend_from_slice(&seq);
        i += 3 * n;
    }
    String::from_utf8(out).ok()
}

/// Hono's `tryDecodeURI`: on a URIError, each run of `%XX` escapes is decoded
/// on its own and kept as written when it still fails.
fn try_decode_uri(s: &str) -> String {
    if let Some(d) = decode_uri(s) {
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
            out.push_str(&decode_uri(run).unwrap_or_else(|| run.to_string()));
            plain = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[plain..]);
    out
}

/// `app.get("/health", (c) => c.json({ status: "ok" }))`.
async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

/// Hono's default not-found response.
pub async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "404 Not Found",
    )
        .into_response()
}

fn origin_of(req: &Request) -> String {
    req.headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Hono `cors({ origin })` as configured in index.ts: in desktop mode only the
/// desktop origins are echoed back; otherwise `*`.
async fn cors(State(desktop): State<bool>, req: Request, next: Next) -> Response {
    let origin = origin_of(&req);
    let allow_origin = if desktop {
        DESKTOP_ORIGINS
            .contains(&origin.as_str())
            .then(|| origin.clone())
    } else {
        Some("*".to_string())
    };

    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        let h = res.headers_mut();
        if let Some(o) = allow_origin
            .as_deref()
            .and_then(|o| HeaderValue::from_str(o).ok())
        {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        }
        let mut vary: Vec<&str> = Vec::new();
        if desktop {
            vary.push("Origin");
        }
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOW_METHODS),
        );
        let requested = req
            .headers()
            .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !requested.is_empty() {
            // `requestHeaders.split(/\s*,\s*/).join(",")`
            let ws = crate::js::is_js_whitespace;
            let parts: Vec<&str> = requested.split(',').collect();
            let last = parts.len() - 1;
            let joined = parts
                .iter()
                .enumerate()
                .map(|(i, part)| {
                    let part = if i > 0 {
                        part.trim_start_matches(ws)
                    } else {
                        part
                    };
                    if i < last {
                        part.trim_end_matches(ws)
                    } else {
                        part
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            if let Ok(v) = HeaderValue::from_str(&joined) {
                h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, v);
            }
            vary.push("Access-Control-Request-Headers");
        }
        if !vary.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&vary.join(", ")) {
                h.insert(header::VARY, v);
            }
        }
        return res;
    }

    let mut res = next.run(req).await;
    let h = res.headers_mut();
    if let Some(o) = allow_origin
        .as_deref()
        .and_then(|o| HeaderValue::from_str(o).ok())
    {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
    }
    if desktop {
        h.append(header::VARY, HeaderValue::from_static("Origin"));
    }
    res
}

/// Desktop origin guard: CORS only hides responses, this also stops other
/// sites' requests from running. Requests without an Origin pass.
async fn origin_guard(State(desktop): State<bool>, req: Request, next: Next) -> Response {
    if desktop {
        let origin = origin_of(&req);
        if !origin.is_empty() && !DESKTOP_ORIGINS.contains(&origin.as_str()) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "Forbidden origin" })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// Hono `logger()`: `<-- METHOD path` / `--> METHOD path status time`.
async fn log_requests(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    tracing::info!("<-- {method} {path}");
    let start = Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        "--> {method} {path} {} {}ms",
        res.status().as_u16(),
        start.elapsed().as_millis()
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Config;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&conn).expect("bootstrap");
        let config = Config {
            db_path: ":memory:".into(),
            db_key: None,
            desktop: true,
            no_network: true,
            encryption_key: None,
            ollama_url_env: None,
            ollama_model_env: None,
            data_dir: std::env::temp_dir(),
        };
        router(AppState::from_connection(conn, config))
    }

    async fn send(req: axum::http::Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
        let res = app().oneshot(req).await.expect("response");
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.expect("body").to_bytes();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    fn get(path: &str) -> axum::http::request::Builder {
        axum::http::Request::builder().uri(path)
    }

    #[tokio::test]
    async fn health_and_not_found() {
        let (s, h, b) = send(get("/health").body(Body::empty()).expect("req")).await;
        assert_eq!((s, b.as_str()), (StatusCode::OK, r#"{"status":"ok"}"#));
        assert_eq!(h[header::CONTENT_TYPE], "application/json");
        assert_eq!(h[header::VARY], "Origin");

        for (method, path) in [
            ("GET", "/nope"),
            ("POST", "/health"),
            ("GET", "/api/exchange-rates/"),
            ("GET", "/api/budget/nope"),
            ("DELETE", "/api/exchange-rates"),
        ] {
            let req = get(path).method(method).body(Body::empty()).expect("req");
            let (s, h, b) = send(req).await;
            assert_eq!(s, StatusCode::NOT_FOUND, "{method} {path}");
            assert_eq!(b, "404 Not Found");
            assert_eq!(h[header::CONTENT_TYPE], "text/plain; charset=UTF-8");
        }
    }

    #[test]
    fn route_path_like_hono_get_path() {
        let cases = [
            ("/health", None),
            ("/%68ealth", Some("/health")),
            ("/api/policies/%74imeline", Some("/api/policies/timeline")),
            // Reserved characters and `%25` stay encoded.
            ("/api/budget%2Faccounts", None),
            ("/api/%2562udget", None),
            ("/a/%2574", None),
            // Undecodable runs are kept; the rest is still decoded.
            ("/a/%E9/%62", Some("/a/%E9/b")),
            ("/a/%C3%A9x%E9", Some("/a/éx%E9")),
            ("/a/%6", None),
            // Decoded characters a URI path can't hold are encoded again.
            ("/a/%20%3C%60", None),
            ("/a/%41%20", Some("/a/A%20")),
        ];
        for (raw, want) in cases {
            assert_eq!(hono_route_path(raw).as_deref(), want, "{raw}");
        }
    }

    #[tokio::test]
    async fn routes_on_the_decoded_path() {
        let (s, _, b) = send(get("/%68ealth").body(Body::empty()).expect("req")).await;
        assert_eq!((s, b.as_str()), (StatusCode::OK, r#"{"status":"ok"}"#));
        let (s, _, _) = send(
            get("/api/exchange-rates/%62ase-currency?x=%61")
                .body(Body::empty())
                .expect("req"),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _, _) = send(get("/api/%2562udget").body(Body::empty()).expect("req")).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn origin_guard_and_cors() {
        let req = get("/health")
            .header("Origin", "https://evil.com")
            .body(Body::empty())
            .expect("req");
        let (s, h, b) = send(req).await;
        assert_eq!(
            (s, b.as_str()),
            (StatusCode::FORBIDDEN, r#"{"error":"Forbidden origin"}"#)
        );
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());

        let req = get("/health")
            .header("Origin", "tauri://localhost")
            .body(Body::empty())
            .expect("req");
        let (s, h, _) = send(req).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");

        let req = get("/api/exchange-rates")
            .method("OPTIONS")
            .header("Origin", "http://localhost:1420")
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "content-type , x-foo")
            .body(Body::empty())
            .expect("req");
        let (s, h, b) = send(req).await;
        assert_eq!(s, StatusCode::NO_CONTENT);
        assert!(b.is_empty());
        assert_eq!(
            h[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "http://localhost:1420"
        );
        assert_eq!(h[header::ACCESS_CONTROL_ALLOW_METHODS], ALLOW_METHODS);
        assert_eq!(
            h[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "content-type,x-foo"
        );
        assert_eq!(h[header::VARY], "Origin, Access-Control-Request-Headers");
    }
}
