//! Backup and document compatibility between Node and Rust (Wave 1 data),
//! through the real HTTP routes on both sides:
//!
//! - Node → Rust: `tests/compat/fixtures/backup/node-export.{fwb1,zip}` were
//!   exported by the Node route (`tests/compat/regen-backup-fixtures.sh`).
//!   Rust imports each, exports again, and its decoded export must equal
//!   Node's decoded export (`node-export.content.json`): every table row and
//!   every document byte.
//! - Rust → Node: Rust's own exports (encrypted and plain) are imported by the
//!   real Node route (`tests/compat/node/backup.ts`, run with the server's
//!   tsx), which exports again; Node's decoded content must equal Rust's.
//!   This needs `apps/server/node_modules` (the parity harness links it). Set
//!   `OPENFINANCE_SKIP_NODE_COMPAT=1` to skip that half explicitly.
//! - Documents: an upload through the Rust route is readable by Node's
//!   download route and the reverse (same paths, names and OFE1 encryption).

use std::path::{Path, PathBuf};
use std::process::Command;

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

/// The decoded content of an export, in the shape `node/backup.ts` writes.
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

fn tsx() -> Option<PathBuf> {
    let repo = crate_dir().join("../../../../..");
    let tsx = repo.join("apps/server/node_modules/.bin/tsx");
    if tsx.exists() {
        return Some(tsx);
    }
    if std::env::var("OPENFINANCE_SKIP_NODE_COMPAT").as_deref() == Ok("1") {
        return None;
    }
    panic!(
        "{} is missing: run the parity harness once (it links node_modules) or set OPENFINANCE_SKIP_NODE_COMPAT=1",
        tsx.display()
    );
}

/// Imports `backup` into a fresh Node server via the real route and returns
/// `{ status, body, content }` (content = Node's decoded re-export).
fn node_import(tsx: &Path, backup: &[u8], password: Option<&str>) -> Value {
    let dir = tempfile::tempdir().expect("tempdir");
    let input = dir.path().join("in.ofb");
    std::fs::write(&input, backup).expect("write");
    let result = dir.path().join("result.json");
    let server_src = crate_dir().join("../../../../../apps/server/src");
    let mut cmd = Command::new(tsx);
    cmd.arg(crate_dir().join("tests/compat/node/backup.ts"))
        .env("MODE", "import")
        .env("IN", &input)
        .env("RESULT", &result)
        .env("SERVER_SRC", &server_src)
        .env("DB_PATH", dir.path().join("node.db"))
        .env("OPENFINANCE_DB_KEY", PASS)
        .env("OPENFINANCE_DESKTOP", "true")
        .env("OPENFINANCE_NO_NETWORK", "1")
        .env_remove("ENCRYPTION_KEY");
    match password {
        Some(p) => cmd.env("PASSWORD", p),
        None => cmd.env_remove("PASSWORD"),
    };
    let out = cmd.output().expect("run tsx");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = std::fs::read_to_string(&result).expect("result");
    parse_json(&text).expect("result json")
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

#[tokio::test]
async fn rust_backups_import_in_node() {
    let Some(tsx) = tsx() else {
        eprintln!("skipped: OPENFINANCE_SKIP_NODE_COMPAT=1");
        return;
    };
    // Encrypted (desktop) export, imported with the passcode as password.
    let dir = tempfile::tempdir().expect("tempdir");
    let s = rust_with_upload(dir.path(), true).await;
    let exported = export(&s).await;
    let (encrypted, content) = decode(&exported);
    assert!(encrypted);
    assert!(content
        .iter()
        .any(|e| e["name"].as_str().is_some_and(|n| n.ends_with(".txt"))));
    let node = node_import(&tsx, &exported, None);
    assert_eq!(node["status"].as_f64(), Some(400.0));
    assert_eq!(node["body"]["error"], "DECRYPTION_REQUIRED");
    let node = node_import(&tsx, &exported, Some(PASS));
    assert_eq!(node["status"].as_f64(), Some(200.0), "{node}");
    assert_eq!(canon(&node["content"]), canon(&Value::Array(content)));

    // Plain export (no backup key outside desktop mode).
    let dir = tempfile::tempdir().expect("tempdir");
    let s = rust_with_upload(dir.path(), false).await;
    let exported = export(&s).await;
    let (encrypted, content) = decode(&exported);
    assert!(!encrypted);
    let node = node_import(&tsx, &exported, None);
    assert_eq!(node["status"].as_f64(), Some(200.0), "{node}");
    assert_eq!(canon(&node["content"]), canon(&Value::Array(content)));
}

#[tokio::test]
async fn rust_upload_is_a_node_readable_file() {
    // The uploaded file Rust wrote is OFE1 with the passcode-derived key and
    // decrypts with crypto::decrypt_buffer exactly as Node's decryptBuffer
    // would (the Node side of that primitive is covered by tests/compat.rs);
    // Node serving it after a backup round trip is covered above.
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
