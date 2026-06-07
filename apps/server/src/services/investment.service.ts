import type {
  CreateInvestmentRequest,
  InvestmentResponse,
  PriceHistoryEntry,
  UpdateInvestmentRequest,
} from "@openfinance/shared/api-contracts";
import { desc, eq } from "drizzle-orm";
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

function toInvestmentResponse(
  row: typeof investments.$inferSelect,
  rates: Record<string, number>
): InvestmentResponse {
  const currency = row.currency ?? "INR";
  const purchaseInr = toInr(row.purchase_value, currency, rates);
  const currentInr = toInr(row.current_value, currency, rates);
  const gainLossInr = currentInr - purchaseInr;
  const gainLossPct = purchaseInr > 0 ? (gainLossInr / purchaseInr) * 100 : 0;

  return {
    id: row.id,
    name: row.name,
    asset_type: row.asset_type as InvestmentResponse["asset_type"],
    currency: currency as InvestmentResponse["currency"],
    purchase_value: row.purchase_value,
    purchase_value_inr: purchaseInr,
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

  let result = rows.map((r) => toInvestmentResponse(r, rates));

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
  return toInvestmentResponse(row, rates);
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

  const [row] = await db
    .update(investments)
    .set({ ...data, updated_at: new Date().toISOString() })
    .where(eq(investments.id, id))
    .returning();

  if (
    data.current_value !== undefined &&
    data.current_value !== existing.current_value
  ) {
    await db.insert(investment_value_history).values({
      investment_id: id,
      previous_value: existing.current_value,
      new_value: data.current_value,
      source: "manual",
      notes: data.notes ?? null,
    });
  }

  return toInvestmentResponse(row, rates);
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
  const invResponse: InvestmentResponse = {
    id: inv.id,
    name: inv.name,
    asset_type: inv.asset_type as InvestmentResponse["asset_type"],
    currency,
    purchase_value: inv.purchase_value,
    purchase_value_inr: purchaseInr,
    units: inv.units ?? null,
    purchase_date: inv.purchase_date,
    current_value: inv.current_value,
    current_value_inr: currentInr,
    gain_loss_inr: currentInr - purchaseInr,
    gain_loss_pct: 0,
    current_value_source: inv.current_value_source ?? null,
    current_value_at: inv.current_value_at ?? null,
    notes: inv.notes ?? null,
    account_id: inv.account_id ?? null,
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
    changed_at: r.changed_at ?? "",
  }));
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
