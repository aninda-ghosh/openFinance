import { balanceDelta, bearsHoldings } from "@openfinance/shared/constants";
import { convertFromINR, convertToINR } from "@openfinance/shared/utils";
import { useMemo } from "react";

/**
 * Running ("balance after this row") figures for a transaction ledger.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * This block used to be copy-pasted into DebtPage, TransactionsPage,
 * SavingsCheckingPage and InvestmentsPage. Two of those copies were wrong: they
 * seeded the walk from `account.balance`, which the server returns
 * HOLDINGS-INCLUSIVE for `investment` / `checking` / `savings` / `cash`
 * accounts (listAccounts adds the `current_value` of every linked
 * `investments` row). Walking transaction deltas back from that seed offsets
 * every single row by the account's total holdings value. DebtPage never had
 * holdings, which is why the bug was invisible where the code was written.
 *
 * ─── The seed contract ──────────────────────────────────────────────────────
 * The seed you pass MUST be a HOLDINGS-EXCLUDED balance in the account's NATIVE
 * currency — i.e. stored opening balance + Σ transaction deltas, and nothing
 * else. `account.balance` straight off the API is NOT that for a
 * holdings-bearing account.
 *
 * Use `useHoldingsExcludedBalance` (single account) or
 * `useHoldingsExcludedBalances` (many) below to produce a correct seed; they
 * are no-ops for account types that cannot carry holdings.
 */

/** Minimum shape `useRunningBalances` needs off a transaction row. */
export type RunningBalanceTxn = {
  id: string;
  /** Required for the multi-account form; ignored for the single-account form. */
  account_id?: string | null;
  type: string;
  payee: string;
  amount: number;
};

/**
 * Either one seed (single-account sheet) or a seed per account id
 * (multi-account ledger). Missing account ids seed at 0.
 */
export type RunningBalanceSeed = number | Readonly<Record<string, number>>;

export type RunningBalanceMap = Record<string, number>;

/**
 * Maps transaction id → the account's balance immediately AFTER that
 * transaction, in the account's native currency.
 *
 * `txns` must be in the order the ledger renders them: NEWEST FIRST. The walk
 * assigns the current balance to row 0, then subtracts that row's delta to get
 * the balance as of the next (older) row. Passing an ascending list produces
 * nonsense — sort before calling, don't reverse after.
 *
 * A `transfer` row whose payee is neither TRANSFER_IN nor TRANSFER_OUT is an
 * orphan leg. `balanceDelta` returns null for it and this hook treats it as
 * ZERO — deliberately, because the server's `listAccounts` also contributes
 * nothing for such a row. Treating it as an outflow (what the old copies did)
 * would desync the walk from the seed it started at.
 *
 * @param txns  Ledger rows, newest first.
 * @param seed  Holdings-excluded native balance — a number for a single-account
 *              view, or a Record<account_id, number> for a mixed ledger.
 */
export function useRunningBalances(
  txns: readonly RunningBalanceTxn[] | undefined,
  seed: RunningBalanceSeed
): RunningBalanceMap {
  return useMemo(() => {
    const balances: RunningBalanceMap = {};
    if (!txns || txns.length === 0) return balances;

    const isSingle = typeof seed === "number";
    // Mutable working copy; never mutate the caller's seed record.
    const running: Record<string, number> = isSingle ? {} : { ...seed };
    const SINGLE = "__single__";
    if (isSingle) running[SINGLE] = seed;

    for (const t of txns) {
      const key = isSingle ? SINGLE : (t.account_id ?? "");
      const current = running[key] ?? 0;
      balances[t.id] = current;
      // null = orphan transfer leg: contributes nothing, same as the server.
      running[key] = current - (balanceDelta(t) ?? 0);
    }

    return balances;
  }, [txns, seed]);
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/** Minimum shape needed off an account row. */
export type SeedAccount = {
  id: string;
  type: string;
  currency: string;
  /** The API's DERIVED balance — holdings-inclusive for holdings-bearing types. */
  balance: number;
};

/** Minimum shape needed off an investment row. */
export type SeedInvestment = {
  account_id?: string | null;
  currency: string;
  current_value: number;
  /** Server-converted base-currency value; preferred when present. */
  current_value_inr?: number;
};

/**
 * Σ linked holdings for one account, expressed in that account's native
 * currency — the exact quantity `listAccounts` folds into `balance`.
 * Returns 0 for account types that never carry holdings.
 */
export function holdingsValueForAccount(
  account: Pick<SeedAccount, "id" | "type" | "currency">,
  investments: readonly SeedInvestment[] | undefined,
  rates: Record<string, number>
): number {
  if (!investments || investments.length === 0) return 0;
  if (!bearsHoldings(account.type)) return 0;

  let totalInr = 0;
  for (const inv of investments) {
    if (inv.account_id !== account.id) continue;
    totalInr +=
      inv.current_value_inr ??
      convertToINR(inv.current_value, inv.currency as any, rates);
  }
  return convertFromINR(totalInr, account.currency as any, rates);
}

/**
 * The seed `useRunningBalances` wants for a single account: the API balance
 * with any linked holdings taken back out.
 *
 * Pass `investments` from `useInvestments()` and `rates` from
 * `useExchangeRates()`. If you have neither (e.g. a debt sheet, where holdings
 * cannot exist), passing `undefined` / `{}` is safe — the result is just
 * `account.balance`.
 */
export function useHoldingsExcludedBalance(
  account: SeedAccount | undefined | null,
  investments: readonly SeedInvestment[] | undefined,
  rates: Record<string, number> = {}
): number {
  return useMemo(() => {
    if (!account) return 0;
    return (
      (account.balance ?? 0) -
      holdingsValueForAccount(account, investments, rates)
    );
  }, [account, investments, rates]);
}

/**
 * The multi-account form of `useHoldingsExcludedBalance`: account id → seed.
 * Feed the result straight into `useRunningBalances` as the `seed`.
 */
export function useHoldingsExcludedBalances(
  accounts: readonly SeedAccount[] | undefined,
  investments: readonly SeedInvestment[] | undefined,
  rates: Record<string, number> = {}
): Record<string, number> {
  return useMemo(() => {
    const seeds: Record<string, number> = {};
    for (const a of accounts ?? []) {
      seeds[a.id] =
        (a.balance ?? 0) - holdingsValueForAccount(a, investments, rates);
    }
    return seeds;
  }, [accounts, investments, rates]);
}
