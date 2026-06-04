import type { DashboardResponse } from "@finwise/shared/api-contracts";
import { and, eq, gte, lte, or } from "drizzle-orm";
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
  listAccounts,
  listEnvelopes,
} from "./budget.service";
import { getLatestRates } from "./exchange-rate.service";
import { listInvestments } from "./investment.service";

// ─── Net Worth ────────────────────────────────────────────────────────────────

export async function getNetWorth() {
  const db = getDb();

  const [liveAccounts, allPolicies, invList, rates] = await Promise.all([
    listAccounts(),
    db.select().from(policies),
    listInvestments(),
    getLatestRates(),
  ]);

  const active = liveAccounts.filter((a) => a.is_active);

  const cashInr = active
    .filter((a) => !a.off_budget && a.type !== "policy")
    .reduce((s, a) => {
      const accInvs = invList.filter((i) => i.account_id === a.id);
      const holdingsValInr = accInvs.reduce((sum, i) => sum + i.current_value_inr, 0);
      return s + Math.max(0, a.balance_inr - holdingsValInr);
    }, 0);

  // Linked account balances (off-budget savings accounts + investment account cash balances)
  const linkedAccountsInr = active
    .filter(
      (a) => a.off_budget && ["investment", "savings", "checking", "cash"].includes(a.type)
    )
    .reduce((s, a) => {
      const accInvs = invList.filter((i) => i.account_id === a.id);
      const holdingsValInr = accInvs.reduce((sum, i) => sum + i.current_value_inr, 0);
      return s + Math.max(0, a.balance_inr - holdingsValInr);
    }, 0);

  // Investment holdings from the investments table
  const holdingsInr = invList.reduce((s, i) => s + i.current_value_inr, 0);

  const investmentsInr = linkedAccountsInr + holdingsInr;

  // Sum the amount owed per debt account individually (matches the Debt page formula)
  const debtInr = active
    .filter(
      (a) => a.type === "credit" || a.type === "loan" || a.type === "debt"
    )
    .reduce((s, a) => s + a.balance_inr, 0);

  // Value policies strictly by current invested amount (linked account balance or fallback formula)
  const policiesInr = allPolicies.reduce((s, p) => {
    const linkedAcc = p.account_id
      ? active.find((a) => a.id === p.account_id)
      : null;
    if (linkedAcc) {
      return s + linkedAcc.balance_inr;
    }
    const freq = p.premium_frequency;
    const paymentsPerYear =
      freq === "monthly" ? 12 : freq === "quarterly" ? 4 : 1;
    const calculatedInvested =
      p.premium_amount * paymentsPerYear * p.premium_term_years;
    const currency = (p as any).currency ?? "INR";
    const calculatedInvestedInr = calculatedInvested * (rates[currency] ?? 1.0);
    return s + calculatedInvestedInr;
  }, 0);

  return {
    total_inr: cashInr + investmentsInr + policiesInr + debtInr,
    breakdown: {
      cash_inr: cashInr,
      investments_inr: investmentsInr,
      policies_inr: policiesInr,
      debt_inr: debtInr,
    },
  };
}

// ─── Portfolio Breakdown ───────────────────────────────────────────────────────

