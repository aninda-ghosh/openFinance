import { Hono } from "hono";
import { runTransaction } from "../db/index";
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
  try {
    // All-or-nothing — a failure mid-way must not leave a half-wiped database
    await runTransaction(async (tx) => {
      await tx.delete(ai_tool_calls);
      await tx.delete(ai_messages);
      await tx.delete(ai_conversations);
      await tx.delete(budget_alerts);
      await tx.delete(recurring_transactions);
      await tx.delete(transactions);
      await tx.delete(envelopes);
      await tx.delete(envelope_groups);
      await tx.delete(price_history);
      await tx.delete(investment_value_history);
      await tx.delete(investment_documents);
      await tx.delete(policy_payouts);
      await tx.delete(policies);
      await tx.delete(investments);
      await tx.delete(accounts);
      await tx.delete(exchange_rates);
    });
    return c.json({ success: true });
  } catch (err) {
    console.error("Reset failed:", err);
    return c.json({ error: "Reset failed" }, 500);
  }
});

// DELETE only transactions + reset envelope budgets to 0.
// Keeps accounts, envelope groups, and envelopes intact.
resetRouter.post("/transactions", async (c) => {
  try {
    await runTransaction(async (tx) => {
      await tx.delete(budget_alerts);
      await tx.delete(transactions);
      // spent mirrors transactions — with them gone it must go back to 0 too
      await tx.update(envelopes).set({ budgeted: 0, spent: 0 });
    });
    return c.json({ success: true });
  } catch (err) {
    console.error("Transaction reset failed:", err);
    return c.json({ error: "Transaction reset failed" }, 500);
  }
});
