import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const user = process.env.POSTGRES_USER ?? "openfinance";
const password = process.env.POSTGRES_PASSWORD ?? "openfinance";
const dbName = process.env.POSTGRES_DB ?? "openfinance";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://${user}:${password}@localhost:5432/${dbName}`;

const pgClient = postgres(DATABASE_URL);
const db: PostgresJsDatabase<typeof schema> = drizzle(pgClient, { schema });

export function getDb() {
  return db;
}

/** Raw postgres-js template tag — used by the startup schema migrations. */
export function getSql() {
  return pgClient;
}

/** Runs `cb` inside a database transaction; rolls back when it throws. */
export async function runTransaction<T>(
  cb: (tx: any) => Promise<T>
): Promise<T> {
  return (await db.transaction(cb)) as T;
}

export type DB = typeof db;
