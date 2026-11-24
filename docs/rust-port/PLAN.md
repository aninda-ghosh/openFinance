# openFinance Rust backend port

Goal: replace the Node sidecar (`apps/server`, run as a bundled 116 MB Node binary)
with a Rust backend that runs **inside the Tauri process**. The React UI
(`apps/desktop/src`) is not rewritten. Existing encrypted databases, uploaded
documents, chat memories and backups must keep working without migration.

Branch: `feat/rust-port` (from `236622a`, which includes the Bulk Add work).

---

## 1. Target architecture

```
apps/desktop/src-tauri/                 Tauri app crate + Cargo workspace root
├── Cargo.toml                          [workspace] members = ["crates/*"]
├── src/lib.rs                          window, unlock, wipe; starts core in-process (Wave 4)
└── crates/openfinance-core/            all backend logic, no Tauri dependency
    ├── src/lib.rs                      module list (foundation-owned)
    ├── src/state.rs                    AppState: DB handle, data dir, settings cache
    ├── src/db/{mod.rs,bootstrap.rs}    SQLCipher open, PRAGMAs, schema/migrations, transactions
    ├── src/error.rs                    ApiError -> {"error": ...} + status code
    ├── src/{ids,crypto,paths,json}.rs  nanoid, OFE1/FWB1 AES-GCM, data dir, JSON helpers
    ├── src/http/mod.rs                 axum Router assembly, origin guard, CORS, /health
    ├── src/http/routes/<domain>.rs     one file per Node route file
    ├── src/services/<domain>.rs        one file per Node service file
    ├── src/ai/...                      Ollama client, tools, harness, memory
    ├── src/jobs.rs                     startup jobs + 15-min exchange-rate refresh
    ├── src/bin/openfinance-server.rs   standalone server (used by the parity harness)
    └── parity/                         differential test harness (see §3)
```

- HTTP stays: axum on `127.0.0.1:3001`, same paths, same JSON. The UI does not
  change until Wave 4, and then only `PasswordGate.tsx` if the unlock flow needs it.
- DB: `rusqlite` with SQLCipher support. One connection behind a mutex, used via
  `spawn_blocking`. Same PRAGMAs as Node: `cipher=sqlcipher`/`legacy=4`
  equivalent, `key`, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
  Transactions are serialised just like `runTransaction` in `apps/server/src/db/index.ts`.
- Background work: tokio tasks for startup jobs (recurring, document migration,
  exchange-rate refresh) and the 15-minute refresh.
- The Node server stays in the repo, unchanged, as the reference implementation
  until the port ships. Removing it (and the self-hosted JWT mode) is a separate,
  later decision.

## 2. Waves and ownership

Each agent works in its own git worktree on its own branch, created from
`feat/rust-port`. The lead reviews and merges each wave before starting the next.
Every file belongs to exactly one wave, which avoids merge conflicts.

| Wave | Agent | Ports (Node source → Rust files it owns) | Depends on |
|---|---|---|---|
| 0 | **foundation** | workspace + crate skeleton; `db/index.ts`, `db/bootstrap.ts`, `db/schema.ts` (as DDL/row types); `utils/crypto.ts`, `utils/paths.ts`; `services/settings.service.ts`, `services/exchange-rate.service.ts`, `routes/exchange-rates.ts`; `services/auth.service.ts` (key derivation; JWT routes only if the desktop build calls them); `index.ts` (middleware, `/health`, startup jobs); the parity harness; **empty stub files for every later-wave module** | — |
| 1 | **budget** | `services/budget.service.ts`, `recurring.service.ts`, `bulk.service.ts`, `routes/budget.ts` | 0 |
| 1 | **policies** | `services/policy.service.ts`, `life-insurance.service.ts`, `routes/policies.ts`, `routes/life-insurance.ts` | 0 |
| 1 | **data** | `services/document.service.ts`, `routes/documents.ts`, `routes/backup.ts`, `routes/reset.ts` | 0 |
| 2 | **investments** | `services/investment.service.ts`, `price.service.ts`, `routes/investments.ts` | 0, 1 (budget `list_accounts`) |
| 2 | **dashboard** | `services/dashboard.service.ts`, `routes/dashboard.ts` | 0, 1, investments `list_investments`* |
| 3 | **ai** | `ai/*`, `config/ai.config.ts`, `routes/ai.ts` | all |
| 4 | **integration** | Tauri `src/lib.rs`: open DB + start core in-process on unlock; wipe; quit; remove sidecar, `tauri-plugin-shell`, `externalBin`/`resources`, Node steps in `scripts/build-mac.sh`; full parity + manual smoke checklist | all |
| 5 | **touch-id** (optional) | Keychain + LocalAuthentication, option B (no Developer ID): opt-in after passcode unlock, Settings toggle, cleared on wipe/passcode change | 4 |

\* Wave 2 runs investments first and dashboard second, or both together if the
dashboard agent is given investments' merged `list_investments` first. The lead decides.

## 3. Parity harness (Wave 0 builds it, every later wave uses it)

The Node server defines the correct behaviour. A domain is done when the Rust
server returns the same responses as Node for every endpoint in that domain.

