import type { DashboardResponse } from "@openfinance/shared/api-contracts";
import {
  balanceDelta,
  bearsHoldings,
  isLiabilityType,
} from "@openfinance/shared/constants";
import { and, eq, gt, gte, lte, or } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  accounts,
  envelope_groups,
  envelopes,
  policies,
  transactions,
} from "../db/schema";
import {
  computeCarryoverForMonth,
  getAccountBalances,
  listAccounts,
  listEnvelopes,
} from "./budget.service";
import { getLatestRates } from "./exchange-rate.service";
import { listInvestments } from "./investment.service";
import { computeInvestedAt } from "./policy.service";

// ─── Net Worth ────────────────────────────────────────────────────────────────
//
// There is exactly ONE net-worth formula: `computeNetWorthAt(asOf, ctx)`.
// `getNetWorth()` is that formula evaluated today and `getNetWorthHistory()` is
// the same formula evaluated at a series of month-ends, so the headline figure,
// the last point of the history chart and the Accounts page tile cannot drift
// apart. They previously disagreed in three ways: the history recomputed
// balances from the *stored* `accounts.balance` column (an opening balance, not
// a live one), it silently dropped every off-budget asset account, and it
// valued unlinked policies at their whole-term premium total in every month.
//
// The anchor is `getAccountBalances()` — the same derivation `listAccounts()`
// returns. A past date is reached by rolling that live balance BACKWARDS over
// the transactions dated after it, so "today" needs no rollback at all and is
// identical to what the account cards show.

/** Local-calendar YYYY-MM-DD, matching how the month loops build their keys. */
function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type NetWorthAccount = {
  id: string;
  type: string;
  currency: string;
  off_budget: boolean;
  is_active: boolean;
  /** Live derived balance, native currency, holdings included. */
  liveNative: number;
  /** The linked-holdings term of `liveNative`, native currency. */
  holdingsNative: number;
};

type NetWorthTxn = {
  date: string;
  type: string;
  payee: string;
  amount: number;
};

/**
 * Everything `computeNetWorthAt` reads, loaded once. Hoisted out of the
 * computation so evaluating N month-ends costs O(1) queries, not O(N).
 */
export type NetWorthContext = {
  /** Earliest date this context can answer for; see `loadNetWorthContext`. */
  since: string;
  accounts: NetWorthAccount[];
  /** Only transactions dated AFTER `since` — that is all a rollback needs. */
  txnsByAccount: Map<string, NetWorthTxn[]>;
  investments: { account_id: string | null; purchase_date: string; current_value_inr: number }[];
  policies: (typeof policies.$inferSelect)[];
  rates: Record<string, number>;
};

/**
 * Loads the shared inputs for one or more net-worth snapshots.
 *
 * `since` is the earliest date that will be asked for. Because a snapshot is
 * produced by rolling the live balance back over later transactions, only
 * transactions dated after `since` are ever needed — asking for today therefore
 * reads (usually zero) future-dated rows rather than the whole ledger.
 */
export async function loadNetWorthContext(
  since: string
): Promise<NetWorthContext> {
  const db = getDb();

  const [rates, balances, invList] = await Promise.all([
    getLatestRates(),
    getAccountBalances(),
    listInvestments(),
  ]);

  const accountRows = await db.select().from(accounts);
  const policyRows = await db.select().from(policies);
  const txnRows = await db
    .select({
      account_id: transactions.account_id,
      amount: transactions.amount,
      type: transactions.type,
      payee: transactions.payee,
      date: transactions.date,
    })
    .from(transactions)
    .where(gt(transactions.date, since));

  const txnsByAccount = new Map<string, NetWorthTxn[]>();
  let orphanLegs = 0;
  for (const t of txnRows) {
    if (!t.account_id) continue;
    // An orphan transfer leg (payee is neither direction) has no signed effect
    // on a balance, so `getAccountBalances` leaves it out of the live figure.
    // Leave it out of the rollback too — dropping it here and there is what
    // keeps the two consistent — but say that it happened.
    if (balanceDelta(t) === null) {
      orphanLegs++;
      continue;
    }
    const list = txnsByAccount.get(t.account_id);
    if (list) list.push(t);
    else txnsByAccount.set(t.account_id, [t]);
  }
  if (orphanLegs > 0) {
    console.error(
      `[net-worth] ${orphanLegs} transfer row(s) have no direction and are ` +
        `excluded from historical rollback (same as the live balance)`
    );
  }

  return {
    since,
    accounts: accountRows.map((r) => {
      const parts = balances.get(r.id);
      return {
        id: r.id,
        type: r.type,
        currency: r.currency ?? "INR",
        off_budget: r.off_budget ?? false,
        is_active: r.is_active ?? true,
        liveNative: parts?.native ?? 0,
        holdingsNative: parts?.holdingsNative ?? 0,
      };
    }),
    txnsByAccount,
    investments: invList.map((i) => ({
      account_id: i.account_id,
      purchase_date: i.purchase_date,
      current_value_inr: i.current_value_inr,
    })),
    policies: policyRows,
    rates,
  };
}

