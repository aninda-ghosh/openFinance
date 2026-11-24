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
