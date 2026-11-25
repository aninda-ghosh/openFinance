//! Backup and document compatibility, through the real HTTP routes:
//!
//! - Node → Rust: `tests/compat/fixtures/backup/node-export.{fwb1,zip}` were
//!   exported by the Node server's route (the last Node release, `1502e08`).
//!   Rust imports each, exports again, and its decoded export must equal
//!   Node's decoded export (`node-export.content.json`): every table row and
//!   every document byte.
//! - Rust → Rust: Rust's own exports (encrypted and plain) import again in a
//!   fresh Rust database, and the decoded re-export equals the original.
//! - Documents: an upload through the Rust route is stored with Node's name
//!   shape and OFE1 encryption, so older app versions can read it.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use openfinance_core::http::routes::backup::{parse_json, Archive};
use openfinance_core::{crypto, db, AppState, Config};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Throwaway passcode (ASCII: the x-backup-password header is Latin-1).
const PASS: &str = "backup'pass 1";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture(name: &str) -> Vec<u8> {
    let p = crate_dir().join("tests/compat/fixtures/backup").join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// A fresh Rust server state in `dir` (desktop mode, network off).
fn state(dir: &Path, desktop: bool) -> AppState {
    let db_path = dir.join("openfinance.db");
    let config = Config {
        db_path: db_path.clone(),
        db_key: Some(PASS.to_string()),
        desktop,
        no_network: true,
        encryption_key: None,
        ollama_url_env: None,
        ollama_model_env: None,
        data_dir: dir.to_path_buf(),
    };
    let conn = db::open(&db_path, Some(PASS)).expect("open db");
    db::bootstrap::bootstrap_schema(&conn).expect("bootstrap");
    AppState::from_connection(conn, config)
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Vec<u8>) {
    let app = openfinance_core::http::router(state.clone());
    let resp = app.oneshot(req).await.expect("response");
    let status = resp.status();
    let body = resp
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, body)
}

async fn import(state: &AppState, body: Vec<u8>, password: Option<&str>) -> (StatusCode, Value) {
    let mut req = Request::post("/api/backup/import");
    if let Some(p) = password {
        req = req.header("x-backup-password", p);
    }
    let (status, body) = call(state, req.body(Body::from(body)).expect("req")).await;
    (status, serde_json::from_slice(&body).expect("json body"))
}

async fn export(state: &AppState) -> Vec<u8> {
    let (status, body) = call(
        state,
        Request::get("/api/backup/export")
            .body(Body::empty())
            .expect("req"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body
}

/// The decoded content of an export, in the shape of `node-export.content.json`.
fn decode(buf: &[u8]) -> (bool, Vec<Value>) {
    let key = crypto::derive_backup_key(PASS, "desktop");
    let (encrypted, zip) = match crypto::decrypt_backup(buf, &key).expect("decrypt") {
        Some(plain) => (true, plain),
        None => (false, buf.to_vec()),
    };
    let mut archive = Archive::open(zip).expect("zip");
    let mut out = Vec::new();
    for entry in archive.entries().to_vec() {
        let data = archive.data(&entry).expect("entry data");
        if entry.name == "backup-data.json" {
            let text = String::from_utf8(data).expect("utf8");
            let parsed = parse_json(&text).expect("json");
            // Rust writes exactly what JSON.stringify(parsed, null, 2) writes.
            let restringified = openfinance_core::http::routes::backup::stringify_pretty(&parsed)
                .expect("stringify");
            out.push(json!({
                "name": entry.name,
                "data": parsed["data"],
                "version": parsed["version"],
                "stringified": restringified == text.as_bytes(),
            }));
        } else {
            use base64::Engine as _;
            out.push(json!({
                "name": entry.name,
                "base64": base64::engine::general_purpose::STANDARD.encode(data),
            }));
        }
    }
    (encrypted, out)
}

/// Canonical text for comparing JSON regardless of integer/float storage.
fn canon(v: &Value) -> String {
    String::from_utf8(
        openfinance_core::http::routes::backup::stringify_pretty(v).expect("stringify"),
    )
    .expect("utf8")
}

fn node_content() -> Vec<Value> {
    let text = String::from_utf8(fixture("node-export.content.json")).expect("utf8");
    match parse_json(&text).expect("content json") {
        Value::Array(a) => a,
        other => panic!("unexpected {other}"),
    }
}

#[tokio::test]
async fn node_encrypted_backup_imports_in_rust() {
    let dir = tempfile::tempdir().expect("tempdir");
    let s = state(dir.path(), true);
    let (status, body) = import(&s, fixture("node-export.fwb1"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "DECRYPTION_REQUIRED");
    let (status, _) = import(&s, fixture("node-export.fwb1"), Some("wrong")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = import(&s, fixture("node-export.fwb1"), Some(PASS)).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "success": true })));
    let (encrypted, content) = decode(&export(&s).await);
    assert!(encrypted);
    assert_eq!(
        canon(&Value::Array(content)),
        canon(&Value::Array(node_content()))
    );
    // The restored document is OFE1 on disk and served decrypted.
    let on_disk =
        std::fs::read(dir.path().join("uploads/documents/doc_compat000001.pdf")).expect("doc");
    assert!(crypto::is_encrypted_file(&on_disk));
    let (status, bytes) = call(
        &s,
        Request::get("/api/documents/doc-compat")
            .body(Body::empty())
            .expect("req"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, "%PDF-1.4 compat ✓ bytes\n".as_bytes());
}

#[tokio::test]
async fn node_plain_backup_imports_in_rust() {
    let dir = tempfile::tempdir().expect("tempdir");
    let s = state(dir.path(), true);
    let (status, _) = import(&s, fixture("node-export.zip"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, content) = decode(&export(&s).await);
    assert_eq!(
        canon(&Value::Array(content)),
        canon(&Value::Array(node_content()))
    );
}

/// A Rust database with the Node fixture's content plus a document uploaded
/// through the Rust route.
async fn rust_with_upload(dir: &Path, desktop: bool) -> AppState {
    let s = state(dir, desktop);
    let (status, _) = import(&s, fixture("node-export.zip"), None).await;
    assert_eq!(status, StatusCode::OK);
    let boundary = "----compatBoundary0123456789abcdef";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload ✓.txt\"\r\nContent-Type: text/plain\r\n\r\nuploaded by rust\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"account_id\"\r\n\r\nchase-checking\r\n--{boundary}--\r\n"
    );
    let req = Request::post("/api/documents")
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .expect("req");
    let (status, row) = call(&s, req).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&row)
    );
    s
}

