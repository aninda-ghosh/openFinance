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
