import { Hono } from "hono";
import * as rateService from "../services/exchange-rate.service";
import { scaleBudgetEnvelopes } from "../services/budget.service";

export const exchangeRatesRouter = new Hono();

function handleError(c: any, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 400)
    return c.json({ error: e.message ?? "Bad request" }, 400);
  if (e.status === 503)
    return c.json({ error: e.message ?? "Service unavailable" }, 503);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

// GET /api/exchange-rates — list all latest stored rates
exchangeRatesRouter.get("/", async (c) => {
  try {
    const rates = await rateService.listRates();
    return c.json({ rates });
  } catch (err) {
    return handleError(c, err);
  }
});

// POST /api/exchange-rates/refresh — fetch live rates from web
// Body (optional): { currency: "USD" | "SGD" | "NTD" }
// If currency is omitted, refreshes all three.
exchangeRatesRouter.post("/refresh", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const currency: string | undefined = body?.currency;
    const updated = await rateService.refreshFromWeb(currency);
    return c.json({ updated, count: updated.length });
  } catch (err) {
    return handleError(c, err);
  }
});

// GET /api/exchange-rates/base-currency — get universal base currency
exchangeRatesRouter.get("/base-currency", async (c) => {
  try {
    const baseCurrency = await rateService.getBaseCurrency();
    return c.json({ base_currency: baseCurrency });
  } catch (err) {
    return handleError(c, err);
  }
});

// POST /api/exchange-rates/base-currency — update universal base currency
exchangeRatesRouter.post("/base-currency", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const baseCurrency = body?.base_currency;
    if (
      !baseCurrency ||
      !["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"].includes(baseCurrency)
    ) {
      return c.json(
        {
          error:
            "Invalid base currency. Must be one of INR, USD, SGD, GBP, EUR, JPY, NTD",
        },
        400
      );
    }
    
    // Calculate conversion rate before updating base currency
    const oldBase = await rateService.getBaseCurrency();
    const oldRates = await rateService.getLatestRates();
    const conversionRate = oldRates[baseCurrency] ?? 1.0;
    
    await rateService.updateBaseCurrency(baseCurrency);
    
    // Scale budget envelopes to match new base currency if base currency changed
    if (oldBase !== baseCurrency) {
      await scaleBudgetEnvelopes(conversionRate, baseCurrency);
    }
    
    const updated = await rateService.refreshFromWeb();
    return c.json({
      success: true,
      base_currency: baseCurrency,
      updated_count: updated.length,
    });
  } catch (err) {
    return handleError(c, err);
  }
});
