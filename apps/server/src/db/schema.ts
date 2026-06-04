import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
} from "./table-helper";
import { nanoid } from "nanoid";

const now = () => new Date().toISOString();

// ─── Accounts ────────────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  type: text("type")
    .$type<
      | "checking"
      | "savings"
      | "cash"
      | "investment"
      | "policy"
      | "credit"
      | "loan"
      | "debt"
    >()
    .notNull(),
  currency: text("currency")
    .$type<"INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD">()
    .default("INR"),
  balance: doublePrecision("balance").default(0),
  institution: text("institution"),
  is_active: boolean("is_active").default(true),
  off_budget: boolean("off_budget").default(false),
  created_at: text("created_at").$defaultFn(now),
  updated_at: text("updated_at").$defaultFn(now),
});

// ─── Envelope Groups ─────────────────────────────────────────────────────────

export const envelope_groups = pgTable("envelope_groups", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  sort_order: integer("sort_order").default(0),
  created_at: text("created_at").$defaultFn(now),
});

// ─── Envelopes ───────────────────────────────────────────────────────────────

export const envelopes = pgTable("envelopes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  group_id: text("group_id")
    .notNull()
    .references(() => envelope_groups.id),
  name: text("name").notNull(),
  budgeted: doublePrecision("budgeted").default(0),
  budget_currency: text("budget_currency")
    .$type<"INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD">()
    .default("INR"),
  spent: doublePrecision("spent").default(0),
  month: text("month").notNull(), // format: "YYYY-MM"
  rollover_type: text("rollover_type")
    .$type<"none" | "amount" | "leftover">()
    .default("none"),
  rollover_amount: doublePrecision("rollover_amount").default(0),
  created_at: text("created_at").$defaultFn(now),
});

// ─── Transactions ─────────────────────────────────────────────────────────────

export const transactions = pgTable("transactions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  account_id: text("account_id")
    .notNull()
    .references(() => accounts.id),
  envelope_id: text("envelope_id").references(() => envelopes.id), // nullable
  payee: text("payee").notNull(),
  amount: doublePrecision("amount").notNull(),
  type: text("type").$type<"income" | "expense" | "transfer">().notNull(),
  date: text("date").notNull(), // ISO date string
  notes: text("notes"),
  import_hash: text("import_hash").unique(), // SHA-256 of raw CSV row, nullable
  income_category: text("income_category").$type<
    "income" | "cashback" | "starting_balance"
  >(),
  transfer_pair_id: text("transfer_pair_id"),
  created_at: text("created_at").$defaultFn(now),
});

// ─── Investments ──────────────────────────────────────────────────────────────

export const investments = pgTable("investments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  asset_type: text("asset_type")
    .$type<
      | "mutual_fund"
      | "stock"
      | "etf"
      | "fd"
      | "savings"
      | "bond"
      | "real_estate"
      | "cash"
      | "structured"
      | "other"
    >()
    .notNull(),
  currency: text("currency")
    .$type<"INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD">()
    .default("INR"),
  purchase_value: doublePrecision("purchase_value").notNull(),
  units: doublePrecision("units"), // nullable
  purchase_date: text("purchase_date").notNull(),
  current_value: doublePrecision("current_value").notNull(),
  current_value_source: text("current_value_source"),
  current_value_at: text("current_value_at"),
  notes: text("notes"),
  account_id: text("account_id").references(() => accounts.id),
  created_at: text("created_at").$defaultFn(now),
  updated_at: text("updated_at").$defaultFn(now),
});

// ─── Policies ─────────────────────────────────────────────────────────────────

export const policies = pgTable("policies", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  policy_number: text("policy_number"),
  currency: text("currency")
    .$type<"INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD">()
    .default("INR"),
  start_date: text("start_date").notNull(),
  premium_amount: doublePrecision("premium_amount").notNull(),
  premium_frequency: text("premium_frequency")
    .$type<"monthly" | "quarterly" | "annual">()
    .notNull(),
  premium_term_years: integer("premium_term_years").notNull(),
  policy_term_years: integer("policy_term_years").notNull(),
  maturity_date: text("maturity_date").notNull(),
  sum_assured: doublePrecision("sum_assured").notNull(),
  maturity_value: doublePrecision("maturity_value").notNull(),
  surrender_value: doublePrecision("surrender_value"), // nullable
  notes: text("notes"),
  account_id: text("account_id").references(() => accounts.id),
  created_at: text("created_at").$defaultFn(now),
  updated_at: text("updated_at").$defaultFn(now),
});

// ─── Policy Payouts ───────────────────────────────────────────────────────────

export const policy_payouts = pgTable("policy_payouts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  policy_id: text("policy_id")
    .notNull()
    .references(() => policies.id),
  payout_date: text("payout_date").notNull(),
  amount: doublePrecision("amount").notNull(),
  label: text("label").notNull(),
  is_received: boolean("is_received").default(false),
});

