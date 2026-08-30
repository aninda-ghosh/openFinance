# openFinance — Logic Consistency Review

Scope: every path that **creates, edits, or deletes a transaction or an account**, and every
place that **derives a balance, a net worth, or an envelope `spent`** from them.

Good news first: `TransactionForm.tsx` is genuinely the single shared add/edit component.
Quick-add drawer, quick-add page, Transactions page, Budget page, Savings/Checking sheet,
Investments sheet and Debt "Make Payment" all mount it. The duplication problem is **not**
in the form — it's in (a) the two write paths that bypass the form, (b) the rules that live
only inside the form and nowhere else, and (c) the five independent re-implementations of
"what is this account's balance".

---

## Severity 1 — Editing an account silently inflates its balance

`listAccounts()` returns a **derived** balance:

```ts
// budget.service.ts:164-176
const startBalance = r.type === "credit" || r.type === "loan"
  ? -Math.abs(r.balance ?? 0) : (r.balance ?? 0);
let liveNative = startBalance + (txnDeltaNative[r.id] ?? 0);
if (["investment","checking","savings","cash"].includes(r.type))
  liveNative += (invDeltaNative[r.id] ?? 0);       // + linked holdings
```

`createAccount()` respects that model — for an on-budget positive opening balance it stores
`balance = 0` and seeds a `"Starting Balance"` income transaction (`budget.service.ts:204-222`).

`updateAccount()` does **not**. It writes the client value straight into the stored column:

```ts
// budget.service.ts:236-240
.update(accounts).set({ ...data, updated_at: ... })
```

And all three edit dialogs prefill that field with the **live** balance:

| Page | Line | Value passed as `initial.balance` |
|---|---|---|
| SavingsCheckingPage | 736 | `a.balance` (live) |
| DebtPage | 617 | `a.balance` (live) |
| InvestmentsPage | 442 | `initial={account}` (live) |

**Failure:** account has stored `balance = 0` and ₹50,000 of transactions → UI shows ₹50,000.
User opens Edit just to fix a typo in the name and hits Save → stored `balance` becomes
50,000 → next read shows **₹100,000**. Every subsequent edit doubles it again. For an
investment/checking account with linked holdings the holdings value is folded in too.

**Fix:** make `updateAccount` treat `balance` the way `createAccount` does — either drop
`balance` from `UpdateAccountSchema` entirely and give balance corrections their own
"adjustment transaction" endpoint, or have `updateAccount` diff the requested balance
against the derived balance and post the delta as an adjustment transaction. Then stop
prefilling the dialog from `a.balance`.

---

## Severity 1 — `envelopes.spent` has three writers with three different units, and the read path ignores all of them

| Writer | Unit | Semantics |
|---|---|---|
| `insertTransactionTx` (budget.service.ts:818-825), `updateTransaction` (931-955), `deleteTransaction` (1008-1036), `deleteAccount` (257-264) | **account-native currency** | incremental `+=` / `-=` |
| `getMonthlySummary` (1387-1396) | **base/INR** | full overwrite, and zeroes any envelope with no txns that month |
| `updateEnvelope` (569-584) | — | reads it back, returns `available = budgeted(native) − spent(mixed)` |

Meanwhile `listEnvelopes()` — the endpoint the Budget page actually renders — **never reads
the column**. It recomputes `spent` from transactions in base currency
(budget.service.ts:398-431).

So the column is a mixed-unit accumulator that's correct only for the last month someone
happened to load a report. Two consumers still trust it:

- `computeCarryoverForMonth` (1296-1311) reads `env.spent` and comments `// value in INR`.
  Carryover / To-Be-Budgeted is therefore wrong for any prior month whose summary
  endpoint was never hit, and wrong in a multi-currency setup regardless.
- `getEnvelopeTrends` (1417-1438) reads it — so the envelope trend chart disagrees with the
  Budget page for the same envelope and month.

**Fix:** delete the `spent` column, or make it a pure cache with exactly one writer. Extract
the "net spent per envelope in base currency" query — it is currently written out three
times (`listEnvelopes` 398-431, `listEnvelopes` prev-month block 462-493, `getMonthlySummary`
1374-1384) — into one function and call it from `computeCarryoverForMonth` and
`getEnvelopeTrends` too.

Related: `getEnvelopeTrends` filters `where(eq(envelopes.id, envelopeId))` and orders by
month. Envelope rows are **per-month with distinct ids**, so this can only ever return one
row — "trends over N months" always renders a single point. The rollover code in
`listEnvelopes` already shows the right key: `${group_id}|${name}`.

---

## Severity 1 — Three different net-worth formulas

