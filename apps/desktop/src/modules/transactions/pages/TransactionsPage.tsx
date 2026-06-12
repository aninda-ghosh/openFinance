import { ChevronLeft, ChevronRight, Search, X, Edit2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import TransactionForm from "@/components/TransactionForm";
import { cn } from "@/lib/utils";
import { useAccounts, useTransactions, useEnvelopes, useDeleteTransaction } from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";

// ── Types ─────────────────────────────────────────────────────────────────────

type Filters = {
  account_id?: string;
  type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  page: number;
  limit: number;
};

const EMPTY: Filters = { page: 1, limit: 50 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number, type: string) {
  const sign = type === "income" ? "+" : type === "expense" ? "-" : "";
  return `${sign}$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtBalance(amount: number) {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function typeColor(type: string) {
  if (type === "income") return "text-positive";
  if (type === "expense") return "text-negative";
  return "text-info";
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    income: "bg-positive/10 text-positive border-positive/20",
    expense: "bg-negative/10 text-negative border-negative/20",
    transfer: "bg-info/10 text-info border-info/20",
  };
  return (
    <span
      className={cn(
        "text-xs px-2 py-0.5 rounded-full border font-medium capitalize",
        colors[type] ?? ""
      )}
    >
      {type}
    </span>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function Filters({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
}) {
  const { data: accountsData } = useAccounts();

  const accounts = (accountsData as any)?.accounts ?? [];

  const set = (patch: Partial<Filters>) =>
    onChange({ ...filters, ...patch, page: 1 });
  const hasFilters = !!(
    filters.account_id ||
    filters.type ||
    filters.date_from ||
    filters.date_to ||
    filters.search
  );

  return (
    <div className="flex flex-nowrap md:flex-wrap items-center gap-2 overflow-x-auto no-scrollbar pb-1 max-w-full [&>*]:flex-shrink-0">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search payee…"
          value={filters.search ?? ""}
          onChange={(e) => set({ search: e.target.value || undefined })}
          className="pl-8 w-48 h-8 text-sm"
        />
      </div>

      {/* Account */}
      <Select
        value={filters.account_id ?? "all"}
        onValueChange={(v) => set({ account_id: v === "all" ? undefined : v })}
      >
        <SelectTrigger className="h-8 text-sm w-44">
          <SelectValue placeholder="All Accounts" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Accounts</SelectItem>
          {accounts.map((a: any) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Type */}
      <Select
        value={filters.type ?? "all"}
        onValueChange={(v) => set({ type: v === "all" ? undefined : v })}
      >
        <SelectTrigger className="h-8 text-sm w-36">
          <SelectValue placeholder="All Types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          <SelectItem value="income">Income</SelectItem>
          <SelectItem value="expense">Expense</SelectItem>
          <SelectItem value="transfer">Transfer</SelectItem>
        </SelectContent>
      </Select>

      {/* Date from */}
      <Input
        type="date"
        value={filters.date_from ?? ""}
        onChange={(e) => set({ date_from: e.target.value || undefined })}
        className="h-8 text-sm w-36"
        placeholder="From"
      />

      {/* Date to */}
      <Input
        type="date"
        value={filters.date_to ?? ""}
        onChange={(e) => set({ date_to: e.target.value || undefined })}
        className="h-8 text-sm w-36"
        placeholder="To"
      />

      {/* Clear */}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground"
          onClick={() => onChange(EMPTY)}
        >
          <X className="w-3.5 h-3.5" /> Clear
        </Button>
      )}
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  trigger,
  title,
  description,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end pt-3">
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-8"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="text-xs h-8"
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Transaction dialog ───────────────────────────────────────────────────

function EditTransactionDialog({
  txn,
  open,
  onOpenChange,
}: {
  txn: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-[500px] p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-5 py-3.5 border-b border-border bg-muted/20 flex-shrink-0">
          <DialogTitle className="text-sm font-semibold tracking-tight">
            Edit Transaction
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col max-h-[80vh] min-h-0">
          {txn && (
            <TransactionForm
              mode="edit"
              transaction={txn}
              onSuccess={() => onOpenChange(false)}
              onDeleted={() => onOpenChange(false)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TransactionsPage() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    setIsMobile(media.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [editingTxn, setEditingTxn] = useState<any | null>(null);

  const { data, isLoading, isError } = useTransactions(filters as any);
  const txns = (data as any)?.transactions ?? [];
  const total = (data as any)?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.limit));

  const { data: accountsData } = useAccounts();
  const accounts = accountsData?.accounts ?? [];
  const accountMap: Record<string, string> = {};
  const accountCurrencyMap: Record<string, string> = {};
  for (const a of accounts) {
    accountMap[a.id] = a.name;
    accountCurrencyMap[a.id] = a.currency ?? "INR";
  }

  const runningBalances = useMemo(() => {
    const balances: Record<string, number> = {};
    const accountBalances: Record<string, number> = {};
    for (const a of accounts) {
      accountBalances[a.id] = a.balance ?? 0;
    }
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      balances[t.id] = accountBalances[t.account_id] ?? 0;
      
      let delta = 0;
      if (t.type === "income") {
        delta = t.amount;
      } else if (t.type === "expense") {
        delta = -t.amount;
      } else if (t.type === "transfer") {
        if (t.payee === "Transfer in") {
          delta = t.amount;
        } else {
          delta = -t.amount;
        }
      }
      if (t.account_id) {
        accountBalances[t.account_id] = (accountBalances[t.account_id] ?? 0) - delta;
      }
    }
    return balances;
  }, [txns, accounts]);

  const { selectedMonth } = useAppStore();
  useEnvelopes(selectedMonth);
  const { mutate: deleteTxn } = useDeleteTransaction();

  const groupedTxns = useMemo(() => {
    const groups: Record<string, any[]> = {};
    txns.forEach((t: any) => {
      const dateLabel = t.date;
      if (!groups[dateLabel]) {
        groups[dateLabel] = [];
      }
      groups[dateLabel].push(t);
    });
    return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
  }, [txns]);

  function formatDateLabel(dateStr: string) {
    if (!dateStr) return "";
    try {
      const parts = dateStr.slice(0, 10).split("-").map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      if (isNaN(d.getTime())) return dateStr;
      
      const formatKey = (date: Date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };

      const today = formatKey(new Date());
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yest = formatKey(yesterdayDate);

      const targetKey = dateStr.slice(0, 10);
      if (targetKey === today) return "Today";
      if (targetKey === yest) return "Yesterday";

      return d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  }

  const goPage = useCallback(
    (p: number) =>
      setFilters((f) => ({ ...f, page: Math.max(1, Math.min(p, totalPages)) })),
    [totalPages]
  );

  const start = (filters.page - 1) * filters.limit + 1;
  const end = Math.min(filters.page * filters.limit, total);

  return (
    <div className="flex flex-col h-full pb-14 md:pb-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <h1 className="text-xl font-semibold">Transactions</h1>
        {total > 0 && (
          <span className="text-sm text-muted-foreground">
            {total.toLocaleString()} total
          </span>
        )}
      </div>

      {/* Filter bar */}
      <div className="px-6 py-3 border-b border-border flex-shrink-0">
        <Filters filters={filters} onChange={setFilters} />
      </div>

      {/* Table / Cards List */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm font-semibold animate-pulse">
            Loading…
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center h-40 text-red-400 text-sm font-semibold">
            Failed to load transactions.
          </div>
        ) : txns.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm font-semibold">
            No transactions found.
          </div>
        ) : isMobile ? (
          <div className="px-4 py-3 space-y-4">
            {groupedTxns.map(([dateStr, items]) => (
              <div key={dateStr} className="space-y-2">
                <h3 className="text-[11px] font-bold text-muted-foreground/85 tracking-wider uppercase border-b border-border/10 pb-1 select-none">
                  {formatDateLabel(dateStr)}
                </h3>
                <div className="space-y-2">
                  {items.map((txn: any) => {
                    const isCredit = txn.type === "income" || (txn.type === "transfer" && txn.payee === "Transfer in");
                    const amtColor = isCredit ? "text-positive" : "text-negative";
                    const sign = isCredit ? "+" : "−";
                    const acctName = accountMap[txn.account_id] ?? "—";
                    return (
                      <div
                        key={txn.id}
                        onClick={() => setEditingTxn(txn)}
                        className="bg-card border border-border/50 rounded-2xl p-4 flex items-center justify-between gap-4 transition-all active:scale-[0.99] active:bg-muted/10 shadow-sm cursor-pointer"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-sm text-foreground truncate max-w-[160px]">
                              {txn.payee === "Transfer in" || txn.payee === "Transfer out"
                                ? txn.notes || txn.payee
                                : txn.payee}
                            </span>
                            <TypeBadge type={txn.type} />
                          </div>
                          
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-semibold">
                            <span className="truncate max-w-[100px]">{acctName}</span>
                            <span>•</span>
                            <span className="truncate max-w-[120px]">
                              {txn.type === "income" ? (
                                txn.income_category === "cashback" ? (
                                  "Cashback"
                                ) : txn.income_category === "starting_balance" ? (
                                  "Starting Bal"
                                ) : (
                                  "Income"
                                )
                              ) : (
                                txn.envelope_name ?? "Uncategorised"
                              )}
                            </span>
                          </div>
                          {txn.notes && txn.payee !== "Transfer in" && txn.payee !== "Transfer out" && (
                            <p className="text-[11px] text-muted-foreground/80 italic truncate mt-0.5 font-medium">
                              {txn.notes}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-0.5 flex-shrink-0 select-none">
                          <span className={cn("text-sm font-bold tabular-nums", amtColor)}>
                            {sign}${txn.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                          <span className="text-[10px] text-muted-foreground/75 font-bold tabular-nums">
                            {fmtBalance(runningBalances[txn.id] ?? 0)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background border-b border-border z-10">
              <tr className="text-left text-muted-foreground">
                <th className="px-6 py-2.5 font-medium w-28">Date</th>
                <th className="px-4 py-2.5 font-medium w-44">Account</th>
                <th className="px-4 py-2.5 font-medium">Payee</th>
                <th className="px-4 py-2.5 font-medium w-36">Category</th>
                <th className="px-4 py-2.5 font-medium w-24">Type</th>
                <th className="px-6 py-2.5 font-medium text-right w-32">
                  Amount
                </th>
                <th className="px-6 py-2.5 font-medium text-right w-32">
                  Balance
                </th>
                <th className="w-24 px-6 py-2.5 text-right font-medium text-xs uppercase tracking-wider opacity-60">Actions</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((txn: any, i: number) => (
                <tr
                  key={txn.id}
                  onClick={() => setEditingTxn(txn)}
                  className={cn(
                    "border-b border-border/50 hover:bg-muted/30 hover:text-foreground transition-all duration-150 cursor-pointer group select-none",
                    i % 2 === 0 ? "" : "bg-muted/10"
                  )}
                >
                  <td className="px-6 py-2.5 text-muted-foreground tabular-nums">
                    {txn.date}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground truncate max-w-0 w-44">
                    <span className="block truncate">
                      {accountMap[txn.account_id] ?? "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    <div className="truncate max-w-xs">{txn.payee}</div>
                    {txn.notes && (
                      <div className="text-xs text-muted-foreground truncate max-w-xs">
                        {txn.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    <span className="truncate block max-w-[9rem]">
                      {txn.type === "income" ? (
                        txn.income_category === "cashback" ? (
                          <span className="text-positive/80 font-medium">Cashback / Refund</span>
                        ) : txn.income_category === "starting_balance" ? (
                          <span className="text-cyan-500/80 font-medium">Starting Balance</span>
                        ) : (
                          <span className="opacity-80">Regular Income</span>
                        )
                      ) : (
                        txn.envelope_name ?? "—"
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <TypeBadge type={txn.type} />
                  </td>
                  <td
                    className={cn(
                      "px-6 py-2.5 text-right font-medium tabular-nums",
                      typeColor(txn.type)
                    )}
                  >
                    {fmt(txn.amount, txn.type)}
                  </td>
                  <td className="px-6 py-2.5 text-right font-semibold tabular-nums text-foreground/80">
                    {fmtBalance(runningBalances[txn.id] ?? 0)}
                  </td>
                  <td className="px-6 py-2.5 text-right w-24" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-2 justify-end opacity-70 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setEditingTxn(txn)}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        title="Edit Transaction"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <ConfirmDialog
                        title="Delete Transaction?"
                        description={
                          txn.type === "transfer"
                            ? "This transaction is a transfer. Deleting it will automatically delete the matching leg in the other involved account to preserve balance integrity."
                            : "This transaction will be permanently removed. This will instantly adjust the account balance and any budgeted category."
                        }
                        onConfirm={() => {
                          deleteTxn(txn.id, {
                            onSuccess: () => toast.success("Transaction deleted"),
                            onError: (err) => toast.error(err.message),
                          });
                        }}
                        trigger={
                          <button
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-negative transition-colors"
                            title="Delete Transaction"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        }
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > filters.limit && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-border flex-shrink-0 text-sm">
          <span className="text-muted-foreground">
            {start}–{end} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={filters.page <= 1}
              onClick={() => goPage(filters.page - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="px-2 text-muted-foreground">
              {filters.page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={filters.page >= totalPages}
              onClick={() => goPage(filters.page + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      <EditTransactionDialog
        key={editingTxn?.id}
        txn={editingTxn}
        open={editingTxn !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEditingTxn(null);
        }}
      />
    </div>
  );
}
