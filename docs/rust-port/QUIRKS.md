# Node behaviours ported as-is

Behaviour that looks like a bug but was kept so Rust matches Node exactly.
Each entry: Node file:line, what it does, suggested fix. Decide on fixes after the port ships.

## Wave 0 — foundation

Line numbers are for `apps/server/src` on `feat/rust-port` (after the
`OPENFINANCE_NO_NETWORK` guard, which adds two lines inside `refreshFromWeb`).

1. **Base-currency change scales budgets the wrong way.**
   `routes/exchange-rates.ts:72-78` + `services/budget.service.ts:1920`.
   Switching base USD → INR takes `conversionRate = oldRates["INR"]` (0.012, i.e.
   1 INR = 0.012 USD) and *multiplies* every envelope's `budgeted` and
   `rollover_amount` by it, so a 100 USD budget becomes 1.2 INR instead of ~8333.
   Suggested fix: divide by the rate (multiply by `1 / oldRates[new]`).
   Rust: `services/budget.rs::scale_budget_envelopes` multiplies, like Node.
2. **Base-currency change is applied, then reported as a failure.**
   `routes/exchange-rates.ts:74-81`. The base currency is saved and envelopes are
   scaled before `refreshFromWeb()`; when the refresh fails (offline), the
   response is `503 {"error":"Failed to fetch exchange rates from API"}` although
   the change stuck. Nothing is transactional. Suggested fix: refresh first, or
   return success with a warning when only the refresh fails.
3. **A stored rate of 0 (or any falsy value) is skipped.**
   `services/exchange-rate.service.ts:62` uses `!latest[cur]`, so a newer row with
   `rate_to_base = 0` (or `''`) is ignored and an older row wins. Suggested fix:
   `!(cur in latest)`.
4. **`GET /api/exchange-rates` invents `source` and `fetched_at`.**
   `services/exchange-rate.service.ts:115-116`: every entry says
   `source: "stored"` and `fetched_at: <now>`, not the row's real values.
   Suggested fix: return the stored row's `source`/`fetched_at`.
5. **Non-string `currency` in `POST /api/exchange-rates/refresh` → 500.**
   `services/exchange-rate.service.ts:166`: `currency.toUpperCase()` throws for a
   truthy non-string (`5`, `true`, `{}`), but only after a successful fetch (with
   the network down it is a 503 first). Suggested fix: validate the body.
6. **"No exchange rates found" never logs.** `index.ts:110`:
   `getLatestRates()` always contains the base currency, so
   `Object.keys(existing).length === 0` is never true. Log-only; Rust omits the line.
7. **`decryptString` returns garbage for plain strings on desktop.**
   `utils/crypto.ts:136-140`: on desktop a never-encrypted string (for example a
   legacy plaintext chat memory) is base64-decoded, the legacy decrypt fails, and
   the decoded bytes are returned as lossy UTF-8 instead of the original text.
   Suggested fix: return `encryptedBase64` when decryption fails. Rust:
   `crypto::decrypt_string` reproduces it, including Node's lenient base64 decoder.
8. **An unusable backup key silently exports an unencrypted backup.**
   `utils/crypto.ts:162-165`: if `keyHex` does not decode to 32 bytes,
   `createCipheriv` throws and `encryptBackup` returns the plain ZIP. Suggested
   fix: fail the export. Rust: `crypto::encrypt_backup` does the same.

## Wave 1 — budget

Line numbers are for `apps/server/src` at `652ab74`. Each item is exercised by
a `budget*` parity scenario unless noted.

1. **Transaction responses always say `currency: "INR"`.**
   `services/budget.service.ts:99` (`toTransactionResponse`): `row.currency ?? "INR"`,
   and no caller selects a currency, so a USD account's transaction reports INR.
   Suggested fix: join `accounts.currency`.
2. **Deleting an account orphans the other leg of its transfers.**
   `services/budget.service.ts:397-417` deletes the account's own rows only; the
   paired leg in the other account stays (`type = transfer`, dangling
   `transfer_pair_id`) and keeps moving that account's balance. Suggested fix:
   also delete by `transfer_pair_id`.
3. **Deleting a category a recurring rule uses is a 500.**
   `deleteEnvelope` (`services/budget.service.ts:983`) and `deleteEnvelopeGroup`
   (`:956`) clear `transactions.envelope_id` but not
   `recurring_transactions.envelope_id`, so the FK fails (`500 Internal server
   error`); neither is transactional, so the transactions are already
   uncategorised when it fails. The recurring job's "category no longer exists"
   branch is therefore unreachable through the API. Suggested fix: null the
   rule's envelope too, in one transaction.
4. **Unknown `account_id` on income / recurring create is a 500, not a 404.**
   `createTransaction` (`:1201`) and `createRecurring`
   (`services/recurring.service.ts:180`) only look the account up for the
   envelope rule (expenses); other types hit the FK. Suggested fix: always look it up.
5. **A transfer from an account to itself is accepted.**
   `createTransfer` (`:1381`) has no `from !== to` check (bulk add has one). Both
   legs land in the same account and cancel out.
6. **`PATCH` with nothing to change is a 500.** `updateEnvelope` (`:889`) and
   `updateRecurring` call drizzle `.set({})` for `{}` (or only unknown keys),
   which throws "No values to set". `PATCH /accounts/:id` and
   `/transactions/:id` with `{}` succeed. Suggested fix: return the row unchanged.
7. **Non-string group `name` is a plain-text 500.** `routes/budget.ts:193,206`:
   `body.name.trim()` throws outside the `try`, so Hono's default handler answers
   `500 text/plain "Internal Server Error"`. Suggested fix: validate with zod.
8. **copy-previous / clear-budget read `month` from the body but say "query
   param".** `routes/budget.ts:107,121`. The regex test stringifies, so
   `["2026-05"]` works (better-sqlite3 spreads it) and `[["2026-05"]]` passes the
   check, then fails to bind (500). Rust reproduces both.
9. **Envelope trends `months` is used raw.** `services/budget.service.ts:1903`:
   `months=` is `Number("") = 0` → empty list; `abc` / negative → no limit;
   `2.5` → SQLite "datatype mismatch" 500. Suggested fix: `z.coerce.number().int().min(1)`.
10. **Listing a month before any budget seeds it from the latest month.**
   `seedMonthFromTemplate` (`:420`) copies the newest month whatever its
   position, so browsing 2026-02 creates February envelopes from July's budget
   (`envelopeForDate` only seeds forward; `listEnvelopes` does not check).
11. **A CSV with a UTF-8 BOM imports nothing.** `importCSV` (`:1522`) uses
   csv-parse's default `bom: false`, so the first header is `﻿date`,
   `row.date` is undefined and the insert fails with "NOT NULL constraint failed:
   transactions.date". The `format` query param is ignored. Suggested fix: `bom: true`.
12. **`reclaimed_inr` is in the base currency** (`:1000-1047`); the name predates
   multi-currency, like `balance_inr` / `budgeted_inr`.
13. **Transfer legs silently ignore `amount` / `payee` / `type` edits.**
   `updateTransaction` (`:1238`) applies only `date` / `notes` to a transfer leg
   and still answers 200.
14. **budget.service.ts has its own `getLatestRates`** (`:47-60`) with the same
   falsy-rate skip as Wave 0 quirk 3, and no base-currency entry.
15. **`POST /accounts` answers `balance: 0` for a seeded opening balance.**
   `createAccount` (`:286-309`) stores `balance: 0`, seeds a Starting Balance
   transaction and returns the stored row; the next list shows the real balance.
   Suggested fix: return the derived balance.
