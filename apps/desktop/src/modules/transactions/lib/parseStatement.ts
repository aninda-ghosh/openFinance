/**
 * Turns pasted statement text into rows: date, description and a signed
 * amount, exactly as the source showed them. Whether a positive number is
 * money in or money out is decided by the caller (it depends on the account
 * and the bank), not here.
 *
 * Handles:
 * - spreadsheet copies (tab-separated) and CSV, with or without a header row,
 *   including split Debit / Credit columns
 * - text copied from a bank or card website, one transaction per line or
 *   spread over several lines (a new transaction starts at each date)
 */

export type DateOrder = "mdy" | "dmy";

export interface ParsedLine {
  /** ISO YYYY-MM-DD, or null when no date could be read. */
  date: string | null;
  description: string;
  /** Signed as the source shows it; null when no amount could be read. */
  amount: number | null;
  /** Identifies the pasted line, so pasting it again can be recognised. */
  sourceKey: string;
}

export interface ParseResult {
  rows: ParsedLine[];
  /** Day/month order used for numeric dates like 03/04/2026. */
  dateOrder: DateOrder;
  /** True when the paste never showed which order its dates use. */
  dateOrderAmbiguous: boolean;
  /**
   * Set when the source made the direction explicit (Debit/Credit columns):
   * amounts are then normalised so money out is negative.
   */
  outflowSign: "negative" | null;
}

export interface ParseOptions {
  /** Force a day/month order; detected from the paste when omitted. */
  dateOrder?: DateOrder;
  /** Reference "today" for dates without a year. */
  today?: Date;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?";

const pad2 = (n: number) => String(n).padStart(2, "0");

function validIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. Feb 30
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** A year-less date takes the most recent year that doesn't put it in the future. */
function inferYear(m: number, d: number, today: Date): number {
  const y = today.getFullYear();
  const candidate = new Date(y, m - 1, d);
  const tomorrow = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1
  );
  return candidate > tomorrow ? y - 1 : y;
}

type DateMatch = { iso: string; length: number };

/**
 * Reads a date at the start of `s`. Numeric dates use `order`; returns the
 * matched length so the caller can take the rest of the line.
 */
function matchDateAtStart(
  s: string,
  order: DateOrder,
  today: Date
): DateMatch | null {
  const t = s.toLowerCase();
  const found = (m: RegExpMatchArray, iso: string | null): DateMatch | null =>
    iso ? { iso, length: m[0].length } : null;
  const monthNumber = (name: string) =>
    MONTHS[name.slice(0, 4) === "sept" ? "sept" : name.slice(0, 3)];

  // 2026-11-12
  const isoDate = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate)
    return found(isoDate, validIso(+isoDate[1], +isoDate[2], +isoDate[3]));

  // 11/12/2026, 11-12-26, 11.12.2026
  const numeric = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  if (numeric) {
    const [a, b, y] = [+numeric[1], +numeric[2], fullYear(+numeric[3])];
    return found(
      numeric,
      order === "mdy" ? validIso(y, a, b) : validIso(y, b, a)
    );
  }

  // 11/12 (no year)
  const short = t.match(/^(\d{1,2})\/(\d{1,2})(?![/\d])/);
  if (short) {
    const [mo, d] =
      order === "mdy" ? [+short[1], +short[2]] : [+short[2], +short[1]];
    return found(short, validIso(inferYear(mo, d, today), mo, d));
  }

  // Nov 12, 2026 · Thu, Nov 12 · November 12
  const monthFirst = t.match(
    new RegExp(
      `^${WEEKDAY_RE}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`
    )
  );
  if (monthFirst) {
    const mo = monthNumber(monthFirst[1]);
    const d = +monthFirst[2];
    const y = monthFirst[3] ? +monthFirst[3] : inferYear(mo, d, today);
    return found(monthFirst, validIso(y, mo, d));
  }

  // 12 Nov 2026 · 12 Nov · 12-Nov-26
  const dayFirst = t.match(
    new RegExp(
      `^${WEEKDAY_RE}(\\d{1,2})[\\s-]+${MONTH_RE}\\.?(?:[\\s-]+(\\d{2,4}))?\\b`
    )
  );
  if (dayFirst) {
    const d = +dayFirst[1];
    const mo = monthNumber(dayFirst[2]);
    const y = dayFirst[3] ? fullYear(+dayFirst[3]) : inferYear(mo, d, today);
    return found(dayFirst, validIso(y, mo, d));
  }
  return null;
}