export type NetWorthSnapshot = {
  as_of: string;
  total_inr: number;
  breakdown: {
    /** On-budget asset accounts, holdings excluded. */
    cash_inr: number;
    /** Investment holdings + the cash sleeve of off-budget asset accounts. */
    investments_inr: number;
    policies_inr: number;
    /** Negative: liabilities reduce net worth. */
    debt_inr: number;
    /** Holdings alone — the `investments` table. Included in investments_inr. */
    holdings_inr: number;
    /** Off-budget asset cash alone. Included in investments_inr. */
    off_budget_cash_inr: number;
  };
};

/**
 * The one net-worth formula.
 *
 * Decisions baked in here, all of which apply identically to every date:
 *
 * - **Off-budget asset accounts count.** They are real assets. They land in
 *   `investments_inr` (the "stash" bucket), which is where the current figure
 *   has always put them and what `getPortfolioBreakdown` assumes; the history
 *   used to drop them entirely, which is what made an off-budget savings
 *   account visible in the headline number and absent from the chart.
 * - **No `Math.max(0, …)` floor on the cash sleeve.** The old floor was there
 *   to defend against double-counting linked holdings, but the holdings term is
 *   now exact (`getAccountBalances().holdingsNative`), so a negative sleeve is
 *   never a double-count artefact — it is a genuinely overdrawn account, and
 *   net worth must show it.
 * - **Policies are valued as of the date**, not at their whole-term premium
 *   total. An unlinked policy is worth the premiums actually paid by `asOf`
 *   (the same number the Policies page shows); a linked policy is worth its
 *   account balance rolled back to `asOf`.
 * - **Holdings a user did not own yet do not count.** An `investments` row
 *   contributes nothing before its `purchase_date`. There is no price history,
 *   so on/after that date it contributes its current value — an approximation,
 *   but a far smaller one than back-dating the whole portfolio.
 */
