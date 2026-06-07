import type {
  CreatePayoutRequest,
  CreatePolicyRequest,
  PayoutResponse,
  PolicyResponse,
  UpdatePayoutRequest,
  UpdatePolicyRequest,
} from "@openfinance/shared/api-contracts";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db/index";
import { accounts, policies, policy_payouts, transactions } from "../db/schema";
import { getBaseCurrency, getLatestRates } from "./exchange-rate.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toPayoutResponse(
  row: typeof policy_payouts.$inferSelect
): PayoutResponse {
  return {
    id: row.id,
    policy_id: row.policy_id,
    payout_date: row.payout_date,
    amount: row.amount,
    label: row.label,
    is_received: row.is_received ?? false,
  };
}

function toInr(
  amount: number,
  currency: string,
  rates: Record<string, number>
): number {
  return amount * (rates[currency] ?? 1.0);
}

function computeTotalInvested(policy: typeof policies.$inferSelect): number {
  const start = new Date(policy.start_date);
  const today = new Date();
  const endOfPremiumTerm = new Date(start);
  endOfPremiumTerm.setFullYear(
    endOfPremiumTerm.getFullYear() + policy.premium_term_years
  );

  const freq = policy.premium_frequency;
  const monthsInterval = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= today && cursor < endOfPremiumTerm) {
    count++;
    cursor.setMonth(cursor.getMonth() + monthsInterval);
  }

  return policy.premium_amount * count;
}

