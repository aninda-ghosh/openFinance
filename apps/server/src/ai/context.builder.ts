import { desc } from "drizzle-orm";
import { getDb } from "../db/index";
import { transactions } from "../db/schema";
import { listAccounts, listEnvelopes } from "../services/budget.service";
import { getNetWorth } from "../services/dashboard.service";
import { getLatestRates } from "../services/exchange-rate.service";
import { listInvestments } from "../services/investment.service";
import { listPolicies } from "../services/policy.service";

function labelAssetType(t: string) {
  const map: Record<string, string> = {
    mutual_fund: "Mutual Fund",
    stock: "Stock",
    etf: "ETF",
    fixed_deposit: "Fixed Deposit",
    bond: "Bond",
    real_estate: "Real Estate",
    cash: "Cash",
    structured: "Structured Product",
    other: "Other",
  };
  return map[t] ?? t;
}

function labelAccountType(t: string) {
  const map: Record<string, string> = {
    checking: "Checking",
    savings: "Savings",
    investment: "Investment",
    credit: "Credit Card",
    loan: "Loan",
    other: "Other",
  };
  return map[t] ?? t;
}

function labelFrequency(f: string) {
  return f === "annual"
    ? "annually"
    : f === "quarterly"
      ? "quarterly"
      : "monthly";
}

const CURRENCY_LOCALE: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  NTD: "zh-TW",
  TWD: "zh-TW",
  GBP: "en-GB",
  EUR: "en-IE",
  SGD: "en-SG",
  JPY: "ja-JP",
};

