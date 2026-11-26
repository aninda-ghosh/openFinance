import type {
  AccountResponse,
  BulkRowError,
  EnvelopeWithGroupResponse,
} from "@openfinance/shared/api-contracts";
import { isLiabilityType } from "@openfinance/shared/constants";
import { localIsoDate, localYearMonth } from "@openfinance/shared/utils";
import {
  ArrowLeft,
  CircleCheck,
  ClipboardPaste,
  LoaderCircle,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isModKey, MOD } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { budgetApi } from "@/modules/budget/api";
import {
  useAccounts,
  useBulkCreateTransactions,
  useEnvelopes,
} from "@/modules/budget/hooks/useBudget";
import {
  applyPreview,
  balanceEffect,
  type DraftRow,
  defaultOutflowSign,
  draftFromParsed,
  KIND_LABELS,
  needsCategory,
  newRowId,
  type OutflowSign,
  payeeKey,
  type RowKind,
  redraftWithSign,
  rowProblem,
  toBulkRow,
} from "../lib/bulkRows";
import {
  type DateOrder,
  type ParsedLine,
  parseStatement,
} from "../lib/parseStatement";

const BATCH_ACCOUNT_TYPES = new Set([
  "checking",
  "savings",
  "cash",
  "credit",
  "loan",
  "debt",
]);

const selectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 aria-invalid:border-destructive";
const cellInputClass =
  "h-8 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-sm outline-none hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