async function getAccountLiveBalance(db: any, accountId: string): Promise<number> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) return 0;

  const txnTotals = await db
    .select({
      type: transactions.type,
      payee: transactions.payee,
      total: sql<number>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .where(eq(transactions.account_id, accountId))
    .groupBy(transactions.type, transactions.payee);

  let delta = 0;
  for (const t of txnTotals) {
    if (t.type === "income") delta += t.total;
    else if (t.type === "expense") delta -= t.total;
    else if (t.type === "transfer" && t.payee === "Transfer in") delta += t.total;
    else if (t.type === "transfer" && t.payee === "Transfer out") delta -= t.total;
  }

  return (account.balance ?? 0) + delta;
}

async function toPolicyResponse(
  row: typeof policies.$inferSelect,
  rates: Record<string, number>
): Promise<PolicyResponse> {
  const db = getDb();
  const payoutRows = await db
    .select()
    .from(policy_payouts)
    .where(eq(policy_payouts.policy_id, row.id))
    .orderBy(policy_payouts.payout_date);

  const currency = row.currency ?? "INR";
  const premiumInr = toInr(row.premium_amount, currency, rates);
  const sumAssuredInr = toInr(row.sum_assured, currency, rates);
  const maturityValueInr = toInr(row.maturity_value, currency, rates);
  const surrenderValueInr =
    row.surrender_value != null
      ? toInr(row.surrender_value, currency, rates)
      : null;
  let totalInvested = computeTotalInvested(row);
  if (row.account_id) {
    totalInvested = await getAccountLiveBalance(db, row.account_id);
  }
  const totalInvestedInr = toInr(totalInvested, currency, rates);

  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    policy_number: row.policy_number ?? null,
    start_date: row.start_date,
    currency: currency as any,
    premium_amount: row.premium_amount,
    premium_amount_inr: premiumInr,
    premium_frequency:
      row.premium_frequency as PolicyResponse["premium_frequency"],
    premium_term_years: row.premium_term_years,
    policy_term_years: row.policy_term_years,
    maturity_date: row.maturity_date,
    sum_assured: row.sum_assured,
    sum_assured_inr: sumAssuredInr,
    maturity_value: row.maturity_value,
    maturity_value_inr: maturityValueInr,
    surrender_value: row.surrender_value ?? null,
    surrender_value_inr: surrenderValueInr,
    total_invested: totalInvested,
    total_invested_inr: totalInvestedInr,
    notes: row.notes ?? null,
    account_id: row.account_id ?? null,
    payouts: payoutRows.map(toPayoutResponse),
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

// ─── Compute next premium due dates ──────────────────────────────────────────

function getNextPremiumDate(policy: typeof policies.$inferSelect): Date | null {
  const start = new Date(policy.start_date);
  const today = new Date();
  const endOfPremiumTerm = new Date(start);
  endOfPremiumTerm.setFullYear(
    endOfPremiumTerm.getFullYear() + policy.premium_term_years
  );
  if (today >= endOfPremiumTerm) return null;

  const freq = policy.premium_frequency;
  const monthsInterval = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;

  const next = new Date(start);
  while (next <= today) {
    next.setMonth(next.getMonth() + monthsInterval);
  }
  return next;
}

// ─── Service methods ──────────────────────────────────────────────────────────

export async function listPolicies(): Promise<PolicyResponse[]> {
  const db = getDb();
  const rows = await db.select().from(policies).orderBy(policies.name);
  const rates = await getLatestRates();
  return Promise.all(rows.map((r) => toPolicyResponse(r, rates)));
}

export async function createPolicy(
  data: CreatePolicyRequest
): Promise<PolicyResponse> {
  const db = getDb();

  // Auto-create a corresponding account of type "policy"
  const baseCurrency = await getBaseCurrency();
  const currency = data.currency ?? baseCurrency;
  const accountId = nanoid();
  await db.insert(accounts).values({
    id: accountId,
    name: data.name,
    type: "policy",
    currency: currency as any,
    balance: 0,
    institution: data.provider,
    is_active: true,
    off_budget: true,
  });

  const [row] = await db
    .insert(policies)
    .values({
      ...data,
      account_id: accountId,
    })
    .returning();

  const rates = await getLatestRates();
  return toPolicyResponse(row, rates);
}

export async function updatePolicy(
  id: string,
  data: UpdatePolicyRequest
): Promise<PolicyResponse> {
  const db = getDb();
  const [row] = await db
    .update(policies)
    .set({ ...data, updated_at: new Date().toISOString() })
    .where(eq(policies.id, id))
    .returning();
  if (!row) throw Object.assign(new Error("Policy not found"), { status: 404 });

  // Update name, provider, currency, and balance on the corresponding account
  if (row.account_id) {
    const actualInvested = computeTotalInvested(row);
    await db
      .update(accounts)
      .set({
        name: row.name,
        institution: row.provider,
        currency: row.currency,
        balance: actualInvested,
        updated_at: new Date().toISOString(),
      })
      .where(eq(accounts.id, row.account_id));
  }

  const rates = await getLatestRates();
  return toPolicyResponse(row, rates);
}

export async function generatePayouts(
  policyId: string,
  opts: {
    start_date: string;
    end_date: string;
    amount: number;
    frequency: "monthly" | "quarterly" | "annual";
    label: string;
  }
): Promise<number> {
  const db = getDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.id, policyId));
  if (!policy)
    throw Object.assign(new Error("Policy not found"), { status: 404 });

  const monthsStep =
    opts.frequency === "monthly" ? 1 : opts.frequency === "quarterly" ? 3 : 12;
  const dates: string[] = [];
  const cursor = new Date(opts.start_date);
  const end = new Date(opts.end_date);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setMonth(cursor.getMonth() + monthsStep);
  }

  if (dates.length === 0) return 0;

  await db.insert(policy_payouts).values(
    dates.map((d) => ({
      policy_id: policyId,
      payout_date: d,
      amount: opts.amount,
      label: opts.label,
      is_received: false,
    }))
  );
  return dates.length;
}

export async function deletePolicy(id: string): Promise<void> {
  const db = getDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.id, id))
    .limit(1);

  await db.delete(policy_payouts).where(eq(policy_payouts.policy_id, id));
  const [row] = await db
    .delete(policies)
    .where(eq(policies.id, id))
    .returning();
  if (!row) throw Object.assign(new Error("Policy not found"), { status: 404 });

  if (policy?.account_id) {
    await db.delete(accounts).where(eq(accounts.id, policy.account_id));
  }
}

