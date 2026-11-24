/**
 * Bulk add: many rows for one account (typically a pasted statement), saved
 * all-or-nothing.
 *
 * Every row goes through the same createTransaction / createTransfer the
 * single-add form uses, so the envelope rules, month re-filing and transfer
 * pairing cannot drift from the one-at-a-time path. runTransaction joins an
 * already-open transaction, so wrapping the loop in one makes the whole batch
 * commit or roll back together.
 */
import type {
  BulkCreateRequest,
  BulkCreateResponse,
  BulkPreviewRequest,
  BulkPreviewResponse,
  BulkRow,
  BulkRowError,
} from "@openfinance/shared/api-contracts";
import { hashRow } from "@openfinance/shared/utils/hash";
import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { getDb, runTransaction } from "../db/index";
import { accounts, envelopes, transactions } from "../db/schema";
import {
  createTransaction,
  createTransfer,
  resolveEnvelopeForMonth,
} from "./budget.service";

/** Days either side of a row's date that count as "possibly the same". */
const DUPLICATE_WINDOW_DAYS = 3;

export class BulkValidationError extends Error {
  status = 400;
  constructor(public errors: BulkRowError[]) {
    super("Some rows need attention");
  }
}

/** Import hash for a pasted line, scoped to the account it was pasted into. */
export function bulkImportHash(accountId: string, sourceKey: string): string {
  return hashRow(`bulk|${accountId}|${sourceKey}`);
}

// ─── Payee matching ───────────────────────────────────────────────────────────

/** Tokens bank descriptions add that say nothing about the merchant. */
const PAYEE_NOISE = new Set([
  "ach",
  "aplpay",
  "autopay",
  "card",
  "co",
  "com",
  "debit",
  "inc",
  "llc",
  "ltd",
  "online",
  "paypal",
  "pos",
  "purchase",
  "recurring",
  "sq",
  "the",
  "tst",
  "www",
]);

/**
 * Lookup keys for a payee, most specific first. "SQ *BLUE BOTTLE #123 OAKLAND"
 * and "Blue Bottle" share "blue bottle"; "STARBUCKS STORE 1234" and "Starbucks"
 * share "starbucks". The one-word key needs 4+ letters so "the"-like stubs
 * cannot match everything.
 */
export function payeeKeys(payee: string): string[] {
  const tokens = payee
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !PAYEE_NOISE.has(t));
  if (tokens.length === 0) return [];
  const keys: string[] = [];
  if (tokens.length >= 2) keys.push(`${tokens[0]} ${tokens[1]}`);
  if (tokens[0].length >= 4) keys.push(tokens[0]);
  return keys;
}

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/**
 * Read-only checks for the grid: which rows were already imported, which look
 * like something already in the account, and the category each payee had last.
 */
export async function previewBulk(
  req: BulkPreviewRequest
): Promise<BulkPreviewResponse> {
  const db = getDb();
  if (req.rows.length === 0) return { rows: [] };

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, req.account_id))
    .limit(1);
  if (!account)
    throw Object.assign(new Error("Account not found"), { status: 404 });

  // Already imported: the same pasted line, saved before.
  const hashes = req.rows.map((r) =>
    r.source_key ? bulkImportHash(req.account_id, r.source_key) : null
  );
  const wanted = hashes.filter((h): h is string => !!h);
  const imported = new Set<string>();
  for (let i = 0; i < wanted.length; i += 500) {
    const found = await db
      .select({ hash: transactions.import_hash })
      .from(transactions)
      .where(inArray(transactions.import_hash, wanted.slice(i, i + 500)));
    for (const f of found) if (f.hash) imported.add(f.hash);
  }

  // Possible duplicates: same amount in this account within a few days.
  const dates = req.rows.map((r) => r.date).sort();
  const nearby = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      payee: transactions.payee,
      amount: transactions.amount,
      type: transactions.type,
      notes: transactions.notes,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.account_id, req.account_id),
        gte(transactions.date, shiftIsoDate(dates[0], -DUPLICATE_WINDOW_DAYS)),
        lte(
          transactions.date,
          shiftIsoDate(dates[dates.length - 1], DUPLICATE_WINDOW_DAYS)
        )
      )
    );

  // Category history: the most recent envelope used for each payee key.
  const history = await db
    .select({
      payee: transactions.payee,
      envelope_id: transactions.envelope_id,
    })
    .from(transactions)
    .where(
      and(eq(transactions.type, "expense"), isNotNull(transactions.envelope_id))
    )
    .orderBy(asc(transactions.date), asc(transactions.created_at));
  const lastEnvelopeByKey = new Map<string, string>();
  for (const h of history) {
    if (!h.envelope_id) continue;
    for (const key of payeeKeys(h.payee))
      lastEnvelopeByKey.set(key, h.envelope_id);
  }

  // Suggestions are returned in the grid's category month.
  const inMonth = new Map<string, string | null>();
  const toCategoryMonth = async (envelopeId: string) => {
    if (!inMonth.has(envelopeId)) {
      inMonth.set(
        envelopeId,
        await resolveEnvelopeForMonth(db, envelopeId, req.category_month)
      );
    }
    return inMonth.get(envelopeId) ?? null;
  };

  const rows: BulkPreviewResponse["rows"] = [];
  for (const [i, r] of req.rows.entries()) {
    const lo = shiftIsoDate(r.date, -DUPLICATE_WINDOW_DAYS);
    const hi = shiftIsoDate(r.date, DUPLICATE_WINDOW_DAYS);
    const amount = Math.abs(r.amount);
    const possible_duplicates = nearby
      .filter(
        (t) =>
          t.date >= lo && t.date <= hi && Math.abs(t.amount - amount) < 0.005
      )
      .map(({ id, date, payee, amount, type, notes }) => ({
        id,
        date,
        // Transfer legs carry a fixed payee; the description lives in notes.
        payee: type === "transfer" && notes ? `${payee} · ${notes}` : payee,
        amount,
        type,
      }));

    let suggested: string | null = null;
    for (const key of payeeKeys(r.payee)) {
      const hit = lastEnvelopeByKey.get(key);
      if (hit) {
        suggested = await toCategoryMonth(hit);
        if (suggested) break;
      }
    }

    rows.push({
      already_imported: !!hashes[i] && imported.has(hashes[i] as string),
      possible_duplicates,
      suggested_envelope_id: suggested,
    });
  }
  return { rows };
}