/// Imports `backup` into a fresh Rust state, exports again and returns
/// `(status, body, decoded re-export)`.
async fn rust_reimport(backup: &[u8], password: Option<&str>) -> (StatusCode, Value, Vec<Value>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let s = state(dir.path(), true);
    let (status, body) = import(&s, backup.to_vec(), password).await;
    let content = if status == StatusCode::OK {
        decode(&export(&s).await).1
    } else {
        Vec::new()
    };
    (status, body, content)
}

#[tokio::test]
async fn rust_backups_reimport_in_rust() {
    // Encrypted (desktop) export, imported with the passcode as password.
    let dir = tempfile::tempdir().expect("tempdir");
    let s = rust_with_upload(dir.path(), true).await;
    let exported = export(&s).await;
    let (encrypted, content) = decode(&exported);
    assert!(encrypted);
    assert!(content
        .iter()
        .any(|e| e["name"].as_str().is_some_and(|n| n.ends_with(".txt"))));
    let (status, body, _) = rust_reimport(&exported, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "DECRYPTION_REQUIRED");
    let (status, body, again) = rust_reimport(&exported, Some(PASS)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(canon(&Value::Array(again)), canon(&Value::Array(content)));

    // Plain export (no backup key outside desktop mode).
    let dir = tempfile::tempdir().expect("tempdir");
    let s = rust_with_upload(dir.path(), false).await;
    let exported = export(&s).await;
    let (encrypted, content) = decode(&exported);
    assert!(!encrypted);
    let (status, body, again) = rust_reimport(&exported, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(canon(&Value::Array(again)), canon(&Value::Array(content)));
}

#[tokio::test]
async fn rust_upload_is_a_node_readable_file() {
    // The uploaded file Rust wrote is OFE1 with the passcode-derived key and
    // decrypts with crypto::decrypt_buffer exactly as Node's decryptBuffer
    // would (tests/compat.rs checks that primitive against Node's output).
    let dir = tempfile::tempdir().expect("tempdir");
    let _state = rust_with_upload(dir.path(), true).await;
    let uploads = dir.path().join("uploads/documents");
    let names: Vec<String> = std::fs::read_dir(&uploads)
        .expect("dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".txt"))
        .collect();
    assert_eq!(names.len(), 1);
    let name = &names[0];
    assert!(name.starts_with("doc_") && name.len() == "doc_".len() + 12 + ".txt".len());
    let raw = std::fs::read(uploads.join(name)).expect("file");
    assert!(crypto::is_encrypted_file(&raw));
    assert_eq!(
        crypto::decrypt_buffer(&raw, Some(PASS), true),
        b"uploaded by rust"
    );
}
