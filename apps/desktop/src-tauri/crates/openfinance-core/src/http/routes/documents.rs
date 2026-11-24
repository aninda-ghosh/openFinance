//! Port of `apps/server/src/routes/documents.ts`, mounted at `/api/documents`.
//! Owner: Wave 1 (data).
//!
//! `upload`, `download` and `remove` are public so the investments routes
//! (`/api/investments/:id/documents`, `/api/investments/documents/:docId`),
//! which run the same code in Node, can reuse them.

pub mod form;
pub mod hono;

use axum::body::{Body, Bytes};
use axum::extract::{RawPathParams, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::services::document::{self, DocumentFile, DocumentFilters, FormText, NewDocument};
use crate::state::AppState;
use form::FormValue;

/// `handleError` in documents.ts (and investments.ts): only 404 passes through.
const PASSTHROUGH: &[u16] = &[404];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{docId}", get(get_one).delete(delete_one))
}

/// `c.req.query(name) || null`.
fn query_or_null(uri: &Uri, name: &str) -> Option<String> {
    hono::query_param(uri.query(), name).filter(|v| !v.is_empty())
}

/// The first raw path parameter, decoded like `c.req.param(...)`.
fn param(params: &RawPathParams) -> String {
    params
        .iter()
        .next()
        .map(|(_, v)| hono::path_param(v))
        .unwrap_or_default()
}

/// GET /api/documents?investment_id=&account_id=&life_insurance_id=
async fn list(State(state): State<AppState>, uri: Uri) -> ApiResult<Json<Value>> {
    let filters = DocumentFilters {
        investment_id: query_or_null(&uri, "investment_id"),
        account_id: query_or_null(&uri, "account_id"),
        life_insurance_id: query_or_null(&uri, "life_insurance_id"),
    };
    let docs = state
        .db(move |conn| document::list_all_documents(conn, &filters))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "documents": docs })))
}

/// Which parent ids an upload gets.
#[derive(Debug, Clone)]
pub enum UploadParent {
    /// `/api/documents`: `investment_id`, `account_id`, `life_insurance_id` from the form.
    FromForm,
    /// `/api/investments/:id/documents`: `{ investmentId: id }`.
    Investment(String),
}

/// POST /api/documents (multipart): `file` (required), `name`, `notes` and the parent ids.
async fn create(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    upload(&state, &headers, &body, UploadParent::FromForm).await
}

/// The upload handler shared with the investments routes.
pub async fn upload(state: &AppState, headers: &HeaderMap, body: &[u8], parent: UploadParent) -> Response {
    match upload_inner(state, headers, body, parent).await {
        Ok(resp) => resp,
        Err(e) => e.handled(PASSTHROUGH).into_response(),
    }
}

async fn upload_inner(
    state: &AppState,
    headers: &HeaderMap,
    body: &[u8],
    parent: UploadParent,
) -> ApiResult<Response> {
    let form = form::parse_body(headers, body).map_err(|e| ApiError::internal(e.0))?;
    let text = |k: &str| form.get(k).map(FormValue::as_form_text);
    let Some(FormValue::File(file)) = form.get("file") else {
        return Err(ApiError::bad_request("File upload is required"));
    };
    let (investment_id, account_id, life_insurance_id) = match parent {
        UploadParent::FromForm => (
            document::or_null(text("investment_id")),
            document::or_null(text("account_id")),
            document::or_null(text("life_insurance_id")),
        ),
        UploadParent::Investment(id) => (Some(FormText::Text(id)), None, None),
    };
    // `name || file.name`
    let name = document::or_null(text("name")).unwrap_or_else(|| FormText::Text(file.name.clone()));
    let new_doc = NewDocument {
        investment_id,
        account_id,
        life_insurance_id,
        name: Some(name),
        size: file.data.len() as f64,
        data: file.data.clone(),
        original_name: file.name.clone(),
        mime_type: file.mime_type.clone(),
        notes: text("notes"),
    };
    let uploads = document::uploads_dir_of(state);
    let s = state.clone();
    let row = state
        .db(move |conn| document::create_document(conn, &uploads, s.file_crypto(), new_doc))
        .await?;
    Ok((StatusCode::CREATED, Json(row)).into_response())
}

/// GET /api/documents/:docId — the decrypted file, served inline.
async fn get_one(State(state): State<AppState>, params: RawPathParams) -> Response {
    download(&state, param(&params)).await
}

/// The download handler shared with the investments routes.
pub async fn download(state: &AppState, doc_id: String) -> Response {
    let uploads = document::uploads_dir_of(state);
    let s = state.clone();
    let found = state
        .db(move |conn| document::read_document(conn, &uploads, s.file_crypto(), &doc_id))
        .await;
    let result = found.and_then(|f| match f {
        DocumentFile::NotFound => Err(ApiError::not_found("Document not found")),
        DocumentFile::PhysicalMissing => Err(ApiError::not_found("Physical file not found")),
        DocumentFile::Found {
            data,
            name,
            mime_type,
        } => file_response(data, &name, &mime_type),
    });
    match result {
        Ok(resp) => resp,
        Err(e) => e.handled(PASSTHROUGH).into_response(),
    }
}

/// `c.body(bytes, 200, { "Content-Type": mime, "Content-Disposition": ... })`.
fn file_response(data: Vec<u8>, name: &str, mime_type: &str) -> ApiResult<Response> {
    let disposition = format!("inline; filename=\"{}\"", hono::encode_uri_component(name));
    let invalid = || ApiError::internal("TypeError: Headers.set: invalid header value");
    let ct = hono::response_header_bytes(mime_type).ok_or_else(invalid)?;
    let cd = hono::response_header_bytes(&disposition).ok_or_else(invalid)?;
    let ct = HeaderValue::from_bytes(&ct).map_err(|_| invalid())?;
    let cd = HeaderValue::from_bytes(&cd).map_err(|_| invalid())?;
    let mut resp = Response::new(Body::from(data));
    resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    resp.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
    Ok(resp)
}

/// DELETE /api/documents/:docId
async fn delete_one(State(state): State<AppState>, params: RawPathParams) -> ApiResult<Json<Value>> {
    remove(&state, param(&params)).await
}

/// The delete handler shared with the investments routes.
pub async fn remove(state: &AppState, doc_id: String) -> ApiResult<Json<Value>> {
    let uploads = document::uploads_dir_of(state);
    state
        .db(move |conn| document::delete_document(conn, &uploads, &doc_id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}
