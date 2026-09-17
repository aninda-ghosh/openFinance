import type {
  CreateInvestmentRequest,
  InvestmentResponse,
  PriceHistoryEntry,
  UpdateInvestmentRequest,
} from "@openfinance/shared/api-contracts";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  investment_value_history,
  investments,
  price_history,
} from "../db/schema";
import { listAccounts } from "./budget.service";
import { getLatestRates } from "./exchange-rate.service";
import { fetchCurrentPrice } from "./price.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInr(
  amount: number,
  currency: string,
  rates: Record<string, number>
): number {
  return amount * (rates[currency] ?? 1.0);
}

/**
 * Sum of new money paid into each holding after the initial purchase, keyed by
 * investment id, in one grouped query rather than one per row.
 */
async function contributionTotals(
  investmentId?: string
): Promise<Record<string, number>> {
  const db = getDb();
  const selection = {
    id: investment_value_history.investment_id,
    total: sql<number>`sum(coalesce(${investment_value_history.contribution}, 0))`,
  };

  const rows = investmentId
    ? await db
        .select(selection)
        .from(investment_value_history)
        .where(eq(investment_value_history.investment_id, investmentId))
        .groupBy(investment_value_history.investment_id)
    : await db
        .select(selection)
        .from(investment_value_history)
        .groupBy(investment_value_history.investment_id);

  const totals: Record<string, number> = {};
  for (const r of rows) {
    if (r.id) totals[r.id] = Number(r.total) || 0;
  }
  return totals;
}