export function computeNetWorthAt(
  asOf: string,
  ctx: NetWorthContext
): NetWorthSnapshot {
  if (asOf < ctx.since) {
    throw new Error(
      `net-worth context was loaded for dates >= ${ctx.since}, cannot answer ${asOf}`
    );
  }

  const toInr = (amount: number, currency: string) =>
    amount * (ctx.rates[currency] ?? 1.0);

  // Rolling the live balance back over everything dated after `asOf`. Summed by
  // filtering rather than by breaking out of a sorted scan, so the result does
  // not depend on the order the query happened to return rows in.
  const nativeAt = (acc: NetWorthAccount) => {
    let after = 0;
    for (const t of ctx.txnsByAccount.get(acc.id) ?? []) {
      if (t.date <= asOf) continue;
      after += balanceDelta(t) ?? 0; // nulls were dropped at load time
    }
    return acc.liveNative - after;
  };

  // An account a policy points at is valued as a policy, never as cash, even if
  // it is not of type `policy` — otherwise it counts twice.
  const policyAccountIds = new Set(
    ctx.policies.map((p) => p.account_id).filter((id): id is string => !!id)
  );

  let cashInr = 0;
  let offBudgetCashInr = 0;
  let debtInr = 0;
  const policyAccountInr = new Map<string, number>();

  for (const acc of ctx.accounts) {
    if (!acc.is_active) continue;
    const balanceInr = toInr(nativeAt(acc), acc.currency);

    if (isLiabilityType(acc.type)) {
      // Stored sign is normalised to negative by `getAccountBalances`, so a
      // liability always subtracts its magnitude regardless of how it was saved.
      debtInr += balanceInr;
      continue;
    }
    if (acc.type === "policy" || policyAccountIds.has(acc.id)) {
      policyAccountInr.set(acc.id, balanceInr);
      continue;
    }

    // Holdings are counted once, from the investments table, so the account
    // contributes only its cash sleeve.
    const sleeveInr = balanceInr - toInr(acc.holdingsNative, acc.currency);
    if (acc.off_budget) offBudgetCashInr += sleeveInr;
    else cashInr += sleeveInr;
  }

  const holdingsInr = ctx.investments
    .filter((i) => i.purchase_date <= asOf)
    .reduce((s, i) => s + i.current_value_inr, 0);

  let policiesInr = 0;
  const valuedPolicyAccounts = new Set<string>();
  for (const p of ctx.policies) {
    const linked = p.account_id ? policyAccountInr.get(p.account_id) : undefined;
    if (linked !== undefined) {
      policiesInr += linked;
      valuedPolicyAccounts.add(p.account_id as string);
      continue;
    }
    // No linked account (or it was deleted/deactivated): value the premiums
    // actually paid by `asOf`.
    policiesInr += toInr(computeInvestedAt(p, asOf), p.currency ?? "INR");
  }
  // A `policy` account with no policy row left pointing at it is still a real
  // balance; count it rather than dropping it.
  for (const [id, value] of policyAccountInr) {
    if (!valuedPolicyAccounts.has(id)) policiesInr += value;
  }

  const investmentsInr = holdingsInr + offBudgetCashInr;

  return {
    as_of: asOf,
    total_inr: cashInr + investmentsInr + policiesInr + debtInr,
    breakdown: {
      cash_inr: cashInr,
      investments_inr: investmentsInr,
      policies_inr: policiesInr,
      debt_inr: debtInr,
      holdings_inr: holdingsInr,
      off_budget_cash_inr: offBudgetCashInr,
    },
  };
}

/**
 * Net worth right now. Identical by construction to the last point of
 * `getNetWorthHistory`, which clamps its final month-end to today.
 */
export async function getNetWorth(
  ctx?: NetWorthContext
): Promise<NetWorthSnapshot> {
  const today = isoDate(new Date());
  return computeNetWorthAt(today, ctx ?? (await loadNetWorthContext(today)));
}

// ─── Portfolio Breakdown ───────────────────────────────────────────────────────

export async function getPortfolioBreakdown() {
  const [invList, allAccounts, balances] = await Promise.all([
    listInvestments(),
    listAccounts(),
    getAccountBalances(),
  ]);

  const byType: Record<string, number> = {};

  for (const inv of invList) {
    byType[inv.asset_type] =
      (byType[inv.asset_type] ?? 0) + inv.current_value_inr;
  }

  // Include the cash sleeve of off-budget asset accounts — the same bucket
  // `computeNetWorthAt` folds into `investments_inr`. The sleeve comes from the
  // shared balance derivation rather than a second holdings subtraction here.
  for (const acc of allAccounts) {
    if (!acc.is_active || !acc.off_budget || !bearsHoldings(acc.type)) continue;
    const parts = balances.get(acc.id);
    const cashValInr = (parts?.base ?? 0) - (parts?.holdingsBase ?? 0);
    // A pie chart cannot render a negative slice; an overdrawn off-budget
    // account is reported by net worth, not here.
    if (cashValInr > 0) {
      byType[acc.type] = (byType[acc.type] ?? 0) + cashValInr;
    }
  }

  const total = Object.values(byType).reduce((s, v) => s + v, 0);

  return Object.entries(byType).map(([asset_type, value_inr]) => ({
    asset_type,
    value_inr,
    percentage: total > 0 ? Math.round((value_inr / total) * 10000) / 100 : 0,
  }));
}

