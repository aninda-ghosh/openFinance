#!/usr/bin/env node
// Parity harness (PLAN.md §3): runs every scenario against the Node server
// (the spec) and the Rust `openfinance-server`, and diffs the responses.
//
//   node apps/desktop/src-tauri/crates/openfinance-core/parity/run.mjs [options] [name ...]
//
//   name ...     only run scenarios whose file name contains one of these
//   --no-build   skip `cargo build` of openfinance-server
//   --keep       keep the temp dir (DBs and server logs) for inspection
//   --verbose    print every step, not only failures
//
// Works from any git worktree: if apps/server or packages/shared has no
// node_modules, they are symlinked from the main checkout (git common dir).
// Exit code: 0 when every scenario matches, 1 on any diff or error.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, createNormaliser } from "./normalise.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRATE = path.resolve(HERE, "..");
const WORKSPACE = path.resolve(CRATE, "../..");
const REPO = path.resolve(WORKSPACE, "../../..");
const SERVER = path.join(REPO, "apps/server");
const SAMPLE = path.join(REPO, "sample-data.json");
const SCENARIOS = path.join(HERE, "scenarios");

// Throwaway passcode for the temp databases (contains a quote on purpose).
const DB_KEY = "parity'pass ✓";
// Nothing listens on the discard port: Ollama looks "not running" to both servers.
const OLLAMA_URL = "http://127.0.0.1:9";
// Compared response headers (lower-case). Everything else is transport detail.
const COMPARED_HEADERS = [
  "content-type",
  "content-disposition",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "vary",
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const filters = args.filter((a) => !a.startsWith("--"));
const VERBOSE = flags.has("--verbose");

// ── Setup helpers ────────────────────────────────────────────────────────────

function ensureNodeModules() {
  const needed = ["apps/server/node_modules", "packages/shared/node_modules"];
  const missing = needed.filter((p) => !fs.existsSync(path.join(REPO, p)));
  if (missing.length === 0) return;
  const common = execFileSync(
    "git",
    ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" }
  ).trim();
  const main = path.dirname(common);
  for (const p of missing) {
    const src = path.join(main, p);
    if (main === REPO || !fs.existsSync(src)) {
      throw new Error(`${p} is missing; run \`pnpm install\` in ${REPO}`);
    }
    fs.symlinkSync(src, path.join(REPO, p));
    console.log(`linked ${p} -> ${src}`);
  }
}

function buildRust() {
  if (!flags.has("--no-build")) {
    console.log("building openfinance-server…");
    execFileSync("cargo", ["build", "-q", "-p", "openfinance-core", "--bin", "openfinance-server"], {
      cwd: WORKSPACE,
      stdio: "inherit",
    });
  }
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(WORKSPACE, process.env.CARGO_TARGET_DIR)
    : path.join(WORKSPACE, "target");
  const bin = path.join(target, "debug", "openfinance-server");
  if (!fs.existsSync(bin)) throw new Error(`missing ${bin}`);
  return bin;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function serverEnv(dir, port) {
  const env = { ...process.env };
  for (const k of ["ENCRYPTION_KEY", "JWT_SECRET", "HOST", "OLLAMA_MODEL", "NODE_ENV"]) delete env[k];
  return {
    ...env,
    DB_PATH: path.join(dir, "openfinance.db"),
    OPENFINANCE_DB_KEY: DB_KEY,
    OPENFINANCE_DESKTOP: "true",
    OPENFINANCE_NO_NETWORK: "1",
    OLLAMA_URL,
    PORT: String(port),
  };
}

/** Starts a server process; resolves once GET /health answers. */
async function startServer(kind, dir, bin) {
  const port = await freePort();
  const log = fs.openSync(path.join(dir, `${kind}.log`), "a");
  const [cmd, argv, cwd] =
    kind === "node"
      ? [path.join(SERVER, "node_modules/.bin/tsx"), ["src/index.ts"], SERVER]
      : [bin, [], dir];
  const child = spawn(cmd, argv, {
    cwd,
    env: serverEnv(dir, port),
    stdio: ["ignore", log, log],
    detached: true,
  });
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { kind, base, child, dir };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  const tail = fs.readFileSync(path.join(dir, `${kind}.log`), "utf8").split("\n").slice(-20).join("\n");
  throw new Error(`${kind} server did not start (${JSON.stringify(exited)}):\n${tail}`);
}

async function stopServer(server) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000);
  await done;
  clearTimeout(timer);
}

/** Seeds a fresh Node database from sample-data.json via POST /api/backup/import. */
async function seed(dir) {
  const require = createRequire(path.join(SERVER, "package.json"));
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  zip.addFile("backup-data.json", fs.readFileSync(SAMPLE));
  let node = await startServer("node", dir);
  const res = await fetch(`${node.base}/api/backup/import`, { method: "POST", body: zip.toBuffer() });
  const text = await res.text();
  await stopServer(node);
  if (res.status !== 200) throw new Error(`seed import failed: ${res.status} ${text}`);
  // Restart once so startup jobs (due recurring transactions) settle into the
  // seed instead of running differently in each server under test.
  node = await startServer("node", dir);
  await stopServer(node);
}

/** Every string stored in the seed database (never masked by the normaliser). */
function knownStrings(dir) {
  const require = createRequire(path.join(SERVER, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dir, "openfinance.db"), { readonly: true });
  db.pragma(`cipher = 'sqlcipher'`);
  db.pragma(`legacy = 4`);
  db.pragma(`key = '${DB_KEY.replace(/'/g, "''")}'`);
  const known = new Set();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const v of Object.values(row)) if (typeof v === "string") known.add(v);
    }
  }
  db.close();
  return known;
}

// ── Scenario execution ───────────────────────────────────────────────────────

