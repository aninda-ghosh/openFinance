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
