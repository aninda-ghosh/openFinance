import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/index";
import { accounts, investments, policies, transactions } from "../db/schema";
import {
  computeNetWorthAt,
  getNetWorth,
  getNetWorthHistory,
  loadNetWorthContext,
  type NetWorthContext,
} from "./dashboard.service";

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

vi.mock("./exchange-rate.service", () => ({
  getLatestRates: async () => ({ INR: 1, USD: 80 }),
  getBaseCurrency: async () => "INR",
}));

vi.mock("./investment.service", () => ({
  listInvestments: async () => mockInvestmentList,
}));

let mockInvestmentList: any[] = [];

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TODAY = "2026-08-19";

function ctxOf(over: Partial<NetWorthContext> = {}): NetWorthContext {
  return {
    since: "2000-01-01",
    accounts: [],
    txnsByAccount: new Map(),
    investments: [],
    policies: [],
    rates: { INR: 1, USD: 80 },
    ...over,
  };
}

function account(over: Partial<NetWorthContext["accounts"][number]>) {
  return {
    id: "acc",
    type: "checking",
    currency: "INR",
    off_budget: false,
    is_active: true,
    liveNative: 0,
    holdingsNative: 0,
    ...over,
  };
}

function policy(over: Partial<(typeof policies.$inferSelect)>) {
  return {
    id: "pol-1",
    name: "Endowment",
    provider: "LIC",
    policy_number: null,
    currency: "INR",
    start_date: "2026-01-01",
    premium_amount: 1000,
    premium_frequency: "monthly",
    premium_term_years: 10,
    policy_term_years: 20,
    maturity_date: "2046-01-01",
    sum_assured: 500000,
    maturity_value: 500000,
    surrender_value: null,
    notes: null,
    account_id: null,
    created_at: "",
    updated_at: "",
    ...over,
  } as typeof policies.$inferSelect;
}

