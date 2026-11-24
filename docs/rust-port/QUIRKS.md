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

## Wave 1 — policies

Line numbers are for `apps/server/src` on `feat/rust-port` (`652ab74`).

1. **`createPolicy` never uses the base currency.** `services/policy.service.ts:224`
   reads `data.currency ?? baseCurrency`, but `CreatePolicySchema` gives
   `currency` a zod default of `"INR"`, so a policy created without a currency
   is always INR (and so is its account), whatever the base currency is.
   Suggested fix: drop the schema default, or drop the fallback.
2. **Updating a policy overwrites its account's balance with the premium
   schedule.** `services/policy.service.ts:262-273`: every PATCH (even `{}`)
   sets the linked account's `balance` to the scheduled premiums paid to date,
   but the response (`:164`) reports `balance + transaction deltas`, so
   transactions on the account are counted on top of the schedule. Suggested
   fix: keep the stored opening balance, or stop syncing it on every update.
3. **A policy can be linked to any account, which is then rewritten and
   deleted.** `UpdatePolicySchema.account_id` (`packages/shared/src/schemas/policy.schema.ts:39`)
   accepts any existing account id. The next update renames that account to the
   policy, sets its institution/currency/balance (`policy.service.ts:262-273`);
   deleting the policy deletes the account (`:337`). If the account has
   transactions the delete fails with a FOREIGN KEY error **after** the policy
   and its payouts are gone, so the request is a 500 but the policy is deleted.
   Suggested fix: reject `account_id` in updates (or only allow `policy`
   accounts), and run `deletePolicy` in a transaction.
4. **Payout update / mark-received change the row before checking the policy.**
   `services/policy.service.ts:367-375` and `:383-392`: the UPDATE runs by payout
   id alone; a payout of another policy is changed and then a 404
   "Payout not found" is returned. Suggested fix: add `policy_id` to the WHERE.
5. **`PATCH /:id/payouts/:payoutId` with `{}` is a 500.** `:387` `.set(data)` on
   an empty object throws drizzle's "No values to set". Suggested fix: return
   the payout unchanged (or 400).
6. **`POST /:id/payouts` on a missing policy is a 500** (foreign-key failure,
   `:358`) rather than a 404, and `GET /:id/payouts` on a missing policy is
   `200 {"payouts":[]}`. Suggested fix: check the policy first.
7. **`POST /:id/payouts/generate` does not validate its body.**
   `routes/policies.ts:66-80` only checks that the five fields are truthy, then
   passes the raw body on:
   - a non-string `start_date`/`end_date` (number, object) is a TypeError (500);
     an array `end_date` is compared as its `join(",")`;
   - `amount`/`label` are bound as-is by better-sqlite3: strings go into the REAL
     `amount` column as text, numbers into `label` as `"7.0"`, booleans/objects
     are a 500, and arrays are *spread* into the parameter list, so
     `amount: [], label: ["a","b"]` stores amount `"a"`, label `"b"`;
   - an unknown `frequency` steps 12 months; a `start_date` without a day gives
     `"2026-02-NaN"` dates; a short/long year (`"999-01-15"`) is compared as a
     string against `end_date`, which can generate up to 2400 rows.
   Suggested fix: validate with a zod schema (dates, positive amount, enum
   frequency, non-empty label).
8. **Timeline cutoff edge cases.** `services/policy.service.ts:410-429`:
   `?years=abc` (NaN) makes the cutoff an invalid Date; maturities and payouts
   are then dropped, but `localIsoDate(cutoff)` is `"NaN-NaN-NaN"` and every
   next premium is kept (`"2027-…" <= "NaN-…"`). `years` is truncated by
   `setFullYear` (1.5 → 1), and Feb 29 + whole years overflows to Mar 1.
   Maturity and payout dates go through `new Date(string)` (`:415`, `:443`):
   ISO dates are UTC midnight while non-ISO strings such as generated
   `"999-01-15"` are parsed by V8's legacy parser as *local* dates.
   Suggested fix: validate `years`; compare calendar strings throughout.
