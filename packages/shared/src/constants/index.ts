/**
 * Cross-cutting domain constants shared by the server and the desktop client.
 *
 * Anything in this file is load-bearing in BOTH apps. If you change a value
 * here you are changing stored data semantics — check for existing rows first.
 */

// ─── Transfer direction ───────────────────────────────────────────────────────
//
// A transfer is stored as two rows sharing a `transfer_pair_id`. The payee
// string is what tells the balance and envelope accounting which leg is which:
// TRANSFER_OUT debits its account and its envelope, TRANSFER_IN credits both.
//
// These strings are persisted in the `transactions.payee` column, so they must
// never be changed without a data migration.

export const TRANSFER_OUT = "Transfer out";
export const TRANSFER_IN = "Transfer in";

export type TransferDirection = typeof TRANSFER_IN | typeof TRANSFER_OUT;

/** True when this row is the crediting (incoming) leg of a transfer pair. */
export function isTransferIn(txn: {
  type: string;
  payee: string;
}): boolean {
  return txn.type === "transfer" && txn.payee === TRANSFER_IN;
}

/** True when this row is the debiting (outgoing) leg of a transfer pair. */
export function isTransferOut(txn: {
  type: string;
  payee: string;
}): boolean {
  return txn.type === "transfer" && txn.payee === TRANSFER_OUT;
}

/**
 * Signed effect of a transaction on its account's balance, in the account's
 * native currency. Returns null for a `transfer` row whose payee matches
 * neither direction — an orphan leg that callers must handle explicitly
 * rather than silently treating as zero.
 */
export function balanceDelta(txn: {
  type: string;
  payee: string;
  amount: number;
}): number | null {
  if (txn.type === "income") return txn.amount;
  if (txn.type === "expense") return -txn.amount;
  if (txn.type === "transfer") {
    if (txn.payee === TRANSFER_IN) return txn.amount;
    if (txn.payee === TRANSFER_OUT) return -txn.amount;
    return null;
  }
  return null;
}

// ─── Account classification ───────────────────────────────────────────────────
//
// Liabilities are stored with a NEGATIVE balance. The server owns this sign:
// clients must send the user-facing magnitude and let createAccount /
// updateAccount normalize it. Do not negate on the client.

export const LIABILITY_TYPES = ["credit", "loan", "debt"] as const;
export type LiabilityType = (typeof LIABILITY_TYPES)[number];

/** Account types whose balance is stored negative and counts against net worth. */
export function isLiabilityType(type: string): boolean {
  return (LIABILITY_TYPES as readonly string[]).includes(type);
}

/**
 * Account types whose derived balance folds in the current value of any
 * `investments` rows linked to them. Kept here because both the balance
 * derivation and the net-worth breakdown must agree on the list.
 */
export const HOLDINGS_BEARING_TYPES = [
  "investment",
  "checking",
  "savings",
  "cash",
] as const;

export function bearsHoldings(type: string): boolean {
  return (HOLDINGS_BEARING_TYPES as readonly string[]).includes(type);
}

// ─── System-generated payees ──────────────────────────────────────────────────
//
// Written by the server, not by the user. Persisted, so treat as data.

/** Seeded by createAccount for a positive on-budget opening balance. */
export const STARTING_BALANCE_PAYEE = "Starting Balance";

/**
 * Written by updateAccount when the user reconciles an account to a new
 * balance: the difference between the requested and the derived balance is
 * posted as a visible transaction rather than overwriting the stored column.
 */
export const BALANCE_ADJUSTMENT_PAYEE = "Balance Adjustment";
