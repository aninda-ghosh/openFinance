//! The drizzle table definitions (`db/schema.ts`) the backup routes need:
//! column order (what `db.select()` returns and `insert()` lists), which
//! columns are `mode: "boolean"`, and each column's insert default.

/// What drizzle inserts for a column missing from a row object.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Default {
    /// No default: the literal `null` (not a bound parameter).
    Null,
    /// `.$defaultFn(() => nanoid())`.
    Nanoid,
    /// `.$defaultFn(now)`: `new Date().toISOString()`.
    Now,
    /// `.default("INR")` etc.: a bound string.
    Text(&'static str),
    /// `.default(0)`: a bound JS number (a double).
    Number(f64),
    /// `.default(true|false)` on a boolean column: bound as 1 / 0.
    Bool(bool),
}

#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub name: &'static str,
    /// `integer(..., { mode: "boolean" })`.
    pub boolean: bool,
    pub default: Default,
}

const fn c(name: &'static str) -> Column {
    Column {
        name,
        boolean: false,
        default: Default::Null,
    }
}

const fn d(name: &'static str, default: Default) -> Column {
    Column {
        name,
        boolean: false,
        default,
    }
}

const fn b(name: &'static str, value: bool) -> Column {
    Column {
        name,
        boolean: true,
        default: Default::Bool(value),
    }
}

const ID: Column = d("id", Default::Nanoid);
const INR: Default = Default::Text("INR");
const ZERO: Default = Default::Number(0.0);

#[derive(Debug, Clone, Copy)]
pub struct Table {
    pub name: &'static str,
    pub columns: &'static [Column],
}