// ─── Budget Heatmap ───────────────────────────────────────────────────────────

export async function getBudgetHeatmap(months: number) {
  const rows: { month: string; envelope_name: string; spend_pct: number }[] =
    [];
  const today = new Date();

  for (let i = 0; i < months; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const envelopes = await listEnvelopes(month);
    for (const env of envelopes) {
      const spendPct = env.budgeted > 0 ? (env.spent / env.budgeted) * 100 : 0;
      rows.push({
        month,
        envelope_name: env.name,
        spend_pct: Math.round(spendPct * 10) / 10,
      });
    }
  }

  return rows;
}

// ─── Top Movers ───────────────────────────────────────────────────────────────

export async function getTopMovers(_days: number, limit: number) {
  const invList = await listInvestments({ sort: "gain_desc" });
  return invList.slice(0, limit).map((inv) => ({
    investment: inv,
    gain_loss_inr: inv.gain_loss_inr,
    gain_loss_pct: inv.gain_loss_pct,
  }));
}

// ─── Spending Trends ──────────────────────────────────────────────────────────

export async function getSpendingTrends(
  months = 6
): Promise<{ month: string; income: number; expenses: number }[]> {
  const today = new Date();
  const promises = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    promises.push(
      getCashFlow(month).then((cf) => {
        const savingsGroup = cf.expense_groups.find(
          (g) => g.group_name.toLowerCase() === "savings"
        );
        const savingsGroupTotal = savingsGroup ? savingsGroup.total : 0;
        const livingExpenses = cf.total_expenses - savingsGroupTotal;
        return {
          month,
          income: Math.round(cf.total_income),
          expenses: Math.round(livingExpenses),
        };
      })
    );
  }

  return Promise.all(promises);
}

// ─── Upcoming Premium Payments ────────────────────────────────────────────────

export async function getUpcomingPremiums(daysAhead = 60): Promise<
  {
    policy_name: string;
    provider: string;
    due_date: string;
    amount: number;
    frequency: string;
  }[]
> {
  const db = getDb();
  const allPolicies = await db.select().from(policies);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + daysAhead);

  const upcoming: {
    policy_name: string;
    provider: string;
    due_date: string;
    amount: number;
    frequency: string;
  }[] = [];

  for (const p of allPolicies) {
    const monthStep =
      p.premium_frequency === "monthly"
        ? 1
        : p.premium_frequency === "quarterly"
          ? 3
          : 12;
    const premiumEnd = new Date(p.start_date);
    premiumEnd.setFullYear(premiumEnd.getFullYear() + p.premium_term_years);

    const cursor = new Date(p.start_date);
    while (cursor <= premiumEnd) {
      if (cursor >= today && cursor <= cutoff) {
        upcoming.push({
          policy_name: p.name,
          provider: p.provider,
          due_date: cursor.toISOString().slice(0, 10),
          amount: p.premium_amount,
          frequency: p.premium_frequency,
        });
      }
      cursor.setMonth(cursor.getMonth() + monthStep);
      if (cursor > cutoff) break;
    }
  }

  return upcoming
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 10);
}

// ─── Cash Flow ────────────────────────────────────────────────────────────────

