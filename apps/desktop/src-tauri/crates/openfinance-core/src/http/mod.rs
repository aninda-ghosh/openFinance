//! HTTP surface: the axum equivalent of the Hono app in `apps/server/src/index.ts`.
//! Owned by Wave 0. Later waves only edit their own `routes/<domain>.rs`.
//!
//! Middleware order matches Node: CORS → desktop origin guard → request log →
//! routes. Unknown paths *and* known paths with the wrong method answer like
//! Hono: `404 text/plain "404 Not Found"`.

pub mod routes;

use std::time::Instant;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::header::{self, HeaderValue};
use axum::http::{Method, StatusCode};
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
    Router::new()
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
        .with_state(state)
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