function interpolate(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => {
      if (!(name in vars)) throw new Error(`unknown variable {{${name}}}`);
      const v = vars[name];
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Sends one step to one server; returns { status, headers, kind, value, raw }. */
async function send(server, step, vars) {
  const headers = interpolate(step.headers ?? {}, vars);
  let body;
  if ("json" in step) {
    body = JSON.stringify(interpolate(step.json, vars));
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  } else if ("body" in step) {
    body = interpolate(step.body, vars);
  } else if ("bodyBase64" in step) {
    body = Buffer.from(step.bodyBase64, "base64");
  } else if ("bodyFrom" in step) {
    body = vars[step.bodyFrom];
    if (!Buffer.isBuffer(body)) throw new Error(`bodyFrom: ${step.bodyFrom} is not a captured body`);
  } else if ("multipart" in step) {
    const form = new FormData();
    const mp = interpolate(step.multipart, vars);
    for (const [k, v] of Object.entries(mp.fields ?? {})) form.append(k, v);
    for (const [k, f] of Object.entries(mp.files ?? {})) {
      const content = f.base64 != null ? Buffer.from(f.base64, "base64") : Buffer.from(f.content ?? "");
      form.append(k, new Blob([content], { type: f.type ?? "application/octet-stream" }), f.name);
    }
    body = form;
  }
  const res = await fetch(server.base + interpolate(step.path, vars), {
    method: step.method ?? "GET",
    headers,
    body,
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const picked = {};
  for (const h of COMPARED_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) picked[h] = v;
  }
  const type = res.headers.get("content-type") ?? "";
  let kind = "empty";
  let value = null;
  if (raw.length > 0 && type.includes("json")) {
    try {
      value = JSON.parse(raw.toString("utf8"));
      kind = "json";
    } catch {
      kind = "text";
      value = raw.toString("utf8");
    }
  } else if (raw.length > 0 && (type.startsWith("text/") || type === "")) {
    kind = "text";
    value = raw.toString("utf8");
  } else if (raw.length > 0) {
    kind = "bytes";
    value = `<${raw.length} bytes, base64 ${raw.toString("base64")}>`;
  }
  return { status: res.status, headers: picked, kind, value, raw };
}

function lineDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return `--- node\n${a}\n+++ rust\n${b}`;
  const dp = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (i < x.length && (j === y.length || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push(`- ${x[i++]}`);
    } else {
      out.push(`+ ${y[j++]}`);
    }
  }
  return out.join("\n");
}

async function runScenario(file, seedDir, tmp, bin, known) {
  const name = path.basename(file, ".json");
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  const runStartedAt = Date.now();
  const servers = {};
  for (const kind of ["node", "rust"]) {
    const dir = path.join(tmp, name, kind);
    fs.cpSync(seedDir, dir, { recursive: true, filter: (src) => !src.endsWith(".log") });
    servers[kind] = { dir };
  }
  const [node, rust] = await Promise.all([
    startServer("node", servers.node.dir),
    startServer("rust", servers.rust.dir, bin),
  ]);
  const ctx = {
    node: { server: node, vars: {}, norm: createNormaliser({ known, runStartedAt }) },
    rust: { server: rust, vars: {}, norm: createNormaliser({ known, runStartedAt }) },
  };
  const failures = [];
  try {
    for (const [index, step] of scenario.steps.entries()) {
      const label = `${name} #${index + 1} ${step.name ?? ""} ${step.method ?? "GET"} ${step.path}`;
      const shown = {};
      for (const kind of ["node", "rust"]) {
        const c = ctx[kind];
        const r = await send(c.server, step, c.vars);
        for (const [v, p] of Object.entries(step.capture ?? {})) c.vars[v] = getPath(r.value, p);
        if (step.captureBody) c.vars[step.captureBody] = r.raw;
        shown[kind] = canonical({
          status: r.status,
          headers: r.headers,
          kind: r.kind,
          body: r.kind === "json" ? c.norm.body(r.status, r.value) : r.value,
        });
      }
      if (shown.node === shown.rust) {
        if (VERBOSE) console.log(`  ok   ${label}`);
      } else {
        failures.push(`  FAIL ${label}  (- node, + rust)\n${lineDiff(shown.node, shown.rust)}`);
      }
    }
  } finally {
    await Promise.all([stopServer(node), stopServer(rust)]);
  }
  return { name, steps: scenario.steps.length, failures };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureNodeModules();
  const bin = buildRust();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openfinance-parity-"));
  let failed = 0;
  try {
    const seedDir = path.join(tmp, "seed");
    fs.mkdirSync(seedDir);
    console.log("seeding from sample-data.json…");
    await seed(seedDir);
    const known = knownStrings(seedDir);
    console.log(`seeded (${known.size} distinct strings in the seed database)`);

    const files = fs
      .readdirSync(SCENARIOS)
      .filter((f) => f.endsWith(".json"))
      .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
      .sort()
      .map((f) => path.join(SCENARIOS, f));
    if (files.length === 0) throw new Error("no scenarios matched");

    for (const file of files) {
      let result;
      try {
        result = await runScenario(file, seedDir, tmp, bin, known);
      } catch (err) {
        result = { name: path.basename(file, ".json"), steps: 0, failures: [`  ERROR ${err.stack ?? err}`] };
      }
      if (result.failures.length === 0) {
        console.log(`PASS ${result.name} (${result.steps} steps)`);
      } else {
        failed++;
        console.log(`FAIL ${result.name} (${result.failures.length} diff(s))`);
        for (const f of result.failures) console.log(f);
      }
    }
    console.log(`\n${files.length - failed}/${files.length} scenarios match, ${failed} with diffs`);
  } finally {
    if (flags.has("--keep")) console.log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