describe("net worth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvestmentList = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T09:00:00`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── The invariant the three call sites used to break ──────────────────────

  describe("one formula for every consumer", () => {
    const ctx = () =>
      ctxOf({
        accounts: [
          account({ id: "chk", type: "checking", liveNative: 120000 }),
          account({
            id: "sav",
            type: "savings",
            off_budget: true,
            liveNative: 400000,
          }),
          account({ id: "card", type: "credit", liveNative: -35000 }),
          account({
            id: "brk",
            type: "investment",
            off_budget: true,
            liveNative: 250000,
            holdingsNative: 200000,
          }),
        ],
        investments: [
          {
            account_id: "brk",
            purchase_date: "2024-06-01",
            current_value_inr: 200000,
          },
        ],
        policies: [policy({})],
      });

    it("current net worth equals the last point of the history series", async () => {
      const shared = ctx();
      const now = await getNetWorth(shared);
      const history = await getNetWorthHistory(6, shared);
      const last = history[history.length - 1];

      expect(history).toHaveLength(6);
      expect(last.as_of).toBe(TODAY);
      expect(now.as_of).toBe(TODAY);
      expect(last.total_inr).toBe(now.total_inr);
      expect(last.cash_inr).toBe(now.breakdown.cash_inr);
      expect(last.debt_inr).toBe(now.breakdown.debt_inr);
      // the chart bundles policies into investments; same numbers, one bucket
      expect(last.investments_inr).toBe(
        now.breakdown.investments_inr + now.breakdown.policies_inr
      );
    });

    it("keeps the breakdown self-consistent with the total", async () => {
      const now = await getNetWorth(ctx());
      const b = now.breakdown;

      expect(b.cash_inr).toBe(120000);
      // off-budget savings + the broker's cash sleeve
      expect(b.off_budget_cash_inr).toBe(400000 + 50000);
      expect(b.holdings_inr).toBe(200000);
      expect(b.investments_inr).toBe(b.holdings_inr + b.off_budget_cash_inr);
      expect(b.debt_inr).toBe(-35000);
      expect(now.total_inr).toBe(
        b.cash_inr + b.investments_inr + b.policies_inr + b.debt_inr
      );
    });
  });

  // ─── Off-budget assets ─────────────────────────────────────────────────────

  describe("off-budget asset accounts", () => {
    const shared = () =>
      ctxOf({
        accounts: [
          account({
            id: "sav",
            type: "savings",
            off_budget: true,
            liveNative: 100000,
          }),
        ],
      });

    it("counts an off-budget savings account identically now and in every month", async () => {
      const ctx = shared();
      const now = await getNetWorth(ctx);
      const history = await getNetWorthHistory(6, ctx);

      expect(now.total_inr).toBe(100000);
      expect(now.breakdown.cash_inr).toBe(0);
      expect(now.breakdown.off_budget_cash_inr).toBe(100000);

      // the history used to drop these accounts on the floor entirely
      for (const point of history) {
        expect(point.total_inr).toBe(100000);
        expect(point.investments_inr).toBe(100000);
      }
    });
  });

  // ─── Liabilities ───────────────────────────────────────────────────────────

  describe("liabilities", () => {
    it("reduces net worth by the magnitude owed, for every liability type", () => {
      for (const type of ["credit", "loan", "debt"]) {
        const snap = computeNetWorthAt(
          TODAY,
          ctxOf({
            accounts: [
              account({ id: "chk", liveNative: 100000 }),
              account({ id: "owed", type, liveNative: -25000 }),
            ],
          })
        );
        expect(snap.breakdown.debt_inr).toBe(-25000);
        expect(snap.total_inr).toBe(75000);
      }
    });
  });

  // ─── Holdings ──────────────────────────────────────────────────────────────

  describe("linked holdings", () => {
    it("counts a linked holding once, not once per account and once per holding", () => {
      const snap = computeNetWorthAt(
        TODAY,
        ctxOf({
          accounts: [
            account({
              id: "brk",
              type: "investment",
              liveNative: 80000, // 50k cash + 30k of linked holdings
              holdingsNative: 30000,
            }),
          ],
          investments: [
            {
              account_id: "brk",
              purchase_date: "2020-01-01",
              current_value_inr: 30000,
            },
          ],
        })
      );

      expect(snap.breakdown.cash_inr).toBe(50000);
      expect(snap.breakdown.holdings_inr).toBe(30000);
      expect(snap.total_inr).toBe(80000);
    });

    it("does not credit a holding before it was bought", () => {
      const ctx = ctxOf({
        accounts: [account({ id: "chk", liveNative: 10000 })],
        investments: [
          {
            account_id: null,
            purchase_date: "2026-07-15",
            current_value_inr: 40000,
          },
        ],
      });

      expect(computeNetWorthAt("2026-06-30", ctx).total_inr).toBe(10000);
      expect(computeNetWorthAt("2026-07-31", ctx).total_inr).toBe(50000);
    });
  });

  // ─── The Math.max(0, …) floor ──────────────────────────────────────────────

  describe("overdrawn accounts", () => {
    it("reports a negative cash sleeve instead of flooring it at zero", () => {
      const snap = computeNetWorthAt(
        TODAY,
        ctxOf({
          accounts: [account({ id: "chk", liveNative: -5000 })],
        })
      );
      // the old formula floored this to 0 and reported a net worth of zero
      expect(snap.breakdown.cash_inr).toBe(-5000);
      expect(snap.total_inr).toBe(-5000);
    });
  });

  // ─── As-of rollback ────────────────────────────────────────────────────────

  describe("as-of dates", () => {
    const ctx = () =>
      ctxOf({
        since: "2026-01-01",
        accounts: [account({ id: "chk", liveNative: 60000 })],
        txnsByAccount: new Map([
          [
            "chk",
            [
              {
                date: "2026-08-10",
                type: "income",
                payee: "Salary",
                amount: 10000,
              },
            ],
          ],
        ]),
      });

    it("rolls the live balance back over later transactions", () => {
      expect(computeNetWorthAt("2026-07-31", ctx()).total_inr).toBe(50000);
      expect(computeNetWorthAt(TODAY, ctx()).total_inr).toBe(60000);
    });

    it("does not depend on the order transactions arrive in", () => {
      const rows = [
        { date: "2026-08-10", type: "income", payee: "Salary", amount: 10000 },
        { date: "2026-06-01", type: "expense", payee: "Rent", amount: 5000 },
        {
          date: "2026-08-02",
          type: "transfer",
          payee: "Transfer out",
          amount: 2000,
        },
      ];
      const build = (order: typeof rows) =>
        ctxOf({
          since: "2026-01-01",
          accounts: [account({ id: "chk", liveNative: 60000 })],
          txnsByAccount: new Map([["chk", order]]),
        });

      const ascending = computeNetWorthAt("2026-07-31", build([...rows].sort((a, b) => a.date.localeCompare(b.date))));
      const descending = computeNetWorthAt("2026-07-31", build([...rows].sort((a, b) => b.date.localeCompare(a.date))));

      // 60000 − (+10000 in Aug) − (−2000 in Aug); the June row is already in
      expect(ascending.total_inr).toBe(52000);
      expect(descending.total_inr).toBe(ascending.total_inr);
    });

    it("refuses a date the context was not loaded for", () => {
      expect(() => computeNetWorthAt("2025-12-31", ctx())).toThrow(
        /cannot answer/
      );
    });

    it("clamps the current month to today so future-dated rows land in neither figure", async () => {
      const future = ctxOf({
        accounts: [account({ id: "chk", liveNative: 70000 })],
        txnsByAccount: new Map([
          [
            "chk",
            [
              {
                date: "2026-08-31",
                type: "income",
                payee: "Bonus",
                amount: 20000,
              },
            ],
          ],
        ]),
      });

      const now = await getNetWorth(future);
      const history = await getNetWorthHistory(3, future);

      expect(now.total_inr).toBe(50000);
      expect(history[history.length - 1].total_inr).toBe(50000);
    });
  });

  // ─── Policies ──────────────────────────────────────────────────────────────

  describe("policies", () => {
    it("values an unlinked policy at the premiums paid by that date", () => {
      const ctx = ctxOf({ policies: [policy({})] });

      // monthly ₹1,000 from 2026-01-01: three paid by end of March
      expect(computeNetWorthAt("2026-03-31", ctx).breakdown.policies_inr).toBe(
        3000
      );
      expect(computeNetWorthAt("2026-06-30", ctx).breakdown.policies_inr).toBe(
        6000
      );
      // ...not the flat whole-term total the old history applied every month
      expect(
        computeNetWorthAt("2026-03-31", ctx).breakdown.policies_inr
      ).not.toBe(1000 * 12 * 10);
    });

    it("converts an unlinked policy's premiums at its own currency", () => {
      const snap = computeNetWorthAt(
        "2026-03-31",
        ctxOf({ policies: [policy({ currency: "USD" })] })
      );
      expect(snap.breakdown.policies_inr).toBe(3000 * 80);
    });

    it("values a linked policy from its account, and never also as cash", () => {
      const snap = computeNetWorthAt(
        TODAY,
        ctxOf({
          accounts: [
            account({ id: "chk", liveNative: 10000 }),
            // a policy pointing at a plain on-budget account: counted once
            account({ id: "pol-acc", type: "savings", liveNative: 45000 }),
          ],
          policies: [policy({ account_id: "pol-acc" })],
        })
      );

      expect(snap.breakdown.cash_inr).toBe(10000);
      expect(snap.breakdown.policies_inr).toBe(45000);
      expect(snap.total_inr).toBe(55000);
    });

    it("still counts a policy account whose policy row is gone", () => {
      const snap = computeNetWorthAt(
        TODAY,
        ctxOf({
          accounts: [account({ id: "orphan", type: "policy", liveNative: 7000 })],
        })
      );
      expect(snap.breakdown.policies_inr).toBe(7000);
    });
  });

  // ─── Inactive accounts ─────────────────────────────────────────────────────

  it("ignores inactive accounts", () => {
    const snap = computeNetWorthAt(
      TODAY,
      ctxOf({
        accounts: [
          account({ id: "chk", liveNative: 1000 }),
          account({ id: "old", liveNative: 999999, is_active: false }),
        ],
      })
    );
    expect(snap.total_inr).toBe(1000);
  });
});

