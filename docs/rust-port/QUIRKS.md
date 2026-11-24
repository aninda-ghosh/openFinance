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
