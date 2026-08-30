import fs from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
// "better-sqlite3" is an npm alias for better-sqlite3-multiple-ciphers (see
// package.json) — the SQLCipher-capable fork. Installing it under the canonical
// name is what lets drizzle-orm/better-sqlite3 pick up the encrypted build.
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

// ─── Database file ────────────────────────────────────────────────────────────
// Desktop (Tauri): DB_PATH is set by the Rust host to
//   ~/Library/Application Support/com.anindaghosh.openfinance/openfinance.db
// Anything else: falls back to ./openfinance.db in the working directory.
const DB_PATH = process.env.DB_PATH ?? path.resolve("openfinance.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);

// ─── Encryption at rest ───────────────────────────────────────────────────────
// OPENFINANCE_DB_KEY is the user's passcode, handed to us by the Tauri host.
// PRAGMA key must be the first statement executed on the connection.
const DB_KEY = process.env.OPENFINANCE_DB_KEY;
if (DB_KEY && DB_KEY.trim() !== "") {
  sqlite.pragma(`cipher = 'sqlcipher'`);
  sqlite.pragma(`legacy = 4`);
  sqlite.pragma(`key = '${DB_KEY.replace(/'/g, "''")}'`);

  // Touching the schema is what actually decrypts page 1. A wrong passcode
  // surfaces here as SQLITE_NOTADB — fail loudly so the desktop unlock screen
  // reports "wrong password" instead of hanging on a half-open database.
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    console.error(
      "[db] Could not open the database with the supplied passcode:",
      (err as Error).message
    );
    process.exit(13);
  }
}

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });

export function getDb() {
  return db;
}

/** The raw better-sqlite3 handle — used by the backup/restore routes. */
export function getSqlite(): SqliteDatabase {
  return sqlite;
}

// ─── postgres-js-compatible tagged template ───────────────────────────────────
// The startup bootstrap writes DDL as await sql`…`. Keeping the same shape here
// means those call sites read identically to the Postgres build.

type SqlRow = Record<string, unknown>;

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  /** Runs a statement built at runtime (no interpolation of user input). */
  unsafe(query: string, params?: unknown[]): Promise<SqlRow[]>;
};

function normalise(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function execute(query: string, params: unknown[]): SqlRow[] {
  const stmt = sqlite.prepare(query);
  const bound = params.map(normalise);
  // `reader` is true for statements that return rows (SELECT, RETURNING, …).
  if (stmt.reader) return stmt.all(...bound) as SqlRow[];
  stmt.run(...bound);
  return [];
}

function run(query: string, params: unknown[]): Promise<SqlRow[]> {
  try {
    return Promise.resolve(execute(query, params));
  } catch (err) {
    return Promise.reject(err);
  }
}

const sqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
  run(strings.join("?"), values)) as SqlTag;

sqlTag.unsafe = (query: string, params: unknown[] = []) => run(query, params);

/** Raw SQL template tag — used by the startup schema migrations. */
export function getSql(): SqlTag {
  return sqlTag;
}

// ─── Transactions ─────────────────────────────────────────────────────────────
// better-sqlite3 is synchronous and single-connection, so an async callback
// cannot be handed to its own db.transaction(). We drive BEGIN/COMMIT by hand
// and serialise callers through a promise queue, so two concurrent requests can
// never interleave their statements inside one another's transaction.

let queue: Promise<unknown> = Promise.resolve();
let depth = 0;

/** Runs `cb` inside a database transaction; rolls back when it throws. */
// The callback receives the drizzle handle, whose fully-inferred type is
// unnameable here; every call site in the services has always taken it as `any`.
export async function runTransaction<T>(
  // biome-ignore lint/suspicious/noExplicitAny: see note above
  cb: (tx: any) => Promise<T>
): Promise<T> {
  // Already inside a transaction (a service helper calling another): join the
  // open one rather than deadlocking on the queue or nesting a second BEGIN.
  if (depth > 0) {
    return cb(db);
  }

  const run = async (): Promise<T> => {
    depth++;
    sqlite.exec("BEGIN");
    try {
      const result = await cb(db);
      sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite (e.g. a constraint abort).
      }
      throw err;
    } finally {
      depth--;
    }
  };

  const result = queue.then(run, run);
  // Keep the chain alive even when this transaction rejects.
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export type DB = typeof db;