1. Create a temp dir. Start Node (`apps/server`, `tsx src/index.ts`) with
   `OPENFINANCE_DESKTOP=true`, a throwaway `OPENFINANCE_DB_KEY`, and `DB_PATH` in the temp dir.
2. Seed it by `POST /api/backup/import` with `sample-data.json`, then stop Node.
3. Copy the DB, uploads and chat memories into two identical dirs. Start Node on
   one port and the Rust `openfinance-server` on another.
4. Run each scenario file in `parity/scenarios/*.json`: ordered requests, each
   sent to both servers. Compare status codes and JSON bodies.
5. Normalisation lives in one file the foundation agent owns. It only:
   - maps generated ids to placeholders in creation order,
   - masks timestamps generated "now",
   - ignores object key order,
   - ignores zod's `details` payload on 400s (status and `error` must still match).

   Nothing else is masked.
6. Network: exchange-rate and price fetches are disabled in both servers via a
   test-only env flag (`OPENFINANCE_NO_NETWORK=1`). That flag is the only change
   allowed in `apps/server`.
7. Output: per-scenario pass/fail and a readable diff. Exit code ≠ 0 on any diff.

Scenarios must cover every endpoint in the domain: the normal path, not-found,
validation failures, and the mutations followed by reads that show their effect.

## 4. Strict rules for every agent

**Behaviour**
1. The Node server is the spec. Port its behaviour exactly, including quirks and
   apparent bugs. Don't fix them; add them to `docs/rust-port/QUIRKS.md`
   (file, line, behaviour, suggested fix) for a later decision.
2. Same paths, methods, status codes, JSON field names and types, error
   messages, ordering, and null-vs-missing fields. Booleans stored as integers
   come back as JSON `true`/`false`, as drizzle returns them.
3. Money and numbers are `f64`, with operations in the same order as the TS code so
   rounding matches. No decimal types, no "improvements".
4. Dates: replicate the JS semantics used (`new Date(...)`, `toISOString()`,
   local vs UTC, month overflow). Port `dates.test.ts`, `depreciation.test.ts`
   and similar tests as Rust unit tests.
5. SQL: keep the same query shape, filters, and `ORDER BY` (or the lack of one).
   No schema changes. The database must open in both Node and Rust interchangeably.

**Scope and safety**
6. Edit only the files your wave owns (§2), plus your scenario files and new
   `[dependencies]` lines in `crates/openfinance-core/Cargo.toml`. If you need a
   change to a shared module (`db`, `error`, `crypto`, `state`, `http/mod.rs`,
   the harness), stop and describe it in your report.
7. Never modify `apps/server`, `apps/desktop/src`, `packages/`, or the existing
   Node tests. Exceptions: the foundation's `OPENFINANCE_NO_NETWORK` flag, and Wave 4's unlock changes.
8. Never open, copy or touch the real user data in
   `~/Library/Application Support/com.anindaghosh.openfinance/`. Use temp dirs only.
9. Never log, print, or write passcodes, keys, or decrypted document contents.
10. No `unsafe`. No `unwrap`/`expect`/`panic!` on request paths: every failure
    maps to the same status/body Node would return.
11. No network calls Node doesn't make. No telemetry. Use well-known crates
    only (axum, tokio, rusqlite, serde, chrono, reqwest, aes-gcm, pbkdf2, sha2,
    nanoid, zip, tracing, …). List every new crate in your report.

**Done means**
12. All of these pass, and the output is pasted into your report:
    - `cargo fmt --check`
    - `cargo clippy --workspace --all-targets -- -D warnings`
    - `cargo test --workspace`
    - the parity harness with 0 diffs for your scenarios and all scenarios already merged
13. Never weaken a scenario, add masking, or skip an endpoint to get a pass.
    If something can't match, stop and report it with the exact diff.
14. Commit on your worktree branch with a conventional message ending in
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push,
    merge, rebase other branches, or touch `main`/`feat/bulk-add`.
15. Report: branch name, commits, endpoints ported (with a checklist against the Node
    route file), gate output, new crates, quirks recorded, and open questions.
    Also update `docs/rust-port/STATUS.md` (your section only).

## 5. Compatibility checkpoints (Wave 0 must prove these first)

- A database created and encrypted by the Node server opens in Rust with the
  same passcode. A wrong passcode fails cleanly (Node exits with code 13; Rust returns an error).
- A database written by Rust opens in Node.
- `OFE1` (documents, chat memory) and `FWB1` (backups) payloads produced by Node
  decrypt in Rust, and the reverse. The test fixtures are generated by running the Node code.

If any of these can't be met with `rusqlite`'s SQLCipher build, the foundation
agent stops and reports options (e.g. a SQLite3MultipleCiphers build) before
writing anything else.

## 6. Manual acceptance (after Wave 4, by the user)

On a copy of the real database:
1. Unlock, including with a wrong passcode.
2. Every page loads: accounts, transactions, Bulk Add, budget, investments, policies, life
   insurance, dashboard, net worth, reports, documents, AI chat.
3. Add, edit and delete a transaction, then check balances.
4. Export a backup, then import it.
5. Quit and check that no process is left running.
6. Check the `.dmg` size.