9. **Life insurance counts days in UTC, policies in local time.**
   Policies use the local calendar day (`localIsoDate`), but
   `life-insurance.service.ts:25-36` computes `days_to_renewal` from the *UTC*
   calendar day, so around midnight the two pages disagree by a day.
   Suggested fix: use `localIsoDate()` + `daysBetweenIso` there too.
10. **Text-valued stored numbers.** Not reachable through the validated API, but
    imported data could hold them: a non-numeric text `accounts.balance` is
    string-concatenated in `getAccountLiveBalance` (`"abc" + 0` → `"abc0"`,
    `policy.service.ts:140`), and a `currency` / `premium_frequency` naming an
    `Object.prototype` member (`"constructor"`) multiplies to NaN (`null` in JSON).
    Rust reproduces both.

Port notes (not Node bugs, but where Rust approximates JS):
- `new Date(string)` / `Date.parse` (`services/policy/dates.rs::parse_date`): the
  ES5 ISO grammar is exact (checked against V8 for ~1,300 inputs, including every
  string `addMonthsIso` produces from the odd inputs above). Of V8's legacy
  fallback only digit/`-`/whitespace forms are implemented; other non-ISO
  strings (month names, `/` dates, legacy times) give NaN in Rust. Only stored
  `maturity_date`/`payout_date` values from imported data could reach that path.
- Dates beyond chrono's range (about ±262,000 years) use the time-zone offset of
  the nearest representable instant.
- `localeCompare` on timeline dates is a UTF-16 code-unit comparison; ICU's root
  collation agrees for the digit/`-` strings involved.

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

## Wave 1 — data

Line numbers are for `apps/server/src` on `feat/rust-port`.

1. **A full reset deletes exchange rates, but the comment says it keeps them.**
   `routes/reset.ts:25` says "leaves exchange_rates … intact", but
   `routes/reset.ts:47` deletes them. Uploaded document files also stay on disk
   (only the rows are deleted). Suggested fix: decide which behaviour is
   intended, and delete `uploads/documents/*` along with the rows.
2. **`file_name` is trusted as a path.** `routes/documents.ts:71` and
   `services/document.service.ts:188` join the stored `file_name` to the
   uploads directory without checking it. A backup can set `../../anything`;
   download then serves that file (decrypted if it is OFE1) and delete unlinks
   it. `file_name: ""` points at the directory itself, so download and delete
   return 500. Suggested fix: reject any `file_name` that is not a plain base
   name, both on import and when reading.
3. **Upload writes the file before the insert can fail.**
   `services/document.service.ts:50`: the insert fails when `investment_id` is
   unknown, or when `name`/`notes` is sent as a file part (better-sqlite3 can't
   bind it). The response is then a 500 and the encrypted file is left orphaned.
   Suggested fix: write the file after the insert, or unlink it on error.
4. **A desktop backup can't be re-imported without the passcode header.**
   On desktop, export encrypts with `deriveBackupKey(passcode, "desktop")`
   (`routes/backup.ts:126`). Import first tries only `users.backup_key`
   (`:153-157`), then the `x-backup-password` header (`:165`). Desktop has no
   users row, so re-importing your own backup needs the passcode sent as a
   header. A passcode with characters above U+00FF can never be sent, because
   headers are ByteStrings. Suggested fix: also try the desktop-derived key in
   step 1.
5. **Import isn't atomic with its documents.** `routes/backup.ts:365-383`: the
   DB restore commits first, then the files are written. A write error returns
   500 "Import failed" after the data has already been replaced. Files from the
   previous data are never removed.
6. **The import pipeline does raw JS arithmetic on backup values.**
   `routes/backup.ts:264-282` has these problems:
   - `getFullYear() + pol.premium_term_years` concatenates when the term is a
     string ("2020" + "2" gives year 20202).
   - An unparseable `start_date` gives a count of 0 (the loop comparison with
     an Invalid Date is false).
   - `premium_amount * count` is stored whatever the result is.

   Odd values are then bound the way better-sqlite3 binds them:
   - Numbers in TEXT columns are stored as text like `"5.0"`.
   - Arrays spread into the parameter list. An empty or two-element array
     shifts every later column, or fails the placeholder count.
   - Booleans, and a second object, throw (500).

   Suggested fix: validate the backup with the shared zod schemas.
