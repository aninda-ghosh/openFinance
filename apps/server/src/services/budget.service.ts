import type {
  AccountResponse,
  CreateAccountRequest,
  CreateEnvelopeRequest,
  CreateTransactionRequest,
  EnvelopeWithGroupResponse,
  ImportResult,
  MonthlySummaryResponse,
  PaginatedTransactionsResponse,
  TransactionFilters,
  TransactionResponse,
  TrendResponse,
  UpdateAccountRequest,
  UpdateEnvelopeRequest,
  UpdateTransactionRequest,
} from "@openfinance/shared/api-contracts";
import {
  BALANCE_ADJUSTMENT_PAYEE,
  balanceDelta,
  bearsHoldings,
  isLiabilityType,
  isTransferIn,
  STARTING_BALANCE_PAYEE,
  TRANSFER_IN,
  TRANSFER_OUT,
} from "@openfinance/shared/constants";
import { hashRow } from "@openfinance/shared/utils/hash";
import { parse } from "csv-parse/sync";
import { and, desc, eq, gte, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, runTransaction } from "../db/index";
import {
  accounts,
  envelope_groups,
  envelopes,
  exchange_rates,
  recurring_transactions,
  transactions,
  investments,
} from "../db/schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getLatestRates(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(exchange_rates)
    .orderBy(desc(exchange_rates.fetched_at));

  const latest: Record<string, number> = {};
  for (const row of rows) {
    if (row.from_currency && !latest[row.from_currency]) {
      latest[row.from_currency] = row.rate_to_base ?? 1;
    }
  }
  return latest;
}

function toInr(
  amount: number,
  currency: string,
  rates: Record<string, number>
): number {
  return amount * (rates[currency] ?? 1.0);
}

function toAccountResponse(
  row: typeof accounts.$inferSelect,
  rates: Record<string, number>
): AccountResponse {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AccountResponse["type"],
    currency: (row.currency ?? "INR") as AccountResponse["currency"],
    balance: row.balance ?? 0,
    balance_inr: toInr(row.balance ?? 0, row.currency ?? "INR", rates),
    institution: row.institution ?? null,
    is_active: row.is_active ?? true,
    off_budget: row.off_budget ?? false,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? "",
  };
}

