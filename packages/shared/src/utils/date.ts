// Convert a Date to "YYYY-MM" format for envelope month fields
export function toYearMonth(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// Parse a "YYYY-MM" string into a Date (set to the 1st of that month)
export function parseYearMonth(s: string): Date {
  const [year, month] = s.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

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

/** Days in a month; `month` is 1-based. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function splitIso(iso: string): [number, number, number] {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return [y, m, d];
}

/**
 * Adds whole months to a calendar date, clamping to the end of shorter months.
 * `anchorDay` is the day-of-month the series is meant to fall on, so a rule
 * for the 31st goes Jan 31 → Feb 28 → Mar 31, instead of drifting to the 28th
 * (or skipping February, which is what overflowing `setMonth` did).
 */
export function addMonthsIso(
  iso: string,
  months: number,
  anchorDay?: number | null
): string {
  const [y, m, d] = splitIso(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return `${ny}-${pad2(nm)}-${pad2(day)}`;
}

/** Adds whole days to a calendar date. */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = splitIso(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Day-of-month of a calendar date. */
export function dayOfMonth(iso: string): number {
  return splitIso(iso)[2];
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = splitIso(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const [y1, m1, d1] = splitIso(fromIso);
  const [y2, m2, d2] = splitIso(toIso);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
