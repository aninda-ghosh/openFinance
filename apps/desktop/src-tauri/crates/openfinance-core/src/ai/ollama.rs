//! Port of `apps/server/src/ai/ollama.client.ts`. The base URL and model are
//! read from the settings cache on every call, so Settings changes apply
//! without a restart. Only the configured Ollama URL is ever contacted.

use std::time::Duration;

use serde_json::{json, Value};

use super::config::{CONTEXT_WINDOW, TEMPERATURE_ANALYSIS, TEMPERATURE_CONVERSATIONAL};
use super::js::{opt_prop, stringify, truthy, JsError};
use crate::services::settings::{get_ollama_model, get_ollama_url};
use crate::state::AppState;

/// `OllamaConnectionError`.
pub const CONNECTION_ERROR: &str = "OllamaConnectionError";
/// `OllamaModelNotFoundError`.
pub const MODEL_NOT_FOUND: &str = "OllamaModelNotFoundError";

fn connection_error(state: &AppState) -> JsError {
    JsError::new(
        CONNECTION_ERROR,
        format!("Cannot connect to Ollama at {}", get_ollama_url(state)),
    )
}

/// `throwIfModelMissing(status, body)`: always an error. The model named is
/// the configured one, even when the request used an override (as in Node).
fn model_missing_or_status(state: &AppState, status: u16, body: &str) -> JsError {
    if status == 404 {
        let m = get_ollama_model(state);
        return JsError::new(
            MODEL_NOT_FOUND,
            format!("Model \"{m}\" is not installed. Run: ollama pull {m}"),
        );
    }
    JsError::error(format!("Ollama error: {status} {body}"))
}

/// `TextDecoder().decode(bytes)`: UTF-8 with replacement, leading BOM dropped.
fn decode_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
}

/// The `POST /api/chat` body, keys in Node's order (`tools` only when given).
fn chat_body(
    model: &str,
    messages: &[Value],
    stream: bool,
    temperature: f64,
    tools: Option<&Value>,
) -> String {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "options": { "temperature": temperature, "num_ctx": CONTEXT_WINDOW },
    });
    if let (Some(tools), Some(obj)) = (tools, body.as_object_mut()) {
        obj.insert("tools".into(), tools.clone());
    }
    stringify(&body)
}

async fn post_chat(state: &AppState, body: String) -> Result<reqwest::Response, JsError> {
    let url = format!("{}/api/chat", get_ollama_url(state));
    state
        .http()
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| connection_error(state))
}

/// `response.json()`: the body parsed, or the SyntaxError JSON.parse throws.
async fn read_json(res: reqwest::Response) -> Result<Value, JsError> {
    let bytes = res
        .bytes()
        .await
        .map_err(|_| JsError::type_error("terminated"))?;
    let text = decode_text(&bytes);
    serde_json::from_str(&text).map_err(|_| {
        if text.trim().is_empty() {
            JsError::new("SyntaxError", "Unexpected end of JSON input")
        } else {
            JsError::new("SyntaxError", format!("{text:?} is not valid JSON"))
        }
    })
}

/// `chat(messages, options)`: a non-streaming answer's content (unused by
/// the routes, as in Node).
pub async fn chat(
    state: &AppState,
    messages: &[Value],
    temperature: Option<f64>,
    tools: Option<&Value>,
) -> Result<Value, JsError> {
    let model = get_ollama_model(state);
    let body = chat_body(
        &model,
        messages,
        false,
        temperature.unwrap_or(TEMPERATURE_CONVERSATIONAL),
        tools,
    );
    let res = post_chat(state, body).await?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return Err(model_missing_or_status(state, status, &text));
    }
    let data = read_json(res).await?;
    let message = super::js::get_prop(Some(&data), "message")?;
    let content = super::js::get_prop(message, "content")?;
    Ok(super::js::nullish(content)
        .cloned()
        .unwrap_or(Value::String(String::new())))
}

/// `chatWithTools(messages, options, modelOverride)`: the assistant message
/// (`data.message`; `None` when absent).
pub async fn chat_with_tools(
    state: &AppState,
    messages: &[Value],
    temperature: Option<f64>,
    tools: Option<&Value>,
    model_override: Option<&str>,
) -> Result<Option<Value>, JsError> {
    let model = model_override
        .map(str::to_string)
        .unwrap_or_else(|| get_ollama_model(state));
    let body = chat_body(
        &model,
        messages,
        false,
        temperature.unwrap_or(TEMPERATURE_ANALYSIS),
        tools,
    );
    let res = post_chat(state, body).await?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = match res.bytes().await {
            Ok(b) => decode_text(&b),
            Err(_) => return Err(JsError::type_error("terminated")),
        };
        return Err(model_missing_or_status(state, status, &text));
    }
    let data = read_json(res).await?;
    Ok(super::js::get_prop(Some(&data), "message")?.cloned())
}

/// Incremental `TextDecoder.decode(chunk, { stream: true })`.
#[derive(Default)]
struct StreamDecoder {
    pending: Vec<u8>,
    started: bool,
}

impl StreamDecoder {
    fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            rest = &rest[valid + n..];
                        }
                        None => {
                            // An incomplete sequence at the end: wait for more.
                            self.pending = rest[valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        if !self.started && !out.is_empty() {
            self.started = true;
            if let Some(stripped) = out.strip_prefix('\u{feff}') {
                return stripped.to_string();
            }
        }
        out
    }
}