/** Looks at every numeric date in the paste to tell 03/04 from 04/03. */
function detectDateOrder(text: string): {
  order: DateOrder;
  ambiguous: boolean;
} {
  let mdy = false;
  let dmy = false;
  let numeric = false;
  // A dot only separates a date when a year follows (31.12.2026); without one,
  // "42.10" is an amount.
  for (const m of text.matchAll(
    /(?:^|[\s,"\t])(?:(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?|(\d{1,2})\.(\d{1,2})\.\d{2,4})(?=$|[\s,"\t])/gm
  )) {
    const a = +(m[1] ?? m[3]);
    const b = +(m[2] ?? m[4]);
    if (a < 1 || b < 1 || (a > 12 && b > 12) || a > 31 || b > 31) continue;
    numeric = true;
    if (a > 12) dmy = true;
    if (b > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: "dmy", ambiguous: false };
  if (mdy && !dmy) return { order: "mdy", ambiguous: false };
  // Only numeric dates like 03/04 can be read either way; ISO dates and
  // month names can't, so a paste without any isn't ambiguous.
  return { order: "mdy", ambiguous: numeric };
}

// ─── Amounts ──────────────────────────────────────────────────────────────────

const CURRENCY = "[$€£₹¥]|usd|inr|eur|gbp|sgd|rs\\.?";

/**
 * A money amount: -$1,234.56 · $1,234.56 · (12.34) · 12.34 CR · ₹500 · −5.00.
 * In free text an amount needs cents, a currency mark or thousands commas, so
 * reference numbers and store numbers are not mistaken for money.
 */
function parseAmountToken(raw: string, strict: boolean): number | null {
  let s = raw.trim().toLowerCase().replace(/−/g, "-");
  if (!s) return null;
  let negative = false;

  const crdr = s.match(/\s*\b(cr|dr)\.?$/);
  if (crdr) {
    if (crdr[1] === "cr") negative = true;
    s = s.slice(0, crdr.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const hasCurrency = new RegExp(`(${CURRENCY})`).test(s);
  s = s.replace(new RegExp(CURRENCY, "g"), "").trim();
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  if (strict && !hasCurrency && !/[.,]/.test(s)) return null;
  if (strict && !hasCurrency && /\.\d$/.test(s)) return null;

  const value = Number.parseFloat(s.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** The last money amount in free text, and the text without it. */
function takeLastAmount(text: string): { amount: number | null; rest: string } {
  const re = new RegExp(
    `\\(?[-+\\u2212]?\\s?(?:${CURRENCY})?\\s?[-\\u2212]?\\d[\\d,]*(?:\\.\\d{1,2})?\\)?(?:\\s?(?:cr|dr)\\b\\.?)?`,
    "gi"
  );
  let last: { amount: number; index: number; length: number } | null = null;
  for (const m of text.matchAll(re)) {
    const amount = parseAmountToken(m[0], true);
    if (amount !== null && m.index !== undefined) {
      last = { amount, index: m.index, length: m[0].length };
    }
  }
  if (!last) return { amount: null, rest: text };
  return {
    amount: last.amount,
    rest: (
      text.slice(0, last.index) +
      " " +
      text.slice(last.index + last.length)
    ).trim(),
  };
}

// ─── Tables (tab / CSV) ───────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function toTable(lines: string[]): string[][] | null {
  const tabbed = lines.filter((l) => l.includes("\t")).length;
  if (tabbed >= Math.max(1, lines.length * 0.6)) {
    return lines.map((l) => l.split("\t").map((c) => c.trim()));
  }
  const rows = lines.map(splitCsvLine);
  const widths = rows.map((r) => r.length);
  const common = widths.sort(
    (a, b) =>
      widths.filter((w) => w === a).length -
      widths.filter((w) => w === b).length
  )[widths.length - 1];
  const consistent = rows.filter((r) => r.length === common).length;
  if (common >= 3 && consistent >= Math.max(1, lines.length * 0.8)) return rows;
  return null;
}

type Columns = {
  date: number;
  description: number;
  amount: number | null;
  debit: number | null;
  credit: number | null;
};

const HEADER_WORDS =
  /date|description|details|narration|particulars|payee|merchant|amount|debit|credit|withdrawal|deposit|memo|balance/i;

function columnsFromHeader(header: string[]): Columns | null {
  const find = (re: RegExp, exclude?: RegExp) =>
    header.findIndex((h) => re.test(h) && !exclude?.test(h));
  // Prefer the transaction date over a posting date.
  let date = find(/trans.*date|^date$|txn date|value date/i);
  if (date < 0) date = find(/date/i, /post/i);
  if (date < 0) date = find(/date/i);
  const description = find(
    /description|details|narration|particulars|payee|merchant|name|memo/i
  );
  const debit = find(/debit|withdrawal|money out|paid out/i);
  const credit = find(/credit|deposit|money in|paid in/i, /card/i);
  const amount = find(/amount/i, /balance/i);
  if (date < 0 || description < 0) return null;
  if (amount >= 0)
    return { date, description, amount, debit: null, credit: null };
  if (debit >= 0 && credit >= 0)
    return { date, description, amount: null, debit, credit };
  return null;
}

function columnsFromContent(
  rows: string[][],
  order: DateOrder,
  today: Date
): Columns | null {
  const width = Math.max(...rows.map((r) => r.length));
  const score = (col: number, test: (c: string) => boolean) =>
    rows.filter((r) => r[col] !== undefined && test(r[col])).length /
    rows.length;

  let date = -1;
  for (let c = 0; c < width; c++) {
    if (score(c, (v) => matchDateAtStart(v, order, today) !== null) >= 0.6) {
      date = c;
      break;
    }
  }
  let amount = -1;
  for (let c = width - 1; c >= 0; c--) {
    if (
      c !== date &&
      score(c, (v) => parseAmountToken(v, false) !== null) >= 0.6
    ) {
      amount = c;
      // A trailing running balance usually follows the amount; prefer the
      // left-most of two adjacent numeric columns at the end.
      if (
        c - 1 !== date &&
        c - 1 >= 0 &&
        score(c - 1, (v) => parseAmountToken(v, false) !== null) >= 0.6
      ) {
        amount = c - 1;
      }
      break;
    }
  }
  if (date < 0 || amount < 0) return null;
  let description = -1;
  let best = 0;
  for (let c = 0; c < width; c++) {
    if (c === date || c === amount) continue;
    const avg =
      rows.reduce(
        (n, r) => n + (r[c]?.replace(/[\d\s.,$-]/g, "").length ?? 0),
        0
      ) / rows.length;
    if (avg > best) {
      best = avg;
      description = c;
    }
  }
  if (description < 0) return null;
  return { date, description, amount, debit: null, credit: null };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function normaliseForKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseStatement(
  text: string,
  options: ParseOptions = {}
): ParseResult {
  const today = options.today ?? new Date();
  const detected = detectDateOrder(text);
  const dateOrder = options.dateOrder ?? detected.order;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, " ").trimEnd())
    .filter((l) => l.trim() !== "");

  const out: Omit<ParsedLine, "sourceKey">[] = [];
  let outflowSign: ParseResult["outflowSign"] = null;

  const table = lines.length ? toTable(lines) : null;
  let usedTable = false;
  if (table) {
    const first = table[0];
    const looksLikeHeader =
      first.some((c) => HEADER_WORDS.test(c)) &&
      !first.some((c) => matchDateAtStart(c, dateOrder, today));
    const body = looksLikeHeader ? table.slice(1) : table;
    const cols = looksLikeHeader
      ? columnsFromHeader(first)
      : columnsFromContent(body, dateOrder, today);
    if (cols && body.length) {
      usedTable = true;
      if (cols.debit !== null) outflowSign = "negative";
      for (const r of body) {
        const date =
          matchDateAtStart(r[cols.date] ?? "", dateOrder, today)?.iso ?? null;
        let amount: number | null;
        if (cols.amount !== null) {
          amount = parseAmountToken(r[cols.amount] ?? "", false);
        } else {
          const debit = parseAmountToken(r[cols.debit as number] ?? "", false);
          const credit = parseAmountToken(
            r[cols.credit as number] ?? "",
            false
          );
          amount =
            debit !== null && debit !== 0
              ? -Math.abs(debit)
              : credit !== null
                ? Math.abs(credit)
                : null;
        }
        const description = (r[cols.description] ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (!date && amount === null && !description) continue;
        out.push({ date, description, amount });
      }
    }
  }

  if (!usedTable) {
    // Free text: a transaction starts at each line that begins with a date
    // and runs until the next one.
    let current: { date: string; parts: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const joined = current.parts.join(" ").replace(/\s+/g, " ").trim();
      const { amount, rest } = takeLastAmount(joined);
      out.push({
        date: current.date,
        description: rest.replace(/\s+/g, " ").trim(),
        amount,
      });
      current = null;
    };
    for (const line of lines) {
      const trimmed = line.trim();
      const hit = matchDateAtStart(trimmed, dateOrder, today);
      if (hit) {
        flush();
        let rest = trimmed.slice(hit.length).trim();
        // A second date right after (posting date) is not part of the payee.
        const second = matchDateAtStart(rest, dateOrder, today);
        if (second) rest = rest.slice(second.length).trim();
        current = { date: hit.iso, parts: [rest] };
      } else if (current) {
        current.parts.push(trimmed);
      }
    }
    flush();
  }

  const seen = new Map<string, number>();
  const rows = out.map((r) => {
    const base = `${r.date ?? "?"}|${r.amount ?? "?"}|${normaliseForKey(r.description)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...r, sourceKey: `${base}#${n}` };
  });

  return {
    rows,
    dateOrder,
    dateOrderAmbiguous: options.dateOrder ? false : detected.ambiguous,
    outflowSign,
  };
}
