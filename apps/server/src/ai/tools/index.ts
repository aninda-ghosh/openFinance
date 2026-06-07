import { TransactionFiltersSchema } from "@openfinance/shared/schemas";
import {
  getMonthlySummary,
  listAccounts,
  listEnvelopes,
  listTransactions,
} from "../../services/budget.service";
import { getNetWorth } from "../../services/dashboard.service";
import {
  getLatestRates,
  refreshFromWeb,
} from "../../services/exchange-rate.service";
import {
  listInvestments,
  refreshPrice,
} from "../../services/investment.service";
import { getTimeline } from "../../services/policy.service";
import { safeEvaluate } from "./calculator";

// ─── Tool definitions (Ollama tool-calling format) ────────────────────────────

export const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_net_worth",
      description:
        "Get total net worth and breakdown across cash/accounts, investments, policies, and debt. Use this for overall asset breakdowns or total net worth queries.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_envelope_summary",
      description:
        "Get budget envelopes for a given month: total budgeted, spent, remaining, and per-category breakdown. Use this for queries about budget limits, category spending, budgeted amounts, or envelope remaining funds.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "YYYY-MM format, e.g. 2026-05. Defaults to current month.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_monthly_summary",
      description:
        "Get total income, total expenses, and net cash flow for a specific month. Use this for overall monthly budget surplus/deficit, income/expense totals, or savings rate questions.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description: "YYYY-MM format. Defaults to current month.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_accounts",
      description: "Get all bank and savings accounts with active balances. Use this for bank names, account types, or individual bank balances.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transactions",
      description: "Get recent transactions with optional filters. Use this to search by payee, find recent purchases, or filter transactions by account, category, or date range.",
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Filter by account ID" },
          envelope_id: { type: "string", description: "Filter by envelope ID" },
          date_from: { type: "string", description: "ISO date YYYY-MM-DD" },
          date_to: { type: "string", description: "ISO date YYYY-MM-DD" },
          limit: { type: "number", description: "Max results, default 20" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_investment_summary",
      description:
        "Get all investments with purchase value, current value, gains/losses, units, and asset type. Use this for mutual funds, stocks, gold, portfolio performance, or investment list.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_policy_timeline",
      description:
        "Get insurance premium due dates, payouts, and maturity events. Use this for insurance policy details, premium schedules, or upcoming policy payouts.",
      parameters: {
        type: "object",
        properties: {
          years: {
            type: "number",
            description: "How many years ahead to look, default 5",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_exchange_rates",
      description: "Get latest currency exchange rates (all currencies converted to INR). Use this to get foreign exchange conversion rates.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_investment_price",
      description: "Fetch live market price for an investment. Use this when the user asks to update or refresh investment performance.",
      parameters: {
        type: "object",
        properties: {
          investment_id: {
            type: "string",
            description: "ID of the investment to refresh",
          },
        },
        required: ["investment_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_exchange_rates",
      description: "Fetch latest exchange rates from the web. Use this to update currency values to their latest market value.",
      parameters: {
        type: "object",
        properties: {
          currency: {
            type: "string",
            description:
              "Specific currency to refresh (USD, SGD, NTD). Leave empty to refresh all.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Perform basic mathematical calculations like interest, budget allocations, percentages, sums, or conversions. Accepts mathematical expressions containing only numbers and operators +, -, *, /, (, ). DO NOT attempt math inside regular responses, always use this tool.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "The mathematical expression to evaluate, e.g. '120000 * 0.15' or '3 * (120000 - 45000)'",
          },
        },
        required: ["expression"],
      },
    },
  },
];

// ─── Formatting helpers ───────────────────────────────────────────────────────

const CURRENCY_LOCALE: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  SGD: "en-SG",
  GBP: "en-GB",
  EUR: "en-IE",
  JPY: "ja-JP",
  NTD: "zh-TW",
};

function fmt(n: number, currency: string) {
  const locale = CURRENCY_LOCALE[currency] ?? "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "JPY" ? 0 : 0,
  }).format(n);
}

