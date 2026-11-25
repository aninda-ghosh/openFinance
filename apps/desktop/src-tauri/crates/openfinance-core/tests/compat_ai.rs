//! AI compatibility between Node and Rust (Wave 3 ai), using the real Node
//! modules through the server's tsx (`tests/compat/node/ai.ts`):
//!
//! - Chat memory: a memory file written by Node's `appendExchange` is read by
//!   Rust's `read_memory` with the same text Node's `readMemory` returns, and
//!   a file written by Rust's `append_exchange` reads back identically in
//!   Node (same path, encryption and format; the `[YYYY-MM-DD HH:MM:SS]`
//!   timestamps are not observable through the API, so this is where the
//!   file contents are compared).
//! - Context builder: `buildSystemContext` (unused by Node's routes, ported
//!   for completeness) produces the same text in both on the same database.
//!
//! Needs `apps/server/node_modules` (the parity harness links it). Set
//! `OPENFINANCE_SKIP_NODE_COMPAT=1` to skip explicitly.

use std::path::{Path, PathBuf};
use std::process::Command;

use openfinance_core::ai::{context, memory};
use openfinance_core::{db, AppState, Config};
use serde_json::Value;

/// Throwaway passcode used as the database and file key.
const PASS: &str = "ai'compat pass 1";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn tsx() -> Option<PathBuf> {
    let tsx = crate_dir().join("../../../../../apps/server/node_modules/.bin/tsx");
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

/// Runs `ai.ts` in `dir` (DATA_DIR) and returns its RESULT.
fn node(tsx: &Path, dir: &Path, mode: &str, extra: &[(&str, &str)]) -> Value {
    let result = dir.join("result.json");
    let mut cmd = Command::new(tsx);
    cmd.arg(crate_dir().join("tests/compat/node/ai.ts"))
        .env("MODE", mode)
        .env("RESULT", &result)
        .env(
            "SERVER_SRC",
            crate_dir().join("../../../../../apps/server/src"),
        )
        .env("DB_PATH", dir.join("openfinance.db"))
        .env("OPENFINANCE_DB_KEY", PASS)
        .env("OPENFINANCE_DESKTOP", "true")
        .env("OPENFINANCE_NO_NETWORK", "1")
        .env_remove("ENCRYPTION_KEY");
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("run tsx");
    assert!(
        out.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_str(&std::fs::read_to_string(&result).expect("result")).expect("json")
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
/// shape, so Node's and Rust's files can be compared to one expected text.
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
    let Some(tsx) = tsx() else {
        eprintln!("skipped: OPENFINANCE_SKIP_NODE_COMPAT=1");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let conv = "conv ✓ x";
    let res = node(&tsx, dir.path(), "memory-write", &[("CONV", conv)]);
    let node_text = res["memory"].as_str().expect("node memory").to_string();
    assert_eq!(shape(&node_text), EXPECTED);
    assert!(memory::file_path(dir.path(), conv).exists());

    let st = state(dir.path());
    let rust_text = memory::read_memory(&st, conv)
        .await
        .expect("rust reads node file");
    assert_eq!(rust_text, node_text);

    // Rust appends to Node's file; Node reads the result.
    memory::append_exchange(&st, conv, " third ", " reply ")
        .await
        .expect("append");
    let res = node(&tsx, dir.path(), "memory-read", &[("CONV", conv)]);
    let node_after = res["memory"].as_str().expect("node memory");
    assert_eq!(
        Some(node_after.to_string()),
        memory::read_memory(&st, conv).await
    );
    assert_eq!(
        shape(node_after),
        format!("{EXPECTED}\n---\n**[<ts>] User:** third\n\n**Assistant:** reply")
    );

    // An id with a slash names a file in a missing subdirectory: Node's
    // appendExchange rejects with ENOENT (the chat ignores it), so does Rust.
    let err = memory::append_exchange(&st, "a/b", "q", "a").await;
    assert_eq!(err.map_err(|e| e.kind()), Err(std::io::ErrorKind::NotFound));

    memory::delete_memory(&st, conv).await;
    let res = node(&tsx, dir.path(), "memory-read", &[("CONV", conv)]);
    assert_eq!(res["memory"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_written_by_rust_reads_in_node() {
    let Some(tsx) = tsx() else {
        eprintln!("skipped: OPENFINANCE_SKIP_NODE_COMPAT=1");
        return;
    };
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
    let res = node(&tsx, dir.path(), "memory-read", &[("CONV", conv)]);
    assert_eq!(
        shape(res["memory"].as_str().expect("node reads rust file")),
        EXPECTED
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn context_builder_matches_node() {
    let Some(tsx) = tsx() else {
        eprintln!("skipped: OPENFINANCE_SKIP_NODE_COMPAT=1");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let sample = crate_dir().join("../../../../../sample-data.json");
    let currencies = [
        "INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD", "XYZ", "toString",
    ];
    let joined = currencies.join(",");
    let res = node(
        &tsx,
        dir.path(),
        "context",
        &[
            ("SAMPLE", sample.to_str().expect("utf8 path")),
            ("CURRENCIES", &joined),
        ],
    );
    for cur in ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"] {
        assert!(
            res[cur]
                .as_str()
                .is_some_and(|t| t.contains("Chase Checking")),
            "{cur}: {}",
            res[cur]
        );
    }
    let st = state(dir.path());
    for cur in currencies {
        let cur_owned = cur.to_string();
        let rust = st
            .db(move |conn| context::build_system_context(conn, &cur_owned))
            .await;
        match (&res[cur], rust) {
            (Value::String(node_text), Ok(rust_text)) => {
                assert_eq!(&rust_text, node_text, "context for {cur}")
            }
            // Node throws (RangeError from Intl for an unknown currency
            // code); Rust returns an error for the same inputs.
            (Value::Object(o), Err(_)) if o.contains_key("error") => {}
            (n, r) => panic!("{cur}: node {n} rust {r:?}"),
        }
    }
}
