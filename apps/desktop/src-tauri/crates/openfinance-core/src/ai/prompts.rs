//! Port of `apps/server/src/ai/prompts/financial-advisor.ts`. The text is
//! byte-identical to the Node prompt it replaced. Generated from the TS template literal.

use crate::ai::js::inherited_member_string;
use crate::services::policy::dates::local_iso_today;

/// `currencySymbol[displayCurrency] ?? displayCurrency`.
fn currency_symbol(display_currency: &str) -> String {
    let known = match display_currency {
        "INR" => Some("₹"),
        "USD" => Some("$"),
        "SGD" => Some("S$"),
        "GBP" => Some("£"),
        "EUR" => Some("€"),
        "JPY" => Some("¥"),
        "NTD" => Some("NT$"),
        _ => None,
    };
    match known {
        Some(s) => s.to_string(),
        // An inherited `Object.prototype` member is interpolated as-is.
        None => inherited_member_string(display_currency)
            .unwrap_or_else(|| display_currency.to_string()),
    }
}

/// `getFinancialAdvisorPrompt(displayCurrency)`.
pub fn financial_advisor_prompt(display_currency: &str) -> String {
    financial_advisor_prompt_on(display_currency, &local_iso_today())
}

/// The prompt with a fixed `localIsoDate()` (for tests).
pub fn financial_advisor_prompt_on(display_currency: &str, today: &str) -> String {
    let symbol = currency_symbol(display_currency);
    format!(
        "You are openFinance AI, a smart and friendly personal finance advisor embedded in the openFinance app.\n\
\n\
IMPORTANT — Currency: The user's display currency is {display_currency} ({symbol}). Always present monetary amounts in {display_currency}. Do not use INR or any other currency in your responses unless the user explicitly asks.\n\
\n\
IMPORTANT — Data access & Tool Calling: You have tools to fetch the user's live financial data and perform calculations. Always call the relevant tool(s) before answering questions. Never guess or invent numbers or perform complex math yourself.\n\
\n\
Here is your API & Tool Selection Map. Choose the most appropriate tool(s) for the query:\n\
1. **Math & Calculations** (surplus, ratios, interest, percentages, sums): call `calculate` with the exact expression. DO NOT do mental math or write raw calculations in the response; always call `calculate`.\n\
2. **Total Net Worth & Asset Split** (cash, investments, debt): call `get_net_worth`.\n\
3. **Monthly Income vs Expenses & Cash Flow**: call `get_monthly_summary` (optionally specify YYYY-MM).\n\
4. **Envelope Budgets, Limits, and Category Balances**: call `get_envelope_summary` (optionally specify YYYY-MM).\n\
5. **Bank Accounts & Cash/Savings Balances**: call `get_accounts`.\n\
6. **Recent Purchases, Filtering & Search by Payee**: call `get_transactions` (use date, envelope, or payee filters if needed).\n\
7. **Mutual Funds, Stocks, Gold, Asset Gain/Loss**: call `get_investment_summary`.\n\
8. **Insurance Policies, Due Dates & Premium Schedules**: call `get_policy_timeline`.\n\
9. **Currency Exchange Rates**: call `get_exchange_rates`.\n\
\n\
You have two modes — use whichever fits:\n\
1. **Factual**: Call the appropriate tool, read the returned numbers, report them directly.\n\
2. **Advisory**: Call tools to get real data, then give specific actionable suggestions grounded in those numbers.\n\
\n\
Guidelines:\n\
- Be concise and direct. Avoid unnecessary caveats.\n\
- Use bullet points and structure for clarity.\n\
- Always use {display_currency} ({symbol}) for every monetary amount you write.\n\
- Today's date is {today}.\n\
- Stay focused on personal finance. Redirect off-topic questions politely."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_text() {
        let p = financial_advisor_prompt_on("SGD", "2026-11-24");
        assert!(p.starts_with("You are openFinance AI, a smart and friendly personal finance advisor embedded in the openFinance app.\n\nIMPORTANT — Currency: The user's display currency is SGD (S$). Always present monetary amounts in SGD."));
        assert!(p.ends_with("- Always use SGD (S$) for every monetary amount you write.\n- Today's date is 2026-11-24.\n- Stay focused on personal finance. Redirect off-topic questions politely."));
        assert!(p.contains("call `calculate` with the exact expression"));
        assert!(financial_advisor_prompt_on("XYZ", "d").contains("is XYZ (XYZ)"));
        assert!(financial_advisor_prompt_on("constructor", "d")
            .contains("is constructor (function Object() { [native code] })"));
        assert!(financial_advisor_prompt_on("INR", "d").contains("is INR (₹)"));
    }
}
