// ─── Calendar dates (YYYY-MM-DD) ──────────────────────────────────────────────
//
// Every date this app stores is a plain calendar date. The old pattern —
// `new Date("2026-03-01")` (parsed as UTC midnight), then `setMonth` (LOCAL
// time), then `toISOString()` (UTC again) — shifts the day for anyone west or
// east of UTC: in US Eastern time a rule on the 1st came back on the 28th of
// the SAME month, and `new Date().toISOString()` after ~8pm is already
// tomorrow. These helpers never touch a time zone: "today" is the user's local
// calendar day, and arithmetic works on year/month/day numbers.

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The user's local calendar day as YYYY-MM-DD (not UTC). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The user's local calendar month as YYYY-MM (not UTC). */
export function localYearMonth(d: Date = new Date()): string {
  return localIsoDate(d).slice(0, 7);
}
