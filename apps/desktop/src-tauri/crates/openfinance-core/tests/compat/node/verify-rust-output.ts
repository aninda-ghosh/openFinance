// Verifies that what Rust wrote can be read by the real Node modules:
//   - $DB_PATH: an encrypted DB created and bootstrapped by Rust (opened via db/index.ts)
//   - $IN/doc.ofe1, $IN/memory.ofe1.b64, $IN/backup.fwb1: Rust-encrypted payloads
// Exits non-zero on any mismatch. Run it through tests/compat/roundtrip.sh.
import * as fs from "node:fs";
import * as path from "node:path";

const IN = process.env.IN;
if (!IN) throw new Error("IN is required");
const PASS = process.env.OPENFINANCE_DB_KEY ?? "";
const server = process.env.SERVER_SRC;
if (!server) throw new Error("SERVER_SRC is required");

// db/index.ts exits with code 13 itself if the key does not open the file.
const { getSqlite } = await import(path.join(server, "db/index.ts"));
const crypto = await import(path.join(server, "utils/crypto.ts"));
const { deriveBackupKey } = await import(path.join(server, "services/auth.service.ts"));

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const sqlite = getSqlite();
const row = sqlite.prepare("SELECT name, balance FROM accounts WHERE id = 'rust-acc'").get() as
  | { name: string; balance: number }
  | undefined;
check(
  "node opens rust-written encrypted db",
  row?.name === "Written by Rust ✓" && row?.balance === 98.76
);
const tables = sqlite
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
  .get() as { n: number };
check(`rust bootstrap created 19 tables (got ${tables.n})`, tables.n === 19);
sqlite.close();

const doc = fs.readFileSync(path.join(IN, "doc.plain"));
check(
  "node decrypts rust OFE1",
  crypto.decryptBuffer(fs.readFileSync(path.join(IN, "doc.ofe1")), PASS).equals(doc)
);
const memo = fs.readFileSync(path.join(IN, "memory.plain"), "utf8");
check(
  "node decrypts rust OFE1 string",
  crypto.decryptString(fs.readFileSync(path.join(IN, "memory.ofe1.b64"), "utf8"), PASS) === memo
);
const backup = fs.readFileSync(path.join(IN, "backup.plain"));
const dec = crypto.decryptBackup(
  fs.readFileSync(path.join(IN, "backup.fwb1")),
  deriveBackupKey(PASS, "desktop")
);
check("node decrypts rust FWB1", dec !== null && dec.equals(backup));

if (failures > 0) process.exit(1);
