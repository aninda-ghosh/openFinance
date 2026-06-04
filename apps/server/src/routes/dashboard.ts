import { Hono } from "hono";
import * as dashboardService from "../services/dashboard.service";
import * as exchangeRateService from "../services/exchange-rate.service";

export const dashboardRouter = new Hono();

function handleError(c: any, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 404) return c.json({ error: e.message ?? "Not found" }, 404);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

dashboardRouter.get("/", async (c) => {
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  try {
    const dashboard = await dashboardService.getDashboard(month);
    return c.json(dashboard);
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/net-worth", async (c) => {
  try {
    const netWorth = await dashboardService.getNetWorth();
    return c.json(netWorth);
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/portfolio-breakdown", async (c) => {
  try {
    const breakdown = await dashboardService.getPortfolioBreakdown();
    return c.json({ breakdown });
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/budget-heatmap", async (c) => {
  const months = Number(c.req.query("months") ?? 6);
  try {
    const heatmap = await dashboardService.getBudgetHeatmap(months);
    return c.json({ heatmap });
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/top-movers", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const limit = Number(c.req.query("limit") ?? 5);
  try {
    const movers = await dashboardService.getTopMovers(days, limit);
    return c.json({ movers });
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/spending-trends", async (c) => {
  const months = Number(c.req.query("months") ?? 6);
  try {
    const trends = await dashboardService.getSpendingTrends(months);
    return c.json({ trends });
  } catch (err) {
    return handleError(c, err);
  }
});

dashboardRouter.get("/cash-flow", async (c) => {
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  try {
    const data = await dashboardService.getCashFlow(month);
    return c.json(data);
  } catch (err) {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

dashboardRouter.get("/net-worth-history", async (c) => {
  const months = Math.min(24, Math.max(1, Number(c.req.query("months") ?? 6)));
  try {
    const history = await dashboardService.getNetWorthHistory(months);
    return c.json({ history });
  } catch (err) {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Exchange Rates ───────────────────────────────────────────────────────────

dashboardRouter.get("/exchange-rates", async (c) => {
  try {
    const rates = await exchangeRateService.listRates();
    return c.json({ rates });
  } catch (err) {
    return handleError(c, err);
  }
});
