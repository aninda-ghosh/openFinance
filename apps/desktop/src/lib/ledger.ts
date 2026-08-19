/**
 * Constants shared by the per-account transaction ledgers.
 *
 * The account-detail sheets (Savings & Checking, Investments' linked accounts,
 * Debt) each render the same ledger for one account, including a running
 * "balance after this row" column. That column is computed by walking BACKWARDS
 * from the account's current balance over the rows that were actually fetched,
 * so the page size is not a cosmetic choice: it decides how far back the walk
 * can go, and a sheet that fetches fewer rows simply stops showing older ones.
 *
 * The three sheets used to ask for 150 / 200 / 100 rows respectively. Since
 * every sheet seeds from the same current balance and walks the same deltas,
 * the numbers themselves agreed — but the CUTOFF did not, so an account with
 * more than 100 transactions showed a different amount of history depending on
 * which screen you opened it from, and the oldest visible row differed. One
 * constant keeps the three sheets literally the same ledger.
 */
export const ACCOUNT_LEDGER_PAGE_SIZE = 200;
