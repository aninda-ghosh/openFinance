// Backup compatibility (Wave 1 data), run with the *real* Node modules
// (db/index.ts, db/bootstrap.ts, routes/backup.ts) through the server's tsx.
// Environment: SERVER_SRC, DB_PATH (fresh, in a temp dir), OPENFINANCE_DB_KEY,
// OPENFINANCE_DESKTOP=true, OPENFINANCE_NO_NETWORK=1, and per MODE:
//
//   MODE=gen     OUT, SAMPLE: imports sample-data.json plus extras (a document,
//                an orphaned investment, a policy without account) and writes
//                node-export.fwb1 (desktop, encrypted), node-export.zip (plain)
//                and node-export.content.json (the decoded content).
//                Run by tests/compat/regen-backup-fixtures.sh.
//   MODE=import  IN (a backup file), optional PASSWORD (x-backup-password),
//                RESULT: imports IN, exports again and writes
//                { status, body, content } to RESULT. Run by tests/compat_backup.rs.
import * as fs from "node:fs";
import * as path from "node:path";
import * as nodeCrypto from "node:crypto";

const server = process.env.SERVER_SRC;
if (!server) throw new Error("SERVER_SRC is required");
const PASS = process.env.OPENFINANCE_DB_KEY ?? "";

const { bootstrapSchema } = await import(path.join(server, "db/bootstrap.ts"));
await bootstrapSchema();
const { backupRouter } = await import(path.join(server, "routes/backup.ts"));
const { deriveBackupKey } = await import(path.join(server, "services/auth.service.ts"));
const { createRequire } = await import("node:module");
const require = createRequire(path.join(server, "../package.json"));
const AdmZip = require("adm-zip");

/** Decrypts (if FWB1) and unzips an export into comparable content. */
function decode(buf: Buffer) {
  let zip = buf;
  const encrypted = buf.subarray(0, 4).equals(Buffer.from("FWB1"));
  if (encrypted) {
    const key = Buffer.from(deriveBackupKey(PASS, "desktop"), "hex");
    const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, buf.subarray(4, 16));
    d.setAuthTag(buf.subarray(16, 32));
    zip = Buffer.concat([d.update(buf.subarray(32)), d.final()]);
  }
  const entries = new AdmZip(zip).getEntries().map((e: any) => {
    const data: Buffer = e.getData();
    if (e.entryName === "backup-data.json") {
      const text = data.toString("utf8");
      const json = JSON.parse(text);
      return { name: e.entryName, data: json.data, version: json.version, stringified: text === JSON.stringify(json, null, 2) };
    }
    return { name: e.entryName, base64: data.toString("base64") };
  });
  return { encrypted, entries };
}

async function exportNow(): Promise<Buffer> {
  const res = await backupRouter.request("/export");
  if (res.status !== 200) throw new Error(`export failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

if (process.env.MODE === "gen") {
  const OUT = process.env.OUT!;
  const sample = JSON.parse(fs.readFileSync(process.env.SAMPLE!, "utf8"));
  const d = sample.data;
  d.investments.push({ id: "inv-orphan", name: "Orphan ✓", asset_type: "etf", currency: "SGD", purchase_value: 91750.79000000001, purchase_date: "2022-02-28", current_value: 0.30000000000000004, units: 1e21, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  d.policies.push({ id: "pol-compat", name: "Compat policy", provider: "P", start_date: "2020-01-31", premium_amount: 1234.5, premium_frequency: "monthly", premium_term_years: 3, policy_term_years: 5, maturity_date: "2025-01-31", sum_assured: 1, maturity_value: 2, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" });
  d.investment_documents = [{ id: "doc-compat", investment_id: "inv-aapl", name: "Statement ✓ (Q1).pdf", file_name: "doc_compat000001.pdf", file_size: 24, mime_type: "application/pdf", notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }];
  const zip = new AdmZip();
  zip.addFile("backup-data.json", Buffer.from(JSON.stringify(sample), "utf8"));
  zip.addFile("documents/doc_compat000001.pdf", Buffer.from("%PDF-1.4 compat ✓ bytes\n", "utf8"));
  const imp = await backupRouter.request("/import", { method: "POST", body: zip.toBuffer() });
  if (imp.status !== 200) throw new Error(`seed import failed: ${imp.status} ${await imp.text()}`);

  const encrypted = await exportNow();
  process.env.OPENFINANCE_DESKTOP = "false"; // read per request: no desktop key fallback
  const plain = await exportNow();
  process.env.OPENFINANCE_DESKTOP = "true";
  fs.writeFileSync(path.join(OUT, "node-export.fwb1"), encrypted);
  fs.writeFileSync(path.join(OUT, "node-export.zip"), plain);
  const a = decode(encrypted);
  const b = decode(plain);
  if (!a.encrypted || b.encrypted) throw new Error("unexpected encryption state");
  if (JSON.stringify(a.entries) !== JSON.stringify(b.entries)) throw new Error("plain and encrypted exports differ");
  fs.writeFileSync(path.join(OUT, "node-export.content.json"), JSON.stringify(a.entries, null, 2) + "\n");
  console.log("backup fixtures written");
} else if (process.env.MODE === "import") {
  const body = fs.readFileSync(process.env.IN!);
  const headers: Record<string, string> = {};
  if (process.env.PASSWORD) headers["x-backup-password"] = process.env.PASSWORD;
  const res = await backupRouter.request("/import", { method: "POST", body, headers });
  const text = await res.text();
  const content = res.status === 200 ? decode(await exportNow()).entries : null;
  fs.writeFileSync(process.env.RESULT!, JSON.stringify({ status: res.status, body: JSON.parse(text), content }));
} else {
  throw new Error("MODE must be gen or import");
}