export async function getCashFlow(month: string) {
  const db = getDb();
  const rates = await getLatestRates();

  const [year, mon] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;

  function toInrLocal(amount: number, currency: string | null) {
    return currency ? amount * (rates[currency] ?? 1.0) : amount;
  }

  const incomeTxns = await db
    .select({
      payee: transactions.payee,
      amount: transactions.amount,
      currency: accounts.currency,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .where(
      and(
        eq(transactions.type, "income"),
        eq(accounts.off_budget, false),
        gte(transactions.date, dateFrom),
        lte(transactions.date, dateTo)
      )
    );

  const incomeByPayee: Record<string, number> = {};
  for (const t of incomeTxns) {
    if (t.payee === "Starting Balance") continue;
    incomeByPayee[t.payee] =
      (incomeByPayee[t.payee] ?? 0) + toInrLocal(t.amount, t.currency);
  }
  const totalIncome = Object.values(incomeByPayee).reduce((s, v) => s + v, 0);

  const expenseTxns = await db
    .select({
      envelope_id: transactions.envelope_id,
      envelope_name: envelopes.name,
      group_name: envelope_groups.name,
      amount: transactions.amount,
      currency: accounts.currency,
      type: transactions.type,
      payee: transactions.payee,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .leftJoin(envelopes, eq(transactions.envelope_id, envelopes.id))
    .leftJoin(envelope_groups, eq(envelopes.group_id, envelope_groups.id))
    .where(
      and(
        or(eq(transactions.type, "expense"), eq(transactions.type, "transfer")),
        eq(accounts.off_budget, false),
        gte(transactions.date, dateFrom),
        lte(transactions.date, dateTo)
      )
    );

  const groupMap: Record<
    string,
    { total: number; envelopes: Record<string, number> }
  > = {};
  let totalExpenses = 0;

  for (const t of expenseTxns) {
    if (!t.envelope_id) continue;
    const isCredit = t.type === "transfer" && t.payee === "Transfer in";
    const inr = toInrLocal(t.amount, t.currency);
    const net = isCredit ? -inr : inr;
    if (net <= 0) continue;

    const groupName = t.group_name ?? "Uncategorised";
    const envName = t.envelope_name ?? "Unknown";

    if (!groupMap[groupName]) groupMap[groupName] = { total: 0, envelopes: {} };
    groupMap[groupName].total += net;
    groupMap[groupName].envelopes[envName] =
      (groupMap[groupName].envelopes[envName] ?? 0) + net;
    totalExpenses += net;
  }

  const expenseGroups = Object.entries(groupMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([group_name, data]) => ({
      group_name,
      total: data.total,
      envelopes: Object.entries(data.envelopes)
        .sort((a, b) => b[1] - a[1])
        .map(([name, amount]) => ({ name, amount })),
    }));

  const carryover = await computeCarryoverForMonth(month, rates);

  return {
    month,
    carryover,
    total_income: totalIncome,
    total_expenses: totalExpenses,
    savings: Math.max(0, totalIncome - totalExpenses),
    income_sources: Object.entries(incomeByPayee)
      .sort((a, b) => b[1] - a[1])
      .map(([payee, amount]) => ({ payee, amount })),
    expense_groups: expenseGroups,
  };
}

// ─── Net Worth History ─────────────────────────────────────────────────────────

/**
 * The same snapshot as `getNetWorth`, evaluated at each month-end.
 *
 * The final month-end is clamped to today, so the last point of the series is
 * literally `getNetWorth()` — a transaction dated in the future belongs to
 * neither.
 *
 * Row shape is unchanged for the chart: `investments_inr` here still bundles
 * policies in with the investment assets (the Net Worth page stacks
 * `investments_inr + policies_inr` for the current figure to get the same
 * thing). `as_of` is new and reports the date each point was valued at.
 */
export async function getNetWorthHistory(
  months: number,
  ctx?: NetWorthContext
) {
  const today = new Date();
  const todayIso = isoDate(today);

  const points: { month: string; asOf: string }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const monthEnd = isoDate(lastDay);
    points.push({ month, asOf: monthEnd > todayIso ? todayIso : monthEnd });
  }

  const loaded = ctx ?? (await loadNetWorthContext(points[0].asOf));

  return points.map(({ month, asOf }) => {
    const snap = computeNetWorthAt(asOf, loaded);
    return {
      month,
      as_of: asOf,
      total_inr: snap.total_inr,
      cash_inr: snap.breakdown.cash_inr,
      investments_inr:
        snap.breakdown.investments_inr + snap.breakdown.policies_inr,
      debt_inr: snap.breakdown.debt_inr,
    };
  });
}

// ─── Full Dashboard ───────────────────────────────────────────────────────────

export async function getDashboard(month: string): Promise<DashboardResponse> {
  const db = getDb();
  const rates = await getLatestRates();

  const { policy_payouts } = await import("../db/schema");

  const [
    netWorth,
    envelopes,
    allAccounts,
    allPayouts,
    allPolicies,
    upcomingPremiums,
    carryover,
    cashFlow,
  ] = await Promise.all([
    getNetWorth(),
    listEnvelopes(month),
    db.select().from(accounts),
    db.select().from(policy_payouts),
    db.select().from(policies),
    getUpcomingPremiums(60),
    computeCarryoverForMonth(month, rates),
    getCashFlow(month),
  ]);

  const totalBudgeted = envelopes.reduce(
    (s, e) => s + (e.budgeted_inr ?? e.budgeted),
    0
  );
  const totalSpent = envelopes.reduce((s, e) => s + e.spent, 0);

  const [year, mon] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;
  const monthTxns = await db
    .select({
      amount: transactions.amount,
      type: transactions.type,
      currency: accounts.currency,
      account_id: transactions.account_id,
      id: transactions.id,
      payee: transactions.payee,
      date: transactions.date,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .where(
      and(gte(transactions.date, dateFrom), lte(transactions.date, dateTo))
    );

  const toInrAmt = (amount: number, currency: string | null) =>
    currency ? amount * (rates[currency] ?? 1.0) : amount;

  const monthlyIncome = cashFlow.total_income;
  const savingsGroup = cashFlow.expense_groups.find(
    (g) => g.group_name.toLowerCase() === "savings"
  );
  const savingsGroupTotal = savingsGroup ? savingsGroup.total : 0;
  const monthlyExpenses = cashFlow.total_expenses - savingsGroupTotal;

  const savingsRate =
    monthlyIncome > 0
      ? Math.round(((monthlyIncome - monthlyExpenses) / monthlyIncome) * 1000) /
        10
      : 0;

  const _policiesInr = netWorth.breakdown.policies_inr;

  const accountMap = Object.fromEntries(
    allAccounts.map((a) => [a.id, { name: a.name, currency: a.currency }])
  );
  const recentTxns = monthTxns
    .filter((t) => t.type !== "transfer")
    .sort(
      (a, b) =>
        toInrAmt(b.amount, accountMap[b.account_id]?.currency ?? null) -
        toInrAmt(a.amount, accountMap[a.account_id]?.currency ?? null)
    )
    .slice(0, 8);

  const today = new Date();
  const in90 = new Date(today);
  in90.setDate(in90.getDate() + 90);
  const policyMap = Object.fromEntries(allPolicies.map((p) => [p.id, p.name]));

  const upcoming = allPayouts
    .filter((po) => {
      const d = new Date(po.payout_date);
      return !po.is_received && d >= today && d <= in90;
    })
    .sort((a, b) => a.payout_date.localeCompare(b.payout_date))
    .slice(0, 5)
    .map((po) => ({
      policy_name: policyMap[po.policy_id] ?? "",
      payout_date: po.payout_date,
      amount: po.amount,
      label: po.label,
    }));

  return {
    net_worth_inr: netWorth.total_inr,
    month,
    budget: {
      total_budgeted: totalBudgeted,
      total_spent: totalSpent,
      total_available: totalBudgeted - totalSpent,
      total_income: monthlyIncome,
      to_assign: monthlyIncome + carryover - totalBudgeted,
    },
    cash_total_inr: netWorth.breakdown.cash_inr,
    investments_total_inr: netWorth.breakdown.investments_inr,
    policies_total_inr: netWorth.breakdown.policies_inr,
    debt_total_inr: netWorth.breakdown.debt_inr,
    monthly_income: monthlyIncome,
    monthly_expenses: monthlyExpenses,
    savings_rate: savingsRate,
    recent_transactions: recentTxns.map((t) => {
      const currency = accountMap[t.account_id]?.currency ?? "INR";
      return {
        id: t.id,
        payee: t.payee,
        amount: t.amount,
        amount_inr: toInrAmt(t.amount, currency),
        currency,
        type: t.type as "income" | "expense" | "transfer",
        date: t.date,
        account_name: accountMap[t.account_id]?.name ?? "",
      };
    }),
    upcoming_policy_payouts: upcoming,
    upcoming_premium_payments: upcomingPremiums,
    top_categories: cashFlow.expense_groups
      .filter((g) => g.group_name.toLowerCase() !== "savings")
      .map((g) => ({
        name: g.group_name,
        amount: g.total,
      })),
  };
}
