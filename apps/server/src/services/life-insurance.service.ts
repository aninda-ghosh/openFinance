import type {
  CreateLifeInsuranceRequest,
  LifeInsuranceResponse,
  UpdateLifeInsuranceRequest,
} from "@openfinance/shared/api-contracts";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { investment_documents, life_insurance } from "../db/schema";
import { getLatestRates } from "./exchange-rate.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInr(
  amount: number,
  currency: string,
  rates: Record<string, number>
): number {
  return amount * (rates[currency] ?? 1.0);
}

/**
 * Whole days between today and `date`, both read as calendar dates in UTC so a
 * local-time offset can never shift the answer by a day.
 */
function daysUntil(date: string): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(target)) return 0;
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return Math.round((target - today) / 86_400_000);
}

const PAYMENTS_PER_YEAR: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

function toResponse(
  row: typeof life_insurance.$inferSelect,
  rates: Record<string, number>,
  documentCount: number
): LifeInsuranceResponse {
  const currency = row.currency ?? "INR";
  const premiumInr =
    row.premium_amount == null
      ? null
      : toInr(row.premium_amount, currency, rates);
  const perYear = row.premium_frequency
    ? (PAYMENTS_PER_YEAR[row.premium_frequency] ?? null)
    : null;

  return {
    id: row.id,
    name: row.name,
    insured_person: row.insured_person,
    provider: row.provider,
    policy_number: row.policy_number ?? null,
    currency: currency as LifeInsuranceResponse["currency"],
    coverage_amount: row.coverage_amount,
    coverage_amount_inr: toInr(row.coverage_amount, currency, rates),
    renewal_date: row.renewal_date,
    days_to_renewal: daysUntil(row.renewal_date),
    premium_amount: row.premium_amount ?? null,
    premium_amount_inr: premiumInr,
    premium_frequency:
      (row.premium_frequency as LifeInsuranceResponse["premium_frequency"]) ??
      null,
    annual_premium_inr:
      premiumInr != null && perYear != null ? premiumInr * perYear : null,
    document_count: documentCount,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

/** doc counts keyed by life_insurance_id, in one query rather than N. */
async function documentCounts(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      id: investment_documents.life_insurance_id,
      count: sql<number>`count(*)`,
    })
    .from(investment_documents)
    .groupBy(investment_documents.life_insurance_id);

  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (r.id) counts[r.id] = Number(r.count);
  }
  return counts;
}

// ─── Service methods ──────────────────────────────────────────────────────────

export async function listLifeInsurance(): Promise<LifeInsuranceResponse[]> {
  const db = getDb();
  const [rows, rates, counts] = await Promise.all([
    db.select().from(life_insurance).orderBy(life_insurance.renewal_date),
    getLatestRates(),
    documentCounts(),
  ]);
  return rows.map((r) => toResponse(r, rates, counts[r.id] ?? 0));
}

export async function getLifeInsurance(
  id: string
): Promise<LifeInsuranceResponse> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(life_insurance)
    .where(eq(life_insurance.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Life insurance policy not found"), {
      status: 404,
    });
  }
  const [rates, counts] = await Promise.all([
    getLatestRates(),
    documentCounts(),
  ]);
  return toResponse(row, rates, counts[row.id] ?? 0);
}

export async function createLifeInsurance(
  data: CreateLifeInsuranceRequest
): Promise<LifeInsuranceResponse> {
  const db = getDb();
  // No companion `accounts` row and no balance: cover is not an asset, so it
  // must stay out of the net-worth breakdown entirely.
  const [row] = await db
    .insert(life_insurance)
    .values({
      name: data.name,
      insured_person: data.insured_person,
      provider: data.provider,
      policy_number: data.policy_number ?? null,
      currency: data.currency,
      coverage_amount: data.coverage_amount,
      renewal_date: data.renewal_date,
      premium_amount: data.premium_amount ?? null,
      premium_frequency: data.premium_frequency ?? null,
    })
    .returning();

  const rates = await getLatestRates();
  return toResponse(row, rates, 0);
}

export async function updateLifeInsurance(
  id: string,
  data: UpdateLifeInsuranceRequest
): Promise<LifeInsuranceResponse> {
  const db = getDb();
  const [row] = await db
    .update(life_insurance)
    .set({ ...data, updated_at: new Date().toISOString() })
    .where(eq(life_insurance.id, id))
    .returning();

  if (!row) {
    throw Object.assign(new Error("Life insurance policy not found"), {
      status: 404,
    });
  }

  const [rates, counts] = await Promise.all([
    getLatestRates(),
    documentCounts(),
  ]);
  return toResponse(row, rates, counts[row.id] ?? 0);
}

export async function deleteLifeInsurance(id: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(life_insurance)
    .where(eq(life_insurance.id, id))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Life insurance policy not found"), {
      status: 404,
    });
  }
  // The ON DELETE CASCADE on investment_documents.life_insurance_id only fires
  // when SQLite's foreign_keys pragma is on, which is not guaranteed here — so
  // delete the attached documents (rows and files) explicitly first.
  const { deleteDocument } = await import("./document.service");
  const docs = await db
    .select({ id: investment_documents.id })
    .from(investment_documents)
    .where(eq(investment_documents.life_insurance_id, id));
  for (const doc of docs) {
    await deleteDocument(doc.id);
  }

  await db.delete(life_insurance).where(eq(life_insurance.id, id));
}

/**
 * Policies renewing within `days` (and any already overdue), soonest first.
 * Exposed for the renewal-reminder strip in the UI.
 */
export async function getRenewalAlerts(
  days = 60
): Promise<LifeInsuranceResponse[]> {
  const all = await listLifeInsurance();
  return all
    .filter((p) => p.days_to_renewal <= days)
    .sort((a, b) => a.days_to_renewal - b.days_to_renewal);
}
