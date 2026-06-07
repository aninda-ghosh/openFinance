import type { ExchangeRateResponse } from "@openfinance/shared/api-contracts";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { app_settings, exchange_rates } from "../db/schema";

export async function getBaseCurrency(): Promise<
  "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD"
> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(app_settings)
    .where(eq(app_settings.id, "system"))
    .limit(1);
  return (row?.base_currency ?? "USD") as
    | "INR"
    | "USD"
    | "SGD"
    | "GBP"
    | "EUR"
    | "JPY"
    | "NTD";
}

export async function updateBaseCurrency(
  baseCurrency: "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD"
): Promise<void> {
  const db = getDb();
  await db
    .insert(app_settings)
    .values({
      id: "system",
      base_currency: baseCurrency,
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: app_settings.id,
      set: {
        base_currency: baseCurrency,
        updated_at: new Date().toISOString(),
      },
    });
}

export async function getLatestRates(): Promise<Record<string, number>> {
  const baseCurrency = await getBaseCurrency();
  const SUPPORTED = ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
  const db = getDb();
  const rows = await db
    .select()
    .from(exchange_rates)
    .orderBy(desc(exchange_rates.fetched_at));

  const latest: Record<string, number> = {};
  // Base currency rate to itself is always 1.0
  latest[baseCurrency] = 1.0;

  for (const row of rows) {
    if (
      row.from_currency &&
      SUPPORTED.includes(row.from_currency) &&
      !latest[row.from_currency]
    ) {
      latest[row.from_currency] = row.rate_to_base ?? 1.0;
    }
  }
  return latest;
}

export async function getRate(fromCurrency: string): Promise<number> {
  const baseCurrency = await getBaseCurrency();
  if (fromCurrency === baseCurrency) {
    return 1.0;
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(exchange_rates)
    .where(eq(exchange_rates.from_currency, fromCurrency))
    .orderBy(desc(exchange_rates.fetched_at))
    .limit(1);

  if (!row) {
    return 1.0;
  }
  return row.rate_to_base ?? 1.0;
}

export async function saveRate(
  fromCurrency: string,
  rateToBase: number,
  source: string
): Promise<ExchangeRateResponse> {
  const db = getDb();
  const [row] = await db
    .insert(exchange_rates)
    .values({ from_currency: fromCurrency, rate_to_base: rateToBase, source })
    .returning();

  return {
    from_currency: row.from_currency as ExchangeRateResponse["from_currency"],
    rate_to_base: row.rate_to_base ?? rateToBase,
    source: row.source ?? source,
    fetched_at: row.fetched_at ?? new Date().toISOString(),
  };
}

export async function listRates(): Promise<ExchangeRateResponse[]> {
  const rates = await getLatestRates();
  const CURRENCY_ORDER = ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
  return Object.entries(rates)
    .map(([currency, rate]) => ({
      from_currency: currency as ExchangeRateResponse["from_currency"],
      rate_to_base: rate,
      source: "stored",
      fetched_at: new Date().toISOString(),
    }))
    .sort((a, b) => {
      const idxA = CURRENCY_ORDER.indexOf(a.from_currency);
      const idxB = CURRENCY_ORDER.indexOf(b.from_currency);
      return idxA - idxB;
    });
}

/**
 * Phase 12: Fetch a live exchange rate from open.er-api.com (free, no key required).
 * Calculates conversions relative to the Universal Base Currency.
 */
export async function refreshFromWeb(
  currency?: string
): Promise<ExchangeRateResponse[]> {
  const baseCurrency = await getBaseCurrency();
  const SUPPORTED = ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"] as const;
  const API_CODE: Record<string, string> = { NTD: "TWD" };

  const baseApiCode = API_CODE[baseCurrency] ?? baseCurrency;
  const url = `https://open.er-api.com/v6/latest/${baseApiCode}`;

  let rates: Record<string, number> = {};
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.result === "success" && data?.rates) {
      rates = data.rates;
    } else {
      throw new Error("Exchange rates response result was not success");
    }
  } catch (err) {
    console.error(
      `[exchange-rate] Failed to fetch live rates from ${url}:`,
      err
    );
    throw Object.assign(new Error("Failed to fetch exchange rates from API"), {
      status: 503,
    });
  }

  const results: ExchangeRateResponse[] = [];
  const targets = currency
    ? SUPPORTED.filter((c) => c === currency.toUpperCase())
    : [...SUPPORTED];

  for (const cur of targets) {
    if (cur === baseCurrency) {
      const saved = await saveRate(cur, 1.0, "system_base");
      results.push(saved);
      continue;
    }

    const targetApiCode = API_CODE[cur] ?? cur;
    const rateInBase = rates[targetApiCode];
    if (rateInBase === undefined || typeof rateInBase !== "number") {
      console.warn(
        `[exchange-rate] Rate for ${cur} (API code: ${targetApiCode}) not found in API response.`
      );
      continue;
    }

    // 1 unit of cur = (1 / rateInBase) unit of base currency
    const conversionRate = 1.0 / rateInBase;
    const saved = await saveRate(cur, conversionRate, "web_search");
    results.push(saved);
  }

  if (!results.length) {
    throw Object.assign(
      new Error("All exchange rate refreshes failed — check network"),
      { status: 503 }
    );
  }

  const CURRENCY_ORDER = ["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"];
  results.sort((a, b) => {
    const idxA = CURRENCY_ORDER.indexOf(a.from_currency);
    const idxB = CURRENCY_ORDER.indexOf(b.from_currency);
    return idxA - idxB;
  });

  return results;
}
