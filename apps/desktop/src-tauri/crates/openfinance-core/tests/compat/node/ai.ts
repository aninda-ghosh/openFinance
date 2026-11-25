// AI compatibility (Wave 3 ai), run with the *real* Node modules
// (ai/chat-memory.ts, ai/context.builder.ts, routes/backup.ts) through the
// server's tsx. Environment: SERVER_SRC, DB_PATH (in a temp dir; DATA_DIR is
// its directory), OPENFINANCE_DB_KEY, OPENFINANCE_DESKTOP=true,
// OPENFINANCE_NO_NETWORK=1, RESULT, and per MODE:
//
//   MODE=memory-write  appends two exchanges to conversation CONV, then
//                      writes { memory: readMemory(CONV) } to RESULT.
//   MODE=memory-read   writes { memory: readMemory(CONV) } to RESULT.
//   MODE=context       imports SAMPLE (sample-data.json) through the backup
//                      route, then writes { "<currency>": buildSystemContext(currency) }
//                      for each currency in CURRENCIES (comma separated).
//
// Memory contents are written only to RESULT inside the test's temp dir.
import * as fs from "node:fs";
import * as path from "node:path";

const server = process.env.SERVER_SRC;
if (!server) throw new Error("SERVER_SRC is required");
const RESULT = process.env.RESULT!;

const { bootstrapSchema } = await import(path.join(server, "db/bootstrap.ts"));
await bootstrapSchema();

const mode = process.env.MODE;
if (mode === "memory-write" || mode === "memory-read") {
  const memory = await import(path.join(server, "ai/chat-memory.ts"));
  const conv = process.env.CONV!;
  if (mode === "memory-write") {
    await memory.appendExchange(conv, "  How much did I spend on groceries? ✓ ", "\n₹12,000 — about 8% of income.\n\nDetails:\n- A\n- B  ");
    await memory.appendExchange(conv, "second", "answer 2");
  }
  fs.writeFileSync(RESULT, JSON.stringify({ memory: await memory.readMemory(conv) }));
} else if (mode === "context") {
  const { backupRouter } = await import(path.join(server, "routes/backup.ts"));
  const { createRequire } = await import("node:module");
  const require = createRequire(path.join(server, "../package.json"));
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  zip.addFile("backup-data.json", fs.readFileSync(process.env.SAMPLE!));
  const imp = await backupRouter.request("/import", { method: "POST", body: zip.toBuffer() });
  if (imp.status !== 200) throw new Error(`seed import failed: ${imp.status} ${await imp.text()}`);
  const { buildSystemContext } = await import(path.join(server, "ai/context.builder.ts"));
  const out: Record<string, unknown> = {};
  for (const cur of process.env.CURRENCIES!.split(",")) {
    try {
      out[cur] = await buildSystemContext(cur);
    } catch (e) {
      out[cur] = { error: String(e) };
    }
  }
  fs.writeFileSync(RESULT, JSON.stringify(out));
} else {
  throw new Error(`unknown MODE ${mode}`);
}
process.exit(0);
