//! Port of `apps/server/src/services/settings.service.ts` (Wave 0).
//!
//! Resolution order for the AI assistant endpoint/model:
//!   1. value saved from the in-app Settings page (app_settings row)
//!   2. OLLAMA_URL / OLLAMA_MODEL environment variables
//!   3. built-in defaults (localhost)

use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::ApiResult;
use crate::js::{js_trim, now_iso};
use crate::state::AppState;

const FALLBACK_OLLAMA_URL: &str = "http://localhost:11434";
const FALLBACK_OLLAMA_MODEL: &str = "gemma4:e2b";

/// The module-level `cachedOllamaUrl` / `cachedOllamaModel`.
#[derive(Debug, Clone, Default)]
pub struct AiSettingsCache {
    pub ollama_url: Option<String>,
    pub ollama_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AiSettings {
    pub ollama_url: String,
    pub ollama_model: String,
    /// True when the value comes from the saved setting (vs env/default).
    pub customized: bool,
}

/// `envOrNull(name)`: trimmed, `None` when unset or blank.
fn env_or_null(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn cache(state: &AppState) -> AiSettingsCache {
    match state.ai_settings_cache().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

pub fn get_ollama_url(state: &AppState) -> String {
    cache(state)
        .ollama_url
        .or_else(|| env_or_null(state.config().ollama_url_env.as_deref()))
        .unwrap_or_else(|| FALLBACK_OLLAMA_URL.to_string())
}

pub fn get_ollama_model(state: &AppState) -> String {
    cache(state)
        .ollama_model
        .or_else(|| env_or_null(state.config().ollama_model_env.as_deref()))
        .unwrap_or_else(|| FALLBACK_OLLAMA_MODEL.to_string())
}

/// `row?.x?.trim() || null`.
fn trimmed_or_null(v: Option<String>) -> Option<String> {
    v.map(|s| js_trim(&s).to_string()).filter(|s| !s.is_empty())
}

/// Reads the saved settings row (the DB half of `loadAiSettings`).
pub fn read_ai_settings_row(conn: &Connection) -> ApiResult<AiSettingsCache> {
    let row = conn
        .query_row(
            "SELECT ollama_url, ollama_model FROM app_settings WHERE id = 'system'",
            [],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let (url, model) = row.unwrap_or((None, None));
    Ok(AiSettingsCache {
        ollama_url: trimmed_or_null(url),
        ollama_model: trimmed_or_null(model),
    })
}

fn store_cache(state: &AppState, value: AiSettingsCache) {
    match state.ai_settings_cache().write() {
        Ok(mut guard) => *guard = value,
        Err(poisoned) => *poisoned.into_inner() = value,
    }
}

/// `loadAiSettings()`.
pub async fn load_ai_settings(state: &AppState) -> ApiResult<()> {
    let value = state.db(read_ai_settings_row).await?;
    store_cache(state, value);
    Ok(())
}

/// `getAiSettings()`.
pub fn get_ai_settings(state: &AppState) -> AiSettings {
    let c = cache(state);
    AiSettings {
        ollama_url: get_ollama_url(state),
        ollama_model: get_ollama_model(state),
        customized: c.ollama_url.is_some() || c.ollama_model.is_some(),
    }
}

/// Input of `updateAiSettings`: the outer `Option` is "key present", the inner
/// one is the JSON value (`null` → `None`).
#[derive(Debug, Default, Clone)]
pub struct AiSettingsInput {
    pub ollama_url: Option<Option<String>>,
    pub ollama_model: Option<Option<String>>,
}

/// `updateAiSettings(input)`.
pub async fn update_ai_settings(state: &AppState, input: AiSettingsInput) -> ApiResult<AiSettings> {
    state
        .db(move |conn| {
            let mut cols: Vec<&str> = vec!["updated_at"];
            let mut vals: Vec<Option<String>> = vec![Some(now_iso())];
            if let Some(url) = input.ollama_url {
                // Empty string resets to env/default; strip a trailing slash otherwise.
                let v = url
                    .as_deref()
                    .map(js_trim)
                    .filter(|t| !t.is_empty())
                    .map(|t| t.trim_end_matches('/').to_string());
                cols.push("ollama_url");
                vals.push(v);
            }
            if let Some(model) = input.ollama_model {
                cols.push("ollama_model");
                vals.push(trimmed_or_null(model));
            }
            let placeholders = vec!["?"; cols.len()].join(", ");
            let set = cols
                .iter()
                .map(|c| format!("{c} = excluded.{c}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "INSERT INTO app_settings (id, {}) VALUES ('system', {placeholders}) ON CONFLICT (id) DO UPDATE SET {set}",
                cols.join(", ")
            );
            conn.execute(&sql, params_from_iter(vals))?;
            Ok(())
        })
        .await?;
    load_ai_settings(state).await?;
    Ok(get_ai_settings(state))
}