7. **Bad uploads to import return 500 instead of 400.** `routes/backup.ts:393`:
   a truncated or non-ZIP upload, or invalid JSON in `backup-data.json`,
   returns 500 "Import failed". Suggested fix: return 400.

## Wave 2 — investments

Line numbers are for `apps/server/src` on `feat/rust-port` (`1ef3ebc`). Each
item is exercised by an `investments*` parity scenario unless noted.

1. **"Refresh price" never fetches a price.** `services/price.service.ts:27-41`:
   `fetchCurrentPrice` returns the stored `current_value` with
   `source_url: "manual://stored-value"`; the mfapi.in and Stooq lookups
   (`_fetchMutualFundNAV` `:47`, `_fetchYahooFinancePrice` `:93`,
   `fetchStooqQuote`) are dead code. So refresh works offline, and every call
   still appends a `price_history` row and a `price_refresh` value-history row
   whose `previous_value` equals `new_value` (`services/investment.service.ts:321-334`).
   Suggested fix: either wire the lookups back in or drop the endpoint.
   Rust: `services/price.rs` ports the dead lookups too (unit-tested parsing),
   unused like in Node.
2. **Refresh stores a timestamp in `current_value_at`.**
   `services/investment.service.ts:342`: `current_value_at` (a `YYYY-MM-DD`
   quote date everywhere else) gets `fetched_at`, a full ISO timestamp.
   Harmless for market assets (only physical assets read it, and they can't be
   refreshed). Suggested fix: store `fetched_at.slice(0, 10)`.
3. **Refresh errors other than 404 become 500s.** `routes/investments.ts:16-21`
   (`handleError` passes only 404 through): a physical asset (service 400
   "Physical assets have no market price to refresh.", `:298-302`) and a zero
   price (service 422, `:311-318`) both answer `500 {"error":"Internal server
   error"}`. Suggested fix: pass 400 and 422 through.
4. **Deleting an investment leaves its document files on disk.**
   `services/investment.service.ts:268-279`: `investment_documents` rows go via
   `ON DELETE CASCADE`, but the encrypted files in `uploads/documents` stay
   (visible in the next backup export). Not transactional either. Suggested
   fix: delete the documents through `deleteDocument` first, in one transaction.
5. **A vehicle linked to an account still counts against that account's cash.**
   `getPortfolioSummary` (`services/investment.service.ts:495-507`) skips
   physical assets in the holdings buckets but subtracts *every* linked
   holding, vehicles included, from an off-budget account's balance to get its
   cash. Creating/updating a vehicle drops the link, but a backup import links
   orphaned investments, vehicles included, to a generated
   `brokerage-<cur>-imported` account (`routes/backup.ts:235-257`); the
   bootstrap migration that unlinks vehicles (`db/bootstrap.ts:317`) only runs
   at the next start. Suggested fix: filter physical assets out of `accInvs`
   too, and skip them in the import's orphan step.
6. **Literal path segments are also ids.** Hono tries routes in registration
   order, so `GET /documents/documents` lists the documents of investment
   "documents" (not document "documents"), `POST /documents/refresh-price`
   refreshes investment "documents", `PATCH|DELETE /portfolio-summary` is a 404
   "Investment not found", and `PATCH /:id/value-history/bulk-contributions` is
   a 404 "History entry not found". Rust reproduces the order (`http/routes/investments.rs::dispatch`).
7. **`PATCH` re-dating a vehicle silently moves its value.**
   `services/investment.service.ts:204-225`: `{ current_value_at }` alone
   re-anchors the depreciation curve without a history row, and with a rate
   change it is overwritten by today (`columns.current_value_at = todayIso()`).
   Suggested fix: treat a new anchor date as a new quote, or reject it without
   `current_value`.

Not reproduced (only reachable with a hand-made backup): non-numeric text in a
REAL column (Node would concatenate strings in `purchase_value + contributions`),
and investment ids / asset types / currencies named like `Object.prototype`
members (`toString`, `__proto__`, …) as keys of `contributions` /
`byAssetType` (Node would read the inherited function). Rust's currency lookup
does reproduce the NaN for those keys (it reuses `policy::rate_for`).
