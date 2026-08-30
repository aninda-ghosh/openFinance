import { and, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, runTransaction } from "../db/index";
import { recurring_transactions } from "../db/schema";
import {
  assertEnvelopeRequired,
  insertTransactionTx,
  resolveEnvelopeForMonth,
} from "./budget.service";

/**
 * Safety valve for the catch-up loop: a weekly rule left alone for five years
 * would still finish, but a corrupt next_date should not generate forever.
 */
const MAX_CATCHUP_PERIODS = 500;

export type RecurringTransaction = typeof recurring_transactions.$inferSelect;

function advanceDate(dateStr: string, frequency: string): string {
  const d = new Date(dateStr);
  switch (frequency) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "annual":
      d.setFullYear(d.getFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

// ─── Apply all due recurring transactions (called at startup and on demand) ───

export async function applyDueRecurring(): Promise<number> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const due = await db
    .select()
    .from(recurring_transactions)
    .where(
      and(
        eq(recurring_transactions.is_active, true),
        lte(recurring_transactions.next_date, today)
      )
    );

  let count = 0;
  for (const r of due) {
    // Skip if past end_date
    if (r.end_date && r.next_date > r.end_date) {
      await db
        .update(recurring_transactions)
        .set({ is_active: false })
        .where(eq(recurring_transactions.id, r.id));
      continue;
    }

    // Insert the transactions and advance next_date atomically — a crash
    // between the two would otherwise recreate the same transaction on the
    // next startup.
    //
    // The loop catches the rule all the way up to today: it used to advance
    // by a single period per run, so a rule three months overdue emitted one
    // transaction per server restart and stayed permanently behind.
    await runTransaction(async (tx) => {
      let nextDate = r.next_date;
      let generated = 0;

      while (nextDate <= today && generated < MAX_CATCHUP_PERIODS) {
        if (r.end_date && nextDate > r.end_date) break;

        // Envelope ids are per-month, so the id pinned on the rule only
        // matches the month it was created in. Re-resolve it for the month
        // this occurrence lands in, or leave the transaction uncategorised —
        // charging a closed month would hide the spend from every budget.
        let envelopeId: string | null = null;
        if (r.envelope_id) {
          envelopeId = await resolveEnvelopeForMonth(
            tx,
            r.envelope_id,
            nextDate.slice(0, 7)
          );
          if (!envelopeId) {
            console.warn(
              `[recurring] rule ${r.id} ("${r.payee}"): no envelope matching the rule's category exists for ${nextDate.slice(0, 7)} — recording the transaction uncategorised`
            );
          }
        }

        await insertTransactionTx(tx, {
          id: nanoid(),
          account_id: r.account_id,
          envelope_id: envelopeId,
          payee: r.payee,
          amount: r.amount,
          type: r.type as "income" | "expense",
          date: nextDate,
          notes: r.notes ? `[Auto] ${r.notes}` : "[Auto] Recurring",
        });
        generated++;

        const advanced = advanceDate(nextDate, r.frequency);
        if (advanced <= nextDate) {
          // Unknown frequency — advanceDate returned the same date. Bail out
          // rather than spin forever.
          console.error(
            `[recurring] rule ${r.id}: unknown frequency "${r.frequency}", deactivating`
          );
          await tx
            .update(recurring_transactions)
            .set({ is_active: false })
            .where(eq(recurring_transactions.id, r.id));
          count += generated;
          return;
        }
        nextDate = advanced;
      }

      const expired = r.end_date ? nextDate > r.end_date : false;
      await tx
        .update(recurring_transactions)
        .set({ next_date: nextDate, is_active: !expired })
        .where(eq(recurring_transactions.id, r.id));

      count += generated;
    });
  }
  return count;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listRecurring(): Promise<RecurringTransaction[]> {
  const db = getDb();
  return db
    .select()
    .from(recurring_transactions)
    .orderBy(recurring_transactions.next_date);
}

/**
 * The envelope rule is enforced when the RULE is created/updated rather than
 * when it fires: a rule that would generate uncategorised on-budget expenses
 * every month is the bug, and failing at fire time would break automation
 * silently instead of telling the user.
 */
async function assertRecurringEnvelope(
  accountId: string | undefined,
  type: string | undefined,
  envelopeId: string | null | undefined
) {
  if (!accountId || type !== "expense" || envelopeId) return;
  await assertEnvelopeRequired(getDb(), accountId, type, envelopeId);
}

export async function createRecurring(data: {
  payee: string;
  amount: number;
  type: "income" | "expense";
  account_id: string;
  envelope_id?: string | null;
  frequency: "weekly" | "monthly" | "quarterly" | "annual";
  next_date: string;
  end_date?: string | null;
  notes?: string | null;
}): Promise<RecurringTransaction> {
  const db = getDb();
  await assertRecurringEnvelope(data.account_id, data.type, data.envelope_id);
  const [row] = await db
    .insert(recurring_transactions)
    .values({
      id: nanoid(),
      ...data,
      envelope_id: data.envelope_id ?? null,
      end_date: data.end_date ?? null,
      notes: data.notes ?? null,
      is_active: true,
    })
    .returning();
  return row;
}

export async function updateRecurring(
  id: string,
  data: Partial<{
    payee: string;
    amount: number;
    type: "income" | "expense";
    account_id: string;
    envelope_id: string | null;
    frequency: "weekly" | "monthly" | "quarterly" | "annual";
    next_date: string;
    end_date: string | null;
    notes: string | null;
    is_active: boolean;
  }>
): Promise<RecurringTransaction> {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(recurring_transactions)
    .where(eq(recurring_transactions.id, id))
    .limit(1);
  if (!existing)
    throw Object.assign(new Error("Recurring transaction not found"), {
      status: 404,
    });
  await assertRecurringEnvelope(
    data.account_id ?? existing.account_id,
    data.type ?? existing.type,
    data.envelope_id !== undefined ? data.envelope_id : existing.envelope_id
  );

  const [row] = await db
    .update(recurring_transactions)
    .set(data)
    .where(eq(recurring_transactions.id, id))
    .returning();
  if (!row)
    throw Object.assign(new Error("Recurring transaction not found"), {
      status: 404,
    });
  return row;
}

export async function deleteRecurring(id: string): Promise<void> {
  const db = getDb();
  const result = await db
    .delete(recurring_transactions)
    .where(eq(recurring_transactions.id, id))
    .returning({ id: recurring_transactions.id });
  if (result.length === 0)
    throw Object.assign(new Error("Recurring transaction not found"), {
      status: 404,
    });
}