export async function getPayouts(policyId: string): Promise<PayoutResponse[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(policy_payouts)
    .where(eq(policy_payouts.policy_id, policyId))
    .orderBy(policy_payouts.payout_date);
  return rows.map(toPayoutResponse);
}

export async function addPayout(
  policyId: string,
  data: CreatePayoutRequest
): Promise<PayoutResponse> {
  const db = getDb();
  const [row] = await db
    .insert(policy_payouts)
    .values({ ...data, policy_id: policyId })
    .returning();
  return toPayoutResponse(row);
}

export async function markPayoutReceived(
  policyId: string,
  payoutId: string
): Promise<PayoutResponse> {
  const db = getDb();
  const [row] = await db
    .update(policy_payouts)
    .set({ is_received: true })
    .where(eq(policy_payouts.id, payoutId))
    .returning();
  if (!row || row.policy_id !== policyId) {
    throw Object.assign(new Error("Payout not found"), { status: 404 });
  }
  return toPayoutResponse(row);
}

export async function updatePayout(
  policyId: string,
  payoutId: string,
  data: UpdatePayoutRequest
): Promise<PayoutResponse> {
  const db = getDb();
  const [row] = await db
    .update(policy_payouts)
    .set(data)
    .where(eq(policy_payouts.id, payoutId))
    .returning();
  if (!row || row.policy_id !== policyId) {
    throw Object.assign(new Error("Payout not found"), { status: 404 });
  }
  return toPayoutResponse(row);
}

export type TimelineEvent = {
  type: "maturity" | "payout" | "premium_due";
  date: string;
  policy_id: string;
  policy_name: string;
  amount: number;
  label: string;
};

export async function getTimeline(years: number): Promise<TimelineEvent[]> {
  const db = getDb();
  const allPolicies = await db.select().from(policies);
  const allPayouts = await db.select().from(policy_payouts);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() + years);
  const events: TimelineEvent[] = [];

  for (const p of allPolicies) {
    // Maturity event
    const maturity = new Date(p.maturity_date);
    if (maturity <= cutoff) {
      events.push({
        type: "maturity",
        date: p.maturity_date,
        policy_id: p.id,
        policy_name: p.name,
        amount: p.maturity_value,
        label: "Policy Maturity",
      });
    }

    // Premium due events
    const next = getNextPremiumDate(p);
    if (next && next <= cutoff) {
      events.push({
        type: "premium_due",
        date: next.toISOString().slice(0, 10),
        policy_id: p.id,
        policy_name: p.name,
        amount: p.premium_amount,
        label: `${p.premium_frequency} premium`,
      });
    }
  }

  // Payout events
  for (const po of allPayouts) {
    const payoutDate = new Date(po.payout_date);
    if (payoutDate <= cutoff) {
      const policy = allPolicies.find((p) => p.id === po.policy_id);
      events.push({
        type: "payout",
        date: po.payout_date,
        policy_id: po.policy_id,
        policy_name: policy?.name ?? "",
        amount: po.amount,
        label: po.label,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

export type PolicyAlert = {
  policy_id: string;
  policy_name: string;
  next_premium_date: string;
  premium_amount: number;
  days_until_due: number;
};

export async function getUpcomingAlerts(days: number): Promise<PolicyAlert[]> {
  const db = getDb();
  const allPolicies = await db.select().from(policies);
  const today = new Date();
  const alerts: PolicyAlert[] = [];

  for (const p of allPolicies) {
    const next = getNextPremiumDate(p);
    if (!next) continue;
    const daysUntil = Math.ceil(
      (next.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntil <= days) {
      alerts.push({
        policy_id: p.id,
        policy_name: p.name,
        next_premium_date: next.toISOString().slice(0, 10),
        premium_amount: p.premium_amount,
        days_until_due: daysUntil,
      });
    }
  }

  return alerts.sort((a, b) => a.days_until_due - b.days_until_due);
}