| Source | Cash | Holdings | Debt |
|---|---|---|---|
| `getNetWorth` (dashboard.service.ts:21-90) | live `balance_inr` of non-off-budget non-policy accounts, **minus linked holdings**, floored at 0 | `linkedAccountsInr + holdingsInr` | signed sum, `credit\|loan\|debt` |
| `getNetWorthHistory` (366-478) | **raw stored** `balance` + txn deltas, off-budget assets **dropped entirely** | global `investmentsCurrentInr` | `credit\|loan\|debt`, sign-normalized |
| `AccountsPage.tsx:47-74` | on-budget `checking\|savings\|cash` only | `nwData.breakdown.investments_inr` | `Math.abs()` of each |

The headline "Net Worth" number, the last point of the history chart, and the Accounts
page "Net Position" tile are computed three different ways and will not agree. Off-budget
savings accounts in particular are in the first, absent from the second, and in the third
only via the breakdown.

**Fix:** one exported `computeNetWorthAt(date)` in `dashboard.service.ts`; have
`getNetWorth` be `computeNetWorthAt(today)`, have the history map it over months, and have
`AccountsPage` read the breakdown instead of re-deriving.

---

## Severity 2 — The `debt` account type is a liability in four places and an asset in two

`AccountTypeEnum` (account.schema.ts:4-13) has `credit`, `loan`, **and** `debt`.

Treats `debt` as a liability: `AccountsPage:66`, `TransactionForm:392-396`,
`DebtPage:369` (create), `getNetWorth:59`, `getNetWorthHistory:426`.

Does **not**: `createAccount` sign-normalization (`budget.service.ts:200`) and
`listAccounts` (`164-167`) both check only `credit || loan`.

**Failure:** create a `debt` account from the Debt page → DebtPage negates it client-side
(line 369-371) so it happens to be right. Create the same type from Savings/Checking or
Investments (`AccountFormDialog` offers "Other Debt / Liability" in every instance,
AccountFormDialog.tsx:24) → stored positive, `listAccounts` won't normalize it, and it
shows as a **positive asset** on the account card while `getNetWorth` adds it to `debtInr`
as a positive number, *increasing* net worth.

**Fix:** one `LIABILITY_TYPES = ["credit","loan","debt"]` constant in `packages/shared`, used
on both sides. Remove the client-side negation in `DebtPage:369-371` and let the server own
the sign.

---

## Severity 2 — The "envelope required for on-budget expenses" rule exists in exactly one place

`TransactionForm.handleSubmit` (TransactionForm.tsx:532-540) blocks an on-budget expense
with no envelope. Nothing else does. The server has no equivalent check —
`createTransaction` (841-865) accepts whatever validates against `CreateTransactionSchema`,
which makes `envelope_id` optional.

Paths that bypass it today:

1. **`TransactionForm.handleSaveEdit`** (570-611) — the *same component*. No envelope
   validation, and it unconditionally sends `envelope_id: tab === "expense" && envelopeId ? envelopeId : null`.
   Edit an on-budget expense, clear the envelope, save → uncategorised expense that
   create-mode would have refused.
2. **`InvestmentsPage.UpdateValueDialog`** (466-496) — posts an `income`/`expense` with no
   envelope at all.
3. **`BudgetPage`** inline recategorize (539-541) — `envelope_id: val || null`, the
   "📁 Uncategorised" option (554) sets it to null.
4. **CSV import** (`importCSV` 1207-1215) — never sets `envelope_id`.
5. **Recurring** (`recurring.service.ts:63`) — passes through whatever the rule holds.

