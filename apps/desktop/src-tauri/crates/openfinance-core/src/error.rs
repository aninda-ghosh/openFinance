//! `ApiError`: every failure on a request path ends here and renders the same
//! status and JSON body the Node route would. Owned by Wave 0.
//!
//! Node services throw `Object.assign(new Error(msg), { status })` and each route
//! file's `handleError` decides which statuses pass through; everything else is
//! logged and becomes `500 {"error":"Internal server error"}`. The Rust shape:
//!
//! - services return [`ApiError::service`] (status + message), or any
//!   `rusqlite::Error` / other failure via `?` (becomes [`ApiError::Internal`]);
//! - the route calls [`ApiError::handled`] with the statuses its Node
//!   `handleError` passes through, e.g. `.map_err(|e| e.handled(&[404]))`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug)]
pub enum ApiError {
    /// A Node `{ status }` error thrown by a service, not yet mapped by a route.
    /// Rendered as-is (`err.status ?? 500` with `err.message`) if a route
    /// returns it without calling [`ApiError::handled`].
    Service {
        status: Option<u16>,
        message: String,
    },
    /// `c.json({ error: message }, status)`.
    Status { status: StatusCode, message: String },
    /// `c.json({ error: "Validation failed", details }, 400)`.
    Validation { details: Value },
    /// Any other JSON body with a status, e.g. `{ error, message }` or `{ error, rows }`.
    Body { status: StatusCode, body: Value },
    /// Unexpected failure: logged, then `500 {"error":"Internal server error"}`.
    Internal(String),
}

impl ApiError {
    /// A service error carrying a Node-style `status`.
    pub fn service(status: u16, message: impl Into<String>) -> Self {
        Self::Service {
            status: Some(status),
            message: message.into(),
        }
    }

    /// A plain `throw new Error(message)` from a service (no status).
    pub fn plain(message: impl Into<String>) -> Self {
        Self::Service {
            status: None,
            message: message.into(),
        }
    }

    pub fn status(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Status {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::status(StatusCode::BAD_REQUEST, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::status(StatusCode::NOT_FOUND, message)
    }

    pub fn validation(details: Value) -> Self {
        Self::Validation { details }
    }

    pub fn body(status: StatusCode, body: Value) -> Self {
        Self::Body { status, body }
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::Internal(err.to_string())
    }

    /// Node's per-route `handleError(c, err)`: a service error whose status is
    /// in `passthrough` keeps its status and message; any other service error
    /// becomes a logged 500. Already-rendered variants are left alone.
    pub fn handled(self, passthrough: &[u16]) -> Self {
        match self {
            Self::Service {
                status: Some(s),
                message,
            } if passthrough.contains(&s) => match StatusCode::from_u16(s) {
                Ok(status) => Self::Status { status, message },
                Err(_) => Self::Internal(message),
            },
            Self::Service { message, .. } => Self::Internal(message),
            other => other,
        }
    }

    /// The HTTP status this error renders with.
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::Service { status, .. } => status
                .and_then(|s| StatusCode::from_u16(s).ok())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Self::Status { status, .. } | Self::Body { status, .. } => *status,
            Self::Validation { .. } => StatusCode::BAD_REQUEST,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Service { status, message } => write!(f, "{message} (status {status:?})"),
            Self::Status { status, message } => write!(f, "{status}: {message}"),
            Self::Validation { .. } => write!(f, "Validation failed"),
            Self::Body { status, body } => write!(f, "{status}: {body}"),
            Self::Internal(msg) => write!(f, "internal: {msg}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let body = match self {
            Self::Service { message, .. } | Self::Status { message, .. } => {
                json!({ "error": message })
            }
            Self::Validation { details } => {
                json!({ "error": "Validation failed", "details": details })
            }
            Self::Body { body, .. } => body,
            Self::Internal(msg) => {
                tracing::error!("{msg}");
                json!({ "error": "Internal server error" })
            }
        };
        (status, Json(body)).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Internal(format!("database error: {err}"))
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(err: serde_json::Error) -> Self {
        Self::Internal(format!("json error: {err}"))
    }
}

impl From<tokio::task::JoinError> for ApiError {
    fn from(err: tokio::task::JoinError) -> Self {
        Self::Internal(format!("blocking task failed: {err}"))
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handled_maps_like_node() {
        let e = ApiError::service(404, "Account not found").handled(&[404]);
        assert_eq!(e.status_code(), StatusCode::NOT_FOUND);
        let e = ApiError::service(404, "Account not found").handled(&[400, 503]);
        assert_eq!(e.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
        let e = ApiError::plain("boom").handled(&[404]);
        assert!(matches!(e, ApiError::Internal(_)));
        let e = ApiError::bad_request("x").handled(&[]);
        assert_eq!(e.status_code(), StatusCode::BAD_REQUEST);
    }
}
