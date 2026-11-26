/**
 * Draft rows for the bulk-add grid: built from pasted lines, enriched by the
 * server preview, checked before saving and converted to the API shape.
 */
import type {
  AccountResponse,
  BulkPreviewRow,
  BulkRow,
} from "@openfinance/shared/api-contracts";
import { isLiabilityType } from "@openfinance/shared/constants";
import type { ParsedLine } from "./parseStatement";

export type RowKind =
  | "expense"
  | "income"
  | "refund"
  | "transfer_in"
  | "transfer_out";

export const KIND_LABELS: Record<RowKind, string> = {
  expense: "Expense",
  refund: "Refund",
  income: "Income",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

export interface DraftRow {
  id: string;
  include: boolean;
  date: string;
  payee: string;
  /** Kept as text while editing; always a positive magnitude. */
  amount: string;
  kind: RowKind;
  envelopeId: string;
  counterpartId: string;
  sourceKey?: string;
  alreadyImported?: boolean;
  duplicates?: BulkPreviewRow["possible_duplicates"];
  /** A transfer the other account's statement already recorded. */
  transferAlreadyRecorded?: boolean;
  serverError?: string;
}

/** Which sign the pasted source uses for money leaving the account. */
export type OutflowSign = "positive" | "negative";

/** Cards usually show charges as positive; bank accounts show spending as negative. */
export function defaultOutflowSign(
  account: Pick<AccountResponse, "type">
): OutflowSign {
  return isLiabilityType(account.type) ? "positive" : "negative";
}

const CARD_PAYMENT_RE =
  /\b(payment|autopay|auto[\s-]?pay|e-?payment|pymt|thank\s*you)\b/i;
const TRANSFER_RE = /\b(transfer|xfer|trnsfr)\b/i;

/** Short names banks print for institutions people name in full. */
const ALIASES: Record<string, string[]> = {
  "american express": ["amex"],
  "bank of america": ["bofa", "bk of amer"],
  "capital one": ["capital one", "cap one", "capone"],
  "wells fargo": ["wells fargo", "wf "],
  "j.p. morgan": ["chase"],
  jpmorgan: ["chase"],
};
const GENERIC_WORDS = new Set([
  "account",
  "bank",
  "card",
  "cards",
  "checking",
  "credit",
  "debit",
  "savings",
  "the",
  "and",
  "my",
  "main",
  "joint",
  "personal",
]);

function accountNeedles(
  a: Pick<AccountResponse, "name" | "institution">
): string[] {
  const needles = new Set<string>();
  for (const source of [a.name, a.institution ?? ""]) {
    const lower = source.toLowerCase().trim();
    if (!lower) continue;
    for (const [full, short] of Object.entries(ALIASES)) {
      if (!lower.includes(full)) continue;
      for (const s of short) needles.add(s);
    }
    for (const word of lower.split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !GENERIC_WORDS.has(word)) needles.add(word);
    }
  }
  return [...needles];
}

/** The other account a transfer description names, if exactly one fits. */
export function guessCounterpart(
  description: string,
  account: AccountResponse,
  accounts: AccountResponse[]
): string {
  const text = ` ${description.toLowerCase()} `;
  const others = accounts.filter((a) => a.id !== account.id && a.is_active);
  const named = others.filter((a) =>
    accountNeedles(a).some((n) => text.includes(n.endsWith(" ") ? ` ${n}` : n))
  );
  if (named.length === 1) return named[0].id;
  // A card payment almost always comes from the one checking account.
  if (isLiabilityType(account.type)) {
    const checking = others.filter((a) => a.type === "checking");
    if (checking.length === 1) return checking[0].id;
  }
  return "";
}

let nextId = 0;
export const newRowId = () => `row-${Date.now().toString(36)}-${nextId++}`;

export function draftFromParsed(
  line: ParsedLine,
  account: AccountResponse,
  accounts: AccountResponse[],
  outflowSign: OutflowSign
): DraftRow {
  const amt = line.amount;
  const out =
    amt === null ? true : outflowSign === "positive" ? amt > 0 : amt < 0;
  const desc = line.description;
  const liability = isLiabilityType(account.type);

  let kind: RowKind;
  if (liability) {
    kind = out
      ? "expense"
      : CARD_PAYMENT_RE.test(desc)
        ? "transfer_in"
        : "refund";
  } else if (out) {
    const paysOwnAccount =
      CARD_PAYMENT_RE.test(desc) &&
      accounts.some(
        (a) =>
          a.id !== account.id &&
          isLiabilityType(a.type) &&
          accountNeedles(a).some((n) => desc.toLowerCase().includes(n.trim()))
      );
    kind =
      TRANSFER_RE.test(desc) || paysOwnAccount ? "transfer_out" : "expense";
  } else {
    kind = TRANSFER_RE.test(desc) ? "transfer_in" : "income";
  }

  return {
    id: newRowId(),
    include: true,
    date: line.date ?? "",
    payee: desc,
    amount: amt === null ? "" : Math.abs(amt).toFixed(2),
    kind,
    envelopeId: "",
    counterpartId:
      kind === "transfer_in" || kind === "transfer_out"
        ? guessCounterpart(desc, account, accounts)
        : "",
    sourceKey: line.sourceKey,
  };
}