function fmtDisplay(
  inrAmount: number,
  displayCurrency: string,
  rates: Record<string, number>
): string {
  if (displayCurrency === "INR") return fmt(inrAmount, "INR");
  const rate = rates[displayCurrency];
  if (!rate) return fmt(inrAmount, "INR");
  const converted = inrAmount / rate;
  return fmt(converted, displayCurrency);
}

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  displayCurrency = "INR"
): Promise<string> {
  const rates = await getLatestRates();
  const d = (inr: number) => fmtDisplay(inr, displayCurrency, rates);

  switch (name) {
    case "get_net_worth": {
      const nw = await getNetWorth();
      return [
        `Net Worth: ${d(nw.total_inr)}`,
        `  Cash & Accounts: ${d(nw.breakdown.cash_inr)}`,
        `  Investments:      ${d(nw.breakdown.investments_inr)}`,
        `  Policies:         ${d(nw.breakdown.policies_inr)}`,
        `  Debt:             ${d(nw.breakdown.debt_inr)}`,
      ].join("\n");
    }

    case "get_envelope_summary": {
      const month = String(
        params.month ?? new Date().toISOString().slice(0, 7)
      );
      const envelopes = await listEnvelopes(month);
      if (envelopes.length === 0) return `No budget envelopes for ${month}.`;
      const totalBudgeted = envelopes.reduce((s, e) => s + e.budgeted_inr, 0);
      const totalSpent = envelopes.reduce((s, e) => s + e.spent, 0);
      const totalAvailable = envelopes.reduce((s, e) => s + e.available, 0);
      const lines = [
        `Budget for ${month}:`,
        `  Total budgeted: ${d(totalBudgeted)}`,
        `  Total spent:    ${d(totalSpent)}`,
        `  Total remaining:${d(totalAvailable)}`,
        "",
        "Per category:",
        ...envelopes.map(
          (e) =>
            `  ${e.name}${e.group_name ? ` (${e.group_name})` : ""}: budgeted ${d(e.budgeted_inr)}, spent ${d(e.spent)}, remaining ${d(e.available)}`
        ),
      ];
      return lines.join("\n");
    }

    case "get_monthly_summary": {
      const month = String(
        params.month ?? new Date().toISOString().slice(0, 7)
      );
      const s = await getMonthlySummary(month);
      return [
        `Monthly summary for ${month}:`,
        `  Income:   ${d(s.total_income)}`,
        `  Expenses: ${d(s.total_expenses)}`,
        `  Net:      ${d(s.net)}`,
      ].join("\n");
    }

    case "get_accounts": {
      const accs = await listAccounts();
      if (accs.length === 0) return "No accounts found.";
      return accs
        .map((a) => {
          const native = fmt(a.balance, a.currency as string);
          const display =
            displayCurrency !== a.currency ? ` (${d(a.balance_inr)})` : "";
          return `${a.name} [${a.type}, ${a.currency}]: ${native}${display}${a.is_active ? "" : " — Inactive"}`;
        })
        .join("\n");
    }

    case "get_transactions": {
      const filters = TransactionFiltersSchema.parse({
        account_id: params.account_id,
        envelope_id: params.envelope_id,
        date_from: params.date_from,
        date_to: params.date_to,
        limit: params.limit ?? 20,
      });
      const response = await listTransactions(filters);
      const txns = response.transactions;
      if (txns.length === 0) return "No transactions found.";
      return txns
        .map(
          (t) =>
            `${t.date} | ${t.type} | ${t.payee} | ${fmt(Math.abs(t.amount), t.currency)}${t.notes ? ` — ${t.notes}` : ""}`
        )
        .join("\n");
    }

    case "get_investment_summary": {
      const investments = await listInvestments();
      if (investments.length === 0) return "No investments tracked.";
      return investments
        .map(
          (i) =>
            `${i.name} (${i.asset_type}): invested ${fmt(i.purchase_value, i.currency)}, current ${fmt(i.current_value, i.currency)}, gain/loss ${d(i.gain_loss_inr)} (${i.gain_loss_pct.toFixed(1)}%)`
        )
        .join("\n");
    }

    case "get_policy_timeline": {
      const years = Number(params.years ?? 5);
      const events = await getTimeline(years);
      if (events.length === 0)
        return `No policy events in the next ${years} years.`;
      return events
        .map(
          (e) =>
            `${e.date} | ${e.label} | ${e.policy_name} | ${d(e.amount ?? 0)}`
        )
        .join("\n");
    }

    case "get_exchange_rates": {
      const r = await getLatestRates();
      return Object.entries(r)
        .map(([k, v]) => `1 ${k} = ₹${v}`)
        .join("\n");
    }

    case "refresh_investment_price": {
      const investment_id = String(params.investment_id ?? "");
      if (!investment_id) throw new Error("investment_id is required");
      const result = await refreshPrice(investment_id);
      return `Updated: ${JSON.stringify(result)}`;
    }

    case "refresh_exchange_rates": {
      const currency = params.currency ? String(params.currency) : undefined;
      const result = await refreshFromWeb(currency);
      return `Updated rates: ${JSON.stringify(result)}`;
    }

    case "calculate": {
      const expression = String(params.expression ?? "");
      if (!expression) throw new Error("expression is required for calculation");
      try {
        const result = safeEvaluate(expression);
        return `Calculation Result: ${result}`;
      } catch (err: any) {
        return `Error in calculation: ${err.message}`;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
