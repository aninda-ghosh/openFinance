import { getSql, getSqlite } from "./index";

const sql = getSql();

/** Column names currently present on a table (empty when the table is absent). */
function columnsOf(table: string): Set<string> {
  const rows = getSqlite()
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** SQLite has no ADD COLUMN IF NOT EXISTS — this is the equivalent. */
function addColumnIfMissing(table: string, column: string, definition: string) {
  if (columnsOf(table).has(column)) return;
  getSqlite().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Creates the schema and applies incremental migrations.
 * Every statement is idempotent, so this runs on every startup.
 */
export async function bootstrapSchema(): Promise<void> {
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )
  `;
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_tool_calls (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      called_at TEXT,
      FOREIGN KEY (message_id) REFERENCES ai_messages(id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS envelope_groups (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT
    )
  `;
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS budget_alerts (
      id TEXT PRIMARY KEY NOT NULL,
      envelope_id TEXT NOT NULL,
      type TEXT NOT NULL,
      threshold_pct REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      triggered_at TEXT,
      FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id TEXT PRIMARY KEY NOT NULL,
      from_currency TEXT NOT NULL,
      rate_to_base REAL NOT NULL,
      source TEXT,
      fetched_at TEXT
    )
  `;
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS price_history (
      id TEXT PRIMARY KEY NOT NULL,
      investment_id TEXT NOT NULL,
      price REAL NOT NULL,
      source_url TEXT,
      fetched_at TEXT,
      FOREIGN KEY (investment_id) REFERENCES investments(id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS investment_value_history (
      id TEXT PRIMARY KEY NOT NULL,
      investment_id TEXT NOT NULL,
      previous_value REAL,
      new_value REAL NOT NULL,
      source TEXT NOT NULL,
      notes TEXT,
      changed_at TEXT,
      FOREIGN KEY (investment_id) REFERENCES investments(id)
    )
  `;
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS policy_payouts (
      id TEXT PRIMARY KEY NOT NULL,
      policy_id TEXT NOT NULL,
      payout_date TEXT NOT NULL,
      amount REAL NOT NULL,
      label TEXT NOT NULL,
      is_received INTEGER DEFAULT 0,
      FOREIGN KEY (policy_id) REFERENCES policies(id)
    )
  `;
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY NOT NULL,
      base_currency TEXT DEFAULT 'USD' NOT NULL,
      updated_at TEXT
    )
  `;
  await sql`
    INSERT INTO app_settings (id, base_currency, updated_at)
    VALUES ('system', 'USD', ${new Date().toISOString()})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
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
  `;

  await sql`
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
  `;

  // ── Incremental column additions ────────────────────────────────────────────
  addColumnIfMissing("transactions", "transfer_pair_id", "TEXT");
  addColumnIfMissing(
    "investments",
    "account_id",
    "TEXT REFERENCES accounts(id)"
  );
  addColumnIfMissing("investments", "maturity_date", "TEXT");
  addColumnIfMissing("policies", "account_id", "TEXT REFERENCES accounts(id)");
  addColumnIfMissing("policies", "currency", "TEXT DEFAULT 'INR'");
  addColumnIfMissing(
    "investment_documents",
    "account_id",
    "TEXT REFERENCES accounts(id) ON DELETE CASCADE"
  );
  addColumnIfMissing("users", "backup_key", "TEXT");
  addColumnIfMissing("app_settings", "ollama_url", "TEXT");
  addColumnIfMissing("app_settings", "ollama_model", "TEXT");

  // ── Base-currency naming migration (rate_to_inr → rate_to_base) ─────────────
  const fxColumns = columnsOf("exchange_rates");
  if (fxColumns.has("rate_to_inr") && !fxColumns.has("rate_to_base")) {
    getSqlite().exec(
      "ALTER TABLE exchange_rates RENAME COLUMN rate_to_inr TO rate_to_base"
    );
  }

  // ── Indexes ─────────────────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions (account_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_envelope ON transactions (envelope_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_price_investment ON price_history (investment_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_msg_conversation ON ai_messages (conversation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_fx_currency ON exchange_rates (from_currency)`;
}
