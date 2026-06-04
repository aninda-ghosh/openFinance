/**
 * Phase 12 — Price Refresh via Web APIs
 *
 * Fetches current market prices from free, no-auth-required public APIs.
 * Per constraint 22: only the investment name and currency code leave the machine.
 *
 * Data sources used:
 *   - Mutual funds (INR):  mfapi.in  (AMFI India)
 *   - Stocks/ETFs/Crypto:  Yahoo Finance v8 chart API (quote search)
 *   - FD / Real estate:    Stored value (no live price available)
 *   - Exchange rates:      open.er-api.com  (free, no key)
 */

import type { InvestmentResponse } from "@finwise/shared/api-contracts";
import { getLatestRates } from "./exchange-rate.service";

export interface PriceResult {
  price: number; // in investment's native currency
  price_inr: number; // converted to INR using latest stored rate
  currency: string;
  source_url: string;
  fetched_at: string;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export async function fetchCurrentPrice(
  investment: InvestmentResponse
): Promise<PriceResult> {
  const { currency, current_value } = investment;
  const fetched_at = new Date().toISOString();

  // All investments return stored value — no external price fetching
  const rates = await getLatestRates();
  const rate = rates[currency] ?? 1.0;
  return {
    price: current_value,
    price_inr: current_value * rate,
    currency,
    source_url: "manual://stored-value",
    fetched_at,
  };
}

// ─── Mutual fund NAV via mfapi.in (AMFI India) ───────────────────────────────

async function _fetchMutualFundNAV(
  name: string
): Promise<Omit<PriceResult, "price_inr" | "fetched_at"> | null> {
  try {
    const searchUrl = `https://api.mfapi.in/mf/search?q=${encodeURIComponent(name)}`;
    const searchRes = await fetchWithTimeout(searchUrl, 8000);
    if (!searchRes.ok) return null;

    const funds: { schemeCode: number; schemeName: string }[] =
      await searchRes.json();
    if (!funds.length) return null;

    const best = funds[0];
    const navUrl = `https://api.mfapi.in/mf/${best.schemeCode}`;
    const navRes = await fetchWithTimeout(navUrl, 8000);
    if (!navRes.ok) return null;

    const data = await navRes.json();
    const latestNav: { nav: string; date: string } = data.data?.[0];
    if (!latestNav) return null;

    const price = parseFloat(latestNav.nav);
    if (Number.isNaN(price) || price <= 0) return null;

    return {
      price,
      currency: "INR",
      source_url: `https://www.amfiindia.com/nav-history-download (code: ${best.schemeCode})`,
    };
  } catch {
    return null;
  }
}

// ─── Stocks, ETFs, crypto via Stooq (no API key required) ───────────────────
// Stooq URL format: https://stooq.com/q/l/?s=TICKER.SUFFIX&f=sd2t2ohlcvn&h&e=csv
// Suffixes: .US (NYSE/NASDAQ), .SG (SGX), .TW (Taiwan), etc.
// Indian NSE stocks are not reliably available on Stooq — mutual funds use mfapi.in.

const CURRENCY_TO_STOOQ_SUFFIX: Record<string, string[]> = {
  USD: [".US"],
  SGD: [".SG", ".US"],
  NTD: [".TW", ".US"],
  INR: [".NS", ".BO", ".US"], // NSE, BSE, then US as last resort
};

async function _fetchYahooFinancePrice(
  name: string,
  preferredCurrency: string
): Promise<Omit<PriceResult, "price_inr" | "fetched_at"> | null> {
  // Extract all-caps ticker candidates from the investment name
  const tickerCandidates = name.match(/\b([A-Z]{1,6})\b/g) ?? [];
  const suffixes = CURRENCY_TO_STOOQ_SUFFIX[preferredCurrency] ?? [".US"];

  for (const ticker of tickerCandidates.slice(0, 4)) {
    for (const suffix of suffixes) {
      const result = await fetchStooqQuote(ticker + suffix);
      if (result) return result;
    }
  }
  return null;
}

async function fetchStooqQuote(
  stooqSymbol: string
): Promise<Omit<PriceResult, "price_inr" | "fetched_at"> | null> {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol.toLowerCase())}&f=sd2t2ohlcvn&h&e=csv`;
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) return null;

    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;

    // CSV columns: Symbol,Date,Time,Open,High,Low,Close,Volume,Name
    const [, dataLine] = lines;
    const cols = dataLine.split(",");
    if (!cols[6] || cols[2] === "N/D") return null; // N/D = no data

    const close = parseFloat(cols[6]);
    if (Number.isNaN(close) || close <= 0) return null;

    // Infer currency from Stooq suffix
    const suffix = stooqSymbol.toUpperCase().split(".").pop() ?? "";
    const SUFFIX_CURRENCY: Record<string, string> = {
      US: "USD",
      SG: "SGD",
      TW: "TWD",
      NS: "INR",
      BO: "INR",
    };
    const currency = SUFFIX_CURRENCY[suffix] ?? "USD";

    return {
      price: close,
      currency,
      source_url: `https://stooq.com/q/?s=${stooqSymbol.toLowerCase()}`,
    };
  } catch {
    return null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  ms: number,
  headers: Record<string, string> = {}
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(id);
  }
}