function toTransactionResponse(
  row: typeof transactions.$inferSelect & { currency?: string | null }
): TransactionResponse {
  return {
    id: row.id,
    account_id: row.account_id,
    envelope_id: row.envelope_id ?? null,
    payee: row.payee,
    amount: row.amount,
    currency: row.currency ?? "INR",
    type: row.type as TransactionResponse["type"],
    date: row.date,
    notes: row.notes ?? null,
    income_category:
      (row.income_category as TransactionResponse["income_category"]) ?? null,
    created_at: row.created_at ?? "",
  };
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

/**
 * The parts of an account's derived balance, all in the account's native
 * currency (`native`, `holdingsNative`) or the base currency (`base`,
 * `holdingsBase`).
 *
 * `native` is the full derived balance: stored opening balance (sign-normalised
 * for liabilities) + the net of every transaction + the current value of any
 * `investments` rows linked to the account. `holdingsNative` is just that last
 * term, so a caller that wants a **holdings-excluded** balance (a cash-only
 * balance, e.g. for a running-balance ledger or a net-worth breakdown that
 * counts holdings separately) can use `native - holdingsNative` without
 * re-deriving anything.
 */
export type AccountBalanceParts = {
  native: number;
  base: number;
  holdingsBase: number;
  holdingsNative: number;
};

/**
 * Derives the live balance of every account. This is THE definition of an
 * account balance — `accounts.balance` is only an opening balance, never the
 * current one, so nothing should read that column directly.
 *
 * Exported so other services (dashboard, reports) can consume the same numbers
 * `listAccounts` returns, including the holdings split, instead of writing a
 * fourth balance derivation.
 */
export async function getAccountBalances(): Promise<
  Map<string, AccountBalanceParts>
> {
  const db = getDb();
  const rates = await getLatestRates();
  const rows = await db.select().from(accounts);
  return deriveAccountBalances(rows, rates);
}

async function deriveAccountBalances(
  rows: (typeof accounts.$inferSelect)[],
  rates: Record<string, number>
): Promise<Map<string, AccountBalanceParts>> {
  const db = getDb();

  // Build a currency map for each account
  const accountCurrency: Record<string, string> = {};
  for (const r of rows) accountCurrency[r.id] = r.currency ?? "INR";

  // Compute live balance from transactions for every account atomically.
  // Transaction amounts are stored in the account's native currency.
  // We accumulate the native delta per account, then convert to INR at the end.
  const txnTotals = await db
    .select({
      account_id: transactions.account_id,
      type: transactions.type,
      payee: transactions.payee,
      total: sql<number>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .groupBy(transactions.account_id, transactions.type, transactions.payee);

  // Build per-account native delta (income/expense/transfers)
  const txnDeltaNative: Record<string, number> = {};
  for (const t of txnTotals) {
    if (!t.account_id) continue;
    const delta = balanceDelta({
      type: t.type,
      payee: t.payee,
      amount: t.total,
    });
    if (delta === null) {
      // A transfer leg whose payee is neither direction cannot be signed.
      // It used to contribute zero silently, quietly understating the
      // account; say so instead of hiding it.
      console.error(
        `[balance] account ${t.account_id}: ${t.type} rows with payee "${t.payee}" ` +
          `have no balance direction and are excluded from the derived balance ` +
          `(transfer legs must be "${TRANSFER_IN}" or "${TRANSFER_OUT}")`
      );
      continue;
    }
    txnDeltaNative[t.account_id] = (txnDeltaNative[t.account_id] ?? 0) + delta;
  }

  // Sum current_value from investments grouped by account_id and currency
  const invTotals = await db
    .select({
      account_id: investments.account_id,
      currency: investments.currency,
      total: sql<number>`sum(${investments.current_value})`,
    })
    .from(investments)
    .groupBy(investments.account_id, investments.currency);

  const invDeltaNative: Record<string, number> = {};
  for (const inv of invTotals) {
    if (!inv.account_id) continue;
    const accountCurr = accountCurrency[inv.account_id] || "INR";
    const invCurr = inv.currency ?? "INR";
    
    let valueInAccountCurrency = inv.total;
    if (invCurr !== accountCurr) {
      const rateFrom = rates[invCurr] ?? 1.0;
      const rateTo = rates[accountCurr] ?? 1.0;
      valueInAccountCurrency = (inv.total * rateFrom) / rateTo;
    }
    
    invDeltaNative[inv.account_id] = (invDeltaNative[inv.account_id] ?? 0) + valueInAccountCurrency;
  }

  const balances = new Map<string, AccountBalanceParts>();
  for (const r of rows) {
    const currency = r.currency ?? "INR";
    // Liabilities (credit/loan/debt) are stored negative — normalize here so
    // an account created positive by any dialog still behaves correctly.
    const startBalance = isLiabilityType(r.type)
      ? -Math.abs(r.balance ?? 0)
      : (r.balance ?? 0);

    // Holdings-bearing accounts fold in the current value of the investments
    // linked to them.
    const holdingsNative = bearsHoldings(r.type)
      ? (invDeltaNative[r.id] ?? 0)
      : 0;

    const native = startBalance + (txnDeltaNative[r.id] ?? 0) + holdingsNative;

    balances.set(r.id, {
      native,
      base: toInr(native, currency, rates),
      holdingsNative,
      holdingsBase: toInr(holdingsNative, currency, rates),
    });
  }
  return balances;
}

export async function listAccounts(): Promise<AccountResponse[]> {
  const db = getDb();
  const rates = await getLatestRates();
  const rows = await db.select().from(accounts).orderBy(accounts.name);
  const balances = await deriveAccountBalances(rows, rates);

  return rows.map((r) => {
    const live = balances.get(r.id);
    return {
      id: r.id,
      name: r.name,
      type: r.type as AccountResponse["type"],
      currency: (r.currency ?? "INR") as AccountResponse["currency"],
      balance: live?.native ?? 0,
      balance_inr: live?.base ?? 0,
      institution: r.institution ?? null,
      is_active: r.is_active ?? true,
      off_budget: r.off_budget ?? false,
      created_at: r.created_at ?? "",
      updated_at: r.updated_at ?? "",
    };
  });
}

export async function createAccount(
  data: CreateAccountRequest
): Promise<AccountResponse> {
  const db = getDb();
  const rates = await getLatestRates();

  const isDebt = isLiabilityType(data.type);
  const openingBalance = isDebt
    ? -Math.abs(data.balance ?? 0)
    : (data.balance ?? 0);
  const shouldSeedTransaction =
    openingBalance > 0 && !data.off_budget && !isDebt;

  const row = await runTransaction(async (tx) => {
    const [created] = await tx
      .insert(accounts)
      .values({ ...data, balance: shouldSeedTransaction ? 0 : openingBalance })
      .returning();

    if (shouldSeedTransaction) {
      await insertTransactionTx(tx, {
        account_id: created.id,
        payee: STARTING_BALANCE_PAYEE,
        amount: openingBalance,
        type: "income",
        date: new Date().toISOString().slice(0, 10),
        income_category: "starting_balance",
      });
    }

    return created;
  });

  return toAccountResponse(row, rates);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Updates an account's metadata and, if the caller sent a `balance`,
 * reconciles the account to it.
 *
 * `accounts.balance` is an OPENING balance — the live balance is derived
 * (see `getAccountBalances`). Writing the client's number straight into that
 * column, as this used to, double-counted every transaction and every linked
 * holding: the edit dialogs prefill the field with the derived balance, so
 * saving an unrelated field (a rename) re-added the whole transaction history
 * to the opening balance and doubled the account.
 *
 * Instead the requested balance is treated as a reconciliation target: the
 * difference against the current derived balance is posted as a visible
 * `Balance Adjustment` transaction. When they already match — the common case,
 * because the dialog prefills the derived value — nothing is written.
 */
export async function updateAccount(
  id: string,
  data: UpdateAccountRequest
): Promise<AccountResponse> {
  const db = getDb();
  const rates = await getLatestRates();

  const { balance: requestedBalance, ...fields } = data;

  const [existing] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1);
  if (!existing)
    throw Object.assign(new Error("Account not found"), { status: 404 });

  // Never write `balance` from this path — only metadata.
  let row = existing;
  if (Object.keys(fields).length > 0) {
    const [updated] = await db
      .update(accounts)
      .set({ ...fields, updated_at: new Date().toISOString() })
      .where(eq(accounts.id, id))
      .returning();
    if (!updated)
      throw Object.assign(new Error("Account not found"), { status: 404 });
    row = updated;
  }

  const currency = row.currency ?? "INR";
  const balances = await getAccountBalances();
  let derived = round2(balances.get(id)?.native ?? 0);

  if (requestedBalance !== undefined) {
    // Liabilities are stored and reported negative; accept either sign from
    // the client and let the server own it (same rule as createAccount).
    const isDebt = isLiabilityType(row.type);
    const target = round2(
      isDebt ? -Math.abs(requestedBalance) : requestedBalance
    );
    const diff = round2(target - derived);

    if (Math.abs(diff) >= 0.01) {
      await runTransaction(async (tx) => {
        await insertTransactionTx(tx, {
          account_id: id,
          payee: BALANCE_ADJUSTMENT_PAYEE,
          amount: Math.abs(diff),
          // Deliberately envelope-less: a reconciliation is not budgeted
          // spending, and this must work on off-budget accounts too.
          envelope_id: null,
          type: diff > 0 ? "income" : "expense",
          date: new Date().toISOString().slice(0, 10),
          notes: `Reconciled from ${derived.toFixed(2)} to ${target.toFixed(2)}`,
        });
      });
      derived = target;
    }
  }

  return {
    ...toAccountResponse(row, rates),
    balance: derived,
    balance_inr: toInr(derived, currency, rates),
  };
}

export async function deleteAccount(id: string): Promise<void> {
  const db = getDb();
  await runTransaction(async (tx) => {
    // No envelope bookkeeping to undo: envelope spend is derived from the
    // transactions themselves (see computeSpentByEnvelope), so deleting them
    // is the reversal.
    await tx
      .delete(recurring_transactions)
      .where(eq(recurring_transactions.account_id, id));
    await tx.delete(transactions).where(eq(transactions.account_id, id));
    const result = await tx
      .delete(accounts)
      .where(eq(accounts.id, id))
      .returning();
    if (result.length === 0)
      throw Object.assign(new Error("Account not found"), { status: 404 });
  });
}

// Envelopes

const activeSeeds = new Map<string, Promise<void>>();

async function seedMonthFromTemplate(
  db: ReturnType<typeof getDb>,
  month: string
) {
  if (activeSeeds.has(month)) {
    return activeSeeds.get(month);
  }

  const promise = (async () => {
    await runTransaction(async (tx) => {
      // 1. Prevent race condition by double checking inside transaction
      const existing = await tx
        .select({ id: envelopes.id })
        .from(envelopes)
        .where(eq(envelopes.month, month))
        .limit(1);
      if (existing.length > 0) return; // already seeded!

      // 2. Find most recent template month
      const template = await tx
        .select({ month: envelopes.month })
        .from(envelopes)
        .orderBy(desc(envelopes.month))
        .limit(1);

      if (template.length === 0) return; // nothing to seed from

      const srcMonth = template[0].month;
      const srcRows = await tx
        .select({
          group_id: envelopes.group_id,
          name: envelopes.name,
          budgeted: envelopes.budgeted,
          budget_currency: envelopes.budget_currency,
        })
        .from(envelopes)
        .where(eq(envelopes.month, srcMonth));

      if (srcRows.length === 0) return;

      // 3. Insert and copy the previous month's budgeted amount and budget currency
      await tx.insert(envelopes).values(
        srcRows.map((r: any) => ({
          group_id: r.group_id,
          name: r.name,
          month,
          budgeted: r.budgeted ?? 0,
          budget_currency: r.budget_currency ?? ("INR" as const),
        }))
      );
    });
  })();

  activeSeeds.set(month, promise);
  try {
    await promise;
  } finally {
    activeSeeds.delete(month);
  }
}

/**
 * THE definition of "how much has been spent against each envelope of `month`",
 * in BASE currency, keyed by envelope id.
 *
 * Expenses and the outgoing leg of a transfer debit their envelope; the
 * incoming leg credits it, so a credited envelope can come back negative.
 * Amounts are stored in the account's native currency and converted here.
 *
 * The `envelopes.spent` column is NOT used: it used to be maintained
 * incrementally in account-native currency by four writers and overwritten
 * wholesale in base currency by a fifth, so it was only ever right for the
 * last month someone happened to open a report on. The column still exists
 * (dropping it needs a migration) but nothing reads or writes it — this
 * function is the only source of truth.
 *
 * Off-budget accounts are deliberately NOT excluded: if a transaction was
 * assigned an envelope, the user meant it to count against that envelope
 * (this is also how on-to-off-budget transfers are budgeted).
 *
 * @param envelopeIds pass the month's envelope ids when the caller already has
 *   them, to skip a lookup. Every id passed (or found) appears in the result.
 */
export async function computeSpentByEnvelope(
  month: string,
  rates: Record<string, number>,
  envelopeIds?: string[]
): Promise<Record<string, number>> {
  const db = getDb();

  const ids =
    envelopeIds ??
    (
      await db
        .select({ id: envelopes.id })
        .from(envelopes)
        .where(eq(envelopes.month, month))
    ).map((r) => r.id);

  const spent: Record<string, number> = {};
  for (const id of ids) spent[id] = 0;
  if (ids.length === 0) return spent;

  const [year, mon] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;

  const rows = await db
    .select({
      envelope_id: transactions.envelope_id,
      amount: transactions.amount,
      currency: accounts.currency,
      type: transactions.type,
      payee: transactions.payee,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .where(
      and(
        or(eq(transactions.type, "expense"), eq(transactions.type, "transfer")),
        gte(transactions.date, dateFrom),
        lte(transactions.date, dateTo),
        inArray(transactions.envelope_id, ids)
      )
    );

  for (const r of rows) {
    if (!r.envelope_id) continue;
    const base = toInr(r.amount, r.currency ?? "INR", rates);
    const isCredit = isTransferIn(r);
    spent[r.envelope_id] = (spent[r.envelope_id] ?? 0) + (isCredit ? -base : base);
  }

  return spent;
}

export async function listEnvelopes(
  month: string
): Promise<EnvelopeWithGroupResponse[]> {
  const db = getDb();
  const rates = await getLatestRates();

  let rows = await db
    .select({
      id: envelopes.id,
      group_id: envelopes.group_id,
      group_name: envelope_groups.name,
      name: envelopes.name,
      budgeted: envelopes.budgeted,
      budget_currency: envelopes.budget_currency,
      month: envelopes.month,
      rollover_type: envelopes.rollover_type,
      rollover_amount: envelopes.rollover_amount,
      created_at: envelopes.created_at,
    })
    .from(envelopes)
    .innerJoin(envelope_groups, eq(envelopes.group_id, envelope_groups.id))
    .where(eq(envelopes.month, month))
    .orderBy(envelope_groups.sort_order, envelopes.name);

  // Auto-seed this month from the most recent month if it has no envelopes yet
  if (rows.length === 0) {
    await seedMonthFromTemplate(db, month);
    rows = await db
      .select({
        id: envelopes.id,
        group_id: envelopes.group_id,
        group_name: envelope_groups.name,
        name: envelopes.name,
        budgeted: envelopes.budgeted,
        budget_currency: envelopes.budget_currency,
        month: envelopes.month,
        rollover_type: envelopes.rollover_type,
        rollover_amount: envelopes.rollover_amount,
        created_at: envelopes.created_at,
      })
      .from(envelopes)
      .innerJoin(envelope_groups, eq(envelopes.group_id, envelope_groups.id))
      .where(eq(envelopes.month, month))
      .orderBy(envelope_groups.sort_order, envelopes.name);
  }

  // Net spent per envelope, in base currency (single source of truth).
  const envIds = rows.map((r) => r.id);
  const spentMap = await computeSpentByEnvelope(month, rates, envIds);

  // ── Rollover: fetch previous month's envelopes for any that have rollover set ─
  const hasRollover = rows.some(
    (r) => r.rollover_type && r.rollover_type !== "none"
  );
  const prevSpentMap: Record<string, number> = {}; // keyed by "group_id|name"
  const prevBudgetedMap: Record<string, number> = {}; // keyed by "group_id|name", value in INR

  if (hasRollover) {
    const [y, m] = month.split("-").map(Number);
    const prevDate = new Date(y, m - 2, 1); // month is 1-based, so m-2 gives previous
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

    const prevRows = await db
      .select({
        id: envelopes.id,
        group_id: envelopes.group_id,
        name: envelopes.name,
        budgeted: envelopes.budgeted,
        budget_currency: envelopes.budget_currency,
      })
      .from(envelopes)
      .where(eq(envelopes.month, prevMonth));

    // Same spent definition as the current month, one month back.
    const prevSpentById = await computeSpentByEnvelope(
      prevMonth,
      rates,
      prevRows.map((r) => r.id)
    );

    for (const pr of prevRows) {
      const key = `${pr.group_id}|${pr.name}`;
      prevBudgetedMap[key] = toInr(
        pr.budgeted ?? 0,
        pr.budget_currency ?? "INR",
        rates
      );
      prevSpentMap[key] = prevSpentById[pr.id] ?? 0;
    }
  }

  return rows.map((r) => {
    const budgetCurrency = r.budget_currency ?? "INR";
    let budgetedInr = toInr(r.budgeted ?? 0, budgetCurrency, rates);
    const spent = spentMap[r.id] ?? 0;
    const rolloverType = (r.rollover_type ??
      "none") as EnvelopeWithGroupResponse["rollover_type"];

    // Apply rollover from previous month
    if (rolloverType !== "none") {
      const key = `${r.group_id}|${r.name}`;
      const prevBudgeted = prevBudgetedMap[key] ?? 0;
      const prevSpent = prevSpentMap[key] ?? 0;
      if (rolloverType === "leftover") {
        const leftover = prevBudgeted - prevSpent;
        if (leftover > 0) budgetedInr += leftover;
      } else if (rolloverType === "amount") {
        budgetedInr += toInr(r.rollover_amount ?? 0, budgetCurrency, rates);
      }
    }

    return {
      id: r.id,
      group_id: r.group_id,
      group_name: r.group_name,
      name: r.name,
      budgeted: r.budgeted ?? 0,
      budget_currency: budgetCurrency,
      budgeted_inr: budgetedInr,
      spent,
      available: budgetedInr - spent,
      month: r.month,
      rollover_type: rolloverType,
      rollover_amount: r.rollover_amount ?? 0,
      created_at: r.created_at ?? "",
    };
  });
}

export async function createEnvelope(data: CreateEnvelopeRequest) {
  const db = getDb();
  const rates = await getLatestRates();
  const [row] = await db.insert(envelopes).values(data).returning();
  const budgetCurrency = row.budget_currency ?? "INR";
  const budgetedInr = toInr(row.budgeted ?? 0, budgetCurrency, rates);
  return {
    id: row.id,
    group_id: row.group_id,
    name: row.name,
    budgeted: row.budgeted ?? 0,
    budget_currency: budgetCurrency,
    budgeted_inr: budgetedInr,
    spent: 0,
    available: budgetedInr,
    month: row.month,
    rollover_type: (row.rollover_type ?? "none") as
      | "none"
      | "amount"
      | "leftover",
    rollover_amount: row.rollover_amount ?? 0,
    created_at: row.created_at ?? "",
  };
}

export async function updateEnvelope(id: string, data: UpdateEnvelopeRequest) {
  const db = getDb();
  const rates = await getLatestRates();
  const [row] = await db
    .update(envelopes)
    .set(data)
    .where(eq(envelopes.id, id))
    .returning();
  if (!row)
    throw Object.assign(new Error("Envelope not found"), { status: 404 });

  // `spent` and `available` are always base currency, derived from
  // transactions — never read back from the dead `spent` column.
  const budgetCurrency = row.budget_currency ?? "INR";
  const budgetedInr = toInr(row.budgeted ?? 0, budgetCurrency, rates);
  const spent = (await computeSpentByEnvelope(row.month, rates, [row.id]))[
    row.id
  ];

  return {
    id: row.id,
    group_id: row.group_id,
    name: row.name,
    budgeted: row.budgeted ?? 0,
    budget_currency: budgetCurrency,
    budgeted_inr: budgetedInr,
    spent,
    available: budgetedInr - spent,
    month: row.month,
    rollover_type: (row.rollover_type ?? "none") as
      | "none"
      | "amount"
      | "leftover",
    rollover_amount: row.rollover_amount ?? 0,
    created_at: row.created_at ?? "",
  };
}

export async function listEnvelopeGroups() {
  const db = getDb();
  return db.select().from(envelope_groups).orderBy(envelope_groups.sort_order);
}

export async function createEnvelopeGroup(name: string) {
  const db = getDb();
  const existing = await db
    .select({ n: sql<number>`count(*)` })
    .from(envelope_groups);
  const sort_order = Number(existing[0]?.n ?? 0);
  const [row] = await db
    .insert(envelope_groups)
    .values({ name, sort_order })
    .returning();
  return row;
}

export async function updateEnvelopeGroup(id: string, name: string) {
  const db = getDb();
  const [row] = await db
    .update(envelope_groups)
    .set({ name })
    .where(eq(envelope_groups.id, id))
    .returning();
  if (!row) throw Object.assign(new Error("Group not found"), { status: 404 });
  return row;
}

export async function deleteEnvelopeGroup(id: string) {
  const db = getDb();
  // Get all envelopes in this group so we can clean up their transactions
  const groupEnvelopes = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(eq(envelopes.group_id, id));
  if (groupEnvelopes.length > 0) {
    const envIds = groupEnvelopes.map((e) => e.id);
    // Nullify FK on transactions for all envelopes in this group
    for (const envId of envIds) {
      await db
        .update(transactions)
        .set({ envelope_id: null })
        .where(eq(transactions.envelope_id, envId));
    }
    // Delete all envelopes in the group
    await db.delete(envelopes).where(eq(envelopes.group_id, id));
  }
  const result = await db
    .delete(envelope_groups)
    .where(eq(envelope_groups.id, id))
    .returning();
  if (result.length === 0)
    throw Object.assign(new Error("Group not found"), { status: 404 });
}

export async function deleteEnvelope(id: string): Promise<void> {
  const db = getDb();
  // Nullify FK on transactions first so the delete doesn't hit a constraint
  await db
    .update(transactions)
    .set({ envelope_id: null })
    .where(eq(transactions.envelope_id, id));
  const result = await db
    .delete(envelopes)
    .where(eq(envelopes.id, id))
    .returning();
  if (result.length === 0)
    throw Object.assign(new Error("Envelope not found"), { status: 404 });
}

export async function reclaimEnvelopeToPool(
  id: string
): Promise<{ reclaimed_inr: number }> {
  const db = getDb();
  const rates = await getLatestRates();

  const [envelope] = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.id, id));
  if (!envelope)
    throw Object.assign(new Error("Envelope not found"), { status: 404 });

  // Use listEnvelopes to get the true effective available (includes rollover).
  const envList = await listEnvelopes(envelope.month);
  const fullEnv = envList.find((e) => e.id === id);
  if (!fullEnv)
    throw Object.assign(new Error("Envelope not found"), { status: 404 });

  const available = fullEnv.available; // in INR, includes rollover
  if (available <= 0) {
    throw Object.assign(
      new Error(
        "No surplus to return — this envelope is fully spent or overspent."
      ),
      { status: 400 }
    );
  }

  // Compute the rollover contribution so we can cancel it:
  //   effective_budgeted_inr = raw_budgeted_inr + rollover
  //   available = effective_budgeted_inr - spent
  //   target:  new effective_budgeted_inr = spent  → available becomes 0
  //   so:      new raw_budgeted_inr = spent - rollover
  //   and:     new_budgeted (in budget_currency) = new_raw_budgeted_inr / rate
  const budgetCurrency = (envelope.budget_currency ?? "INR") as string;
  const rate = rates[budgetCurrency] ?? 1;
  const rawBudgetedInr = toInr(envelope.budgeted ?? 0, budgetCurrency, rates);
  const rolloverInr = fullEnv.budgeted_inr - rawBudgetedInr;
  const spent = fullEnv.spent;

  const targetRawInr = spent - rolloverInr;
  const newBudgeted = Math.round((targetRawInr / rate) * 100) / 100;

  await db
    .update(envelopes)
    .set({ budgeted: newBudgeted })
    .where(eq(envelopes.id, id));

  return { reclaimed_inr: available };
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function listTransactions(
  filters: TransactionFilters
): Promise<PaginatedTransactionsResponse> {
  const db = getDb();
  const conditions = [];

  if (filters.account_id)
    conditions.push(eq(transactions.account_id, filters.account_id));
  if (filters.envelope_id) {
    if (filters.envelope_id === "_uncategorised_") {
      conditions.push(isNull(transactions.envelope_id));
      conditions.push(eq(transactions.type, "expense"));
    } else {
      conditions.push(eq(transactions.envelope_id, filters.envelope_id));
    }
  }
  if (filters.type) conditions.push(eq(transactions.type, filters.type));
  if (filters.date_from)
    conditions.push(gte(transactions.date, filters.date_from));
  if (filters.date_to) conditions.push(lte(transactions.date, filters.date_to));
  if (filters.search)
    conditions.push(like(transactions.payee, `%${filters.search}%`));
  if (filters.off_budget !== undefined) {
    const isOffBudget = filters.off_budget === "true" || filters.off_budget === true;
    if (isOffBudget) {
      conditions.push(eq(accounts.off_budget, true));
    } else {
      conditions.push(or(eq(accounts.off_budget, false), isNull(accounts.off_budget)));
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: transactions.id,
        account_id: transactions.account_id,
        envelope_id: transactions.envelope_id,
        envelope_name: envelopes.name,
        payee: transactions.payee,
        amount: transactions.amount,
        currency: accounts.currency,
        type: transactions.type,
        date: transactions.date,
        notes: transactions.notes,
        income_category: transactions.income_category,
        transfer_pair_id: transactions.transfer_pair_id,
        created_at: transactions.created_at,
      })
      .from(transactions)
      .leftJoin(envelopes, eq(transactions.envelope_id, envelopes.id))
      .leftJoin(accounts, eq(transactions.account_id, accounts.id))
      .where(where)
      // created_at breaks same-day ties. Without it the order of same-day rows
      // is whatever the planner returns, so a client running-balance column
      // reshuffles between refetches for no reason.
      .orderBy(desc(transactions.date), desc(transactions.created_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .leftJoin(accounts, eq(transactions.account_id, accounts.id))
      .where(where),
  ]);

  return {
    transactions: rows.map((r) => ({
      ...toTransactionResponse(r as any),
      currency: r.currency ?? "INR",
      envelope_name: r.envelope_name ?? null,
    })),
    total: Number(countResult[0]?.count ?? 0),
    page,
    limit,
  };
}

/**
 * The single write path for inserting a transaction row, shared by every
 * caller (UI create, transfers, CSV import, recurring, account seeding and
 * reconciliation). Must be called with a runTransaction handle.
 *
 * It deliberately does NOT touch `envelopes.spent`: envelope spend is derived
 * from the transactions by `computeSpentByEnvelope`, so the row itself is the
 * whole bookkeeping.
 */
export async function insertTransactionTx(
  tx: any,
  data: typeof transactions.$inferInsert
): Promise<typeof transactions.$inferSelect> {
  const [row] = await tx.insert(transactions).values(data).returning();
  return row;
}

/**
 * "An expense on an on-budget account must be assigned to an envelope."
 *
 * This rule used to live only in TransactionForm.handleSubmit, so five write
 * paths bypassed it — that same component's edit handler, the Budget page
 * recategoriser, the Investments value dialog, recurring rules and CSV import.
 * It belongs next to the on-to-off-budget check in createTransfer: at the
 * service layer, where every caller has to go through it.
 *
 * Off-budget accounts are exempt (they do not participate in envelope
 * budgeting), as are income and transfer rows.
 *
 * @param q a db handle or a transaction handle.
 */
export async function assertEnvelopeRequired(
  q: { select: (...args: any[]) => any },
  accountId: string,
  type: string | null | undefined,
  envelopeId: string | null | undefined
): Promise<void> {
  if (type !== "expense" || envelopeId) return;

  const [account] = await q
    .select({ off_budget: accounts.off_budget })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account)
    throw Object.assign(new Error("Account not found"), { status: 404 });
  if (account.off_budget) return;

  throw Object.assign(
    new Error(
      "An envelope category is required for expenses on On-Budget accounts."
    ),
    { status: 400 }
  );
}

/** Unique-index violations from concurrent duplicate imports (PG + SQLite). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "23505" ||
    e?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed/i.test(e?.message ?? "")
  );
}

export async function createTransaction(
  data: CreateTransactionRequest
): Promise<TransactionResponse | null> {
  try {
    const result = await runTransaction(async (tx) => {
      await assertEnvelopeRequired(
        tx,
        data.account_id,
        data.type,
        data.envelope_id
      );

      // Deduplicate on import_hash — return null to signal "already exists".
      // Checked inside the transaction; concurrent duplicates that slip past
      // the check hit the unique index and are mapped below.
      if (data.import_hash) {
        const existing = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.import_hash, data.import_hash));
        if (existing.length > 0) return null;
      }

      return insertTransactionTx(tx, data);
    });

    return result ? toTransactionResponse(result) : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function updateTransaction(
  id: string,
  data: UpdateTransactionRequest
): Promise<TransactionResponse> {
  const db = getDb();

  const result = await runTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, id));
    if (!existing)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });

    // Transfer legs must stay symmetric: amount/type/payee/envelope changes on
    // one leg would desync the pair (and the payee string drives the
    // credit/debit envelope accounting). Only date and notes are editable,
    // and they are applied to both legs atomically.
    if (existing.transfer_pair_id) {
      const disallowed =
        data.amount !== undefined ||
        data.type !== undefined ||
        data.payee !== undefined ||
        data.envelope_id !== undefined ||
        data.income_category !== undefined;
      if (disallowed) {
        throw Object.assign(
          new Error(
            "Only date and notes can be edited on a transfer — delete and recreate the transfer to change amounts, accounts, or envelopes."
          ),
          { status: 400 }
        );
      }

      const pairData: Partial<typeof transactions.$inferInsert> = {};
      if (data.date !== undefined) pairData.date = data.date;
      if (data.notes !== undefined) pairData.notes = data.notes;
      if (Object.keys(pairData).length === 0) return existing;

      await tx
        .update(transactions)
        .set(pairData)
        .where(eq(transactions.transfer_pair_id, existing.transfer_pair_id));

      const [updated] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, id));
      return updated;
    }

    const newType = data.type ?? existing.type;
    const newAmount = data.amount ?? existing.amount;
    const newEnvelopeId =
      data.envelope_id !== undefined ? data.envelope_id : existing.envelope_id;
    const resolvedEnvId = newType === "income" ? null : newEnvelopeId;

    // Same rule as create: an edit must not leave an on-budget expense
    // uncategorised (clearing the envelope on the edit screen used to do
    // exactly that).
    await assertEnvelopeRequired(
      tx,
      existing.account_id,
      newType,
      resolvedEnvId
    );

    // No envelope `spent` bookkeeping: it is derived from the transaction rows.

    // Build a properly-typed partial to avoid Drizzle rejecting unknown keys
    const setData: Partial<typeof transactions.$inferInsert> = {};
    if (data.payee !== undefined) setData.payee = data.payee;
    if (data.amount !== undefined) setData.amount = data.amount;
    if (data.date !== undefined) setData.date = data.date;
    if (data.notes !== undefined) setData.notes = data.notes;
    if (newType !== existing.type)
      setData.type = newType as "income" | "expense" | "transfer";
    if (resolvedEnvId !== existing.envelope_id)
      setData.envelope_id = resolvedEnvId ?? null;
    if (data.income_category !== undefined)
      setData.income_category = data.income_category ?? null;

    // If nothing changed, return the existing record without hitting the DB
    if (Object.keys(setData).length === 0) return existing;

    const [updated] = await tx
      .update(transactions)
      .set(setData)
      .where(eq(transactions.id, id))
      .returning();

    return updated;
  });

  return toTransactionResponse(result);
}

export async function deleteTransaction(id: string): Promise<void> {
  const db = getDb();

  await runTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, id));
    if (!existing)
      throw Object.assign(new Error("Transaction not found"), { status: 404 });

    // Envelope spend is derived from the rows, so deleting them is the whole
    // reversal — no `spent` bookkeeping to undo.
    if (existing.transfer_pair_id) {
      // Both legs go together: a half-deleted transfer would leave an orphan
      // leg that no balance derivation can classify.
      await tx
        .delete(transactions)
        .where(eq(transactions.transfer_pair_id, existing.transfer_pair_id));
    } else {
      await tx.delete(transactions).where(eq(transactions.id, id));
    }
  });
}

export async function createTransfer(data: {
  from_account_id: string;
  to_account_id: string;
  amount: number;
  to_amount: number;
  date: string;
  notes?: string;
  import_hash?: string;
  envelope_id?: string; // Transfer Out side — debits this envelope
  to_envelope_id?: string; // Transfer In side — credits this envelope
}): Promise<{ from: TransactionResponse; to: TransactionResponse } | null> {
  const db = getDb();

  // Load from and to accounts to check off_budget status
  const [fromAccount] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, data.from_account_id))
    .limit(1);
  const [toAccount] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, data.to_account_id))
    .limit(1);

  if (!fromAccount)
    throw Object.assign(new Error("Source account not found"), { status: 404 });
  if (!toAccount)
    throw Object.assign(new Error("Destination account not found"), {
      status: 404,
    });

  const fromOnBudget = !fromAccount.off_budget;
  const toOffBudget = !!toAccount.off_budget;

  // On-to-Off Budget boundary: requires an envelope category
  if (fromOnBudget && toOffBudget && !data.envelope_id) {
    throw Object.assign(
      new Error(
        "On-to-Off Budget transfers require a budget envelope category."
      ),
      { status: 400 }
    );
  }

  try {
    const result = await runTransaction(async (tx) => {
      // Deduplicate on import_hash — return null to signal "already exists"
      if (data.import_hash) {
        const existing = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.import_hash, data.import_hash));
        if (existing.length > 0) return null;
      }

      const pairId = nanoid();

      // The helper applies the envelope accounting for both legs:
      // TRANSFER_OUT + envelope_id debits, TRANSFER_IN + envelope_id credits.
      const from = await insertTransactionTx(tx, {
        account_id: data.from_account_id,
        payee: TRANSFER_OUT,
        amount: data.amount,
        type: "transfer",
        date: data.date,
        notes: data.notes ?? null,
        import_hash: data.import_hash ?? null,
        envelope_id: data.envelope_id ?? null,
        transfer_pair_id: pairId,
      });

      const to = await insertTransactionTx(tx, {
        account_id: data.to_account_id,
        payee: TRANSFER_IN,
        amount: data.to_amount,
        type: "transfer",
        date: data.date,
        notes: data.notes ?? null,
        transfer_pair_id: pairId,
        envelope_id: data.to_envelope_id ?? null,
      });

      return { from, to };
    });

    if (!result) return null;
    return {
      from: toTransactionResponse(result.from),
      to: toTransactionResponse(result.to),
    };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// ─── CSV Import ───────────────────────────────────────────────────────────────

type CsvRow = {
  date: string;
  payee: string;
  amount: string;
  type: string;
  notes?: string;
};

/**
 * CSV import is deliberately EXEMPT from the "on-budget expense needs an
 * envelope" rule enforced by createTransaction/updateTransaction: a bank
 * export carries no envelope, and refusing whole files would make bulk import
 * useless. Imported expenses land uncategorised and are counted in
 * `ImportResult.uncategorised` so the UI can send the user to categorise them.
 */
export async function importCSV(
  fileBuffer: Buffer,
  accountId: string,
  _format: string
): Promise<ImportResult> {
  const db = getDb();
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    uncategorised: 0,
    errors: [],
  };

  let rows: CsvRow[];
  try {
    rows = parse(fileBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (_e) {
    return {
      imported: 0,
      skipped: 0,
      uncategorised: 0,
      errors: ["Failed to parse CSV file"],
    };
  }

  // Validate the target account up front — inside the transaction a FK
  // violation would abort the whole batch.
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    return {
      imported: 0,
      skipped: 0,
      uncategorised: 0,
      errors: ["Account not found"],
    };
  }

  // Phase 1: validate and hash every row in memory. Nothing may fail inside
  // the insert transaction — on Postgres a single failed statement poisons
  // the transaction and aborts everything after it.
  const candidates: (typeof transactions.$inferInsert)[] = [];
  const seenHashes = new Set<string>();
  for (const row of rows) {
    const importHash = hashRow(JSON.stringify(row));

    // Identical row appearing twice in the same file
    if (seenHashes.has(importHash)) {
      result.skipped++;
      continue;
    }

    const amount = parseFloat(row.amount);
    if (Number.isNaN(amount)) {
      result.errors.push(`Row skipped — invalid amount: "${row.amount}"`);
      continue;
    }

    const type = row.type?.toLowerCase();
    if (!["income", "expense", "transfer"].includes(type)) {
      result.errors.push(`Row skipped — invalid type: "${row.type}"`);
      continue;
    }

    seenHashes.add(importHash);
    candidates.push({
      account_id: accountId,
      payee: row.payee ?? "Unknown",
      amount,
      type: type as "income" | "expense" | "transfer",
      date: row.date,
      notes: row.notes ?? null,
      import_hash: importHash,
    });
  }

  if (candidates.length === 0) return result;

  // Phase 2: all-or-nothing insert. Rows already in the database are skipped;
  // everything else either fully imports or fully rolls back.
  try {
    await runTransaction(async (tx) => {
      const existingDupes = new Set<string>();
      const hashes = [...seenHashes];
      for (let i = 0; i < hashes.length; i += 500) {
        const chunk = hashes.slice(i, i + 500);
        const found = await tx
          .select({ import_hash: transactions.import_hash })
          .from(transactions)
          .where(inArray(transactions.import_hash, chunk));
        for (const f of found) {
          if (f.import_hash) existingDupes.add(f.import_hash);
        }
      }

      for (const candidate of candidates) {
        if (candidate.import_hash && existingDupes.has(candidate.import_hash)) {
          result.skipped++;
          continue;
        }
        await insertTransactionTx(tx, candidate);
        result.imported++;
        if (candidate.type === "expense" && !candidate.envelope_id)
          result.uncategorised = (result.uncategorised ?? 0) + 1;
      }
    });
  } catch (err) {
    return {
      imported: 0,
      skipped: 0,
      uncategorised: 0,
      errors: [
        `Import failed — no rows were imported: ${(err as Error).message}`,
      ],
    };
  }

  return result;
}

// ─── Reports ──────────────────────────────────────────────────────────────────

// Computes the cumulative unassigned surplus from all months before `month`.
// This is the Actual-style "From Last Month" / TBB carryover:
//   carryover = Σ(income - budgeted) for every prior month
// Positive = you had leftover money; negative = you over-budgeted in the past.
export async function computeCarryoverForMonth(
  month: string,
  rates: Record<string, number>
): Promise<number> {
  const db = getDb();

  const monthDatePrefix = `${month}-01`;

  // All income from on-budget accounts in months before `month`
  const incomeTxns = await db
    .select({ amount: transactions.amount, currency: accounts.currency })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .where(
      and(
        eq(transactions.type, "income"),
        or(eq(accounts.off_budget, false), isNull(accounts.off_budget)),
        lt(transactions.date, monthDatePrefix)
      )
    );

  const totalPriorIncome = incomeTxns.reduce(
    (s, t) => s + toInr(t.amount, t.currency ?? "INR", rates),
    0
  );

  // All envelopes in months prior to `month` to compute both prior budgeted and overspending
  const priorEnvelopes = await db
    .select({
      id: envelopes.id,
      month: envelopes.month,
      budgeted: envelopes.budgeted,
      budget_currency: envelopes.budget_currency,
    })
    .from(envelopes)
    .where(lt(envelopes.month, month));

  // Spend is derived per month from the transactions — the `spent` column it
  // used to read was an incrementally-maintained mix of account-native
  // amounts, so carryover was wrong for every month whose summary endpoint
  // had never been hit and wrong in any multi-currency setup regardless.
  const priorMonths = [...new Set(priorEnvelopes.map((e) => e.month))];
  const spentByMonth = new Map<string, Record<string, number>>();
  for (const m of priorMonths) {
    spentByMonth.set(
      m,
      await computeSpentByEnvelope(
        m,
        rates,
        priorEnvelopes.filter((e) => e.month === m).map((e) => e.id)
      )
    );
  }

  let totalPriorBudgeted = 0;
  let totalPriorOverspent = 0;

  for (const env of priorEnvelopes) {
    const currency = env.budget_currency ?? "INR";
    const budgetedInr = toInr(env.budgeted ?? 0, currency, rates);
    const spentInr = spentByMonth.get(env.month)?.[env.id] ?? 0;

    totalPriorBudgeted += budgetedInr;
    if (spentInr > budgetedInr) {
      totalPriorOverspent += spentInr - budgetedInr;
    }
  }

  return totalPriorIncome - totalPriorBudgeted - totalPriorOverspent;
}

export async function getMonthlySummary(
  month: string
): Promise<MonthlySummaryResponse> {
  const db = getDb();

  // Month bounds e.g. "2026-04" → "2026-04-01" to "2026-04-30"
  const [year, mon] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const dateTo = `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;

  const rates = await getLatestRates();

  const carryoverFromPrevious = await computeCarryoverForMonth(month, rates);

  // Join transactions with their account's currency so we can convert to INR.
  // Exclude off-budget accounts — they track net worth but don't participate in envelope budgeting.
  const txns = await db
    .select({
      id: transactions.id,
      account_id: transactions.account_id,
      envelope_id: transactions.envelope_id,
      amount: transactions.amount,
      type: transactions.type,
      payee: transactions.payee,
      currency: accounts.currency,
    })
    .from(transactions)
    .leftJoin(accounts, eq(transactions.account_id, accounts.id))
    .where(
      and(
        gte(transactions.date, dateFrom),
        lte(transactions.date, dateTo),
        or(eq(accounts.off_budget, false), isNull(accounts.off_budget))
      )
    );

  // Convert each transaction amount to INR using the account's currency
  const toInrAmount = (amount: number, currency: string | null) =>
    toInr(amount, currency ?? "INR", rates);

  // Transfers only included in income/expense totals if they cross the budget boundary (have an envelope_id)
  const totalIncome = txns
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + toInrAmount(t.amount, t.currency), 0);
  const totalExpenses = txns
    .filter((t) => t.type === "expense" || (t.envelope_id && t.type === "transfer"))
    .reduce((s, t) => {
      const inr = toInrAmount(t.amount, t.currency);
      return s + (isTransferIn(t) ? -inr : inr);
    }, 0);

  // Envelope spend comes from listEnvelopes, which uses computeSpentByEnvelope
  // — the same numbers the Budget page renders. This endpoint used to
  // recompute them AND overwrite the `envelopes.spent` column with the result,
  // which is what left that column holding base-currency values on top of the
  // account-native increments every write path was making.
  const envRows = await listEnvelopes(month);

  return {
    month,
    total_income: totalIncome,
    total_expenses: totalExpenses,
    net: totalIncome - totalExpenses,
    carryover_from_previous: carryoverFromPrevious,
    envelope_summaries: envRows.map((e) => ({
      envelope_id: e.id,
      envelope_name: e.name,
      budgeted: e.budgeted,
      spent: e.spent,
      available: e.available,
    })),
  };
}

/**
 * Budgeted vs spent for one envelope over the last `months` months, both in
 * base currency.
 *
 * Envelope rows are per-month with distinct ids, so the previous
 * `where(envelopes.id = envelopeId)` could only ever match a single row and
 * the trend chart always rendered one point. The envelope's identity across
 * months is `group_id|name`, the same key the rollover logic uses.
 */
export async function getEnvelopeTrends(
  envelopeId: string,
  months: number
): Promise<TrendResponse[]> {
  const db = getDb();
  const rates = await getLatestRates();

  const [anchor] = await db
    .select({ group_id: envelopes.group_id, name: envelopes.name })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!anchor)
    throw Object.assign(new Error("Envelope not found"), { status: 404 });

  const rows = await db
    .select({
      id: envelopes.id,
      month: envelopes.month,
      budgeted: envelopes.budgeted,
      budget_currency: envelopes.budget_currency,
    })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.group_id, anchor.group_id),
        eq(envelopes.name, anchor.name)
      )
    )
    .orderBy(desc(envelopes.month))
    .limit(months);

  const trends: TrendResponse[] = [];
  for (const r of rows) {
    const spent = await computeSpentByEnvelope(r.month, rates, [r.id]);
    trends.push({
      month: r.month,
      budgeted: toInr(r.budgeted ?? 0, r.budget_currency ?? "INR", rates),
      spent: spent[r.id] ?? 0,
    });
  }
  return trends;
}

export async function scaleBudgetEnvelopes(conversionRate: number, newBase: string) {
  const db = getDb();
  await db.update(envelopes).set({
    budgeted: sql`${envelopes.budgeted} * ${conversionRate}`,
    rollover_amount: sql`${envelopes.rollover_amount} * ${conversionRate}`,
    budget_currency: newBase as any,
  });
}

export async function copyPreviousMonthBudget(
  month: string
): Promise<{ count: number }> {
  const db = getDb();

  // Find the matching current month envelopes
  const currentEnvs = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.month, month));

  if (currentEnvs.length === 0) {
    // If no envelopes exist for current month, we can seed them first!
    await seedMonthFromTemplate(db, month);
  }

  // Get the template month (most recent month before `month` that has envelopes)
  const templateMonthQuery = await db
    .select({ month: envelopes.month })
    .from(envelopes)
    .where(lt(envelopes.month, month))
    .orderBy(desc(envelopes.month))
    .limit(1);

  if (templateMonthQuery.length === 0) {
    return { count: 0 };
  }

  const prevMonth = templateMonthQuery[0].month;
  const prevEnvs = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.month, prevMonth));

  // Re-fetch current month envelopes (in case they were just seeded)
  const updatedCurrentEnvs = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.month, month));

  let count = 0;

  // Perform updates inside a transaction
  await runTransaction(async (tx) => {
    for (const prev of prevEnvs) {
      // Find matching current envelope by group_id and name
      const matchingCurrent = updatedCurrentEnvs.find(
        (c) => c.group_id === prev.group_id && c.name === prev.name
      );

      if (matchingCurrent) {
        await tx
          .update(envelopes)
          .set({
            budgeted: prev.budgeted,
            budget_currency: prev.budget_currency,
          })
          .where(eq(envelopes.id, matchingCurrent.id));
        count++;
      } else {
        // If it doesn't exist, we can create it in the current month!
        await tx.insert(envelopes).values({
          group_id: prev.group_id,
          name: prev.name,
          month,
          budgeted: prev.budgeted,
          budget_currency: prev.budget_currency,
        });
        count++;
      }
    }
  });

  return { count };
}

export async function clearMonthBudget(
  month: string
): Promise<{ count: number }> {
  const db = getDb();
  const result = await db
    .update(envelopes)
    .set({ budgeted: 0 })
    .where(eq(envelopes.month, month))
    .returning();
  return { count: result.length };
}
