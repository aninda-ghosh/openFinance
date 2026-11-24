//! Compatibility checkpoints (PLAN.md §5) against fixtures produced by the real
//! Node modules (tests/compat/regen-fixtures.sh). The reverse direction (Rust
//! output read by Node) is checked by tests/compat/roundtrip.sh, which runs the
//! ignored `write_outputs_for_node` test below and then a Node verifier.

use std::path::{Path, PathBuf};

use openfinance_core::{crypto, db};

/// Throwaway passcode used to generate the fixtures (contains a quote on purpose).
const PASS: &str = "thr0w'away pass ✓";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/compat/fixtures")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn temp_copy_of_node_db() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("openfinance.db");
    std::fs::copy(fixtures().join("node-encrypted.sqlite"), &path).expect("copy fixture");
    (dir, path)
}

fn schema(conn: &rusqlite::Connection) -> Vec<(String, String, Option<String>)> {
    let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .expect("prepare");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("query");
    rows.map(|r| r.expect("row")).collect()
}

#[test]
fn node_db_is_encrypted_on_disk() {
    let bytes = read("node-encrypted.sqlite");
    assert!(!bytes.starts_with(b"SQLite format 3\0"));
}

#[test]
fn rust_opens_node_encrypted_db() {
    let (_dir, path) = temp_copy_of_node_db();
    let conn = db::open(&path, Some(PASS)).expect("open with the right passcode");
    let (name, balance): (String, f64) = conn
        .query_row("SELECT name, balance FROM accounts WHERE id = 'node-acc'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .expect("row written by node");
    assert_eq!(name, "Written by Node ✓");
    assert_eq!(balance, 1234.5);
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .expect("journal_mode");
    assert_eq!(mode, "wal");
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).expect("fk");
    assert_eq!(fk, 1);
}

#[test]
fn rust_bootstrap_matches_node_schema_exactly() {
    let (_dir, path) = temp_copy_of_node_db();
    let node = db::open(&path, Some(PASS)).expect("open node db");
    let node_schema = schema(&node);
    // Bootstrapping an existing Node DB is a no-op on the schema.
    db::bootstrap::bootstrap_schema(&node).expect("bootstrap on node db");
    assert_eq!(schema(&node), node_schema);

    let dir = tempfile::tempdir().expect("tempdir");
    let fresh = db::open(&dir.path().join("fresh.db"), Some(PASS)).expect("open fresh");
    db::bootstrap::bootstrap_schema(&fresh).expect("bootstrap fresh");
    assert_eq!(schema(&fresh), node_schema, "sqlite_master differs from Node's");
}

#[test]
fn wrong_passcode_fails_cleanly() {
    let (_dir, path) = temp_copy_of_node_db();
    match db::open(&path, Some("not the passcode")) {
        Err(db::OpenError::WrongKey(err)) => {
            assert!(err.to_string().contains("file is not a database"), "{err}");
        }
        Err(other) => panic!("expected WrongKey, got {other}"),
        Ok(_) => panic!("wrong passcode opened the database"),
    }
    // Without any key the file is unreadable too.
    let conn = db::open(&path, None);
    assert!(conn.is_err(), "unkeyed open should fail on the encrypted file");
    // The file is untouched: the right passcode still works afterwards.
    db::open(&path, Some(PASS)).expect("reopen with the right passcode");
}

#[test]
fn rust_decrypts_node_ofe1() {
    let plain = read("doc.plain");
    assert_eq!(crypto::decrypt_buffer(&read("doc.ofe1"), Some(PASS), false), plain);
    assert_eq!(crypto::decrypt_buffer(&read("doc.ofe1"), Some(PASS), true), plain);
    // A wrong key hands back the input, exactly like Node.
    assert_eq!(
        crypto::decrypt_buffer(&read("doc.ofe1"), Some("wrong"), true),
        read("doc.ofe1")
    );
}

#[test]
fn rust_decrypts_node_legacy_layout_only_on_desktop() {
    let plain = read("doc.plain");
    let legacy = read("doc.legacy");
    assert_eq!(crypto::decrypt_buffer(&legacy, Some(PASS), true), plain);
    assert_eq!(crypto::decrypt_buffer(&legacy, Some(PASS), false), legacy);
}

#[test]
fn rust_decrypts_node_ofe1_string() {
    let memo = String::from_utf8(read("memory.plain")).expect("utf8");
    let enc = String::from_utf8(read("memory.ofe1.b64")).expect("utf8");
    assert_eq!(crypto::decrypt_string(&enc, Some(PASS), true), memo);
    assert_eq!(crypto::decrypt_string(&enc, Some(PASS), false), memo);
}

#[test]
fn rust_derives_node_backup_key_and_decrypts_fwb1() {
    let key = crypto::derive_backup_key(PASS, "desktop");
    assert_eq!(key.as_bytes(), read("backup_key.desktop.hex").as_slice());
    let plain = read("backup.plain");
    let dec = crypto::decrypt_backup(&read("backup.fwb1"), &key).expect("decrypt");
    assert_eq!(dec, Some(plain));
    assert!(crypto::decrypt_backup(&read("backup.fwb1"), &"00".repeat(32)).is_err());
}

/// Writes Rust-produced artifacts for the Node verifier. Ignored by default;
/// run through tests/compat/roundtrip.sh (sets COMPAT_OUT).
#[test]
#[ignore]
fn write_outputs_for_node() {
    let out = PathBuf::from(std::env::var("COMPAT_OUT").expect("COMPAT_OUT"));
    let conn = db::open(&out.join("rust.db"), Some(PASS)).expect("open");
    db::bootstrap::bootstrap_schema(&conn).expect("bootstrap");
    conn.execute(
        "INSERT INTO accounts (id, name, type, currency, balance) VALUES ('rust-acc', 'Written by Rust ✓', 'checking', 'USD', 98.76)",
        [],
    )
    .expect("insert");
    drop(conn); // closing checkpoints the WAL
    let header = std::fs::read(out.join("rust.db")).expect("read db");
    assert!(!header.starts_with(b"SQLite format 3\0"), "rust db is not encrypted");

    let doc = read("doc.plain");
    std::fs::write(out.join("doc.plain"), &doc).expect("write");
    std::fs::write(out.join("doc.ofe1"), crypto::encrypt_buffer(&doc, Some(PASS))).expect("write");
    let memo = String::from_utf8(read("memory.plain")).expect("utf8");
    std::fs::write(out.join("memory.plain"), &memo).expect("write");
    std::fs::write(
        out.join("memory.ofe1.b64"),
        crypto::encrypt_string(&memo, Some(PASS)),
    )
    .expect("write");
    let backup = read("backup.plain");
    std::fs::write(out.join("backup.plain"), &backup).expect("write");
    let key = crypto::derive_backup_key(PASS, "desktop");
    std::fs::write(out.join("backup.fwb1"), crypto::encrypt_backup(&backup, &key)).expect("write");
}
