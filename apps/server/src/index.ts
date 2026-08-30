import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bootstrapSchema } from "./db/bootstrap";
import { aiRouter } from "./routes/ai";
import { authRouter } from "./routes/auth";
import { backupRouter } from "./routes/backup";
import { budgetRouter } from "./routes/budget";
import { dashboardRouter } from "./routes/dashboard";
import { documentsRouter } from "./routes/documents";
import { exchangeRatesRouter } from "./routes/exchange-rates";
import { investmentsRouter } from "./routes/investments";
import { lifeInsuranceRouter } from "./routes/life-insurance";
import { policiesRouter } from "./routes/policies";
import { resetRouter } from "./routes/reset";
import { verifyToken } from "./services/auth.service";

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

// ── Bootstrap schema + incremental migrations ─────────────────────────────────
// Creates every table and applies pending column additions. All statements are
// idempotent, so this is safe to run on every startup.
await bootstrapSchema();
console.log("[startup] Schema migrations complete.");

// ── Load runtime AI settings (Ollama endpoint/model) from the database ───────
import { loadAiSettings } from "./services/settings.service";

try {
  await loadAiSettings();
} catch (err) {
  console.warn("[startup] Could not load AI settings:", (err as Error).message);
}

// ── Encrypt any documents uploaded before at-rest encryption was enabled ─────
import { migratePlaintextDocuments } from "./services/document.service";

try {
  const migrated = migratePlaintextDocuments();
  if (migrated > 0) {
    console.log(
      `[startup] Encrypted ${migrated} existing plaintext document(s) at rest.`
    );
  }
} catch (err) {
  console.warn(
    "[startup] Document encryption migration failed:",
    (err as Error).message
  );
}

// ── Apply due recurring transactions on startup ───────────────────────────────
import { applyDueRecurring } from "./services/recurring.service";

(async () => {
  try {
    const count = await applyDueRecurring();
    if (count > 0)
      console.log(`[recurring] Applied ${count} due recurring transaction(s).`);
  } catch (err) {
    console.warn(
      "[recurring] Failed to apply due recurring transactions:",
      (err as Error).message
    );
  }
})();

// ── Exchange rates: fetch on startup, then refresh every 15 minutes ──────────
import {
  getLatestRates,
  refreshFromWeb,
} from "./services/exchange-rate.service";

(async () => {
  try {
    const existing = await getLatestRates();
    if (Object.keys(existing).length === 0) {
      console.log("[startup] No exchange rates found — fetching from web…");
    }
    await refreshFromWeb();
    console.log("[startup] Exchange rates refreshed.");
  } catch (err) {
    console.warn(
      "[startup] Could not refresh exchange rates:",
      (err as Error).message
    );
  }
})();

const FIFTEEN_MINUTES = 15 * 60 * 1000;
setInterval(async () => {
  try {
    await refreshFromWeb();
    console.log("[rates] Exchange rates auto-refreshed.");
  } catch (err) {
    console.warn("[rates] Auto-refresh failed:", (err as Error).message);
  }
}, FIFTEEN_MINUTES);

// ── Auth middleware — protects all /api/* except /api/auth/* ─────────────────
app.use("/api/*", async (c, next) => {
  if (process.env.OPENFINANCE_DESKTOP === "true") return next();
  if (c.req.path.startsWith("/api/auth/")) return next();

  let token = "";
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    token = header.slice(7);
  } else {
    token = c.req.query("token") || "";
  }

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = verifyToken(token);
  if (!payload) return c.json({ error: "Invalid or expired token" }, 401);
  return next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/api/auth", authRouter);
app.route("/api/budget", budgetRouter);
app.route("/api/investments", investmentsRouter);
app.route("/api/policies", policiesRouter);
app.route("/api/life-insurance", lifeInsuranceRouter);
app.route("/api/dashboard", dashboardRouter);
app.route("/api/exchange-rates", exchangeRatesRouter);
app.route("/api/ai", aiRouter);
app.route("/api/reset", resetRouter);
app.route("/api/backup", backupRouter);
app.route("/api/documents", documentsRouter);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`openFinance server running on http://localhost:${PORT}`);
});
