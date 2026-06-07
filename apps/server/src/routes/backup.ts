import { Hono } from "hono";
import { nanoid } from "nanoid";
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
  recurring_transactions,
  transactions,
  investment_documents,
  users,
} from "../db/schema";
import * as rateService from "../services/exchange-rate.service";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";
import { UPLOADS_DIR } from "../services/document.service";
import { encryptBuffer, decryptBuffer, encryptBackup, decryptBackup } from "../utils/crypto";
import { deriveBackupKey } from "../services/auth.service";

export const backupRouter = new Hono();

backupRouter.get("/export", async (c) => {
  const db = getDb();
  try {
    const [
      accountRows,
      envelopeGroupRows,
      envelopeRows,
      transactionRows,
      budgetAlertRows,
      recurringRows,
      investmentRows,
      priceHistoryRows,
      policyRows,
      policyPayoutRows,
      exchangeRateRows,
      aiConversationRows,
      aiMessageRows,
      aiToolCallRows,
      investmentValueHistoryRows,
      investmentDocumentRows,
    ] = await Promise.all([
      db.select().from(accounts),
      db.select().from(envelope_groups),
      db.select().from(envelopes),
      db.select().from(transactions),
      db.select().from(budget_alerts),
      db.select().from(recurring_transactions),
      db.select().from(investments),
      db.select().from(price_history),
      db.select().from(policies),
      db.select().from(policy_payouts),
      db.select().from(exchange_rates),
      db.select().from(ai_conversations),
      db.select().from(ai_messages),
      db.select().from(ai_tool_calls),
      db.select().from(investment_value_history),
      db.select().from(investment_documents),
    ]);

    const backupData = {
      version: "1",
      exported_at: new Date().toISOString(),
      data: {
        accounts: accountRows,
        envelope_groups: envelopeGroupRows,
        envelopes: envelopeRows,
        transactions: transactionRows,
        budget_alerts: budgetAlertRows,
        recurring_transactions: recurringRows,
        investments: investmentRows,
        price_history: priceHistoryRows,
        policies: policyRows,
        policy_payouts: policyPayoutRows,
        exchange_rates: exchangeRateRows,
        ai_conversations: aiConversationRows,
        ai_messages: aiMessageRows,
        ai_tool_calls: aiToolCallRows,
        investment_value_history: investmentValueHistoryRows,
        investment_documents: investmentDocumentRows,
      },
    };

    const zip = new AdmZip();
    zip.addFile("backup-data.json", Buffer.from(JSON.stringify(backupData, null, 2), "utf8"));

    // Add local uploaded documents if the directory exists and has files
    const docsDir = UPLOADS_DIR;
    if (fs.existsSync(docsDir)) {
      const files = fs.readdirSync(docsDir);
      for (const file of files) {
        const filePath = path.join(docsDir, file);
        if (fs.statSync(filePath).isFile()) {
          let fileData: any = fs.readFileSync(filePath);
          const key = process.env.OPENFINANCE_DB_KEY;
          fileData = decryptBuffer(fileData, key);
          zip.addFile(path.join("documents", file), fileData);
        }
      }
    }

    const zipBuffer = zip.toBuffer();

    // ── Seamless encryption: look up the user's backup_key ─────────────────
    let backupKey: string | null = null;
    const [userRow] = await db.select({ backup_key: users.backup_key }).from(users).limit(1);
    if (userRow?.backup_key) {
      backupKey = userRow.backup_key;
    } else if (process.env.OPENFINANCE_DESKTOP === "true" && process.env.OPENFINANCE_DB_KEY) {
      // Desktop fallback: derive from the DB key if backup_key not yet saved
      backupKey = deriveBackupKey(process.env.OPENFINANCE_DB_KEY, "desktop");
    }

    const outputBuffer = backupKey ? encryptBackup(zipBuffer, backupKey) : zipBuffer;

    return c.body(new Uint8Array(outputBuffer), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="openfinance-backup.ofb"',
    });
  } catch (err) {
    console.error("Export failed:", err);
    return c.json({ error: "Export failed" }, 500);
  }
});

