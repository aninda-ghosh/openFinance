import type { Currency } from "../schemas/currency.schema";

const localeMap: Record<
  Currency,
  { locale: string; opts: Intl.NumberFormatOptions }
> = {
  INR: {
    locale: "en-IN",
    opts: { style: "currency", currency: "INR", minimumFractionDigits: 0 },
  },
  USD: {
    locale: "en-US",
    opts: { style: "currency", currency: "USD", minimumFractionDigits: 2 },
  },
  SGD: {
    locale: "en-SG",
    opts: { style: "currency", currency: "SGD", minimumFractionDigits: 2 },
  },
  GBP: {
    locale: "en-GB",
    opts: { style: "currency", currency: "GBP", minimumFractionDigits: 2 },
  },
  EUR: {
    locale: "en-IE",
    opts: { style: "currency", currency: "EUR", minimumFractionDigits: 2 },
  },
  JPY: {
    locale: "ja-JP",
    opts: { style: "currency", currency: "JPY", minimumFractionDigits: 0 },
  },
  NTD: {
    locale: "zh-TW",
    opts: { style: "currency", currency: "TWD", minimumFractionDigits: 0 },
  },
};

// Display an amount in its native currency (e.g. "$1,234.56", "S$1,234", "₹1,23,456")
export function formatCurrency(amount: number, currency: Currency): string {
  const cfg = localeMap[currency] || localeMap.USD;
  const { locale, opts } = cfg;
  return new Intl.NumberFormat(locale, opts).format(amount);
}

// Always format a value that is already in INR (for totals / net worth)
export function formatINR(amount: number): string {
  return formatCurrency(amount, "INR");
}

// Convert a native-currency amount to the active base currency using the latest rates map
export function convertToINR(
  amount: number,
  currency: Currency,
  rates: Record<string, number> // { USD: 1.0, INR: 83.5, SGD: 1.34 } where base is USD
): number {
  // Dynamically find base currency where rate is exactly 1.0
  let baseCurrency: Currency = "USD";
  const foundBase = Object.entries(rates || {}).find(
    ([_, r]) => r === 1.0
  )?.[0] as Currency | undefined;
  if (foundBase) baseCurrency = foundBase;

  if (currency === baseCurrency) return amount;
  const rate = rates[currency];
  if (rate === undefined || rate === null) return amount; // fallback: no conversion
  return amount * rate;
}

// Convert an active base currency amount to a target currency using stored rates
export function convertFromINR(
  amountInr: number,
  targetCurrency: Currency,
  rates: Record<string, number>
): number {
  // Dynamically find base currency where rate is exactly 1.0
  let baseCurrency: Currency = "USD";
  const foundBase = Object.entries(rates || {}).find(
    ([_, r]) => r === 1.0
  )?.[0] as Currency | undefined;
  if (foundBase) baseCurrency = foundBase;

  if (targetCurrency === baseCurrency) return amountInr;
  const rate = rates[targetCurrency];
  if (!rate) return amountInr; // fallback: show as-is if rate missing
  return amountInr / rate;
}
