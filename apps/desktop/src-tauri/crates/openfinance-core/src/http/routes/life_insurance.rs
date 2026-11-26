//! Port of `apps/server/src/routes/life-insurance.ts`, mounted at `/api/life-insurance`.
//! Owner: Wave 1 (policies).

use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::policies::hono;
use crate::error::ApiResult;
use crate::json::{parse_body, string_to_number};
use crate::services::life_insurance as service;
use crate::services::policy::schemas;
use crate::state::AppState;

/// `handleError` in life-insurance.ts: only 404 passes through.
const PASSTHROUGH: &[u16] = &[404];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        // "/alerts" is declared before "/:id" in Node; PATCH/DELETE still reach "/:id".
        .route("/alerts", get(alerts).patch(update).delete(delete))
        .route("/{id}", get(get_one).patch(update).delete(delete))
}

/// GET /api/life-insurance
async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let policies = state
        .db(service::list_life_insurance)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "policies": policies })))
}

/// GET /api/life-insurance/alerts?days=60
async fn alerts(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let days = hono::query(uri.query(), "days").map_or(60.0, |s| string_to_number(&s));
    let policies = state
        .db(move |conn| service::get_renewal_alerts(conn, days))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "policies": policies })))
}

/// GET /api/life-insurance/:id
async fn get_one(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = hono::param(uri.path(), 3);
    let policy = state
        .db(move |conn| service::get_life_insurance(conn, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(policy)?))
}

/// POST /api/life-insurance
async fn create(
    State(state): State<AppState>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let data = schemas::parse(schemas::CREATE_LIFE_INSURANCE, parse_body(&body).as_ref())?;
    let policy = state
        .db(move |conn| service::create_life_insurance(conn, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok((StatusCode::CREATED, Json(serde_json::to_value(policy)?)))
}

/// PATCH /api/life-insurance/:id
async fn update(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let data = schemas::parse(schemas::UPDATE_LIFE_INSURANCE, parse_body(&body).as_ref())?;
    let id = hono::param(uri.path(), 3);
    let policy = state
        .db(move |conn| service::update_life_insurance(conn, &id, &data))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(serde_json::to_value(policy)?))
}

/// DELETE /api/life-insurance/:id
async fn delete(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
) -> ApiResult<Json<Value>> {
    let id = hono::param(uri.path(), 3);
    let uploads = state.config().data_dir.join("uploads").join("documents");
    state
        .db(move |conn| service::delete_life_insurance(conn, &uploads, &id))
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "success": true })))
}