backupRouter.post("/import", async (c) => {
  const db = getDb();
  try {
    const arrayBuffer = await c.req.arrayBuffer();
    let rawBuffer = Buffer.from(arrayBuffer);

    // ── Seamless decryption ────────────────────────────────────────────────
    // Check for the FWB1 magic header that marks an encrypted backup.
    const MAGIC = Buffer.from("FWB1");
    if (rawBuffer.subarray(0, 4).equals(MAGIC)) {
      let decrypted: Buffer | null = null;

      // 1. Try the stored backup_key for the current user first.
      const [userRow] = await db.select({ backup_key: users.backup_key }).from(users).limit(1);
      if (userRow?.backup_key) {
        try {
          decrypted = decryptBackup(rawBuffer, userRow.backup_key);
        } catch {
          decrypted = null;
        }
      }

      // 2. Fallback: try a password supplied in the request header (different-user backup).
      if (!decrypted) {
        const headerPassword = c.req.header("x-backup-password");
        if (headerPassword) {
          const headerUsername = c.req.header("x-backup-username");
          const [u] = await db.select({ username: users.username }).from(users).limit(1);

          // Build a list of usernames to try (deduplicated)
          const usernamesToTry = new Set<string>();
          if (headerUsername) usernamesToTry.add(headerUsername);
          if (u?.username) usernamesToTry.add(u.username);
          usernamesToTry.add("desktop"); // last-resort fallback

          for (const uname of usernamesToTry) {
            if (decrypted) break;
            const fallbackKey = deriveBackupKey(headerPassword, uname);
            try {
              decrypted = decryptBackup(rawBuffer, fallbackKey);
            } catch {
              decrypted = null;
            }
          }
        }
      }

      if (!decrypted) {
        return c.json(
          { error: "DECRYPTION_REQUIRED", message: "This backup is encrypted. Provide the password used to create it via the x-backup-password header." },
          400
        );
      }

      rawBuffer = decrypted as Buffer<ArrayBuffer>;
    }
    // Legacy unencrypted ZIP — use rawBuffer as-is

    const zip = new AdmZip(rawBuffer);

    const jsonEntry = zip.getEntry("backup-data.json");
    if (!jsonEntry) {
      return c.json({ error: "Invalid backup ZIP: backup-data.json not found" }, 400);
    }

    const body = JSON.parse(jsonEntry.getData().toString("utf8"));
    if (!body?.data) return c.json({ error: "Invalid backup file" }, 400);

    const d = body.data;

    // --- JSON Backup Migration Pipeline ---
    if (!d.accounts) d.accounts = [];
    if (!d.investment_documents) d.investment_documents = [];
    if (!d.investments) d.investments = [];
    if (!d.policies) d.policies = [];
    if (!d.exchange_rates) d.exchange_rates = [];
    else {
      d.exchange_rates = d.exchange_rates.filter(
        (r: any) => r.rate_to_base != null && !isNaN(Number(r.rate_to_base))
      );
    }

    // Clean up any weird double currency naming like "Brokerage Portfolio (INR)" -> "Brokerage Portfolio"
    if (d.accounts) {
      for (const acc of d.accounts) {
        if (acc.name && acc.name.startsWith("Brokerage Portfolio")) {
          acc.name = "Brokerage Portfolio";
        }
      }
    }

    // 1. Create a parent brokerage account for orphaned investments grouped by currency
    const orphanedInvestments = d.investments.filter(
      (inv: any) => !inv.account_id
    );
    if (orphanedInvestments.length > 0) {
      for (const inv of orphanedInvestments) {
        const currency = inv.currency ?? "INR";
        const dummyBrokerageId = `brokerage-${currency.toLowerCase()}-imported`;
        if (!d.accounts.some((acc: any) => acc.id === dummyBrokerageId)) {
          d.accounts.push({
            id: dummyBrokerageId,
            name: "Brokerage Portfolio",
            type: "investment",
            currency: currency,
            balance: 0,
            institution: "Imported Portfolio",
            is_active: true,
            off_budget: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        inv.account_id = dummyBrokerageId;
      }
    }

    // 2. Auto-generate first-class policy accounts in accounts for every policy record matching policy currency
    for (const pol of d.policies) {
      if (!pol.account_id) {
        pol.account_id = `policy-acc-${pol.id || nanoid()}`;
      }
      const start = new Date(pol.start_date);
      const today = new Date();
      const endOfPremiumTerm = new Date(start);
      endOfPremiumTerm.setFullYear(
        endOfPremiumTerm.getFullYear() + pol.premium_term_years
      );

      const freq = pol.premium_frequency;
      const monthsInterval = freq === "monthly" ? 1 : freq === "quarterly" ? 3 : 12;

      let count = 0;
      const cursor = new Date(start);
      while (cursor <= today && cursor < endOfPremiumTerm) {
        count++;
        cursor.setMonth(cursor.getMonth() + monthsInterval);
      }

      const calculatedInvested = pol.premium_amount * count;

      const polCurrency = pol.currency ?? "INR";
      if (!d.accounts.some((acc: any) => acc.id === pol.account_id)) {
        d.accounts.push({
          id: pol.account_id,
          name: pol.name,
          type: "policy",
          currency: polCurrency,
          balance: calculatedInvested,
          institution: pol.provider,
          is_active: true,
          off_budget: true,
          created_at: pol.created_at || new Date().toISOString(),
          updated_at: pol.updated_at || new Date().toISOString(),
        });
      }
    }

    // Delete in FK-safe reverse order
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

    // Batch insert helper to avoid Postgres prepared statement MAX_PARAMETERS_EXCEEDED (65,535 limit)
    const batchInsert = async (table: any, items: any[], chunkSize = 1000) => {
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        await db.insert(table).values(chunk);
      }
    };

    // Insert in FK-safe order
    if (d.exchange_rates?.length)
      await batchInsert(exchange_rates, d.exchange_rates);
    if (d.accounts?.length) await batchInsert(accounts, d.accounts);
    if (d.envelope_groups?.length)
      await batchInsert(envelope_groups, d.envelope_groups);
    if (d.envelopes?.length) await batchInsert(envelopes, d.envelopes);
    if (d.transactions?.length)
      await batchInsert(transactions, d.transactions);
    if (d.budget_alerts?.length)
      await batchInsert(budget_alerts, d.budget_alerts);
    if (d.recurring_transactions?.length)
      await batchInsert(recurring_transactions, d.recurring_transactions);
    if (d.investments?.length)
      await batchInsert(investments, d.investments);
    if (d.price_history?.length)
      await batchInsert(price_history, d.price_history);
    if (d.investment_value_history?.length)
      await batchInsert(investment_value_history, d.investment_value_history);
    if (d.investment_documents?.length)
      await batchInsert(investment_documents, d.investment_documents);
    if (d.policies?.length) await batchInsert(policies, d.policies);

    // Extract documents folder from ZIP directly to disk
    const docsDir = UPLOADS_DIR;
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.startsWith("documents/") && !entry.isDirectory) {
        const fileName = path.basename(entry.entryName);
        if (fileName) {
          let fileData = entry.getData();
          const key = process.env.OPENFINANCE_DB_KEY;
          fileData = encryptBuffer(fileData, key);
          fs.writeFileSync(path.join(docsDir, fileName), fileData);
        }
      }
    }
    if (d.policy_payouts?.length)
      await batchInsert(policy_payouts, d.policy_payouts);
    if (d.ai_conversations?.length)
      await batchInsert(ai_conversations, d.ai_conversations);
    if (d.ai_messages?.length)
      await batchInsert(ai_messages, d.ai_messages);
    if (d.ai_tool_calls?.length)
      await batchInsert(ai_tool_calls, d.ai_tool_calls);

    // Flush and reset exchange rates to universal base currency
    try {
      await rateService.refreshFromWeb();
    } catch (rateErr) {
      console.warn("Failed to refresh exchange rates after import:", rateErr);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error("Import failed:", err);
    try {
      fs.writeFileSync("/Users/anindaghosh/Projects/FinWise-Desktop-App/import-error.log", (err as Error).stack || String(err));
    } catch (logErr) {
      console.error("Failed to write error log:", logErr);
    }
    return c.json({ error: "Import failed" }, 500);
  }
});
