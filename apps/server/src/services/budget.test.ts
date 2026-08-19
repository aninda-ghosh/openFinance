import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/index";
import {
  computeSpentByEnvelope,
  listAccounts,
  createTransaction,
  createTransfer,
  deleteTransaction,
  updateAccount,
  updateTransaction,
} from "./budget.service";

vi.mock("../db/index", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  return {
    getDb: () => mockDb,
    runTransaction: (cb: any) => mockDb.transaction(cb),
  };
});

// ─── Query-builder fake ───────────────────────────────────────────────────────
//
// Drizzle builders are thenables: every method returns the builder and awaiting
// it runs the query. `chain(result)` mimics that — any method call returns the
// same object, and awaiting it resolves to `result`. Tests queue one result per
// query, in call order.

function chain(result: unknown) {
  const proxy: any = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then")
        return (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

type Fake = {
  /** FIFO queue of `db.select(...)` results, in query order. */
  selects: unknown[][];
  /** FIFO queue of `db.update(...).returning()` results. */
  updateReturns: unknown[][];
  /** Every row passed to `insert().values()`, on db or inside a transaction. */
  inserted: any[];
  /** Every payload passed to `update().set()`. */
  updated: any[];
};

function installFake(): Fake {
  const db = getDb() as any;
  const fake: Fake = {
    selects: [],
    updateReturns: [],
    inserted: [],
    updated: [],
  };

  const selectImpl = () => chain(fake.selects.shift() ?? []);
  const insertImpl = () => ({
    values: (v: any) => {
      fake.inserted.push(v);
      return {
        returning: async () => [{ id: "txn-new", ...v }],
        then: (res: any) => Promise.resolve([{ id: "txn-new", ...v }]).then(res),
      };
    },
  });
  const updateImpl = () => ({
    set: (v: any) => {
      fake.updated.push(v);
      return chain(fake.updateReturns.shift() ?? []);
    },
  });

  db.select.mockImplementation(selectImpl);
  db.insert.mockImplementation(insertImpl);
  db.update.mockImplementation(updateImpl);
  db.delete.mockImplementation(() => chain([]));
  db.transaction.mockImplementation(async (cb: any) =>
    cb({
      select: selectImpl,
      insert: insertImpl,
      update: updateImpl,
      delete: () => chain([]),
    })
  );

  return fake;
}

describe("budget.service", () => {
  const db = getDb();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTransfer boundary checks", () => {
    it("throws 400 if transfer crosses On-Budget to Off-Budget boundary without envelope", async () => {
      const limitMock = vi
        .fn()
        .mockResolvedValueOnce([
          { id: "acc-1", off_budget: false, currency: "USD" },
        ])
        .mockResolvedValueOnce([
          { id: "acc-2", off_budget: true, currency: "USD" },
        ]);

      const mockSelect = () => ({
        from: () => ({
          where: () => ({
            limit: limitMock,
          }),
        }),
      });

      (db.select as any).mockImplementation(mockSelect);

      await expect(
        createTransfer({
          from_account_id: "acc-1",
          to_account_id: "acc-2",
          amount: 100,
          to_amount: 100,
          date: "2026-05-21",
        })
      ).rejects.toThrow(
        "On-to-Off Budget transfers require a budget envelope category."
      );
    });

    it("allows transfer if envelope is provided for On-Budget to Off-Budget crossing", async () => {
      const limitMock = vi
        .fn()
        .mockResolvedValueOnce([
          { id: "acc-1", off_budget: false, currency: "USD" },
        ])
        .mockResolvedValueOnce([
          { id: "acc-2", off_budget: true, currency: "USD" },
        ]);

      const mockSelect = () => ({
        from: () => ({
          where: () => ({
            limit: limitMock,
          }),
        }),
      });

      (db.select as any).mockImplementation(mockSelect);
      (db.transaction as any).mockImplementation(async (cb: any) => {
        const mockTx = {
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "txn-1" }]),
            })),
          })),
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockResolvedValue(true),
            })),
          })),
        };
        return cb(mockTx);
      });

      const _res = await createTransfer({
        from_account_id: "acc-1",
        to_account_id: "acc-2",
        amount: 100,
        to_amount: 100,
        date: "2026-05-21",
        envelope_id: "env-123",
      });

      expect(db.transaction).toHaveBeenCalled();
    });
  });

  // ─── updateAccount reconciliation ──────────────────────────────────────────

  describe("updateAccount balance handling", () => {
    const account = {
      id: "acc-1",
      name: "Old Name",
      type: "checking",
      currency: "INR",
      balance: 0, // opening balance — the live balance is derived
      institution: null,
      is_active: true,
      off_budget: false,
      created_at: "",
      updated_at: "",
    };

    /**
     * Queues the six selects updateAccount issues, in order:
     * rates, target account, then getAccountBalances' rates / accounts /
     * transaction totals / investment totals.
     */
    function queueUpdateAccount(fake: Fake, derivedFromTxns: number) {
      const txnTotals = [
        {
          account_id: "acc-1",
          type: "income",
          payee: "Starting Balance",
          total: derivedFromTxns,
        },
      ];
      fake.selects.push([], [account], [], [account], txnTotals, []);
      fake.updateReturns.push([account]);
    }

    it("writes no transaction when the balance is unchanged (rename only)", async () => {
      const fake = installFake();
      queueUpdateAccount(fake, 50000);

      const res = await updateAccount("acc-1", {
        name: "New Name",
        balance: 50000, // dialog prefills the derived balance
      });

      expect(fake.inserted).toHaveLength(0);
      // and the stored opening balance is never touched
      for (const payload of fake.updated) {
        expect(payload).not.toHaveProperty("balance");
      }
      expect(res.balance).toBe(50000);
    });

    it("posts a positive adjustment when reconciling upwards", async () => {
      const fake = installFake();
      queueUpdateAccount(fake, 50000);

      const res = await updateAccount("acc-1", { balance: 60000 });

      expect(fake.inserted).toHaveLength(1);
      expect(fake.inserted[0]).toMatchObject({
        account_id: "acc-1",
        payee: "Balance Adjustment",
        type: "income",
        amount: 10000,
        envelope_id: null,
      });
      // derived balance now equals what the user asked for
      expect(res.balance).toBe(60000);
      for (const payload of fake.updated) {
        expect(payload).not.toHaveProperty("balance");
      }
    });

    it("posts a negative adjustment when reconciling downwards", async () => {
      const fake = installFake();
      queueUpdateAccount(fake, 50000);

      const res = await updateAccount("acc-1", { balance: 45000 });

      expect(fake.inserted).toHaveLength(1);
      expect(fake.inserted[0]).toMatchObject({
        payee: "Balance Adjustment",
        type: "expense",
        amount: 5000,
      });
      expect(res.balance).toBe(45000);
    });

    it("throws 404 for an unknown account", async () => {
      const fake = installFake();
      fake.selects.push([], []);

      await expect(updateAccount("nope", { name: "x" })).rejects.toThrow(
        "Account not found"
      );
    });
  });

  // ─── Liability sign normalisation ──────────────────────────────────────────

  describe("listAccounts liability handling", () => {
    it("normalises credit, loan AND debt balances to negative", async () => {
      const fake = installFake();
      const rows = [
        { id: "a1", name: "Card", type: "credit", currency: "INR", balance: 1000 },
        { id: "a2", name: "Mortgage", type: "loan", currency: "INR", balance: 2000 },
        { id: "a3", name: "Owed to a friend", type: "debt", currency: "INR", balance: 3000 },
        { id: "a4", name: "Bank", type: "checking", currency: "INR", balance: 4000 },
      ];
      // rates, accounts, txn totals, investment totals
      fake.selects.push([], rows, [], []);

      const accounts = await listAccounts();

      expect(accounts.map((a) => a.balance)).toEqual([-1000, -2000, -3000, 4000]);
    });
  });

  // ─── Envelope spend derivation ─────────────────────────────────────────────

  describe("computeSpentByEnvelope", () => {
    it("nets spend per envelope in base currency, crediting transfers in", async () => {
      const fake = installFake();
      fake.selects.push([
        // account-native amounts; USD converts at 80
        { envelope_id: "e1", amount: 100, currency: "USD", type: "expense", payee: "Coffee" },
        { envelope_id: "e1", amount: 50, currency: "INR", type: "expense", payee: "Tea" },
        { envelope_id: "e2", amount: 200, currency: "INR", type: "transfer", payee: "Transfer in" },
        { envelope_id: "e2", amount: 20, currency: "INR", type: "transfer", payee: "Transfer out" },
      ]);

      const spent = await computeSpentByEnvelope(
        "2026-05",
        { USD: 80 },
        ["e1", "e2", "e3"]
      );

      expect(spent.e1).toBe(100 * 80 + 50);
      // 200 credited, 20 debited → net credit of 180
      expect(spent.e2).toBe(-180);
      // an envelope with no transactions is reported, as zero
      expect(spent.e3).toBe(0);
    });

    it("short-circuits when the month has no envelopes", async () => {
      const fake = installFake();
      const spent = await computeSpentByEnvelope("2026-05", {}, []);
      expect(spent).toEqual({});
      expect(fake.selects).toHaveLength(0);
    });
  });

  // ─── Envelope-required rule ────────────────────────────────────────────────

  describe("on-budget expenses require an envelope", () => {
    const expense = {
      account_id: "acc-1",
      payee: "Groceries",
      amount: 500,
      type: "expense" as const,
      date: "2026-05-21",
    };

    it("rejects an on-budget expense with no envelope", async () => {
      const fake = installFake();
      fake.selects.push([{ off_budget: false }]);

      await expect(createTransaction(expense)).rejects.toThrow(
        "An envelope category is required for expenses on On-Budget accounts."
      );
      expect(fake.inserted).toHaveLength(0);
    });

    it("allows an off-budget expense with no envelope", async () => {
      const fake = installFake();
      fake.selects.push([{ off_budget: true }]);

      await createTransaction(expense);

      expect(fake.inserted).toHaveLength(1);
    });

    it("allows an on-budget expense that has an envelope", async () => {
      const fake = installFake();

      await createTransaction({ ...expense, envelope_id: "env-1" });

      expect(fake.inserted).toHaveLength(1);
      // no account lookup needed when an envelope is present
      expect(fake.selects).toHaveLength(0);
    });

    it("allows income with no envelope", async () => {
      const fake = installFake();

      await createTransaction({ ...expense, type: "income" });

      expect(fake.inserted).toHaveLength(1);
    });

    it("rejects clearing the envelope on an on-budget expense", async () => {
      const fake = installFake();
      fake.selects.push(
        [
          {
            id: "txn-1",
            account_id: "acc-1",
            envelope_id: "env-1",
            amount: 500,
            type: "expense",
            payee: "Groceries",
            transfer_pair_id: null,
          },
        ],
        [{ off_budget: false }]
      );

      await expect(
        updateTransaction("txn-1", { envelope_id: null })
      ).rejects.toThrow(
        "An envelope category is required for expenses on On-Budget accounts."
      );
    });
  });

  describe("envelopes.spent is never written", () => {
    it("deleting a transaction only deletes rows, no spent bookkeeping", async () => {
      const fake = installFake();
      fake.selects.push([
        {
          id: "txn-1",
          account_id: "acc-1",
          envelope_id: "env-1",
          amount: 500,
          type: "expense",
          payee: "Groceries",
          transfer_pair_id: null,
        },
      ]);

      await deleteTransaction("txn-1");

      expect(fake.updated).toHaveLength(0);
    });

    it("deleting one leg of a transfer deletes the pair without spent bookkeeping", async () => {
      const fake = installFake();
      fake.selects.push([
        {
          id: "txn-1",
          account_id: "acc-1",
          envelope_id: "env-1",
          amount: 500,
          type: "transfer",
          payee: "Transfer out",
          transfer_pair_id: "pair-1",
        },
      ]);

      await deleteTransaction("txn-1");

      expect(fake.updated).toHaveLength(0);
    });
  });
});
