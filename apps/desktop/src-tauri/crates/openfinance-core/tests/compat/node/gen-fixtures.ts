// Generates the Node-side compatibility fixtures that the Rust tests in
// tests/compat.rs check. Runs the *real* server modules (db/index.ts,
// db/bootstrap.ts, utils/crypto.ts, services/auth.service.ts).
//
// Run it through tests/compat/regen-fixtures.sh, which sets the environment
// (OUT, DB_PATH, OPENFINANCE_DB_KEY, OPENFINANCE_DESKTOP) and uses the server's tsx.
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = process.env.OUT;
if (!OUT) throw new Error("OUT is required");
const PASS = process.env.OPENFINANCE_DB_KEY ?? "";

const server = process.env.SERVER_SRC;
if (!server) throw new Error("SERVER_SRC is required");
const { getSqlite } = await import(path.join(server, "db/index.ts"));
const { bootstrapSchema } = await import(path.join(server, "db/bootstrap.ts"));
const crypto = await import(path.join(server, "utils/crypto.ts"));
const { deriveBackupKey } = await import(path.join(server, "services/auth.service.ts"));

// ── Encrypted database written by Node ───────────────────────────────────────
await bootstrapSchema();
const sqlite = getSqlite();
sqlite
  .prepare(
    "INSERT INTO accounts (id, name, type, currency, balance, is_active, off_budget, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  .run(
    "node-acc",
    "Written by Node ✓",
    "checking",
    "USD",
    1234.5,
    1,
    0,
    "2026-01-02T03:04:05.006Z",
    "2026-01-02T03:04:05.006Z"
  );
sqlite.close(); // checkpoints the WAL into the main file

// ── OFE1 / legacy / FWB1 payloads ────────────────────────────────────────────
const doc = Buffer.from("openFinance document fixture — ✓ ünïcödé\n".repeat(3), "utf8");
fs.writeFileSync(path.join(OUT, "doc.plain"), doc);
const ofe1 = crypto.encryptBuffer(doc, PASS);
fs.writeFileSync(path.join(OUT, "doc.ofe1"), ofe1);
// Legacy desktop format: the same layout without the 4-byte magic.
fs.writeFileSync(path.join(OUT, "doc.legacy"), ofe1.subarray(4));

const memo = "chat memory: the user likes index funds ✓";
fs.writeFileSync(path.join(OUT, "memory.plain"), memo);
fs.writeFileSync(path.join(OUT, "memory.ofe1.b64"), crypto.encryptString(memo, PASS));

const backupKey = deriveBackupKey(PASS, "desktop");
fs.writeFileSync(path.join(OUT, "backup_key.desktop.hex"), backupKey);
const zipish = Buffer.from("PK\u0003\u0004 not really a zip, just bytes for FWB1", "utf8");
fs.writeFileSync(path.join(OUT, "backup.plain"), zipish);
fs.writeFileSync(path.join(OUT, "backup.fwb1"), crypto.encryptBackup(zipish, backupKey));

console.log("fixtures written");
