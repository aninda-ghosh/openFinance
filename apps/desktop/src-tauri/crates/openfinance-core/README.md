# openfinance-core

The openFinance backend: the HTTP API, the SQLCipher database, document and
chat-memory encryption, backups, and the Ollama chat. The desktop app
(`apps/desktop/src-tauri/src/backend.rs`) opens the database with the user's
passcode and serves this crate's router on `127.0.0.1:3001` inside the app
process; the React UI talks to it over HTTP.

The crate is a port of the former Node server (Hono + Drizzle + better-sqlite3,
`apps/server` up to `main` / `1502e08`). It keeps that server's API, status
codes, response bodies, database schema and file formats exactly, including the
known bugs listed in [`docs/rust-port/QUIRKS.md`](../../../../../docs/rust-port/QUIRKS.md).
Comments that name `apps/server/...` files refer to that commit.

## Layout

```
src/
├── lib.rs        serve(): startup jobs, background jobs, router
├── state.rs      AppState (the one DB connection, config, file crypto, AI settings) and Config
├── db/           opening the encrypted DB (PRAGMAs, run_transaction) and the schema bootstrap
├── http/         router, CORS, origin guard, request logging, 404s
│   └── routes/   one module per API prefix (/api/budget, /api/investments, …)
├── services/     business logic, one module per domain (budget, investment, policy, dashboard, …)
├── ai/           Ollama client, chat harness, tools, prompts, chat memories, SSE
├── crypto.rs     OFE1 file / string encryption, FWB1 backups, backup key derivation
├── jobs.rs       startup jobs and the 15-minute background refresh
├── paths.rs      DB_PATH / DATA_DIR resolution
├── error.rs      ApiError / ApiResult
└── ids.rs, js.rs, json.rs   nanoid, JS semantics (Date, Number, JSON) the API relies on
tests/
├── compat.rs, compat_backup.rs, compat_ai.rs   compatibility tests (see below)
└── compat/fixtures/                             data written by the Node server
```

The app's lifecycle (unlock, wipe, quit) is in `apps/desktop/src-tauri/src/`
(`lib.rs`, `backend.rs`) and is tested by `apps/desktop/src-tauri/tests/lifecycle.rs`.

## Running the checks

Run cargo from `apps/desktop/src-tauri` (the Cargo workspace):

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo test -p openfinance-core` runs only this crate: unit tests (next to the
code, mostly on an in-memory database) plus the integration tests in `tests/`.
Nothing needs Node, network access or a running Ollama.

**Compatibility tests.** `tests/compat/fixtures` holds files produced by the real
Node server: an encrypted database, OFE1 / legacy-layout documents, an OFE1
string, an FWB1 payload, encrypted and plain backup exports, and a chat-memory
file. The tests prove that the Rust backend still opens, decrypts and imports
data written by older app versions, and that what Rust writes reads back the
same way. These fixtures can't be regenerated any more; don't edit them. If a
format ever changes on purpose, add a new fixture next to the old ones and keep
the old tests passing.

## How to work in this crate

**State and DB.** Handlers take `State(state): State<AppState>`.
- `state.db(|conn| { ... Ok(value) }).await` runs a closure with the single
  `rusqlite::Connection` on the blocking pool (autocommit). The closure must be
  `Send + 'static`, so move owned inputs in.
- `state.transaction(|conn| ...).await` is BEGIN/COMMIT, with ROLLBACK on `Err`.
  Calls are serialised. Inside a closure, call `db::run_transaction(conn, |conn| ...)`
  to get the same semantics; when a transaction is already open it joins it.
- Write services as plain functions taking `&Connection`. They are easy to
  compose in one transaction and to unit-test on `Connection::open_in_memory()`
  + `db::bootstrap::bootstrap_schema`. Only code that awaits network I/O takes `&AppState`.
- Never hold the connection across an `.await`; split DB work and network work
  like `services/exchange_rate.rs::refresh_from_web`.
- `state.config()` holds the configuration (`desktop`, `data_dir`, `no_network`, …);
  `state.file_crypto()` is the file encryption key + the desktop flag for OFE1;
  `state.http()` is the shared `reqwest` client. `config().no_network` is for
  tests: outbound fetches then fail like a network error, before any I/O.

**IDs, time, JSON.** `ids::nanoid()` (npm alphabet/length), `js::now_iso()`
(`new Date().toISOString()`), `crypto::js_trim` (JS `String.prototype.trim`). `json::from_sql(row.get_ref(i)?)`
turns a column into the JSON value the API returns (INTEGER/REAL → number,
TEXT → string). Booleans stored as integers must be converted to `true/false`
explicitly where the API returns booleans.
`json::parse_body` / `json::body_or_empty_object` parse request bodies like the
Node server did (`c.req.json()` and `.catch(() => ({}))`); take the body as
`axum::body::Bytes`, not `Json<T>`, so parse failures produce the API's own
status/body rather than axum's rejection.
`serde_json` has `preserve_order`, so `json!`/`Map` keep insertion order like JS.

**Errors.** Return `ApiResult<T>`. In services: `ApiError::service(404, "Account not found")`
for an error with a status, `ApiError::plain(msg)` for a bare error, and `?` on
`rusqlite::Error` (→ 500). In routes, mirror the route's error handling with
`.map_err(|e| e.handled(&[404]))`: listed statuses pass through with their
message, everything else becomes a logged `500 {"error":"Internal server error"}`.
Use `ApiError::validation(details)` for `{"error":"Validation failed","details":…}`,
`ApiError::bad_request`, `ApiError::not_found`, or `ApiError::body(status, json)`
for any other shape. No `unwrap`/`expect`/`panic!` on request paths.

**Adding routes.** Edit `http/routes/<domain>.rs` (its `router()` is mounted at
the API prefix) and `services/<domain>.rs`. Paths inside `router()` are
relative: `.route("/accounts/{id}", get(...))` (axum 0.8 uses `{id}`). Unknown
paths and wrong methods already return `404 text/plain "404 Not Found"`; a
trailing slash is a 404. Routing happens on the decoded path (Hono's
`getPath`); handlers that need raw parameters read `OriginalUri`. CORS, the
origin guard, logging and the unlimited body size are applied globally.

**Tests.** Put unit tests next to the code (`#[cfg(test)] mod tests`). Route
tests build `http::router(state)` over an in-memory or temp-dir database and
call it with `tower::ServiceExt::oneshot`; see `http/mod.rs` and
`tests/compat_backup.rs` for examples.