// ─── Wiring: the context really is the shared balance derivation ─────────────

describe("loadNetWorthContext", () => {
  /**
   * Drizzle builders are thenables: every method returns the builder and
   * awaiting it runs the query. Results are queued per table, in query order,
   * so the fake does not depend on how the calls interleave.
   */
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

  function installFake(queues: Map<unknown, unknown[][]>) {
    const db = getDb() as any;
    db.select.mockImplementation(() => ({
      from: (table: unknown) => chain(queues.get(table)?.shift() ?? []),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvestmentList = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T09:00:00`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes balances from getAccountBalances, so stored signs and holdings are already resolved", async () => {
    const accountRows = [
      {
        id: "chk",
        type: "checking",
        currency: "INR",
        balance: 0,
        is_active: true,
        off_budget: false,
      },
      // stored POSITIVE by a dialog that forgot to negate — still a liability
      {
        id: "owed",
        type: "debt",
        currency: "INR",
        balance: 5000,
        is_active: true,
        off_budget: false,
      },
    ];
    mockInvestmentList = [
      {
        account_id: "chk",
        purchase_date: "2024-01-01",
        current_value_inr: 30000,
      },
    ];

    installFake(
      new Map<unknown, unknown[][]>([
        // read by getAccountBalances, then by loadNetWorthContext
        [accounts, [accountRows, accountRows]],
        [
          transactions,
          [
            // getAccountBalances' grouped totals…
            [
              {
                account_id: "chk",
                type: "income",
                payee: "Starting Balance",
                total: 50000,
              },
              // an orphan transfer leg: no direction, excluded from the balance
              {
                account_id: "chk",
                type: "transfer",
                payee: "Moved",
                total: 999,
              },
            ],
            // …then loadNetWorthContext's rows after the cutoff
            [],
          ],
        ],
        [investments, [[{ account_id: "chk", currency: "INR", total: 30000 }]]],
        [policies, [[]]],
      ])
    );

    const ctx = await loadNetWorthContext(TODAY);
    const snap = computeNetWorthAt(TODAY, ctx);

    // 50k of transactions + 30k of holdings, holdings counted once
    expect(snap.breakdown.cash_inr).toBe(50000);
    expect(snap.breakdown.holdings_inr).toBe(30000);
    // stored +5000 on a `debt` account still subtracts
    expect(snap.breakdown.debt_inr).toBe(-5000);
    expect(snap.total_inr).toBe(75000);
  });
});