pub const ACCOUNTS: Table = Table {
    name: "accounts",
    columns: &[
        ID,
        c("name"),
        c("type"),
        d("currency", INR),
        d("balance", ZERO),
        c("institution"),
        b("is_active", true),
        b("off_budget", false),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const ENVELOPE_GROUPS: Table = Table {
    name: "envelope_groups",
    columns: &[ID, c("name"), d("sort_order", ZERO), d("created_at", Default::Now)],
};

pub const ENVELOPES: Table = Table {
    name: "envelopes",
    columns: &[
        ID,
        c("group_id"),
        c("name"),
        d("budgeted", ZERO),
        d("budget_currency", INR),
        d("spent", ZERO),
        c("month"),
        d("rollover_type", Default::Text("none")),
        d("rollover_amount", ZERO),
        d("created_at", Default::Now),
    ],
};

pub const TRANSACTIONS: Table = Table {
    name: "transactions",
    columns: &[
        ID,
        c("account_id"),
        c("envelope_id"),
        c("payee"),
        c("amount"),
        c("type"),
        c("date"),
        c("notes"),
        c("import_hash"),
        c("income_category"),
        c("transfer_pair_id"),
        d("created_at", Default::Now),
    ],
};

pub const INVESTMENTS: Table = Table {
    name: "investments",
    columns: &[
        ID,
        c("name"),
        c("asset_type"),
        d("currency", INR),
        c("purchase_value"),
        c("units"),
        c("purchase_date"),
        c("current_value"),
        c("current_value_source"),
        c("current_value_at"),
        c("notes"),
        c("account_id"),
        c("maturity_date"),
        c("depreciation_rate"),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const POLICIES: Table = Table {
    name: "policies",
    columns: &[
        ID,
        c("name"),
        c("provider"),
        c("policy_number"),
        d("currency", INR),
        c("start_date"),
        c("premium_amount"),
        c("premium_frequency"),
        c("premium_term_years"),
        c("policy_term_years"),
        c("maturity_date"),
        c("sum_assured"),
        c("maturity_value"),
        c("surrender_value"),
        c("notes"),
        c("account_id"),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const POLICY_PAYOUTS: Table = Table {
    name: "policy_payouts",
    columns: &[
        ID,
        c("policy_id"),
        c("payout_date"),
        c("amount"),
        c("label"),
        b("is_received", false),
    ],
};

pub const LIFE_INSURANCE: Table = Table {
    name: "life_insurance",
    columns: &[
        ID,
        c("name"),
        c("insured_person"),
        c("provider"),
        c("policy_number"),
        d("currency", INR),
        c("coverage_amount"),
        c("renewal_date"),
        c("premium_amount"),
        c("premium_frequency"),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const PRICE_HISTORY: Table = Table {
    name: "price_history",
    columns: &[
        ID,
        c("investment_id"),
        c("price"),
        c("source_url"),
        d("fetched_at", Default::Now),
    ],
};

pub const INVESTMENT_VALUE_HISTORY: Table = Table {
    name: "investment_value_history",
    columns: &[
        ID,
        c("investment_id"),
        c("previous_value"),
        c("new_value"),
        d("contribution", ZERO),
        c("source"),
        c("notes"),
        d("changed_at", Default::Now),
    ],
};

pub const INVESTMENT_DOCUMENTS: Table = Table {
    name: "investment_documents",
    columns: &[
        ID,
        c("investment_id"),
        c("account_id"),
        c("life_insurance_id"),
        c("name"),
        c("file_name"),
        c("file_size"),
        c("mime_type"),
        c("notes"),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const EXCHANGE_RATES: Table = Table {
    name: "exchange_rates",
    columns: &[
        ID,
        c("from_currency"),
        c("rate_to_base"),
        c("source"),
        d("fetched_at", Default::Now),
    ],
};

pub const AI_CONVERSATIONS: Table = Table {
    name: "ai_conversations",
    columns: &[
        ID,
        c("title"),
        d("created_at", Default::Now),
        d("updated_at", Default::Now),
    ],
};

pub const AI_MESSAGES: Table = Table {
    name: "ai_messages",
    columns: &[
        ID,
        c("conversation_id"),
        c("role"),
        c("content"),
        c("confidence"),
        c("sources_json"),
        d("created_at", Default::Now),
    ],
};

pub const AI_TOOL_CALLS: Table = Table {
    name: "ai_tool_calls",
    columns: &[
        ID,
        c("message_id"),
        c("tool_name"),
        c("params_json"),
        c("result_json"),
        d("called_at", Default::Now),
    ],
};

pub const BUDGET_ALERTS: Table = Table {
    name: "budget_alerts",
    columns: &[
        ID,
        c("envelope_id"),
        c("type"),
        c("threshold_pct"),
        b("is_active", true),
        c("triggered_at"),
    ],
};

pub const RECURRING_TRANSACTIONS: Table = Table {
    name: "recurring_transactions",
    columns: &[
        ID,
        c("payee"),
        c("amount"),
        c("type"),
        c("account_id"),
        c("envelope_id"),
        c("frequency"),
        c("next_date"),
        c("anchor_day"),
        c("end_date"),
        c("notes"),
        b("is_active", true),
        d("created_at", Default::Now),
    ],
};

/// `backupData.data` keys in export order, with their tables.
pub const EXPORT_ORDER: [Table; 17] = [
    ACCOUNTS,
    ENVELOPE_GROUPS,
    ENVELOPES,
    TRANSACTIONS,
    BUDGET_ALERTS,
    RECURRING_TRANSACTIONS,
    INVESTMENTS,
    PRICE_HISTORY,
    POLICIES,
    POLICY_PAYOUTS,
    EXCHANGE_RATES,
    AI_CONVERSATIONS,
    AI_MESSAGES,
    AI_TOOL_CALLS,
    INVESTMENT_VALUE_HISTORY,
    INVESTMENT_DOCUMENTS,
    LIFE_INSURANCE,
];

/// The FK-safe insert order of the import.
pub const INSERT_ORDER: [Table; 17] = [
    EXCHANGE_RATES,
    ACCOUNTS,
    ENVELOPE_GROUPS,
    ENVELOPES,
    TRANSACTIONS,
    BUDGET_ALERTS,
    RECURRING_TRANSACTIONS,
    INVESTMENTS,
    PRICE_HISTORY,
    INVESTMENT_VALUE_HISTORY,
    LIFE_INSURANCE,
    INVESTMENT_DOCUMENTS,
    POLICIES,
    POLICY_PAYOUTS,
    AI_CONVERSATIONS,
    AI_MESSAGES,
    AI_TOOL_CALLS,
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Every listed column exists in the bootstrapped schema.
    #[test]
    fn columns_exist() {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&conn).expect("bootstrap");
        for t in EXPORT_ORDER {
            let cols = t
                .columns
                .iter()
                .map(|c| format!("\"{}\"", c.name))
                .collect::<Vec<_>>()
                .join(", ");
            conn.prepare(&format!("select {cols} from \"{}\"", t.name))
                .unwrap_or_else(|e| panic!("{}: {e}", t.name));
        }
        let mut names: Vec<&str> = INSERT_ORDER.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let mut export: Vec<&str> = EXPORT_ORDER.iter().map(|t| t.name).collect();
        export.sort_unstable();
        assert_eq!(names, export);
    }
}