// ─── Create ───────────────────────────────────────────────────────────────────

type AccountRow = typeof accounts.$inferSelect;

function validateRow(
  r: BulkRow,
  account: AccountRow,
  accountsById: Map<string, AccountRow>,
  envelopeIds: Set<string>
): string | null {
  if (r.envelope_id && !envelopeIds.has(r.envelope_id)) {
    return "That category no longer exists — pick another.";
  }

  if (r.type === "expense") {
    if (!account.off_budget && !r.envelope_id) {
      return "Pick a category — spending on an on-budget account needs one.";
    }
    return null;
  }

  if (r.type === "transfer") {
    if (!r.direction) return "Choose whether money moved in or out.";
    if (!r.counterpart_account_id)
      return "Choose the other account for this transfer.";
    if (r.counterpart_account_id === account.id) {
      return "A transfer needs two different accounts.";
    }
    const other = accountsById.get(r.counterpart_account_id);
    if (!other) return "The other account no longer exists.";
    if ((other.currency ?? "INR") !== (account.currency ?? "INR")) {
      return "Transfers between currencies need both amounts — add this one with Quick Add.";
    }
    const from = r.direction === "out" ? account : other;
    const to = r.direction === "out" ? other : account;
    if (!from.off_budget && to.off_budget && !r.envelope_id) {
      return `Pick a category — money leaving the budget for ${to.name} needs one.`;
    }
  }
  return null;
}

export async function createBulk(
  req: BulkCreateRequest
): Promise<BulkCreateResponse> {
  const db = getDb();

  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, req.account_id))
    .limit(1);
  if (!account)
    throw Object.assign(new Error("Account not found"), { status: 404 });

  const counterpartIds = [
    ...new Set(
      req.rows
        .map((r) => r.counterpart_account_id)
        .filter((id): id is string => !!id)
    ),
  ];
  const counterparts = counterpartIds.length
    ? await db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, counterpartIds))
    : [];
  const accountsById = new Map(counterparts.map((a) => [a.id, a]));

  const envelopeIdsWanted = [
    ...new Set(
      req.rows.map((r) => r.envelope_id).filter((id): id is string => !!id)
    ),
  ];
  const foundEnvelopes = envelopeIdsWanted.length
    ? await db
        .select({ id: envelopes.id })
        .from(envelopes)
        .where(inArray(envelopes.id, envelopeIdsWanted))
    : [];
  const envelopeIds = new Set(foundEnvelopes.map((e) => e.id));

  // Check every row first, so the user sees all problems at once rather than
  // fixing them one failed save at a time.
  const errors: BulkRowError[] = [];
  req.rows.forEach((r, index) => {
    const message = validateRow(r, account, accountsById, envelopeIds);
    if (message) errors.push({ index, message });
  });
  if (errors.length > 0) throw new BulkValidationError(errors);

  let created = 0;
  let skipped = 0;
  await runTransaction(async () => {
    for (const [index, r] of req.rows.entries()) {
      const import_hash = r.source_key
        ? bulkImportHash(account.id, r.source_key)
        : undefined;
      try {
        let result: unknown;
        if (r.type === "transfer") {
          const out = r.direction === "out";
          const other = r.counterpart_account_id as string;
          result = await createTransfer({
            from_account_id: out ? account.id : other,
            to_account_id: out ? other : account.id,
            amount: r.amount,
            to_amount: r.amount,
            date: r.date,
            // Transfer legs have a fixed payee; keep the bank's description.
            notes: r.notes?.trim() || r.payee,
            import_hash,
            envelope_id: r.envelope_id,
          });
        } else {
          result = await createTransaction({
            account_id: account.id,
            payee: r.payee,
            amount: r.amount,
            type: r.type,
            date: r.date,
            notes: r.notes?.trim() || undefined,
            import_hash,
            envelope_id: r.type === "expense" ? r.envelope_id : undefined,
            income_category:
              r.type === "income" ? (r.income_category ?? "income") : undefined,
          });
        }
        if (result === null) skipped++;
        else created++;
      } catch (err) {
        // Rolls the whole batch back and points the grid at this row.
        const e = err as { message?: string };
        throw new BulkValidationError([
          { index, message: e.message || "This row could not be saved." },
        ]);
      }
    }
  });

  return { created, skipped };
}