/// What one NDJSON line asks the stream loop to do.
enum Line {
    Skip,
    Token(Value),
    Done,
    TokenThenDone(Value),
}

fn parse_line(line: &str) -> Line {
    if crate::js::js_trim(line).is_empty() {
        return Line::Skip;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(line) else {
        return Line::Skip; // malformed lines are skipped
    };
    if parsed.is_null() {
        // `null.message` throws inside the try: skipped too.
        return Line::Skip;
    }
    let content = opt_prop(opt_prop(Some(&parsed), "message"), "content");
    let done = truthy(opt_prop(Some(&parsed), "done"));
    match (truthy(content), done) {
        (true, true) => Line::TokenThenDone(content.cloned().unwrap_or(Value::Null)),
        (true, false) => Line::Token(content.cloned().unwrap_or(Value::Null)),
        (false, true) => Line::Done,
        (false, false) => Line::Skip,
    }
}

/// `stream(messages, options, modelOverride)`: calls `on_token` for every
/// truthy `message.content` until a line says `done`. Like Node, each network
/// chunk is split on `\n` on its own: a line split across chunks is lost.
pub async fn stream(
    state: &AppState,
    messages: &[Value],
    temperature: Option<f64>,
    model_override: Option<&str>,
    on_token: &mut (dyn FnMut(Value) + Send),
) -> Result<(), JsError> {
    let model = model_override
        .map(str::to_string)
        .unwrap_or_else(|| get_ollama_model(state));
    let body = chat_body(
        &model,
        messages,
        true,
        temperature.unwrap_or(TEMPERATURE_CONVERSATIONAL),
        None,
    );
    let res = post_chat(state, body).await?;
    let status = res.status();
    // `!response.ok || !response.body` (a 204/304 has no body).
    if !status.is_success() || status.as_u16() == 204 {
        return Err(model_missing_or_status(state, status.as_u16(), ""));
    }
    let mut decoder = StreamDecoder::default();
    let mut res = res;
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|_| JsError::type_error("terminated"))?
    {
        let text = decoder.decode(&chunk);
        for line in text.split('\n') {
            match parse_line(line) {
                Line::Skip => {}
                Line::Token(t) => on_token(t),
                Line::Done => return Ok(()),
                Line::TokenThenDone(t) => {
                    on_token(t);
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// `GET /api/tags` with a 3 s abort covering the whole exchange.
async fn tags(state: &AppState, read_body: bool) -> Option<(bool, Option<Value>)> {
    let url = format!("{}/api/tags", get_ollama_url(state));
    let fut = async {
        let res = state.http().get(url).send().await.ok()?;
        let ok = res.status().is_success();
        if !read_body || !ok {
            return Some((ok, None));
        }
        let bytes = res.bytes().await.ok()?;
        let data = serde_json::from_str::<Value>(&decode_text(&bytes)).ok()?;
        Some((ok, Some(data)))
    };
    tokio::time::timeout(Duration::from_millis(3000), fut)
        .await
        .ok()
        .flatten()
}

/// `listModels()`: `data.models.map(m => m.name)`; `[]` on any failure.
/// Entries are kept as JSON values (`undefined` names become `null`).
pub async fn list_models(state: &AppState) -> Vec<Value> {
    let Some((true, Some(data))) = tags(state, true).await else {
        return Vec::new();
    };
    if data.is_null() {
        return Vec::new(); // `null.models` throws → []
    }
    let models = match opt_prop(Some(&data), "models") {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        // Not an array: `.map` is not a function → [].
        Some(_) => return Vec::new(),
    };
    let mut names = Vec::with_capacity(models.len());
    for m in &models {
        if m.is_null() {
            return Vec::new(); // `null.name` throws → []
        }
        names.push(opt_prop(Some(m), "name").cloned().unwrap_or(Value::Null));
    }
    names
}

/// `ping()`: whether `/api/tags` answers 2xx within 3 s.
pub async fn ping(state: &AppState) -> bool {
    matches!(tags(state, false).await, Some((true, _)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_keeps_partial_sequences() {
        let mut d = StreamDecoder::default();
        let bytes = "\u{feff}a€b".as_bytes();
        assert_eq!(d.decode(&bytes[..5]), "a");
        assert_eq!(d.decode(&bytes[5..]), "€b");
        let mut d = StreamDecoder::default();
        assert_eq!(d.decode(b"x\xffy"), "x\u{fffd}y");
    }

    #[test]
    fn lines() {
        assert!(matches!(parse_line("  "), Line::Skip));
        assert!(matches!(parse_line("{bad"), Line::Skip));
        assert!(matches!(parse_line("null"), Line::Skip));
        assert!(matches!(
            parse_line(r#"{"message":{"content":""}}"#),
            Line::Skip
        ));
        assert!(matches!(
            parse_line(r#"{"message":{"content":"hi"}}"#),
            Line::Token(_)
        ));
        assert!(matches!(parse_line(r#"{"done":true}"#), Line::Done));
        assert!(matches!(
            parse_line(r#"{"message":{"content":"x"},"done":1}"#),
            Line::TokenThenDone(_)
        ));
    }

    #[test]
    fn body_shape() {
        let b = chat_body(
            "m",
            &[json!({"role": "user", "content": "hi"})],
            true,
            0.4,
            None,
        );
        assert_eq!(
            b,
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true,"options":{"temperature":0.4,"num_ctx":16384}}"#
        );
    }
}
