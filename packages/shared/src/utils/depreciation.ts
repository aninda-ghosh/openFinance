/**
 * Physical assets (a paid-off car) lose value over time. Rather than writing a
 * new value every day, the app stores the last real valuation (a quote) and
 * the date it was taken, and derives today's value on read:
 *
 *   value(asOf) = quote × (1 − rate/100) ^ (years between quote date and asOf)
 *
 * A new manual quote simply replaces the anchor, so a real-world valuation
 * always wins over the curve. The same formula run for a date BEFORE the
 * quote gives a higher value, which is a sensible estimate of what the asset
 * was worth then — that is what lets the net-worth history chart use it.
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Whole-day-precision years from `from` to `to` (both YYYY-MM-DD). */
function yearsBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / MS_PER_YEAR;
}

/**
 * @param quote      last real valuation, native currency
 * @param ratePct    yearly depreciation in percent (15 = 15%/yr); null/0 = none
 * @param quotedAt   YYYY-MM-DD the quote was taken; null = no curve
 * @param asOf       YYYY-MM-DD to value the asset at
 */
export function depreciatedValue(
  quote: number,
  ratePct: number | null | undefined,
  quotedAt: string | null | undefined,
  asOf: string
): number {
  if (!ratePct || ratePct <= 0 || !quotedAt) return quote;
  const rate = Math.min(ratePct, 100) / 100;
  if (rate >= 1) return 0;
  const value = quote * (1 - rate) ** yearsBetween(quotedAt, asOf);
  return Math.round(value * 100) / 100;
}