/** Re-reads direction for every pasted row after the sign toggle flips. */
export function redraftWithSign(
  rows: DraftRow[],
  lines: Map<string, ParsedLine>,
  account: AccountResponse,
  accounts: AccountResponse[],
  outflowSign: OutflowSign
): DraftRow[] {
  return rows.map((r) => {
    const line = r.sourceKey ? lines.get(r.sourceKey) : undefined;
    if (!line) return r;
    const fresh = draftFromParsed(line, account, accounts, outflowSign);
    return {
      ...r,
      kind: fresh.kind,
      counterpartId: fresh.counterpartId || r.counterpartId,
    };
  });
}

export function applyPreview(
  rows: DraftRow[],
  preview: BulkPreviewRow[]
): DraftRow[] {
  return rows.map((r, i) => {
    const p = preview[i];
    if (!p) return r;
    const isTransfer = r.kind === "transfer_in" || r.kind === "transfer_out";
    const transferAlreadyRecorded =
      isTransfer && p.possible_duplicates.some((d) => d.type === "transfer");
    return {
      ...r,
      alreadyImported: p.already_imported,
      duplicates: p.possible_duplicates,
      transferAlreadyRecorded,
      envelopeId:
        r.envelopeId ||
        (r.kind === "expense" ? (p.suggested_envelope_id ?? "") : ""),
      include: r.include && !p.already_imported && !transferAlreadyRecorded,
    };
  });
}

// ─── Checking and converting ──────────────────────────────────────────────────

export function parseAmount(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What stops an included row from saving, or null when it's ready. */
export function rowProblem(
  r: DraftRow,
  account: AccountResponse,
  accountsById: Map<string, AccountResponse>
): string | null {
  if (!ISO_DATE.test(r.date)) return "Enter a date";
  if (parseAmount(r.amount) === null) return "Enter an amount";
  if (!r.payee.trim()) return "Enter a description";
  if (r.kind === "expense" && !account.off_budget && !r.envelopeId) {
    return "Pick a category";
  }
  if (r.kind === "transfer_in" || r.kind === "transfer_out") {
    const other = accountsById.get(r.counterpartId);
    if (!other) return "Pick the other account";
    if (other.currency !== account.currency) {
      return "Different currencies — add this one with Quick Add";
    }
    const from = r.kind === "transfer_out" ? account : other;
    const to = r.kind === "transfer_out" ? other : account;
    if (!from.off_budget && to.off_budget && !r.envelopeId) {
      return "Pick a category (money is leaving the budget)";
    }
  }
  return r.serverError ?? null;
}

/** Whether this row needs a category picker at all. */
export function needsCategory(
  r: DraftRow,
  account: AccountResponse,
  accountsById: Map<string, AccountResponse>
): boolean {
  if (r.kind === "expense") return true;
  if (r.kind === "transfer_in" || r.kind === "transfer_out") {
    const other = accountsById.get(r.counterpartId);
    if (!other) return false;
    const from = r.kind === "transfer_out" ? account : other;
    const to = r.kind === "transfer_out" ? other : account;
    return !from.off_budget && !!to.off_budget;
  }
  return false;
}

export function toBulkRow(
  r: DraftRow,
  account: AccountResponse,
  accountsById: Map<string, AccountResponse>
): BulkRow {
  const base = {
    date: r.date,
    payee: r.payee.trim(),
    amount: parseAmount(r.amount) as number,
    source_key: r.sourceKey,
  };
  switch (r.kind) {
    case "expense":
      return {
        ...base,
        type: "expense",
        envelope_id: r.envelopeId || undefined,
      };
    case "income":
      return { ...base, type: "income", income_category: "income" };
    case "refund":
      return { ...base, type: "income", income_category: "cashback" };
    default:
      return {
        ...base,
        type: "transfer",
        direction: r.kind === "transfer_in" ? "in" : "out",
        counterpart_account_id: r.counterpartId,
        envelope_id: needsCategory(r, account, accountsById)
          ? r.envelopeId || undefined
          : undefined,
      };
  }
}

/** Signed effect of a row on the account's balance (money in is positive). */
export function balanceEffect(r: DraftRow): number {
  const amount = parseAmount(r.amount) ?? 0;
  return r.kind === "expense" || r.kind === "transfer_out" ? -amount : amount;
}

// ─── Same-payee fill ──────────────────────────────────────────────────────────

const NOISE = new Set([
  "ach",
  "aplpay",
  "autopay",
  "card",
  "co",
  "com",
  "debit",
  "inc",
  "llc",
  "ltd",
  "online",
  "paypal",
  "pos",
  "purchase",
  "recurring",
  "sq",
  "the",
  "tst",
  "www",
]);

/** "SQ *BLUE BOTTLE #12" and "Blue Bottle Coffee 99" both give "blue bottle". */
export function payeeKey(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NOISE.has(t))
    .slice(0, 2)
    .join(" ");
}
