import { and, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db/index";
import { recurring_transactions, transactions } from "../db/schema";

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

    // Create the actual transaction
    await db.insert(transactions).values({
      id: nanoid(),
      account_id: r.account_id,
      envelope_id: r.envelope_id ?? null,
      payee: r.payee,
      amount: r.amount,
      type: r.type as "income" | "expense",
      date: r.next_date,
      notes: r.notes ? `[Auto] ${r.notes}` : "[Auto] Recurring",
    });

    // Advance next_date; deactivate if past end_date
    const nextDate = advanceDate(r.next_date, r.frequency);
    const expired = r.end_date ? nextDate > r.end_date : false;
    await db
      .update(recurring_transactions)
      .set({ next_date: nextDate, is_active: !expired })
      .where(eq(recurring_transactions.id, r.id));

    count++;
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
