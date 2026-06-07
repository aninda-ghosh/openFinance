import {
  CreateAccountSchema,
  CreateEnvelopeSchema,
  CreateTransactionSchema,
  TransactionFiltersSchema,
  UpdateAccountSchema,
  UpdateEnvelopeSchema,
  UpdateTransactionSchema,
} from "@openfinance/shared/schemas";
import { type Context, Hono } from "hono";
import * as budgetService from "../services/budget.service";
import * as recurringService from "../services/recurring.service";

export const budgetRouter = new Hono();

// ─── Error helpers ────────────────────────────────────────────────────────────

function handleError(c: Context, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 404) return c.json({ error: e.message ?? "Not found" }, 404);
  if (e.status === 400)
    return c.json({ error: e.message ?? "Bad request" }, 400);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

budgetRouter.get("/accounts", async (c) => {
  try {
    const accounts = await budgetService.listAccounts();
    return c.json({ accounts });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/accounts", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const account = await budgetService.createAccount(parsed.data);
    return c.json(account, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.patch("/accounts/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const account = await budgetService.updateAccount(
      c.req.param("id"),
      parsed.data
    );
    return c.json(account);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.delete("/accounts/:id", async (c) => {
  try {
    await budgetService.deleteAccount(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── Envelopes ────────────────────────────────────────────────────────────────

budgetRouter.get("/envelopes", async (c) => {
  const month = c.req.query("month");
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }
  try {
    const envelopes = await budgetService.listEnvelopes(month);
    return c.json({ envelopes });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/envelopes/copy-previous", async (c) => {
  const body = await c.req.json().catch(() => null);
  const month = body?.month;
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }
  try {
    const result = await budgetService.copyPreviousMonthBudget(month);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/envelopes/clear-budget", async (c) => {
  const body = await c.req.json().catch(() => null);
  const month = body?.month;
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }
  try {
    const result = await budgetService.clearMonthBudget(month);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/envelopes", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const envelope = await budgetService.createEnvelope(parsed.data);
    return c.json(envelope, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.patch("/envelopes/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const envelope = await budgetService.updateEnvelope(
      c.req.param("id"),
      parsed.data
    );
    return c.json(envelope);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/envelopes/:id/reclaim", async (c) => {
  try {
    const result = await budgetService.reclaimEnvelopeToPool(c.req.param("id"));
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.delete("/envelopes/:id", async (c) => {
  try {
    await budgetService.deleteEnvelope(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.get("/envelope-groups", async (c) => {
  try {
    const groups = await budgetService.listEnvelopeGroups();
    return c.json({ groups });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/envelope-groups", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name?.trim()) return c.json({ error: "name required" }, 400);
  try {
    const group = await budgetService.createEnvelopeGroup(body.name.trim());
    return c.json(group, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.patch("/envelope-groups/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name?.trim()) return c.json({ error: "name required" }, 400);
  try {
    const group = await budgetService.updateEnvelopeGroup(
      c.req.param("id"),
      body.name.trim()
    );
    return c.json(group);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.delete("/envelope-groups/:id", async (c) => {
  try {
    await budgetService.deleteEnvelopeGroup(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── Transactions ─────────────────────────────────────────────────────────────

budgetRouter.get("/transactions", async (c) => {
  const raw = c.req.query();
  const parsed = TransactionFiltersSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid filters", details: parsed.error }, 400);
  }
  try {
    const result = await budgetService.listTransactions(parsed.data);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/transactions", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const txn = await budgetService.createTransaction(parsed.data);
    if (txn === null)
      return c.json({ skipped: true, reason: "duplicate" }, 409);
    return c.json(txn, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.patch("/transactions/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  }
  try {
    const txn = await budgetService.updateTransaction(
      c.req.param("id"),
      parsed.data
    );
    return c.json(txn);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/transactions/transfer", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body?.from_account_id ||
    !body?.to_account_id ||
    !body?.amount ||
    !body?.date
  ) {
    return c.json(
      { error: "from_account_id, to_account_id, amount, date required" },
      400
    );
  }
  try {
    const result = await budgetService.createTransfer({
      from_account_id: body.from_account_id,
      to_account_id: body.to_account_id,
      amount: Number(body.amount),
      to_amount: Number(body.to_amount ?? body.amount),
      date: body.date,
      notes: body.notes,
      import_hash: body.import_hash,
      envelope_id: body.envelope_id,
      to_envelope_id: body.to_envelope_id,
    });
    if (result === null)
      return c.json({ skipped: true, reason: "duplicate" }, 409);
    return c.json(result, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.delete("/transactions/:id", async (c) => {
  try {
    await budgetService.deleteTransaction(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── CSV Import ───────────────────────────────────────────────────────────────

budgetRouter.post("/import", async (c) => {
  const accountId = c.req.query("account_id");
  const format = c.req.query("format") ?? "generic";
  if (!accountId) {
    return c.json({ error: "account_id query param required" }, 400);
  }
  try {
    const arrayBuffer = await c.req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await budgetService.importCSV(buffer, accountId, format);
    return c.json(result);
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

budgetRouter.get("/reports/summary", async (c) => {
  const month = c.req.query("month");
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ error: "month query param required (YYYY-MM)" }, 400);
  }
  try {
    const summary = await budgetService.getMonthlySummary(month);
    return c.json(summary);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.get("/reports/envelope-trends/:id", async (c) => {
  const months = Number(c.req.query("months") ?? 6);
  try {
    const trends = await budgetService.getEnvelopeTrends(
      c.req.param("id"),
      months
    );
    return c.json({ trends });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── Recurring Transactions ───────────────────────────────────────────────────

budgetRouter.get("/recurring", async (c) => {
  try {
    return c.json({ recurring: await recurringService.listRecurring() });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/recurring", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);
  try {
    const row = await recurringService.createRecurring(body);
    return c.json(row, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.patch("/recurring/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);
  try {
    const row = await recurringService.updateRecurring(c.req.param("id"), body);
    return c.json(row);
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.delete("/recurring/:id", async (c) => {
  try {
    await recurringService.deleteRecurring(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

budgetRouter.post("/recurring/apply-due", async (c) => {
  try {
    const count = await recurringService.applyDueRecurring();
    return c.json({ applied: count });
  } catch (err) {
    return handleError(c, err);
  }
});