function fmt(n: number, currency = "INR") {
  const locale = CURRENCY_LOCALE[currency] ?? "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}

// Convert an INR amount to display currency
function fromINR(
  inr: number,
  currency: string,
  rates: Record<string, number>
): number {
  if (currency === "INR") return inr;
  const rate = rates[currency];
  if (!rate) return inr;
  return inr / rate;
}

export async function buildSystemContext(
  displayCurrency = "INR"
): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  const [netWorth, accounts_, envelopes, investments, policies, rates] =
    await Promise.all([
      getNetWorth(),
      listAccounts(),
      listEnvelopes(currentMonth),
      listInvestments(),
      listPolicies(),
      getLatestRates(),
    ]);

  // Helper: format an INR value in display currency, with INR shown alongside if different
  const fmtDisplay = (inr: number) => {
    if (displayCurrency === "INR") return fmt(inr, "INR");
    const converted = fromINR(inr, displayCurrency, rates);
    return `${fmt(converted, displayCurrency)} (${fmt(inr, "INR")})`;
  };

  // Last 15 transactions
  const recentTxns = await db
    .select({
      date: transactions.date,
      payee: transactions.payee,
      amount: transactions.amount,
      type: transactions.type,
      notes: transactions.notes,
      account_id: transactions.account_id,
    })
    .from(transactions)
    .orderBy(desc(transactions.date))
    .limit(15);

  const accountNameById = Object.fromEntries(
    accounts_.map((a) => [a.id, `${a.name} (${a.currency})`])
  );
  const accountCurrencyById = Object.fromEntries(
    accounts_.map((a) => [a.id, a.currency as string])
  );

  const lines: string[] = [
    `=== YOUR FINANCIAL SNAPSHOT — ${today} ===`,
    `CURRENCY: All amounts below are in ${displayCurrency}${displayCurrency !== "INR" ? `. INR equivalents are shown in parentheses for reference only — always respond in ${displayCurrency}` : ""}. Do not convert or restate amounts in any other currency unless asked.`,
    "",
    `## Net Worth`,
    `Total net worth: ${fmtDisplay(netWorth.total_inr)}`,
    `  - Cash & Accounts: ${fmtDisplay(netWorth.breakdown.cash_inr)}`,
    `  - Investments: ${fmtDisplay(netWorth.breakdown.investments_inr)}`,
    `  - Insurance Policies: ${fmtDisplay(netWorth.breakdown.policies_inr)}`,
    `  - Debt: ${fmtDisplay(netWorth.breakdown.debt_inr)}`,
    "",
    `## Exchange Rates (to INR)`,
    Object.entries(rates)
      .map(([k, v]) => `  1 ${k} = ₹${v}`)
      .join("\n"),
    "",
    `## Bank & Savings Accounts`,
    ...(accounts_.length === 0
      ? ["  No accounts added."]
      : accounts_.map((a) => {
          const nativeLine = `${fmt(a.balance, a.currency)}${a.currency !== "INR" ? ` (${fmt(a.balance_inr, "INR")})` : ""}`;
          const displayLine =
            displayCurrency !== "INR" && displayCurrency !== a.currency
              ? ` = ${fmt(fromINR(a.balance_inr, displayCurrency, rates), displayCurrency)}`
              : "";
          return `  ${a.name} — ${labelAccountType(a.type)}, ${a.currency}\n    Balance: ${nativeLine}${displayLine}${a.is_active ? "" : " [Inactive]"}`;
        })),
    "",
    `## Budget for ${currentMonth}`,
    ...(envelopes.length === 0
      ? ["  No envelopes set up."]
      : (() => {
          const totalBudgeted = envelopes.reduce(
            (s, e) => s + e.budgeted_inr,
            0
          );
          const totalSpent = envelopes.reduce((s, e) => s + e.spent, 0);
          const totalAvailable = envelopes.reduce((s, e) => s + e.available, 0);
          return [
            `  >>> TOTALS: budgeted=${fmtDisplay(totalBudgeted)}, spent=${fmtDisplay(totalSpent)}, remaining=${fmtDisplay(totalAvailable)} <<<`,
            ...envelopes.map(
              (e) =>
                `  ${e.name}${e.group_name ? ` (${e.group_name})` : ""}: ` +
                `budgeted ${fmtDisplay(e.budgeted_inr)}, spent ${fmtDisplay(e.spent)}, available ${fmtDisplay(e.available)}`
            ),
          ];
        })()),
    "",
    `## Investments`,
    ...(investments.length === 0
      ? ["  No investments tracked."]
      : investments.map((i) => {
          const purchaseDisplay = fmtDisplay(
            i.purchase_value *
              (i.currency === "INR" ? 1 : (rates[i.currency] ?? 1))
          );
          const currentDisplay = fmtDisplay(i.current_value_inr);
          const gainDisplay = fmtDisplay(i.gain_loss_inr);
          return (
            `  ${i.name} — ${labelAssetType(i.asset_type)}, held in ${i.currency}` +
            `\n    Invested: ${fmt(i.purchase_value, i.currency)}${i.currency !== "INR" ? ` (${purchaseDisplay})` : ""}` +
            `\n    Current value: ${fmt(i.current_value, i.currency)}${i.currency !== "INR" ? ` (${currentDisplay})` : ""}` +
            `\n    Gain/Loss: ${gainDisplay} (${i.gain_loss_pct.toFixed(1)}%)`
          );
        })),
    "",
    `## Insurance & Savings Policies`,
    ...(policies.length === 0
      ? ["  No policies tracked."]
      : policies.map(
          (p) =>
            `  ${p.name} by ${p.provider}` +
            `\n    Premium: ${fmtDisplay(p.premium_amount)} paid ${labelFrequency(p.premium_frequency)}` +
            `\n    Sum Assured: ${fmtDisplay(p.sum_assured)} | Maturity Value: ${fmtDisplay(p.maturity_value ?? 0)} on ${p.maturity_date}`
        )),
    "",
    `## Recent Transactions (last 15)`,
    ...(recentTxns.length === 0
      ? ["  No transactions yet."]
      : recentTxns.map((t) => {
          const txnCurrency = accountCurrencyById[t.account_id] ?? "INR";
          const txnAmountNative = fmt(Math.abs(t.amount), txnCurrency);
          const txnAmountDisplay =
            displayCurrency !== txnCurrency
              ? ` (${fmtDisplay(Math.abs(t.amount) * (txnCurrency === "INR" ? 1 : (rates[txnCurrency] ?? 1)))})`
              : "";
          return `  ${t.date} | ${t.type} | ${accountNameById[t.account_id] ?? "Unknown"} | ${t.payee} | ${txnAmountNative}${txnAmountDisplay}${t.notes ? ` — ${t.notes}` : ""}`;
        })),
    "",
    `=== END OF SNAPSHOT ===`,
  ];

  return lines.join("\n");
}
