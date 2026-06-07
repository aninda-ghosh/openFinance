import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getSql } from "./db/index";
import { aiRouter } from "./routes/ai";
import { authRouter } from "./routes/auth";
import { backupRouter } from "./routes/backup";
import { budgetRouter } from "./routes/budget";
import { dashboardRouter } from "./routes/dashboard";
import { exchangeRatesRouter } from "./routes/exchange-rates";
import { investmentsRouter } from "./routes/investments";
import { policiesRouter } from "./routes/policies";
import { resetRouter } from "./routes/reset";
import { documentsRouter } from "./routes/documents";
import { verifyToken } from "./services/auth.service";

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

// ── Bootstrap schema + incremental migrations ─────────────────────────────────
// Uses CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS so this is safe
// to run on every startup.
const sql = getSql();
await sql`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    currency TEXT DEFAULT 'INR',
    balance DOUBLE PRECISION DEFAULT 0,
    institution TEXT,
    is_active BOOLEAN DEFAULT true,
    off_budget BOOLEAN DEFAULT false,
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
    budgeted DOUBLE PRECISION DEFAULT 0,
    budget_currency TEXT DEFAULT 'INR',
    spent DOUBLE PRECISION DEFAULT 0,
    month TEXT NOT NULL,
    rollover_type TEXT DEFAULT 'none',
    rollover_amount DOUBLE PRECISION DEFAULT 0,
    created_at TEXT,
    FOREIGN KEY (group_id) REFERENCES envelope_groups(id)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS budget_alerts (
    id TEXT PRIMARY KEY NOT NULL,
    envelope_id TEXT NOT NULL,
    type TEXT NOT NULL,
    threshold_pct DOUBLE PRECISION NOT NULL,
    is_active BOOLEAN DEFAULT true,
    triggered_at TEXT,
    FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS exchange_rates (
    id TEXT PRIMARY KEY NOT NULL,
    from_currency TEXT NOT NULL,
    rate_to_base DOUBLE PRECISION NOT NULL,
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
    purchase_value DOUBLE PRECISION NOT NULL,
    units DOUBLE PRECISION,
    purchase_date TEXT NOT NULL,
    current_value DOUBLE PRECISION NOT NULL,
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
    price DOUBLE PRECISION NOT NULL,
    source_url TEXT,
    fetched_at TEXT,
    FOREIGN KEY (investment_id) REFERENCES investments(id)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS investment_value_history (
    id TEXT PRIMARY KEY NOT NULL,
    investment_id TEXT NOT NULL,
    previous_value DOUBLE PRECISION,
    new_value DOUBLE PRECISION NOT NULL,
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
    premium_amount DOUBLE PRECISION NOT NULL,
    premium_frequency TEXT NOT NULL,
    premium_term_years INTEGER NOT NULL,
    policy_term_years INTEGER NOT NULL,
    maturity_date TEXT NOT NULL,
    sum_assured DOUBLE PRECISION NOT NULL,
    maturity_value DOUBLE PRECISION NOT NULL,
    surrender_value DOUBLE PRECISION,
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
    amount DOUBLE PRECISION NOT NULL,
    label TEXT NOT NULL,
    is_received BOOLEAN DEFAULT false,
    FOREIGN KEY (policy_id) REFERENCES policies(id)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    envelope_id TEXT,
    payee TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
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
    amount DOUBLE PRECISION NOT NULL,
    type TEXT NOT NULL,
    account_id TEXT NOT NULL,
    envelope_id TEXT,
    frequency TEXT NOT NULL,
    next_date TEXT NOT NULL,
    end_date TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (envelope_id) REFERENCES envelopes(id)
  )
`;

// Incremental column additions
await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_pair_id TEXT`;
await sql`ALTER TABLE investments ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id)`;
await sql`ALTER TABLE policies ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id)`;
await sql`ALTER TABLE policies ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR'`;

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
await sql`ALTER TABLE investment_documents ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE`;
await sql`ALTER TABLE investment_documents ALTER COLUMN investment_id DROP NOT NULL`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_key TEXT`;

// Run base currency naming migration safely in PostgreSQL
await sql`
  DO $$ 
  BEGIN 
    IF EXISTS (
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name='exchange_rates' AND column_name='rate_to_inr'
    ) THEN
      ALTER TABLE exchange_rates RENAME COLUMN rate_to_inr TO rate_to_base;
    END IF;
  END $$;
`;

// Indexes — IF NOT EXISTS is supported in PostgreSQL
await sql`CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions (account_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (date)`;
await sql`CREATE INDEX IF NOT EXISTS idx_txn_envelope ON transactions (envelope_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_price_investment ON price_history (investment_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_msg_conversation ON ai_messages (conversation_id)`;
await sql`CREATE INDEX IF NOT EXISTS idx_fx_currency ON exchange_rates (from_currency)`;

console.log("[startup] Schema migrations complete.");

// ── Apply due recurring transactions on startup ───────────────────────────────
import { applyDueRecurring } from "./services/recurring.service";

(async () => {
  try {
    const count = await applyDueRecurring();
    if (count > 0)
      console.log(`[recurring] Applied ${count} due recurring transaction(s).`);
  } catch (err) {
    console.warn(
      "[recurring] Failed to apply due recurring transactions:",
      (err as Error).message
    );
  }
})();

// ── Exchange rates: fetch on startup, then refresh every 15 minutes ──────────
import {
  getLatestRates,
  refreshFromWeb,
} from "./services/exchange-rate.service";

(async () => {
  try {
    const existing = await getLatestRates();
    if (Object.keys(existing).length === 0) {
      console.log("[startup] No exchange rates found — fetching from web…");
    }
    await refreshFromWeb();
    console.log("[startup] Exchange rates refreshed.");
  } catch (err) {
    console.warn(
      "[startup] Could not refresh exchange rates:",
      (err as Error).message
    );
  }
})();

const FIFTEEN_MINUTES = 15 * 60 * 1000;
setInterval(async () => {
  try {
    await refreshFromWeb();
    console.log("[rates] Exchange rates auto-refreshed.");
  } catch (err) {
    console.warn("[rates] Auto-refresh failed:", (err as Error).message);
  }
}, FIFTEEN_MINUTES);

// ── Auth middleware — protects all /api/* except /api/auth/* ─────────────────
app.use("/api/*", async (c, next) => {
  if (process.env.OPENFINANCE_DESKTOP === "true") return next();
  if (c.req.path.startsWith("/api/auth/")) return next();
  
  let token = "";
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    token = header.slice(7);
  } else {
    token = c.req.query("token") || "";
  }

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = verifyToken(token);
  if (!payload) return c.json({ error: "Invalid or expired token" }, 401);
  return next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/api/auth", authRouter);
app.route("/api/budget", budgetRouter);
app.route("/api/investments", investmentsRouter);
app.route("/api/policies", policiesRouter);
app.route("/api/dashboard", dashboardRouter);
app.route("/api/exchange-rates", exchangeRatesRouter);
app.route("/api/ai", aiRouter);
app.route("/api/reset", resetRouter);
app.route("/api/backup", backupRouter);
app.route("/api/documents", documentsRouter);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`openFinance server running on http://localhost:${PORT}`);
});
