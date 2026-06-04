import { z } from "zod";

export const CurrencyEnum = z.enum([
  "INR",
  "USD",
  "SGD",
  "GBP",
  "EUR",
  "JPY",
  "NTD",
]);
export type Currency = z.infer<typeof CurrencyEnum>;

export const SUPPORTED_CURRENCIES: Currency[] = [
  "INR",
  "USD",
  "SGD",
  "GBP",
  "EUR",
  "JPY",
  "NTD",
];

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  INR: "₹",
  USD: "$",
  SGD: "S$",
  GBP: "£",
  EUR: "€",
  JPY: "¥",
  NTD: "NT$",
};
