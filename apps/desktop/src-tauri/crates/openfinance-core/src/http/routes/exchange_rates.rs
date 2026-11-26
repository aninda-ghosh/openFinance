//! Port of `apps/server/src/routes/exchange-rates.ts` (Wave 0), mounted at
//! `/api/exchange-rates`.

use axum::body::Bytes;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::json::{body_or_empty_object, field};
use crate::services::{budget, exchange_rate as rate_service};
use crate::state::AppState;

/// `handleError` in exchange-rates.ts: 400 and 503 pass through.
const PASSTHROUGH: &[u16] = &[400, 503];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/refresh", post(refresh))
        .route("/base-currency", get(get_base).post(set_base))
}

/// GET /api/exchange-rates — list all latest stored rates.
async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rates = state
        .db(rate_service::list_rates)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "rates": rates })))
}

/// POST /api/exchange-rates/refresh — fetch live rates from web.
async fn refresh(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let body = body_or_empty_object(&body);
    let currency = field(&body, "currency").cloned();
    let updated = rate_service::refresh_from_web(&state, currency)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    let count = updated.len();
    Ok(Json(json!({ "updated": updated, "count": count })))
}

/// GET /api/exchange-rates/base-currency.
async fn get_base(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let base = state
        .db(rate_service::get_base_currency)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))?;
    Ok(Json(json!({ "base_currency": base })))
}

/// POST /api/exchange-rates/base-currency — update the base currency, scale
/// budget envelopes by the old rate of the new base, then refresh rates.
async fn set_base(State(state): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let body = body_or_empty_object(&body);
    let base = match field(&body, "base_currency").and_then(Value::as_str) {
        Some(b) if rate_service::SUPPORTED.contains(&b) => b.to_string(),
        _ => {
            return Err(ApiError::bad_request(
                "Invalid base currency. Must be one of INR, USD, SGD, GBP, EUR, JPY, NTD",
            ))
        }
    };
    set_base_inner(&state, base)
        .await
        .map_err(|e| e.handled(PASSTHROUGH))
}

async fn set_base_inner(state: &AppState, base: String) -> ApiResult<Json<Value>> {
    let b = base.clone();
    let old_base = state.db(rate_service::get_base_currency).await?;
    // `oldRates[baseCurrency] ?? 1.0`, kept as the raw value Node would bind.
    let conversion_rate = state
        .db(move |conn| {
            let rates = rate_service::get_latest_rates(conn)?;
            Ok(rates
                .into_iter()
                .find(|(k, _)| *k == b)
                .map(|(_, v)| v)
                .filter(|v| !v.is_null())
                .unwrap_or_else(|| json!(1.0)))
        })
        .await?;

    let b = base.clone();
    state
        .db(move |conn| rate_service::update_base_currency(conn, &b))
        .await?;

    if old_base != base {
        let b = base.clone();
        state
            .db(move |conn| budget::scale_budget_envelopes(conn, &conversion_rate, &b))
            .await?;
    }

    let updated = rate_service::refresh_from_web(state, None).await?;
    Ok(Json(json!({
        "success": true,
        "base_currency": base,
        "updated_count": updated.len(),
    })))
}