export async function getPortfolioBreakdown() {
  const [invList, allAccounts] = await Promise.all([
    listInvestments(),
    listAccounts(),
  ]);

  const byType: Record<string, number> = {};

  for (const inv of invList) {
    byType[inv.asset_type] =
      (byType[inv.asset_type] ?? 0) + inv.current_value_inr;
  }

  // Include linked account cash balances (off-budget savings / investment accounts cash portions)
  for (const acc of allAccounts) {
    if (
      acc.off_budget &&
      ["investment", "savings", "checking", "cash"].includes(acc.type)
    ) {
      const accInvs = invList.filter((i) => i.account_id === acc.id);
      const holdingsValInr = accInvs.reduce((sum, i) => sum + i.current_value_inr, 0);
      const cashValInr = Math.max(0, acc.balance_inr - holdingsValInr);
      if (cashValInr > 0) {
        byType[acc.type] = (byType[acc.type] ?? 0) + cashValInr;
      }
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
  const db = getDb();
  const rates = await getLatestRates();
  const results: { month: string; income: number; expenses: number }[] = [];
  const today = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const dateFrom = `${month}-01`;
    const dateTo = `${month}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;

    const rows = await db
      .select({
        type: transactions.type,
        amount: transactions.amount,
        currency: accounts.currency,
      })
      .from(transactions)
      .leftJoin(accounts, eq(transactions.account_id, accounts.id))
      .where(
        and(gte(transactions.date, dateFrom), lte(transactions.date, dateTo))
      );

    const toInrAmt = (amount: number, currency: string | null) =>
      currency ? amount * (rates[currency] ?? 1.0) : amount;

    const income = rows
      .filter((r) => r.type === "income")
      .reduce((s, r) => s + toInrAmt(r.amount, r.currency), 0);
    const expenses = rows
      .filter((r) => r.type === "expense")
      .reduce((s, r) => s + toInrAmt(r.amount, r.currency), 0);
    results.push({
      month,
      income: Math.round(income),
      expenses: Math.round(expenses),
    });
  }

  return results;
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

export async function getNetWorthHistory(months: number) {
  const db = getDb();
  const rates = await getLatestRates();

  function toInrLocal(amount: number, currency: string | null) {
    return currency ? amount * (rates[currency] ?? 1.0) : amount;
  }

  // Fetch all accounts and all transactions once
  const allAccountRows = await db.select().from(accounts);
  const allTxns = await db
    .select({
      account_id: transactions.account_id,
      amount: transactions.amount,
      type: transactions.type,
      payee: transactions.payee,
      date: transactions.date,
    })
    .from(transactions)
    .orderBy(transactions.date);

  const invList = await listInvestments();
  const investmentsCurrentInr = invList.reduce(
    (s, i) => s + i.current_value_inr,
    0
  );
  const allPolicies = await db.select().from(policies);

  const txnsByAccount: Record<string, typeof allTxns> = {};
  for (const t of allTxns) {
    if (!t.account_id) continue;
    (txnsByAccount[t.account_id] ??= []).push(t);
  }

  const today = new Date();
  const results: {
    month: string;
    total_inr: number;
    cash_inr: number;
    investments_inr: number;
    debt_inr: number;
  }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthEnd = `${month}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;

    let cashInr = 0;
    let debtInr = 0;
    let policiesInr = 0;

    for (const acc of allAccountRows) {
      if (!acc.is_active) continue;
      const currency = acc.currency ?? "INR";
      const isDebt =
        acc.type === "credit" || acc.type === "loan" || acc.type === "debt";
      const isOffBudget = acc.off_budget;

      const openingBalance = isDebt
        ? -Math.abs(acc.balance ?? 0)
        : (acc.balance ?? 0);
      let delta = 0;

      for (const t of txnsByAccount[acc.id] ?? []) {
        if (t.date > monthEnd) break;
        if (t.type === "income") delta += t.amount;
        else if (t.type === "expense") delta -= t.amount;
        else if (t.type === "transfer" && t.payee === "Transfer in")
          delta += t.amount;
        else if (t.type === "transfer" && t.payee === "Transfer out")
          delta -= t.amount;
      }

      const balanceNative = openingBalance + delta;
      const balanceInr = toInrLocal(balanceNative, currency);

      if (isDebt) {
        debtInr += balanceInr;
      } else if (acc.type === "policy") {
        policiesInr += balanceInr;
      } else if (!isOffBudget) {
        cashInr += balanceInr;
      }
    }

    // Add policies that do NOT have a linked account as a fallback
    for (const p of allPolicies) {
      if (!p.account_id || !allAccountRows.some((a) => a.id === p.account_id)) {
        const freq = p.premium_frequency;
        const paymentsPerYear =
          freq === "monthly" ? 12 : freq === "quarterly" ? 4 : 1;
        const calculatedInvested =
          p.premium_amount * paymentsPerYear * p.premium_term_years;
        const currency = (p as any).currency ?? "INR";
        policiesInr += toInrLocal(calculatedInvested, currency);
      }
    }

    results.push({
      month,
      total_inr: cashInr + investmentsCurrentInr + policiesInr + debtInr,
      cash_inr: cashInr,
      investments_inr: investmentsCurrentInr + policiesInr, // policy net worth counts as investment assets
      debt_inr: debtInr,
    });
  }

  return results;
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
  ] = await Promise.all([
    getNetWorth(),
    listEnvelopes(month),
    db.select().from(accounts),
    db.select().from(policy_payouts),
    db.select().from(policies),
    getUpcomingPremiums(60),
    computeCarryoverForMonth(month, rates),
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

  const monthlyIncome = monthTxns
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + toInrAmt(t.amount, t.currency), 0);
  const monthlyExpenses = monthTxns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + toInrAmt(t.amount, t.currency), 0);

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
  };
}
