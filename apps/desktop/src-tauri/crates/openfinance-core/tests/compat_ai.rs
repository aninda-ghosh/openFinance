//! AI compatibility (chat memory files and the context builder):
//!
//! - Chat memory: `tests/compat/fixtures/ai/node-memory.md` was written by the
//!   Node server's `appendExchange` (the last Node release, `1502e08`). Rust's
//!   `read_memory` must read it, append to it and delete it. A file written by
//!   Rust's `append_exchange` must read back with the same text (same path,
//!   encryption and format; the `[YYYY-MM-DD HH:MM:SS]` timestamps are not
//!   observable through the API, so this is where the file contents are
//!   compared).
//! - Context builder: `build_system_context` describes a database restored
//!   from the Node backup fixture for every supported currency, and fails for
//!   a malformed currency code (Node's `Intl` threw a RangeError there).

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use openfinance_core::ai::{context, memory};
use openfinance_core::{db, AppState, Config};
use tower::ServiceExt;

/// Throwaway passcode used as the database and file key (also the key the
/// memory fixture was written with).
const PASS: &str = "ai'compat pass 1";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture(rel: &str) -> Vec<u8> {
    let p = crate_dir().join("tests/compat/fixtures").join(rel);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// A Rust server state over `dir/openfinance.db` (desktop mode, network off).
fn state(dir: &Path) -> AppState {
    let db_path = dir.join("openfinance.db");
    let config = Config {
        db_path: db_path.clone(),
        db_key: Some(PASS.to_string()),
        desktop: true,
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

/// The memory text with its two timestamps replaced, after checking their
/// shape, so files can be compared to one expected text.
fn shape(memory: &str) -> String {
    let mut out = String::new();
    let mut rest = memory;
    while let Some(i) = rest.find("**[") {
        out.push_str(&rest[..i + 3]);
        let ts = &rest[i + 3..i + 22];
        let b = ts.as_bytes();
        assert!(
            ts.len() == 19
                && b[4] == b'-'
                && b[7] == b'-'
                && b[10] == b' '
                && b[13] == b':'
                && b[16] == b':'
                && ts
                    .chars()
                    .enumerate()
                    .all(|(k, c)| [4, 7, 10, 13, 16].contains(&k) || c.is_ascii_digit()),
            "timestamp {ts:?}"
        );
        out.push_str("<ts>");
        rest = &rest[i + 22..];
    }
    out.push_str(rest);
    out
}

const EXPECTED: &str = "# Chat Memory: conv ✓ x\n\n---\n**[<ts>] User:** How much did I spend on groceries? ✓\n\n**Assistant:** ₹12,000 — about 8% of income.\n\nDetails:\n- A\n- B\n---\n**[<ts>] User:** second\n\n**Assistant:** answer 2";

#[tokio::test(flavor = "multi_thread")]
async fn memory_written_by_node_reads_in_rust() {
    let dir = tempfile::tempdir().expect("tempdir");
    let conv = "conv ✓ x";
    let path = memory::file_path(dir.path(), conv);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&path, fixture("ai/node-memory.md")).expect("write fixture");

    let st = state(dir.path());
    let text = memory::read_memory(&st, conv)
        .await
        .expect("rust reads node file");
    assert_eq!(shape(&text), EXPECTED);

    // Rust appends to Node's file and reads the result back.
    memory::append_exchange(&st, conv, " third ", " reply ")
        .await
        .expect("append");
    let after = memory::read_memory(&st, conv).await.expect("read after");
    assert!(after.starts_with(&text), "the Node part is kept as is");
    assert_eq!(
        shape(&after),
        format!("{EXPECTED}\n---\n**[<ts>] User:** third\n\n**Assistant:** reply")
    );

    // An id with a slash names a file in a missing subdirectory: Node's
    // appendExchange rejected with ENOENT (the chat ignores it), so does Rust.
    let err = memory::append_exchange(&st, "a/b", "q", "a").await;
    assert_eq!(err.map_err(|e| e.kind()), Err(std::io::ErrorKind::NotFound));

    memory::delete_memory(&st, conv).await;
    assert!(!path.exists());
    assert_eq!(memory::read_memory(&st, conv).await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_written_by_rust_reads_back() {
    let dir = tempfile::tempdir().expect("tempdir");
    let conv = "conv ✓ x";
    {
        let st = state(dir.path());
        memory::append_exchange(
            &st,
            conv,
            "  How much did I spend on groceries? ✓ ",
            "\n₹12,000 — about 8% of income.\n\nDetails:\n- A\n- B  ",
        )
        .await
        .expect("append 1");
        memory::append_exchange(&st, conv, "second", "answer 2")
            .await
            .expect("append 2");
        assert_eq!(
            shape(&memory::read_memory(&st, conv).await.expect("read")),
            EXPECTED
        );
    }
    // A new state (as after an app restart) reads the same file.
    let st = state(dir.path());
    assert_eq!(
        shape(&memory::read_memory(&st, conv).await.expect("reread")),
        EXPECTED
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn context_builder_describes_restored_backup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let st = state(dir.path());
    // Seed with the Node-exported backup fixture (sample-data.json plus extras).
    let app = openfinance_core::http::router(st.clone());
    let resp = app
        .oneshot(
            Request::post("/api/backup/import")
                .body(Body::from(fixture("backup/node-export.zip")))
                .expect("req"),
        )
        .await
        .expect("response");
    assert_eq!(resp.status(), StatusCode::OK);

    for cur in ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"] {
        let cur_owned = cur.to_string();
        let text = st
            .db(move |conn| context::build_system_context(conn, &cur_owned))
            .await
            .unwrap_or_else(|e| panic!("{cur}: {e:?}"));
        assert!(text.contains("Chase Checking"), "{cur}: {text}");
    }
    // A well-formed but unknown code is formatted like Intl does ("XYZ 1,234").
    let text = st
        .db(|conn| context::build_system_context(conn, "XYZ"))
        .await
        .expect("XYZ");
    assert!(text.contains("XYZ\u{a0}"), "{text}");
    // Node threw (RangeError from Intl) for a malformed code.
    let res = st
        .db(|conn| context::build_system_context(conn, "toString"))
        .await;
    assert!(res.is_err(), "toString: {res:?}");
}
