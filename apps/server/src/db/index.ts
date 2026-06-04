/* eslint-disable @typescript-eslint/no-explicit-any */
import { drizzle as pgDrizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import postgres from "postgres";
import Database from "better-sqlite3-multiple-ciphers";
import * as fs from "fs";
import * as schema from "./schema";

const isSqlite =
  process.env.DB_DIALECT === "sqlite" ||
  !process.env.DATABASE_URL ||
  process.env.FINWISE_DESKTOP === "true";

let db: PostgresJsDatabase<typeof schema>;
let pgClient: any;
let sqliteClient: any;

if (isSqlite) {
  const dbPath = process.env.DB_PATH ?? "./finwise.db";
  sqliteClient = new Database(dbPath);

  // Apply encryption key if provided (e.g. from Tauri spawn_server env)
  const dbKey = process.env.FINWISE_DB_KEY;
  if (dbKey && dbKey.trim() !== "") {
    const escapedKey = dbKey.replace(/'/g, "''");
    sqliteClient.pragma(`key = '${escapedKey}'`);

    // Verify passcode if the database file is not empty (already has schema)
    if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      try {
        sqliteClient.prepare("SELECT count(*) FROM sqlite_schema").all();
      } catch (err) {
        console.error("CRITICAL ERROR: SQLCipher decryption failed. The passcode is incorrect.");
        process.exit(1); // Exit immediately with failure status code
      }
    }
  }

  db = sqliteDrizzle(sqliteClient, { schema }) as any;
} else {
  const user = process.env.POSTGRES_USER ?? "finwise";
  const password = process.env.POSTGRES_PASSWORD ?? "finwise";
  const dbName = process.env.POSTGRES_DB ?? "finwise";
  const DATABASE_URL =
    process.env.DATABASE_URL ??
    `postgres://${user}:${password}@localhost:5432/${dbName}`;

  pgClient = postgres(DATABASE_URL);
  db = pgDrizzle(pgClient, { schema });
}

export function getDb() {
  return db;
}

export function isSqliteDb() {
  return isSqlite;
}

function cleanQueryForSqlite(query: string): string | null {
  const trimmed = query.trim();

  // Skip PL/pgSQL blocks
  if (trimmed.includes("DO $$")) {
    return null;
  }

  // Skip postgres-specific alter column commands
  if (trimmed.includes("ALTER COLUMN")) {
    return null;
  }

  // Check if it's an ALTER TABLE ADD COLUMN query
  const alterMatch = trimmed.match(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(.+)/i
  );
  if (alterMatch) {
    const tableName = alterMatch[1];
    const columnName = alterMatch[2];
    const columnDef = alterMatch[3];

    // Check if column already exists in SQLite table
    try {
      const columns = sqliteClient
        .prepare(`PRAGMA table_info(${tableName})`)
        .all();
      const exists = columns.some((col: any) => col.name === columnName);
      if (exists) {
        return null; // Column already exists, so skip the alter command
      }
    } catch (e) {
      console.warn(
        `[sqlite-migration] Failed checking table info for ${tableName}:`,
        e
      );
    }

    return `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`;
  }

  // Replace DOUBLE PRECISION with REAL for SQLite
  let cleaned = trimmed.replace(/DOUBLE\s+PRECISION/gi, "REAL");

  return cleaned;
}

// Custom template tag to execute raw queries on SQLite with a similar API to postgres-js
function sqliteSql(strings: TemplateStringsArray, ...values: any[]) {
  return new Promise<any>((resolve, reject) => {
    try {
      const query = strings.join("?");
      const cleanedQuery = cleanQueryForSqlite(query);
      if (cleanedQuery === null) {
        resolve([]);
        return;
      }

      const stmt = sqliteClient.prepare(cleanedQuery);
      if (cleanedQuery.trim().toLowerCase().startsWith("select")) {
        const rows = stmt.all(...values);
        resolve(rows);
      } else {
        const info = stmt.run(...values);
        resolve(info);
      }
    } catch (err) {
      // For SQLite migrations, resolve instead of reject to avoid crashing server on startup.
      // SQLite doesn't support some PG-specific schema queries, which can be safely ignored.
      resolve([]);
    }
  });
}

export function getSql() {
  if (isSqlite) {
    return sqliteSql as any;
  }
  return pgClient;
}

export type DB = typeof db;
