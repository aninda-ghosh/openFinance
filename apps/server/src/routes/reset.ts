import { Hono } from "hono";
import { getDb } from "../db/index";
import {
  accounts,
  ai_conversations,
  ai_messages,
  ai_tool_calls,
  budget_alerts,
  envelope_groups,
  envelopes,
  exchange_rates,
  investment_value_history,
  investments,
  policies,
  policy_payouts,
  price_history,
  transactions,
  recurring_transactions,
  investment_documents,
} from "../db/schema";

export const resetRouter = new Hono();

// DELETE all user data — leaves exchange_rates and the DB structure intact.
// Tables must be deleted in FK-safe order (children before parents).
resetRouter.post("/", async (c) => {
  const db = getDb();
  try {
    await db.delete(ai_tool_calls);
    await db.delete(ai_messages);
    await db.delete(ai_conversations);
    await db.delete(budget_alerts);
    await db.delete(recurring_transactions);
    await db.delete(transactions);
    await db.delete(envelopes);
    await db.delete(envelope_groups);
    await db.delete(price_history);
    await db.delete(investment_value_history);
    await db.delete(investment_documents);
    await db.delete(policy_payouts);
    await db.delete(policies);
    await db.delete(investments);
    await db.delete(accounts);
    await db.delete(exchange_rates);
    return c.json({ success: true });
  } catch (err) {
    console.error("Reset failed:", err);
    return c.json({ error: "Reset failed" }, 500);
  }
});

// DELETE only transactions + reset envelope budgets to 0.
// Keeps accounts, envelope groups, and envelopes intact.
resetRouter.post("/transactions", async (c) => {
  const db = getDb();
  try {
    await db.delete(budget_alerts);
    await db.delete(transactions);
    await db.update(envelopes).set({ budgeted: 0 });
    return c.json({ success: true });
  } catch (err) {
    console.error("Transaction reset failed:", err);
    return c.json({ error: "Transaction reset failed" }, 500);
  }
});