// ─── Price History ────────────────────────────────────────────────────────────

export const price_history = pgTable("price_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  investment_id: text("investment_id")
    .notNull()
    .references(() => investments.id),
  price: doublePrecision("price").notNull(), // in investment's native currency
  source_url: text("source_url"),
  fetched_at: text("fetched_at").$defaultFn(now),
});

// ─── Investment Value History ─────────────────────────────────────────────────

export const investment_value_history = pgTable("investment_value_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  investment_id: text("investment_id")
    .notNull()
    .references(() => investments.id),
  previous_value: doublePrecision("previous_value"),
  new_value: doublePrecision("new_value").notNull(),
  source: text("source").$type<"manual" | "price_refresh">().notNull(),
  notes: text("notes"),
  changed_at: text("changed_at").$defaultFn(now),
});

// ─── Investment Documents ──────────────────────────────────────────────────────

export const investment_documents = pgTable("investment_documents", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  investment_id: text("investment_id")
    .references(() => investments.id, { onDelete: "cascade" }),
  account_id: text("account_id")
    .references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  file_name: text("file_name").notNull(),
  file_size: integer("file_size").notNull(),
  mime_type: text("mime_type").notNull(),
  notes: text("notes"),
  created_at: text("created_at").$defaultFn(now),
  updated_at: text("updated_at").$defaultFn(now),
});

// ─── Exchange Rates ───────────────────────────────────────────────────────────

export const exchange_rates = pgTable("exchange_rates", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  from_currency: text("from_currency").notNull(), // e.g. "USD", "SGD", "NTD"
  rate_to_base: doublePrecision("rate_to_base").notNull(), // 1 unit of from_currency = rate_to_base base currency
  source: text("source"), // "web_search" | "manual"
  fetched_at: text("fetched_at").$defaultFn(now),
});

// ─── AI Conversations ─────────────────────────────────────────────────────────

export const ai_conversations = pgTable("ai_conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  title: text("title").notNull(),
  created_at: text("created_at").$defaultFn(now),
  updated_at: text("updated_at").$defaultFn(now),
});

// ─── AI Messages ──────────────────────────────────────────────────────────────

export const ai_messages = pgTable("ai_messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  conversation_id: text("conversation_id")
    .notNull()
    .references(() => ai_conversations.id),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  confidence: text("confidence").$type<"high" | "medium" | "low">(), // nullable
  sources_json: text("sources_json"), // nullable — JSON array of source citations
  created_at: text("created_at").$defaultFn(now),
});

// ─── AI Tool Calls ────────────────────────────────────────────────────────────

export const ai_tool_calls = pgTable("ai_tool_calls", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  message_id: text("message_id")
    .notNull()
    .references(() => ai_messages.id),
  tool_name: text("tool_name").notNull(),
  params_json: text("params_json").notNull(),
  result_json: text("result_json").notNull(),
  called_at: text("called_at").$defaultFn(now),
});

// ─── Budget Alerts ────────────────────────────────────────────────────────────

export const budget_alerts = pgTable("budget_alerts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  envelope_id: text("envelope_id")
    .notNull()
    .references(() => envelopes.id),
  type: text("type").$type<"over_budget" | "approaching">().notNull(),
  threshold_pct: doublePrecision("threshold_pct").notNull(),
  is_active: boolean("is_active").default(true),
  triggered_at: text("triggered_at"), // nullable
});

// ─── Recurring Transactions ───────────────────────────────────────────────────

export const recurring_transactions = pgTable("recurring_transactions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  payee: text("payee").notNull(),
  amount: doublePrecision("amount").notNull(),
  type: text("type").$type<"income" | "expense">().notNull(),
  account_id: text("account_id")
    .notNull()
    .references(() => accounts.id),
  envelope_id: text("envelope_id").references(() => envelopes.id),
  frequency: text("frequency")
    .$type<"weekly" | "monthly" | "quarterly" | "annual">()
    .notNull(),
  next_date: text("next_date").notNull(), // YYYY-MM-DD — when it will next fire
  end_date: text("end_date"), // nullable — stop generating after this date
  notes: text("notes"),
  is_active: boolean("is_active").default(true),
  created_at: text("created_at").$defaultFn(now),
});

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => nanoid()),
  username: text("username").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  created_at: text("created_at").$defaultFn(now),
});

// ─── App Settings ─────────────────────────────────────────────────────────────

export const app_settings = pgTable("app_settings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => "system"),
  base_currency: text("base_currency")
    .$type<"INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD">()
    .default("USD")
    .notNull(),
  updated_at: text("updated_at").$defaultFn(now),
});
