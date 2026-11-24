//! Port of `apps/server/src/db/bootstrap.ts` (Wave 0). The DDL text is copied
//! verbatim so `sqlite_master.sql` is identical whichever backend created the
//! file. Every statement is idempotent; this runs on every startup.

use std::collections::HashSet;

use rusqlite::Connection;

/// Column names currently present on a table (empty when the table is absent).
fn columns_of(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>("name"))?;
    rows.collect()
}

/// SQLite has no ADD COLUMN IF NOT EXISTS: this is the equivalent.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if columns_of(conn, table)?.contains(column) {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))
}

/// The `CREATE TABLE` statements, in Node's order. The leading newline and
/// six-space indentation reproduce the template literals in bootstrap.ts.
const CREATE_TABLES_1: &[&str] = &[
    "
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT DEFAULT 'INR',
      balance REAL DEFAULT 0,
      institution TEXT,
      is_active INTEGER DEFAULT 1,
      off_budget INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence TEXT,
      sources_json TEXT,
      created_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS ai_tool_calls (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      called_at TEXT,
      FOREIGN KEY (message_id) REFERENCES ai_messages(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS envelope_groups (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS envelopes (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      budgeted REAL DEFAULT 0,
      budget_currency TEXT DEFAULT 'INR',
      spent REAL DEFAULT 0,
      month TEXT NOT NULL,
      rollover_type TEXT DEFAULT 'none',
      rollover_amount REAL DEFAULT 0,
      created_at TEXT,
      FOREIGN KEY (group_id) REFERENCES envelope_groups(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS budget_alerts (
      id TEXT PRIMARY KEY NOT NULL,
      envelope_id TEXT NOT NULL,
      type TEXT NOT NULL,
      threshold_pct REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      triggered_at TEXT,
      FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id TEXT PRIMARY KEY NOT NULL,
      from_currency TEXT NOT NULL,
      rate_to_base REAL NOT NULL,
      source TEXT,
      fetched_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS investments (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      currency TEXT DEFAULT 'INR',
      purchase_value REAL NOT NULL,
      units REAL,
      purchase_date TEXT NOT NULL,
      current_value REAL NOT NULL,
      current_value_source TEXT,
      current_value_at TEXT,
      notes TEXT,
      account_id TEXT REFERENCES accounts(id),
      created_at TEXT,
      updated_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS price_history (
      id TEXT PRIMARY KEY NOT NULL,
      investment_id TEXT NOT NULL,
      price REAL NOT NULL,
      source_url TEXT,
      fetched_at TEXT,
      FOREIGN KEY (investment_id) REFERENCES investments(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS investment_value_history (
      id TEXT PRIMARY KEY NOT NULL,
      investment_id TEXT NOT NULL,
      previous_value REAL,
      new_value REAL NOT NULL,
      source TEXT NOT NULL,
      notes TEXT,
      contribution REAL DEFAULT 0,
      changed_at TEXT,
      FOREIGN KEY (investment_id) REFERENCES investments(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      policy_number TEXT,
      start_date TEXT NOT NULL,
      premium_amount REAL NOT NULL,
      premium_frequency TEXT NOT NULL,
      premium_term_years INTEGER NOT NULL,
      policy_term_years INTEGER NOT NULL,
      maturity_date TEXT NOT NULL,
      sum_assured REAL NOT NULL,
      maturity_value REAL NOT NULL,
      surrender_value REAL,
      notes TEXT,
      account_id TEXT REFERENCES accounts(id),
      created_at TEXT,
      updated_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS policy_payouts (
      id TEXT PRIMARY KEY NOT NULL,
      policy_id TEXT NOT NULL,
      payout_date TEXT NOT NULL,
      amount REAL NOT NULL,
      label TEXT NOT NULL,
      is_received INTEGER DEFAULT 0,
      FOREIGN KEY (policy_id) REFERENCES policies(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      envelope_id TEXT,
      payee TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT,
      import_hash TEXT UNIQUE,
      income_category TEXT,
      created_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY NOT NULL,
      base_currency TEXT DEFAULT 'USD' NOT NULL,
      updated_at TEXT
    )
  ",
];

const INSERT_APP_SETTINGS: &str = "
    INSERT INTO app_settings (id, base_currency, updated_at)
    VALUES ('system', 'USD', ?)
    ON CONFLICT (id) DO NOTHING
  ";

const CREATE_TABLES_2: &[&str] = &[
    "
    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id TEXT PRIMARY KEY NOT NULL,
      payee TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      envelope_id TEXT,
      frequency TEXT NOT NULL,
      next_date TEXT NOT NULL,
      end_date TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS investment_documents (
      id TEXT PRIMARY KEY NOT NULL,
      investment_id TEXT REFERENCES investments(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  ",
    "
    CREATE TABLE IF NOT EXISTS life_insurance (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      insured_person TEXT NOT NULL,
      provider TEXT NOT NULL,
      policy_number TEXT,
      currency TEXT DEFAULT 'INR',
      coverage_amount REAL NOT NULL,
      renewal_date TEXT NOT NULL,
      premium_amount REAL,
      premium_frequency TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  ",
];

/// Incremental column additions, in Node's order.
const ADD_COLUMNS: &[(&str, &str, &str)] = &[
    ("transactions", "transfer_pair_id", "TEXT"),
    ("investments", "account_id", "TEXT REFERENCES accounts(id)"),
    ("investments", "maturity_date", "TEXT"),
    ("investments", "depreciation_rate", "REAL"),
    ("recurring_transactions", "anchor_day", "INTEGER"),
    ("policies", "account_id", "TEXT REFERENCES accounts(id)"),
    ("policies", "currency", "TEXT DEFAULT 'INR'"),
    (
        "investment_documents",
        "account_id",
        "TEXT REFERENCES accounts(id) ON DELETE CASCADE",
    ),
    (
        "investment_documents",
        "life_insurance_id",
        "TEXT REFERENCES life_insurance(id) ON DELETE CASCADE",
    ),
    ("investment_value_history", "contribution", "REAL DEFAULT 0"),
    ("users", "backup_key", "TEXT"),
    ("app_settings", "ollama_url", "TEXT"),
    ("app_settings", "ollama_model", "TEXT"),
];

const INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions (account_id)",
    "CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (date)",
    "CREATE INDEX IF NOT EXISTS idx_txn_envelope ON transactions (envelope_id)",
    "CREATE INDEX IF NOT EXISTS idx_price_investment ON price_history (investment_id)",
    "CREATE INDEX IF NOT EXISTS idx_msg_conversation ON ai_messages (conversation_id)",
    "CREATE INDEX IF NOT EXISTS idx_fx_currency ON exchange_rates (from_currency)",
    "CREATE INDEX IF NOT EXISTS idx_life_insurance_renewal ON life_insurance (renewal_date)",
    "CREATE INDEX IF NOT EXISTS idx_doc_life_insurance ON investment_documents (life_insurance_id)",
];

/// Creates the schema and applies incremental migrations (`bootstrapSchema`).
pub fn bootstrap_schema(conn: &Connection) -> rusqlite::Result<()> {
    for ddl in CREATE_TABLES_1 {
        conn.execute(ddl, [])?;
    }
    conn.execute(INSERT_APP_SETTINGS, [crate::js::now_iso()])?;
    for ddl in CREATE_TABLES_2 {
        conn.execute(ddl, [])?;
    }

    for (table, column, definition) in ADD_COLUMNS {
        add_column_if_missing(conn, table, column, definition)?;
    }

    // Base-currency naming migration (rate_to_inr → rate_to_base).
    let fx_columns = columns_of(conn, "exchange_rates")?;
    if fx_columns.contains("rate_to_inr") && !fx_columns.contains("rate_to_base") {
        conn.execute_batch("ALTER TABLE exchange_rates RENAME COLUMN rate_to_inr TO rate_to_base")?;
    }

    // Physical assets are never holdings inside an account.
    conn.execute_batch(
        "UPDATE investments SET account_id = NULL WHERE asset_type = 'vehicle' AND account_id IS NOT NULL",
    )?;

    for ddl in INDEXES {
        conn.execute(ddl, [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open");
        bootstrap_schema(&conn).expect("first run");
        bootstrap_schema(&conn).expect("second run");
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(tables, 19);
        let base: String = conn
            .query_row("SELECT base_currency FROM app_settings WHERE id = 'system'", [], |r| {
                r.get(0)
            })
            .expect("settings row");
        assert_eq!(base, "USD");
    }

    #[test]
    fn renames_legacy_rate_column() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE exchange_rates (id TEXT PRIMARY KEY NOT NULL, from_currency TEXT NOT NULL, rate_to_inr REAL NOT NULL, source TEXT, fetched_at TEXT)",
        )
        .expect("legacy table");
        bootstrap_schema(&conn).expect("bootstrap");
        let cols = columns_of(&conn, "exchange_rates").expect("cols");
        assert!(cols.contains("rate_to_base") && !cols.contains("rate_to_inr"));
    }
}