function formatMoney(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

function shortDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function CategorySelect({
  value,
  onChange,
  envelopes,
  invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  envelopes: EnvelopeWithGroupResponse[];
  invalid: boolean;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, EnvelopeWithGroupResponse[]>();
    for (const e of envelopes) {
      const list = map.get(e.group_name) ?? [];
      list.push(e);
      map.set(e.group_name, list);
    }
    return [...map.entries()];
  }, [envelopes]);
  return (
    <select
      className={cn(selectClass, !value && "text-muted-foreground")}
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Category…</option>
      {groups.map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function BulkAddPage() {
  const { data: accountsData } = useAccounts();
  const allAccounts = useMemo(
    () => (accountsData?.accounts ?? []).filter((a) => a.is_active),
    [accountsData]
  );
  const accountsById = useMemo(
    () => new Map(allAccounts.map((a) => [a.id, a])),
    [allAccounts]
  );
  const batchAccounts = allAccounts.filter((a) =>
    BATCH_ACCOUNT_TYPES.has(a.type)
  );

  // Categories are offered from this month; the server files each row under
  // its own month when it saves.
  const categoryMonth = localYearMonth();
  const { data: envelopeData } = useEnvelopes(categoryMonth);
  const envelopes = envelopeData?.envelopes ?? [];

  const [accountId, setAccountId] = useState("");
  const account = accountsById.get(accountId);
  const [text, setText] = useState("");
  const [pastes, setPastes] = useState<string[]>([]);
  const [lines, setLines] = useState<Map<string, ParsedLine>>(new Map());
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [outflowSign, setOutflowSign] = useState<OutflowSign>("positive");
  const [dateOrder, setDateOrder] = useState<DateOrder | undefined>(undefined);
  const [ambiguousDates, setAmbiguousDates] = useState(false);
  const [checking, setChecking] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const save = useBulkCreateTransactions();

  const problems = useMemo(() => {
    const map = new Map<string, string>();
    if (!account) return map;
    for (const r of rows) {
      if (!r.include) continue;
      const p = rowProblem(r, account, accountsById);
      if (p) map.set(r.id, p);
    }
    return map;
  }, [rows, account, accountsById]);

  const included = rows.filter((r) => r.include);
  const totals = useMemo(() => {
    let out = 0;
    let inn = 0;
    for (const r of included) {
      const e = balanceEffect(r);
      if (e < 0) out += -e;
      else inn += e;
    }
    return { out, in: inn, net: inn - out };
  }, [included]);

  const visibleRows = onlyAttention
    ? rows.filter((r) => problems.has(r.id))
    : rows;
  const currency = account?.currency ?? "USD";

  // ── Actions ──────────────────────────────────────────────────────────────

  function chooseAccount(id: string) {
    setAccountId(id);
    const a = accountsById.get(id);
    if (a) setOutflowSign(defaultOutflowSign(a));
  }

  async function checkRows(newRows: DraftRow[], acct: AccountResponse) {
    const sendable = newRows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    if (sendable.length === 0) return;
    setChecking(true);
    try {
      const res = await budgetApi.bulkPreview({
        account_id: acct.id,
        category_month: categoryMonth,
        rows: sendable.map((r) => ({
          date: r.date,
          payee: r.payee,
          amount: Number.parseFloat(r.amount) || 0,
          source_key: r.sourceKey,
        })),
      });
      const byId = new Map(sendable.map((r, i) => [r.id, res.rows[i]]));
      setRows((current) =>
        current.map((r) => {
          const p = byId.get(r.id);
          return p ? applyPreview([r], [p])[0] : r;
        })
      );
    } catch (e) {
      toast.error("Couldn't check for duplicates", {
        description: (e as Error).message,
      });
    } finally {
      setChecking(false);
    }
  }

  function readText(order: DateOrder | undefined = dateOrder) {
    if (!account || !text.trim()) return;
    const result = parseStatement(text, { dateOrder: order });
    if (result.rows.length === 0) {
      toast.error("No transactions found in that text", {
        description:
          "Each transaction needs a date, a description and an amount.",
      });
      return;
    }
    const sign =
      rows.length === 0 && result.outflowSign
        ? result.outflowSign
        : outflowSign;
    if (sign !== outflowSign) setOutflowSign(sign);
    const drafts = result.rows.map((l) =>
      draftFromParsed(l, account, allAccounts, sign)
    );
    setLines((m) => {
      const next = new Map(m);
      for (const l of result.rows) next.set(l.sourceKey, l);
      return next;
    });
    setRows((r) => [...r, ...drafts]);
    setPastes((p) => [...p, text]);
    setAmbiguousDates((a) => a || result.dateOrderAmbiguous);
    setText("");
    toast.success(`Read ${drafts.length} row${drafts.length === 1 ? "" : "s"}`);
    void checkRows(drafts, account);
  }

  /** Re-read every paste with the other day/month order (edits are reset). */
  function rereadWithOrder(order: DateOrder) {
    if (!account) return;
    setDateOrder(order);
    const all: ParsedLine[] = [];
    for (const p of pastes)
      all.push(...parseStatement(p, { dateOrder: order }).rows);
    const drafts = all.map((l) =>
      draftFromParsed(l, account, allAccounts, outflowSign)
    );
    setLines(new Map(all.map((l) => [l.sourceKey, l])));
    setRows([...rows.filter((r) => !r.sourceKey), ...drafts]);
    setAmbiguousDates(false);
    void checkRows(drafts, account);
  }

  function flipSign(sign: OutflowSign) {
    if (!account || sign === outflowSign) return;
    setOutflowSign(sign);
    setRows((r) => redraftWithSign(r, lines, account, allAccounts, sign));
  }

  function update(id: string, patch: Partial<DraftRow>) {
    setRows((current) =>
      current.map((r) =>
        r.id === id ? { ...r, ...patch, serverError: undefined } : r
      )
    );
  }

  function setCategory(row: DraftRow, envelopeId: string) {
    // Picking a category also fills it in on other uncategorised rows from
    // the same merchant.
    const key = payeeKey(row.payee);
    const alsoFill = new Set(
      envelopeId && key
        ? rows
            .filter(
              (r) =>
                r.id !== row.id &&
                r.include &&
                r.kind === "expense" &&
                !r.envelopeId &&
                payeeKey(r.payee) === key
            )
            .map((r) => r.id)
        : []
    );
    setRows((current) =>
      current.map((r) =>
        r.id === row.id
          ? { ...r, envelopeId, serverError: undefined }
          : alsoFill.has(r.id) && !r.envelopeId
            ? { ...r, envelopeId }
            : r
      )
    );
    const others = alsoFill.size;
    if (others > 0) {
      const name =
        envelopes.find((e) => e.id === envelopeId)?.name ?? "that category";
      toast.info(
        `Also set ${name} on ${others} other ${row.payee.split(" ")[0]} row${others === 1 ? "" : "s"}`
      );
    }
  }

  function addBlankRow() {
    setRows((r) => [
      ...r,
      {
        id: newRowId(),
        include: true,
        date: localIsoDate(),
        payee: "",
        amount: "",
        kind: "expense",
        envelopeId: "",
        counterpartId: "",
      },
    ]);
  }

  function startOver() {
    setRows([]);
    setPastes([]);
    setLines(new Map());
    setAmbiguousDates(false);
    setDateOrder(undefined);
    setOnlyAttention(false);
  }

  async function saveAll() {
    if (
      !account ||
      included.length === 0 ||
      problems.size > 0 ||
      save.isPending
    )
      return;
    const batch = included;
    try {
      const res = await save.mutateAsync({
        account_id: account.id,
        rows: batch.map((r) => toBulkRow(r, account, accountsById)),
      });
      toast.success(
        `Saved ${res.created} transaction${res.created === 1 ? "" : "s"} to ${account.name}`,
        res.skipped
          ? {
              description: `${res.skipped} already saved before ${res.skipped === 1 ? "was" : "were"} skipped.`,
            }
          : undefined
      );
      startOver();
    } catch (e) {
      const rowErrors =
        (e as { body?: { rows?: BulkRowError[] } }).body?.rows ?? [];
      if (rowErrors.length > 0) {
        const byId = new Map(
          rowErrors.map((er) => [batch[er.index]?.id, er.message])
        );
        setRows((current) =>
          current.map((r) =>
            byId.has(r.id) ? { ...r, serverError: byId.get(r.id) } : r
          )
        );
        toast.error(
          `${rowErrors.length} row${rowErrors.length === 1 ? "" : "s"} need attention`,
          {
            description:
              "Nothing was saved. Fix the highlighted rows and save again.",
          }
        );
      } else {
        toast.error("Couldn't save", { description: (e as Error).message });
      }
    }
  }

  const allIncluded = rows.length > 0 && rows.every((r) => r.include);
  const counterpartOptions = allAccounts.filter((a) => a.id !== accountId);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: page-level save shortcut
    <div
      className="flex flex-col h-full"
      onKeyDown={(e) => {
        if (e.key === "Enter" && isModKey(e)) {
          e.preventDefault();
          void saveAll();
        }
      }}
    >
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
        <Link
          to="/transactions"
          className="p-1.5 -ml-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label="Back to transactions"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Bulk add</h1>
          <p className="text-sm text-muted-foreground">
            Paste one account's transactions, check them, then save them all at
            once.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        {/* Step 1: account and paste */}
        <section className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium min-w-56">
              Account
              <select
                className={cn(selectClass, "h-9")}
                value={accountId}
                disabled={rows.length > 0}
                onChange={(e) => chooseAccount(e.target.value)}
              >
                <option value="">Choose the account you're pasting…</option>
                <optgroup label="Cards and loans">
                  {batchAccounts
                    .filter((a) => isLiabilityType(a.type))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Bank and cash">
                  {batchAccounts
                    .filter((a) => !isLiabilityType(a.type))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            {account && (
              <div className="flex flex-col gap-1 text-sm font-medium">
                Money out is shown as
                <div className="inline-flex rounded-lg border border-input p-0.5 h-9">
                  {(["positive", "negative"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => flipSign(s)}
                      className={cn(
                        "px-3 rounded-md text-xs font-semibold transition-colors",
                        outflowSign === s
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {s === "positive"
                        ? "Positive (12.50)"
                        : "Negative (−12.50)"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {rows.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={startOver}
              >
                Start over
              </Button>
            )}
          </div>

          {account ? (
            <>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "Paste rows from your bank or card website, a CSV file or a spreadsheet. For example:\n" +
                  "Nov 12, 2026   STARBUCKS STORE 12345   $5.40\n" +
                  "11/13/2026,AUTOPAY PAYMENT - THANK YOU,-200.00"
                }
                className="min-h-28 max-h-72 font-mono text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isModKey(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    readText();
                  }
                }}
              />
              <div className="flex items-center gap-3">
                <Button onClick={() => readText()} disabled={!text.trim()}>
                  <ClipboardPaste className="w-4 h-4" />
                  {rows.length > 0 ? "Add these rows" : "Read rows"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {text.trim()
                    ? `${MOD}Enter to read`
                    : "Nothing is saved until you press Save."}
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pick the account first, so card charges and payments are read the
              right way round.
            </p>
          )}
        </section>

        {ambiguousDates && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm flex flex-wrap items-center gap-2">
            <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            Dates like 03/04 were read as{" "}
            {dateOrder === "dmy"
              ? "day/month (3 April)"
              : "month/day (March 4)"}
            .
            <button
              type="button"
              className="font-semibold text-primary hover:underline"
              onClick={() =>
                rereadWithOrder(dateOrder === "dmy" ? "mdy" : "dmy")
              }
            >
              Read them as {dateOrder === "dmy" ? "month/day" : "day/month"}{" "}
              instead
            </button>
            <span className="text-muted-foreground">
              (resets edits to pasted rows)
            </span>
          </div>
        )}

        {/* Step 2: review */}
        {account && rows.length > 0 && (
          <section className="rounded-xl border border-border bg-card flex flex-col min-h-0">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border text-sm">
              <span className="font-semibold">{rows.length} rows</span>
              <span className="text-muted-foreground">
                {included.length} selected
              </span>
              {problems.size > 0 && (
                <button
                  type="button"
                  onClick={() => setOnlyAttention((v) => !v)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                    onlyAttention
                      ? "bg-negative text-white"
                      : "bg-negative/10 text-negative hover:bg-negative/20"
                  )}
                >
                  {problems.size} need attention
                  {onlyAttention ? " · show all" : ""}
                </button>
              )}
              {checking && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> Checking
                  for duplicates…
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={addBlankRow}
              >
                <Plus className="w-3.5 h-3.5" /> Add row
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="text-xs text-muted-foreground border-b border-border">
                  <tr className="text-left">
                    <th className="w-9 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all rows"
                        checked={allIncluded}
                        onChange={(e) =>
                          setRows((r) =>
                            r.map((x) => ({ ...x, include: e.target.checked }))
                          )
                        }
                      />
                    </th>
                    <th className="w-36 px-1 py-2 font-medium">Date</th>
                    <th className="px-1 py-2 font-medium">Description</th>
                    <th className="w-32 px-1 py-2 font-medium">Type</th>
                    <th className="w-52 px-1 py-2 font-medium">
                      Category / account
                    </th>
                    <th className="w-28 px-1 py-2 font-medium text-right">
                      Amount
                    </th>
                    <th className="w-56 px-3 py-2 font-medium">Status</th>
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const problem = problems.get(r.id);
                    const isTransfer =
                      r.kind === "transfer_in" || r.kind === "transfer_out";
                    const showCategory = needsCategory(
                      r,
                      account,
                      accountsById
                    );
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b border-border/60 align-top",
                          !r.include && "opacity-50",
                          problem && "bg-negative/5"
                        )}
                      >
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            className="mt-2"
                            aria-label="Include this row"
                            checked={r.include}
                            onChange={(e) =>
                              update(r.id, { include: e.target.checked })
                            }
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="date"
                            className={cellInputClass}
                            value={r.date}
                            aria-invalid={
                              problem === "Enter a date" || undefined
                            }
                            onChange={(e) =>
                              update(r.id, { date: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            className={cellInputClass}
                            value={r.payee}
                            placeholder="Description"
                            aria-invalid={
                              problem === "Enter a description" || undefined
                            }
                            onChange={(e) =>
                              update(r.id, { payee: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-1 py-1">
                          <select
                            className={selectClass}
                            value={r.kind}
                            onChange={(e) => {
                              const kind = e.target.value as RowKind;
                              const toTransfer =
                                kind === "transfer_in" ||
                                kind === "transfer_out";
                              update(r.id, {
                                kind,
                                counterpartId: toTransfer
                                  ? r.counterpartId
                                  : "",
                              });
                            }}
                          >
                            {(Object.keys(KIND_LABELS) as RowKind[]).map(
                              (k) => (
                                <option key={k} value={k}>
                                  {KIND_LABELS[k]}
                                </option>
                              )
                            )}
                          </select>
                        </td>
                        <td className="px-1 py-1">
                          <div className="flex flex-col gap-1">
                            {isTransfer && (
                              <select
                                className={cn(
                                  selectClass,
                                  !r.counterpartId && "text-muted-foreground"
                                )}
                                value={r.counterpartId}
                                aria-invalid={
                                  problem === "Pick the other account" ||
                                  undefined
                                }
                                onChange={(e) =>
                                  update(r.id, {
                                    counterpartId: e.target.value,
                                  })
                                }
                              >
                                <option value="">
                                  {r.kind === "transfer_in"
                                    ? "From account…"
                                    : "To account…"}
                                </option>
                                {counterpartOptions.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {showCategory &&
                              (envelopes.length > 0 ? (
                                <CategorySelect
                                  value={r.envelopeId}
                                  envelopes={envelopes}
                                  invalid={
                                    !!problem?.startsWith("Pick a category")
                                  }
                                  onChange={(id) => setCategory(r, id)}
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground px-1 py-2">
                                  No categories this month — set up the budget
                                  first.
                                </span>
                              ))}
                            {!isTransfer && !showCategory && (
                              <span className="text-xs text-muted-foreground px-2 py-2">
                                {r.kind === "refund"
                                  ? "Cashback / Refund"
                                  : r.kind === "income"
                                    ? "Income"
                                    : "—"}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <input
                            inputMode="decimal"
                            className={cn(
                              cellInputClass,
                              "text-right font-semibold tabular-nums",
                              r.kind === "expense" || r.kind === "transfer_out"
                                ? "text-foreground"
                                : "text-positive"
                            )}
                            value={r.amount}
                            placeholder="0.00"
                            aria-invalid={
                              problem === "Enter an amount" || undefined
                            }
                            onChange={(e) =>
                              update(r.id, { amount: e.target.value })
                            }
                          />
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.include && problem ? (
                            <span className="text-negative font-medium">
                              {problem}
                            </span>
                          ) : r.alreadyImported ? (
                            <span className="text-muted-foreground">
                              Already saved from an earlier paste
                            </span>
                          ) : r.transferAlreadyRecorded ? (
                            <span className="text-muted-foreground">
                              Already recorded from the other account
                            </span>
                          ) : r.duplicates && r.duplicates.length > 0 ? (
                            <span
                              className="text-amber-600 dark:text-amber-400 font-medium flex items-start gap-1"
                              title={r.duplicates
                                .map(
                                  (d) =>
                                    `${shortDate(d.date)} · ${d.payee} · ${formatMoney(d.amount, currency)}`
                                )
                                .join("\n")}
                            >
                              <TriangleAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                              Possible duplicate:{" "}
                              {shortDate(r.duplicates[0].date)} ·{" "}
                              {r.duplicates[0].payee}
                            </span>
                          ) : r.include ? (
                            <span className="text-positive flex items-center gap-1">
                              <CircleCheck className="w-3.5 h-3.5" /> Ready
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              Left out
                            </span>
                          )}
                        </td>
                        <td className="pr-2 py-1">
                          <button
                            type="button"
                            className="p-1.5 mt-0.5 rounded-md text-muted-foreground hover:text-negative hover:bg-negative/10"
                            aria-label="Remove row"
                            onClick={() =>
                              setRows((cur) => cur.filter((x) => x.id !== r.id))
                            }
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {/* Footer: totals and save */}
      {account && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 border-t border-border bg-card flex-shrink-0 text-sm pb-[calc(0.75rem+56px+env(safe-area-inset-bottom))] md:pb-3">
          <span>
            <span className="text-muted-foreground">Money out </span>
            <span className="font-semibold tabular-nums">
              {formatMoney(totals.out, currency)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">Money in </span>
            <span className="font-semibold tabular-nums text-positive">
              {formatMoney(totals.in, currency)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">
              Change to {account.name}{" "}
            </span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                totals.net < 0 ? "text-negative" : "text-positive"
              )}
            >
              {totals.net > 0 ? "+" : ""}
              {formatMoney(totals.net, currency)}
            </span>
          </span>
          <div className="ml-auto flex items-center gap-3">
            {problems.size > 0 && (
              <span className="text-xs text-negative">
                Fix {problems.size} row{problems.size === 1 ? "" : "s"} to save
              </span>
            )}
            <Button
              size="lg"
              onClick={() => void saveAll()}
              disabled={
                included.length === 0 || problems.size > 0 || save.isPending
              }
              title={`${MOD}Enter`}
            >
              {save.isPending && (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              )}
              Save {included.length} transaction
              {included.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
