//! Hono `streamSSE` as `routes/ai.ts` uses it: one `writeSSE` per harness
//! event (`token`, `tool`, `done` with `[DONE]`, `error`), the stream ending
//! after `done` / `error`. A stream with no generation attached (the request
//! that starts one, see `ai::harness`) stays open with no events until the
//! client goes away, as in Node.

use axum::body::{Body, Bytes};
use axum::http::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{self, StreamExt};
use serde_json::Value;

use crate::ai::harness::{GenerationEvent, Listener};
use crate::ai::js::stringify;

/// `writeSSE({ data, event })`: `event:` line, one `data:` line per line of
/// `data` (split on `\r\n`, `\r` or `\n`), then a blank line.
pub fn frame(event: &str, data: &str) -> String {
    let normalized = data.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = normalized
        .split('\n')
        .map(|l| format!("data: {l}"))
        .collect();
    format!("event: {event}\n{}\n\n", lines.join("\n"))
}

/// The bytes for one event, and whether the stream ends after it. A token
/// that is not a string makes Node's listener throw on `data.split`, which
/// ends the stream without writing.
fn render(event: GenerationEvent) -> (Option<String>, bool) {
    match event {
        GenerationEvent::Token(Value::String(t)) => (Some(frame("token", &t)), false),
        GenerationEvent::Token(_) => (None, true),
        GenerationEvent::Tool(data) => (Some(frame("tool", &stringify(&data))), false),
        GenerationEvent::Done => (Some(frame("done", "[DONE]")), true),
        GenerationEvent::Error(msg) => (Some(frame("error", &msg)), true),
    }
}

/// The SSE response for `listener`.
pub fn response(mut listener: Listener) -> Response {
    let body = match listener.events.take() {
        None => {
            // Never resolves; dropping the body (client gone) drops the listener.
            let pending = stream::pending::<Result<Bytes, std::io::Error>>().map(move |x| {
                let _keep = &listener;
                x
            });
            Body::from_stream(pending)
        }
        Some(rx) => {
            let s = stream::unfold(
                (rx, listener, false),
                |(mut rx, listener, finished)| async move {
                    if finished {
                        return None;
                    }
                    loop {
                        let event = rx.recv().await?;
                        let (bytes, end) = render(event);
                        match bytes {
                            Some(b) => {
                                return Some((
                                    Ok::<Bytes, std::io::Error>(Bytes::from(b)),
                                    (rx, listener, end),
                                ))
                            }
                            None if end => return None,
                            None => continue,
                        }
                    }
                },
            );
            Body::from_stream(s)
        }
    };
    let mut res = (StatusCode::OK, body).into_response();
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_matches_hono() {
        assert_eq!(frame("token", "Hel"), "event: token\ndata: Hel\n\n");
        assert_eq!(
            frame("token", "a\r\nb\rc\n"),
            "event: token\ndata: a\ndata: b\ndata: c\ndata: \n\n"
        );
        assert_eq!(frame("done", "[DONE]"), "event: done\ndata: [DONE]\n\n");
    }
}