**Fix:** move the rule into `budget.service.ts` next to the transfer-boundary check
(`createTransfer` 1079-1086 already validates server-side — that's the pattern to copy), and
apply it in `createTransaction` and `updateTransaction`.

---

## Severity 2 — `UpdateValueDialog` double-counts on any investment account with linked holdings

```ts
// InvestmentsPage.tsx:468-471
const currentBalance = account.balance as number;   // live: stored + txns + Σ holdings
const delta = parsed - currentBalance;
// …posts income/expense of |delta|
```

`listAccounts` already adds `Σ investments.current_value` for `investment` accounts
(budget.service.ts:171-173). Recording the delta as a transaction adds a *second*
contribution on top of the holdings the balance already reflects. Two "Update Value" clicks
and the account's balance drifts away from the sum of its holdings permanently.

This dialog is also the only account-mutating write in the app that doesn't go through
`TransactionForm`. If the intent is "adjust the cash sleeve", it should target the cash
component, not the holdings-inclusive live balance.

---

## Severity 3 — `runningBalances` is copy-pasted four times, and it's wrong in two of them

Byte-identical bodies at:

- `DebtPage.tsx:108-129`
- `TransactionsPage.tsx:308-334`
- `SavingsCheckingPage.tsx:133-154`
- `InvestmentsPage.tsx:214-235`

Each seeds from `account.balance` (holdings-inclusive) and walks backwards subtracting only
transaction deltas, so on `SavingsCheckingPage` and `InvestmentsPage` every row's running
balance is offset by the linked-holdings total. `DebtPage` has no holdings so it's fine —
which is why the bug is invisible in the place the code was probably written.

Two more inconsistencies in the same block: the page size differs per caller
(100 / 150 / 200 / page-controlled), so the same transaction shows a different running
balance depending on which screen you open it from; and `listTransactions` orders by
`desc(transactions.date)` only (budget.service.ts:777) with no tiebreak, so same-day rows
have nondeterministic order and the running balances shuffle between refetches.

**Fix:** one `useRunningBalances(accountId, txns)` hook; add `desc(transactions.created_at)`
as a secondary sort; seed from a holdings-excluded balance.

---

## Severity 3 — `"Transfer in"` / `"Transfer out"` are load-bearing magic strings in 20 places

The payee string is what decides whether a transfer **credits or debits** an envelope
(`insertTransactionTx:817`), whether it **adds or subtracts** from an account balance
(`listAccounts:128-131`), and how it renders. It appears in 12 server locations and 8
client locations with no shared constant. Two consequences:

- A `transfer` row whose payee is neither string contributes **zero** to the account
  balance in `listAccounts` — silently, no error.
- A user creating an ordinary expense literally named "Transfer in" gets credited.

**Fix:** `export const TRANSFER_IN = "Transfer in"` in `packages/shared`, or better, key the
direction off `transfer_pair_id` + account identity, or add an explicit `direction` column.

---

## Severity 3 — Validation applied inconsistently across write routes

- **Amount sign.** `CreateTransactionSchema.amount` is bare `z.number()`;
  `UpdateTransactionSchema.amount` is `z.number().positive()` (transaction.schema.ts:14, 26).
  The API accepts a negative or zero amount on create and rejects it on update. Only
  `TransactionForm` enforces positivity on create (line 468-472) — CSV import
  (`importCSV:1194-1198` accepts any parseable float, including negatives) does not.
- **Recurring transactions have no schema at all.** `budget.ts:347-367` passes raw
  `body` into `createRecurring` / `updateRecurring`, while every other write route
  `safeParse`s a shared schema. There is no `recurring.schema.ts`.
- **`UpdateTransactionSchema.type`** excludes `"transfer"` (transaction.schema.ts:28) — correct —
  but `CreateTransactionSchema.type` includes it (line 15), so `POST /transactions` will happily
  create an orphan transfer leg with no `transfer_pair_id`, which then breaks
  `deleteTransaction`'s pair logic and contributes 0 to `listAccounts` unless the payee
  happens to match.

---

## Severity 4 — Smaller drift

- **Two definitions of `available`.** `listEnvelopes` returns `budgeted_inr − spent`
  (535); `getMonthlySummary.envelope_summaries` returns `e.budgeted − spent` — native
  budgeted minus INR spent (1411). `BudgetPage:417` re-derives a third copy inline.
- **`TransactionForm`'s envelope picker** reverse-converts instead of using `available`:
  `remaining = env.budgeted − (env.spent/env.budgeted_inr)*env.budgeted` (694-698). When
  `budgeted_inr === 0` the guard makes `remaining` fall back to `env.budgeted` (0), hiding
  overspend on unbudgeted envelopes. Just use `env.available`.
- **`off_budget` defaults disagree.** `AccountFormDialog` defaults to `false` (line 58);
  DebtPage (365) and InvestmentsPage (446) override to `true` in their `initial`; the
  Savings/Checking add button passes no `initial` at all, so it inherits `checking`/`false`.
- **`createRecurring` pins an `envelope_id`** from one month, but envelope rows are
  per-month. Generated transactions in later months point at a stale envelope whose date
  range no longer matches, so the spend never lands in the current month's budget.
- **`applyDueRecurring`** advances `next_date` by one period per run, so a rule that is
  three months overdue only generates one transaction per server restart.
- **`budgetApi.importCSV`** (api.ts:144-151) builds a `FormData`, then sends `body: file`
  and drops it. Harmless today because the server reads the raw `arrayBuffer`
  (`budget.ts:300-302`), but the dead `FormData` implies a contract that isn't there.
- **`listEnvelopes` computes `envIds`** (397) and only uses it for a length check — the
  spent query has no `inArray` filter, so it scans every expense/transfer in the month.

---

## Suggested order of work

1. `updateAccount` balance handling + stop prefilling live balance in the three edit dialogs. *(silent data corruption)*
2. Single source of truth for envelope `spent`; fix `computeCarryoverForMonth` and `getEnvelopeTrends`.
3. `computeNetWorthAt()` shared by the three net-worth consumers.
4. `LIABILITY_TYPES` constant; server owns the debt sign.
5. Move the on-budget-expense envelope rule to the service layer; add `recurring.schema.ts`; align amount validation.
6. Extract `useRunningBalances`; add the `created_at` tiebreak to `listTransactions`.
7. `TRANSFER_IN` / `TRANSFER_OUT` constants (or an explicit direction column).