function toInvestmentResponse(
  row: typeof investments.$inferSelect,
  rates: Record<string, number>,
  contributions = 0
): InvestmentResponse {
  const currency = row.currency ?? "INR";
  const purchaseInr = toInr(row.purchase_value, currency, rates);
  // Money in = the original outlay plus every later top-up. Gain used to be
  // measured against purchase_value alone, so paying into a 401k lifted the
  // current value while the basis stayed at its first-day figure and the whole
  // deposit was reported as profit.
  const costBasis = row.purchase_value + contributions;
  const costBasisInr = toInr(costBasis, currency, rates);
  const currentInr = toInr(row.current_value, currency, rates);
  const gainLossInr = currentInr - costBasisInr;
  const gainLossPct =
    costBasisInr > 0 ? (gainLossInr / costBasisInr) * 100 : 0;

  return {
    id: row.id,
    name: row.name,
    asset_type: row.asset_type as InvestmentResponse["asset_type"],
    currency: currency as InvestmentResponse["currency"],
    purchase_value: row.purchase_value,
    purchase_value_inr: purchaseInr,
    total_contributions: contributions,
    total_contributions_inr: toInr(contributions, currency, rates),
    cost_basis: costBasis,
    cost_basis_inr: costBasisInr,
    units: row.units ?? null,
    purchase_date: row.purchase_date,
    current_value: row.current_value,
    current_value_inr: currentInr,
    gain_loss_inr: gainLossInr,
    gain_loss_pct: Math.round(gainLossPct * 100) / 100,
    current_value_source: row.current_value_source ?? null,
    current_value_at: row.current_value_at ?? null,
    notes: row.notes ?? null,
    account_id: row.account_id ?? null,
    maturity_date: row.maturity_date ?? null,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

// ─── Service methods ──────────────────────────────────────────────────────────

export async function listInvestments(filters?: {
  asset_type?: string;
  sort?: string;
}): Promise<InvestmentResponse[]> {
  const db = getDb();
  const rates = await getLatestRates();
  const rows = await db.select().from(investments).orderBy(investments.name);
  const contributions = await contributionTotals();

  let result = rows.map((r) =>
    toInvestmentResponse(r, rates, contributions[r.id] ?? 0)
  );

  if (filters?.asset_type) {
    result = result.filter((r) => r.asset_type === filters.asset_type);
  }
  if (filters?.sort === "gain_desc") {
    result.sort((a, b) => b.gain_loss_inr - a.gain_loss_inr);
  }

  return result;
}

export async function createInvestment(
  data: CreateInvestmentRequest
): Promise<InvestmentResponse> {
  const db = getDb();
  const rates = await getLatestRates();
  const [row] = await db.insert(investments).values(data).returning();
  // A brand-new holding has no history, so its basis is just the purchase.
  return toInvestmentResponse(row, rates, 0);
}

export async function updateInvestment(
  id: string,
  data: UpdateInvestmentRequest
): Promise<InvestmentResponse> {
  const db = getDb();
  const rates = await getLatestRates();

  const [existing] = await db
    .select()
    .from(investments)
    .where(eq(investments.id, id));
  if (!existing)
    throw Object.assign(new Error("Investment not found"), { status: 404 });

  // `contribution` describes the value CHANGE, not a column on investments —
  // it belongs on the history row this update produces.
  const { contribution, ...columns } = data;

  const [row] = await db
    .update(investments)
    .set({ ...columns, updated_at: new Date().toISOString() })
    .where(eq(investments.id, id))
    .returning();

  const valueChanged =
    data.current_value !== undefined &&
    data.current_value !== existing.current_value;

  if (valueChanged) {
    await db.insert(investment_value_history).values({
      investment_id: id,
      previous_value: existing.current_value,
      new_value: data.current_value as number,
      source: "manual",
      notes: data.notes ?? null,
      contribution: contribution ?? 0,
    });
  } else if (contribution) {
    // A contribution with no value change would otherwise vanish. Record it as
    // a zero-movement row so the basis still rises.
    await db.insert(investment_value_history).values({
      investment_id: id,
      previous_value: existing.current_value,
      new_value: existing.current_value,
      source: "manual",
      notes: data.notes ?? null,
      contribution,
    });
  }

  const totals = await contributionTotals(id);
  return toInvestmentResponse(row, rates, totals[id] ?? 0);
}

export async function deleteInvestment(id: string): Promise<void> {
  const db = getDb();
  await db.delete(price_history).where(eq(price_history.investment_id, id));
  await db
    .delete(investment_value_history)
    .where(eq(investment_value_history.investment_id, id));
  const result = await db
    .delete(investments)
    .where(eq(investments.id, id))
    .returning();
  if (result.length === 0)
    throw Object.assign(new Error("Investment not found"), { status: 404 });
}

export async function refreshPrice(id: string): Promise<{
  source_url: string;
  price: number;
  price_inr: number;
  currency: string;
  fetched_at: string;
}> {
  const db = getDb();
  const rates = await getLatestRates();
  const [inv] = await db
    .select()
    .from(investments)
    .where(eq(investments.id, id));
  if (!inv)
    throw Object.assign(new Error("Investment not found"), { status: 404 });

  // Build a minimal InvestmentResponse to pass into the price service
  const currency = (inv.currency ?? "INR") as InvestmentResponse["currency"];
  const purchaseInr = toInr(inv.purchase_value, currency, rates);
  const currentInr = toInr(inv.current_value, currency, rates);
  const contributions = (await contributionTotals(id))[id] ?? 0;
  const costBasis = inv.purchase_value + contributions;
  const costBasisInr = toInr(costBasis, currency, rates);
  const invResponse: InvestmentResponse = {
    id: inv.id,
    name: inv.name,
    asset_type: inv.asset_type as InvestmentResponse["asset_type"],
    currency,
    purchase_value: inv.purchase_value,
    purchase_value_inr: purchaseInr,
    total_contributions: contributions,
    total_contributions_inr: toInr(contributions, currency, rates),
    cost_basis: costBasis,
    cost_basis_inr: costBasisInr,
    units: inv.units ?? null,
    purchase_date: inv.purchase_date,
    current_value: inv.current_value,
    current_value_inr: currentInr,
    gain_loss_inr: currentInr - costBasisInr,
    gain_loss_pct: 0,
    current_value_source: inv.current_value_source ?? null,
    current_value_at: inv.current_value_at ?? null,
    notes: inv.notes ?? null,
    account_id: inv.account_id ?? null,
    maturity_date: inv.maturity_date ?? null,
    created_at: inv.created_at ?? "",
    updated_at: inv.updated_at ?? "",
  };

  const result = await fetchCurrentPrice(invResponse);

  // Reject nonsensical prices — they would corrupt stored value
  if (!result.price || result.price <= 0) {
    throw Object.assign(
      new Error(
        `Could not find a valid market price for "${inv.name}" — try updating the value manually`
      ),
      { status: 422 }
    );
  }

  // price_history is append-only
  await db.insert(price_history).values({
    investment_id: id,
    price: result.price,
    source_url: result.source_url,
  });

  // Record value change in history
  await db.insert(investment_value_history).values({
    investment_id: id,
    previous_value: inv.current_value,
    new_value: result.price,
    source: "price_refresh",
    notes: result.source_url ?? null,
  });

  // Update current_value in native currency
  await db
    .update(investments)
    .set({
      current_value: result.price,
      current_value_source: result.source_url,
      current_value_at: result.fetched_at,
      updated_at: result.fetched_at,
    })
    .where(eq(investments.id, id));

  return {
    source_url: result.source_url,
    price: result.price,
    price_inr: result.price_inr,
    currency: result.currency,
    fetched_at: result.fetched_at,
  };
}

export async function getPriceHistory(
  id: string,
  from?: string,
  to?: string
): Promise<PriceHistoryEntry[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(price_history)
    .where(eq(price_history.investment_id, id))
    .orderBy(desc(price_history.fetched_at));

  return rows
    .filter((r) => {
      if (from && r.fetched_at && r.fetched_at < from) return false;
      if (to && r.fetched_at && r.fetched_at > to) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      price: r.price,
      source_url: r.source_url ?? null,
      fetched_at: r.fetched_at ?? "",
    }));
}

export async function getValueHistory(id: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(investment_value_history)
    .where(eq(investment_value_history.investment_id, id))
    .orderBy(desc(investment_value_history.changed_at));
  return rows.map((r) => ({
    id: r.id,
    previous_value: r.previous_value ?? null,
    new_value: r.new_value,
    source: r.source as "manual" | "price_refresh",
    notes: r.notes ?? null,
    contribution: r.contribution ?? 0,
    changed_at: r.changed_at ?? "",
  }));
}

/**
 * Reclassify one history row: how much of its change was new money.
 * Recomputes nothing itself — cost basis is derived from these rows on read.
 */
export async function setEntryContribution(
  investmentId: string,
  entryId: string,
  contribution: number
): Promise<InvestmentResponse> {
  const db = getDb();
  const [entry] = await db
    .select()
    .from(investment_value_history)
    .where(eq(investment_value_history.id, entryId))
    .limit(1);

  if (!entry || entry.investment_id !== investmentId) {
    throw Object.assign(new Error("History entry not found"), { status: 404 });
  }

  await db
    .update(investment_value_history)
    .set({ contribution })
    .where(eq(investment_value_history.id, entryId));

  return getInvestmentById(investmentId);
}

/**
 * Bulk reclassification for a holding whose whole history is deposits — the
 * 401k case, where every row is a payroll contribution and none is a market
 * move. `match_delta` sets each row's contribution to its own change (a
 * negative change becomes a withdrawal); `clear` puts everything back to
 * market movement. Rows with no previous value are left at zero: there is no
 * change to attribute.
 */
export async function bulkSetContributions(
  investmentId: string,
  mode: "match_delta" | "clear"
): Promise<InvestmentResponse> {
  const db = getDb();
  const rows = await db
    .select()
    .from(investment_value_history)
    .where(eq(investment_value_history.investment_id, investmentId));

  for (const r of rows) {
    const delta =
      mode === "clear" || r.previous_value === null
        ? 0
        : r.new_value - r.previous_value;
    if ((r.contribution ?? 0) === delta) continue;
    await db
      .update(investment_value_history)
      .set({ contribution: delta })
      .where(eq(investment_value_history.id, r.id));
  }

  return getInvestmentById(investmentId);
}

export async function getInvestmentById(
  id: string
): Promise<InvestmentResponse> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(investments)
    .where(eq(investments.id, id))
    .limit(1);
  if (!row)
    throw Object.assign(new Error("Investment not found"), { status: 404 });
  const [rates, totals] = await Promise.all([
    getLatestRates(),
    contributionTotals(id),
  ]);
  return toInvestmentResponse(row, rates, totals[id] ?? 0);
}

export async function getPortfolioSummary() {
  const [invList, allAccounts] = await Promise.all([
    listInvestments(),
    listAccounts(),
  ]);

  const byAssetType: Record<string, number> = {};

  // Investment holdings
  for (const inv of invList) {
    byAssetType[inv.asset_type] =
      (byAssetType[inv.asset_type] ?? 0) + inv.current_value_inr;
  }

  // Linked accounts (off-budget savings / investment accounts cash portions)
  const linkedAccounts = allAccounts.filter(
    (a) => a.off_budget && ["investment", "savings", "checking", "cash"].includes(a.type)
  );
  for (const acc of linkedAccounts) {
    const accInvs = invList.filter((i) => i.account_id === acc.id);
    const holdingsValInr = accInvs.reduce((sum, i) => sum + i.current_value_inr, 0);
    const cashValInr = Math.max(0, acc.balance_inr - holdingsValInr);
    if (cashValInr > 0) {
      const key = acc.type; // "savings" or "investment"
      byAssetType[key] = (byAssetType[key] ?? 0) + cashValInr;
    }
  }

  const totalInr = Object.values(byAssetType).reduce((s, v) => s + v, 0);
  return { total_inr: totalInr, by_asset_type: byAssetType };
}
