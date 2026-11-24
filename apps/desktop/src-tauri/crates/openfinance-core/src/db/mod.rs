//! Port of `apps/server/src/db/index.ts` (Wave 0): opening the encrypted
//! database. Transactions live in [`crate::state`].
//!
//! Node uses better-sqlite3-multiple-ciphers with
//! `cipher = 'sqlcipher'; legacy = 4; key = '<passcode>'`, i.e. the SQLCipher 4
//! on-disk format. We link SQLCipher itself (rusqlite `bundled-sqlcipher`),
//! whose default format *is* SQLCipher 4; `cipher_compatibility = 4` pins that
//! explicitly. tests/compat.rs proves both directions against Node fixtures.

pub mod bootstrap;

use std::path::Path;

use rusqlite::Connection;

pub use rusqlite;

/// Exit code Node uses when the passcode does not open the database.
pub const WRONG_KEY_EXIT_CODE: i32 = 13;

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    /// The passcode does not decrypt the file (SQLITE_NOTADB on first read).
    #[error("Could not open the database with the supplied passcode: {0}")]
    WrongKey(rusqlite::Error),
    #[error("could not create the database directory: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Opens (creating if needed) the database at `path`, keyed with `key` when it
/// is non-blank, then applies the same PRAGMAs as Node in the same order.
pub fn open(path: &Path, key: Option<&str>) -> Result<Connection, OpenError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let conn = Connection::open(path)?;

    if let Some(key) = key.filter(|k| !crate::crypto::js_trim(k).is_empty()) {
        // PRAGMA key must be the first statement on the connection. rusqlite
        // quotes the value as a string literal, doubling single quotes exactly
        // like Node's `key = '${DB_KEY.replace(/'/g, "''")}'`.
        conn.pragma_update(None, "key", key)?;
        conn.pragma_update(None, "cipher_compatibility", 4)?;
        // Touching the schema is what actually decrypts page 1.
        if let Err(err) = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        }) {
            return Err(OpenError::WrongKey(err));
        }
    }

    // journal_mode returns a row, so read it rather than pragma_update.
    conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(conn)
}

/// `runTransaction` for code that already holds the connection: BEGIN, run
/// `f`, COMMIT; ROLLBACK and return the error when `f` (or COMMIT) fails.
/// Inside an open transaction it simply runs `f`, joining the outer one, as
/// Node does for a service helper that calls another.
pub fn run_transaction<T, E, F>(conn: &Connection, f: F) -> Result<T, E>
where
    F: FnOnce(&Connection) -> Result<T, E>,
    E: From<rusqlite::Error>,
{
    if !conn.is_autocommit() {
        return f(conn);
    }
    conn.execute_batch("BEGIN")?;
    let result = f(conn).and_then(|value| {
        conn.execute_batch("COMMIT")?;
        Ok(value)
    });
    if result.is_err() && !conn.is_autocommit() {
        // Ignore failure: SQLite may already have rolled back (constraint abort).
        let _ = conn.execute_batch("ROLLBACK");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        c.execute_batch("CREATE TABLE t (v INTEGER)")
            .expect("table");
        c
    }

    fn count(c: &Connection) -> i64 {
        c.query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .expect("count")
    }

    #[test]
    fn commits_and_rolls_back() {
        let c = conn();
        run_transaction::<_, rusqlite::Error, _>(&c, |c| c.execute("INSERT INTO t VALUES (1)", []))
            .expect("commit");
        assert_eq!(count(&c), 1);
        let res: Result<(), rusqlite::Error> = run_transaction(&c, |c| {
            c.execute("INSERT INTO t VALUES (2)", [])?;
            Err(rusqlite::Error::QueryReturnedNoRows)
        });
        assert!(res.is_err());
        assert_eq!(count(&c), 1);
        assert!(c.is_autocommit());
    }

    #[test]
    fn nested_joins_outer() {
        let c = conn();
        let res: Result<(), rusqlite::Error> = run_transaction(&c, |c| {
            c.execute("INSERT INTO t VALUES (1)", [])?;
            run_transaction(c, |c| c.execute("INSERT INTO t VALUES (2)", []).map(|_| ()))?;
            // The inner call did not commit on its own.
            assert!(!c.is_autocommit());
            Err(rusqlite::Error::QueryReturnedNoRows)
        });
        assert!(res.is_err());
        assert_eq!(count(&c), 0);
    }
}
