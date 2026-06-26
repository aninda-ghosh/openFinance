import { convertFromINR, convertToINR, formatCurrency } from "@openfinance/shared/utils";
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Copy,
  CornerUpLeft,
  Info,
  Pencil,
  PlusCircle,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppStore } from "@/stores/app.store";
import TransactionForm from "@/components/TransactionForm";
import {
  useAccounts,
  useCopyPreviousMonthBudget,
  useClearMonthBudget,
  useCreateEnvelope,
  useCreateEnvelopeGroup,
  useCreateRecurring,
  useDeleteEnvelope,
  useDeleteEnvelopeGroup,
  useEnvelopeGroups,
  useEnvelopes,
  useExchangeRates,
  useMonthlySummary,
  useReclaimEnvelope,
  useTransactions,
  useUpdateEnvelope,
  useUpdateTransaction,
} from "../hooks/useBudget";

// ─── Month Selector ────────────────────────────────────────────────────────────

function MonthSelector() {
  const { selectedMonth, setSelectedMonth } = useAppStore();
  const [year, mon] = selectedMonth.split("-").map(Number);
  const label = new Date(year, mon - 1).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  const prev = () => {
    const d = new Date(year, mon - 2);
    setSelectedMonth(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  };
  const next = () => {
    const d = new Date(year, mon);
    setSelectedMonth(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" onClick={prev}>
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <span className="text-sm font-medium w-36 text-center">{label}</span>
      <Button variant="ghost" size="icon" onClick={next}>
        <ChevronRight className="w-4 h-4" />
      </Button>
    </div>
  );
}

// ─── Envelope Group Section ────────────────────────────────────────────────────

function EnvelopeFormDialog({
  trigger,
  title,
  initial,
  onSubmit,
  isPending,
  selectedMonth,
  groups,
}: {
  trigger: React.ReactNode;
  title: string;
  initial?: {
    name: string;
    budgeted: number;
    budget_currency?: string;
    group_id: string;
  };
  onSubmit: (data: {
    name: string;
    budgeted: number;
    budget_currency: string;
    group_id: string;
    month: string;
    rollover_type: "none";
    rollover_amount: number;
  }) => void;
  isPending: boolean;
  selectedMonth: string;
  groups: { id: string; name: string }[];
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [budgeted, setBudgeted] = useState(String(initial?.budgeted ?? 0));
  const [budgetCurrency, setBudgetCurrency] = useState(
    initial?.budget_currency ?? defaultCurrency
  );
  const [groupId, setGroupId] = useState(
    initial?.group_id ?? groups[0]?.id ?? ""
  );

  const reset = () => {
    setName(initial?.name ?? "");
    setBudgeted(String(initial?.budgeted ?? 0));
    setBudgetCurrency(initial?.budget_currency ?? defaultCurrency);
    setGroupId(initial?.group_id ?? groups[0]?.id ?? "");
  };

  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Groceries"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Category</Label>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">
                Add a category first using the + button.
              </p>
            ) : (
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className={sel}
              >
                <option value="">Select category</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Label>Monthly Budget</Label>
              <Input
                type="number"
                value={budgeted}
                onChange={(e) => setBudgeted(e.target.value)}
                placeholder="1000"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Currency</Label>
              <select
                value={budgetCurrency}
                onChange={(e) => setBudgetCurrency(e.target.value)}
                className={sel}
              >
                {["INR", "USD", "SGD", "GBP", "EUR", "JPY", "NTD"].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {budgetCurrency !== "INR" && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
              Budget is in <strong>{budgetCurrency}</strong>. The ₹ equivalent
              is computed automatically using stored exchange rates.
            </p>
          )}
          <Button
            className="w-full"
            onClick={() => {
              if (!name.trim() || !groupId) return;
              onSubmit({
                name: name.trim(),
                budgeted: parseFloat(budgeted) || 0,
                budget_currency: budgetCurrency,
                group_id: groupId,
                month: selectedMonth,
                rollover_type: "none",
                rollover_amount: 0,
              });
              setOpen(false);
              reset();
            }}
            disabled={isPending || !name.trim() || !groupId}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reusable confirm dialog (replaces window.confirm which is blocked in Tauri) ─

function ConfirmDialog({
  trigger,
  title,
  description,
  onConfirm,
  destructive = true,
  confirmLabel = "Delete",
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  onConfirm: () => void;
  destructive?: boolean;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddCategoryDialog({
  onAdd,
  isPending,
}: {
  onAdd: (name: string) => void;
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">
          <PlusCircle className="w-3 h-3 mr-1" />
          Add Category
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Category</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label>Name</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Needs, Wants, Savings, Misc"
              className="mt-1"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  onAdd(name.trim());
                  setOpen(false);
                  setName("");
                }
              }}
            />
          </div>
          <Button
            className="w-full"
            disabled={!name.trim() || isPending}
            onClick={() => {
              onAdd(name.trim());
              setOpen(false);
              setName("");
            }}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type DrillEnvelope = {
  id: string;
  name: string;
  spent: number;
  budgeted_inr: number;
};

function EnvelopeTransactionsSheet({
  envelope,
  dateFrom,
  dateTo,
  fmtBudget,
  onClose,
}: {
  envelope: DrillEnvelope | null;
  dateFrom: string;
  dateTo: string;
  fmtBudget: (n: number) => string;
  onClose: () => void;
}) {
  const { data: txnData } = useTransactions(
    envelope
      ? {
          envelope_id: envelope.id,
          date_from: dateFrom,
          date_to: dateTo,
          limit: 200,
        }
      : { envelope_id: "_none_" }
  );
  const { data: accountsData } = useAccounts();
  const month = dateFrom.slice(0, 7);
  const { data: envelopesData } = useEnvelopes(month);
  const allEnvelopes = envelopesData?.envelopes ?? [];
  const { mutate: updateTxn } = useUpdateTransaction();

  const INCOME_GROUP_NAMES = new Set([
    "Income",
    "Cashback",
    "Starting Balances",
  ]);
  const allowedEnvelopes = allEnvelopes.filter(
    (e: any) => !INCOME_GROUP_NAMES.has(e.group_name)
  );

  const accountMap = (accountsData?.accounts ?? []).reduce<Record<string, any>>(
    (acc, a: any) => {
      acc[a.id] = a;
      return acc;
    },
    {}
  );
  const txns = txnData?.transactions ?? [];
  const balance = (envelope?.budgeted_inr ?? 0) - (envelope?.spent ?? 0);

  return (
    <Sheet
      open={!!envelope}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:w-[520px] sm:max-w-none flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 pt-5 pb-4 border-b pr-14 flex-shrink-0">
          <SheetTitle className="text-base leading-tight">
            {envelope?.name}
          </SheetTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {dateFrom} — {dateTo}
          </p>
          {envelope?.id !== "_uncategorised_" ? (
            <div className="flex gap-4 text-sm mt-2">
              <div>
                <p className="text-xs text-muted-foreground">Budgeted</p>
                <p className="font-semibold">
                  {fmtBudget(envelope?.budgeted_inr ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Net spent</p>
                <p
                  className={`font-semibold ${(envelope?.spent ?? 0) > 0 ? "text-negative" : (envelope?.spent ?? 0) < 0 ? "text-positive" : ""}`}
                >
                  {(envelope?.spent ?? 0) !== 0
                    ? fmtBudget(envelope?.spent ?? 0)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Balance</p>
                <p
                  className={`font-semibold ${balance < 0 ? "text-negative" : balance > 0 ? "text-positive" : "text-muted-foreground"}`}
                >
                  {fmtBudget(balance)}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex gap-4 text-sm mt-2">
              <div>
                <p className="text-xs text-muted-foreground">Total Uncategorised</p>
                <p className="font-semibold text-negative">
                  {fmtBudget(envelope?.spent ?? 0)}
                </p>
              </div>
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {txns.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-16">
              No transactions for this envelope this month.
            </p>
          ) : (
            <div className="divide-y">
              {txns.map((t: any) => {
                const acct = accountMap[t.account_id];
                const currency = acct?.currency ?? t.currency ?? "INR";
                const isCredit =
                  t.type === "transfer" && t.payee === "Transfer in";
                const amountColor = isCredit
                  ? "text-positive"
                  : "text-negative";
                const sign = isCredit ? "+" : "−";
                return (
                  <div
                    key={t.id}
                    className="px-6 py-3 flex items-start justify-between gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {t.payee === "Transfer in" ||
                          t.payee === "Transfer out"
                            ? t.notes || t.payee
                            : t.payee}
                        </span>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${
                            t.type === "expense"
                              ? "bg-negative/10 text-negative"
                              : t.type === "income"
                                ? "bg-positive/10 text-positive"
                                : "bg-info/10 text-info"
                          }`}
                        >
                          {isCredit
                            ? "Transfer in"
                            : t.type === "transfer"
                              ? "Transfer out"
                              : t.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                        <span>{t.date}</span>
                        {acct && (
                          <>
                            <span>·</span>
                            <span>{acct.name}</span>
                          </>
                        )}
                      </div>
                      {t.type === "expense" && (
                        <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                            Envelope:
                          </span>
                          <select
                            value={t.envelope_id ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
updateTxn({
                                id: t.id,
                                data: { envelope_id: val || null }
                              }, {
                                onSuccess: () => toast.success("Transaction categorized"),
                                onError: (err) => {
                                  toast.error("Intent Unfulfilled: Categorization Failed", {
                                    description: err?.message || "Failed to update transaction category. Please check your connection and try again.",
                                    duration: 6000,
                                  });
                                }
                              });
                            }}
                            className="text-[11px] border border-border rounded px-1.5 py-0.5 bg-background truncate max-w-[180px] focus:outline-none focus:ring-1 focus:ring-primary/50 text-foreground cursor-pointer hover:border-muted-foreground/30 transition-colors"
                          >
                            <option value="">📁 Uncategorised</option>
                            {allowedEnvelopes.map((env: any) => (
                              <option key={env.id} value={env.id}>
                                📁 {env.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-sm font-medium tabular-nums flex-shrink-0 ${amountColor}`}
                    >
                      {sign}
                      {formatCurrency(t.amount, currency)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BudgetTable({
  groupedEnvelopes,
  selectedMonth,
  groups,
  fmtBudget,
  setDrillEnvelope,
}: {
  groupedEnvelopes: { group: { id: string; name: string }; envelopes: any[] }[];
  selectedMonth: string;
  groups: { id: string; name: string }[];
  fmtBudget: (n: number) => string;
  setDrillEnvelope: (env: DrillEnvelope | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingBudget, setEditingBudget] = useState<{
    envId: string;
    value: string;
  } | null>(null);

  const { mutate: createEnvelope, isPending: creatingEnv } =
    useCreateEnvelope();
  const { mutate: updateEnvelope } = useUpdateEnvelope();
  const { mutate: deleteEnvelope } = useDeleteEnvelope();
  const { mutate: reclaimEnvelope } = useReclaimEnvelope();
  const { mutate: deleteGroup } = useDeleteEnvelopeGroup();

  // Income transactions for this month — for the income breakdown at the bottom
  const [year, mon] = selectedMonth.split("-").map(Number);
  const dateFrom = `${selectedMonth}-01`;
  const dateTo = `${selectedMonth}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;
  const { data: incomeTxnData } = useTransactions({
    type: "income",
    date_from: dateFrom,
    date_to: dateTo,
    limit: 200,
    off_budget: "false",
  });
  const { data: rates = {} } = useExchangeRates();

  type IncomeGroup = "income" | "cashback" | "starting_balance";
  const INCOME_GROUPS: { key: IncomeGroup; label: string }[] = [
    { key: "income", label: "Income" },
    { key: "cashback", label: "Cashback" },
    { key: "starting_balance", label: "Starting Balances" },
  ];

  const incomeByGroup = (incomeTxnData?.transactions ?? []).reduce<
    Record<IncomeGroup, Record<string, number>>
  >(
    (acc, t: any) => {
      const cat: IncomeGroup = t.income_category ?? "income";
      const inr = convertToINR(t.amount, t.currency as any, rates);
      acc[cat][t.payee] = (acc[cat][t.payee] ?? 0) + inr;
      return acc;
    },
    { income: {}, cashback: {}, starting_balance: {} }
  );

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const saveBudget = (envId: string, value: string) => {
    const n = parseFloat(value);
    if (!Number.isNaN(n)) {
      updateEnvelope(
        { id: envId, data: { budgeted: n } },
        {
          onSuccess: () => toast.success("Budget updated"),
          onError: (e) => toast.error(e.message),
        }
      );
    }
    setEditingBudget(null);
  };

  return (
    <div className="rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30 overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[500px]">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground uppercase tracking-wide">
              Category
            </th>
            <th className="text-right px-4 py-2.5 font-medium text-xs text-muted-foreground uppercase tracking-wide w-36">
              Budgeted
            </th>
            <th className="text-right px-4 py-2.5 font-medium text-xs text-muted-foreground uppercase tracking-wide w-36">
              Spent
            </th>
            <th className="text-right px-4 py-2.5 font-medium text-xs text-muted-foreground uppercase tracking-wide w-36">
              Balance
            </th>
            <th className="w-16 px-2" />
          </tr>
        </thead>
        <tbody>
          {groupedEnvelopes.map(({ group, envelopes }) => {
            const isCollapsed = collapsed.has(group.id);
            const totalBudgeted = envelopes.reduce(
              (s, e) => s + (e.budgeted_inr ?? e.budgeted),
              0
            );
            const totalSpent = envelopes.reduce((s, e) => s + e.spent, 0);
            const totalBalance = totalBudgeted - totalSpent;
            return (
              <Fragment key={group.id}>
                {/* Group header row */}
                <tr
                  className="border-t bg-muted/20 hover:bg-muted/30 cursor-pointer select-none group/grp"
                  onClick={() => toggleGroup(group.id)}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2 font-semibold">
                      {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      )}
                      {group.name}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                    {fmtBudget(totalBudgeted)}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right tabular-nums font-medium ${totalSpent > 0 ? "text-negative" : "text-muted-foreground"}`}
                  >
                    {totalSpent > 0 ? `−${fmtBudget(totalSpent)}` : "—"}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right tabular-nums font-medium ${totalBalance < 0 ? "text-negative" : totalBalance === 0 && totalBudgeted > 0 ? "text-muted-foreground" : ""}`}
                  >
                    {fmtBudget(totalBalance)}
                  </td>
                  <td className="px-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-0.5 justify-end opacity-0 group-hover/grp:opacity-100 transition-opacity">
                      <EnvelopeFormDialog
                        title="Add Envelope"
                        trigger={
                          <button className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground">
                            <PlusCircle className="w-3.5 h-3.5" />
                          </button>
                        }
                        isPending={creatingEnv}
                        selectedMonth={selectedMonth}
                        groups={groups}
                        initial={{ name: "", budgeted: 0, group_id: group.id }}
                        onSubmit={(data) =>
                          createEnvelope(data as any, {
                            onSuccess: () => toast.success("Envelope added"),
                            onError: (e) => toast.error(e.message),
                          })
                        }
                      />
                      <ConfirmDialog
                        trigger={
                          <button className="p-1 rounded hover:bg-background text-muted-foreground hover:text-negative">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        }
                        title={`Delete "${group.name}"?`}
                        description="This will permanently delete this category and all its envelopes. Transactions will be uncategorised."
                        onConfirm={() =>
                          deleteGroup(group.id, {
                            onSuccess: () => toast.success("Category deleted"),
                            onError: (e) => toast.error(e.message),
                          })
                        }
                      />
                    </div>
                  </td>
                </tr>

                {/* Envelope rows */}
                {!isCollapsed &&
                  envelopes.map((env) => {
                    const budgetedInr = env.budgeted_inr ?? env.budgeted;
                    const balance = budgetedInr - env.spent;
                    const isEditing = editingBudget?.envId === env.id;
                    const hasForeignCurrency =
                      env.budget_currency && env.budget_currency !== "INR";
                    return (
                      <tr
                        key={env.id}
                        className="border-t border-border/30 hover:bg-muted/10 group/env text-muted-foreground/80 hover:text-foreground transition-all duration-150"
                      >
                        <td
                          className="px-4 py-2 pl-10 text-sm cursor-pointer hover:text-primary hover:underline underline-offset-2 group-hover/env:font-semibold transition-all duration-150"
                          onClick={() =>
                            setDrillEnvelope({
                              id: env.id,
                              name: env.name,
                              spent: env.spent,
                              budgeted_inr: env.budgeted_inr ?? env.budgeted,
                            })
                          }
                        >
                          {env.name}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-1.5">
                              {hasForeignCurrency && (
                                <span className="text-xs text-muted-foreground">
                                  {env.budget_currency}
                                </span>
                              )}
                              <input
                                type="number"
                                value={editingBudget?.value}
                                onChange={(e) =>
                                  setEditingBudget({
                                    envId: env.id,
                                    value: e.target.value,
                                  })
                                }
                                onBlur={() =>
                                   saveBudget(env.id, editingBudget?.value ?? "")
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    saveBudget(env.id, editingBudget?.value ?? "");
                                  if (e.key === "Escape")
                                    setEditingBudget(null);
                                }}
                                className="w-28 text-right bg-background border rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </div>
                          ) : (
                            <span
                              className="cursor-pointer hover:underline hover:text-primary transition-all duration-150 group-hover/env:font-semibold"
                              title={
                                hasForeignCurrency
                                  ? `${env.budgeted} ${env.budget_currency} — click to edit`
                                  : "Click to edit"
                              }
                              onClick={() =>
                                setEditingBudget({
                                  envId: env.id,
                                  value: String(Math.max(0, env.budgeted)),
                                })
                              }
                            >
                              {fmtBudget(budgetedInr)}
                            </span>
                          )}
                        </td>
                        <td
                          className={`px-4 py-2 text-right tabular-nums cursor-pointer hover:opacity-75 transition-all duration-150 group-hover/env:font-semibold ${env.spent > 0 ? "text-negative" : env.spent < 0 ? "text-positive" : "text-muted-foreground/80 group-hover/env:text-foreground"}`}
                          onClick={() =>
                            setDrillEnvelope({
                              id: env.id,
                              name: env.name,
                              spent: env.spent,
                              budgeted_inr: env.budgeted_inr ?? env.budgeted,
                            })
                          }
                        >
                          {env.spent > 0
                            ? `−${fmtBudget(env.spent)}`
                            : env.spent < 0
                              ? `+${fmtBudget(Math.abs(env.spent))}`
                              : "—"}
                        </td>
                        <td
                          className={`px-4 py-2 text-right tabular-nums transition-all duration-150 group-hover/env:font-semibold ${balance < 0 ? "text-negative" : balance === 0 ? "text-muted-foreground/80 group-hover/env:text-foreground" : ""}`}
                        >
                          {fmtBudget(balance)}
                        </td>
                        <td className="px-2">
                          <div className="flex gap-0.5 justify-end opacity-70 hover:opacity-100 transition-opacity">
                            {balance > 0 && (
                              <ConfirmDialog
                                trigger={
                                  <button
                                    title="Return leftover budget to global pool"
                                    className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-positive"
                                  >
                                    <CornerUpLeft className="w-3 h-3" />
                                  </button>
                                }
                                title={`Return ${fmtBudget(balance)} to pool?`}
                                description={`The ${fmtBudget(balance)} left in "${env.name}" will be returned to your unassigned budget. You can re-allocate it to any envelope at any time.`}
                                confirmLabel="Return to pool"
                                destructive={false}
                                onConfirm={() =>
                                  reclaimEnvelope(env.id, {
                                    onSuccess: (r) =>
                                      toast.success(
                                        `Returned ${fmtBudget(r.reclaimed_inr)} to pool`
                                      ),
                                    onError: (e) => toast.error(e.message),
                                  })
                                }
                              />
                            )}
                            <EnvelopeFormDialog
                              title="Edit Envelope"
                              trigger={
                                <button className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                                  <Pencil className="w-3 h-3" />
                                </button>
                              }
                              initial={{
                                name: env.name,
                                budgeted: Math.max(0, env.budgeted),
                                budget_currency: env.budget_currency,
                                group_id: env.group_id,
                              }}
                              isPending={false}
                              selectedMonth={selectedMonth}
                              groups={groups}
                              onSubmit={({
                                name,
                                budgeted,
                                budget_currency,
                                group_id,
                              }) =>
                                updateEnvelope(
                                  {
                                    id: env.id,
                                    data: {
                                      name,
                                      budgeted,
                                      budget_currency,
                                      group_id,
                                    },
                                  },
                                  {
                                    onSuccess: () =>
                                      toast.success("Envelope updated"),
                                    onError: (e) => toast.error(e.message),
                                  }
                                )
                              }
                            />
                            <ConfirmDialog
                              trigger={
                                <button className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-negative">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              }
                              title={`Delete "${env.name}"?`}
                              description="This envelope will be removed. Transactions assigned to it will become uncategorised."
                              onConfirm={() =>
                                deleteEnvelope(env.id, {
                                  onSuccess: () =>
                                    toast.success("Envelope deleted"),
                                  onError: (e) => toast.error(e.message),
                                })
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            );
          })}

          {/* Income breakdown — three collapsible groups */}
          {INCOME_GROUPS.map(({ key, label }, idx) => {
            const byPayee = incomeByGroup[key];
            const groupTotal = Object.values(byPayee).reduce(
              (s, v) => s + v,
              0
            );
            const hasEntries = Object.keys(byPayee).length > 0;
            const isGroupCollapsed = collapsed.has(`__income_${key}`);
            return (
              <Fragment key={key}>
                <tr
                  className={`${idx === 0 ? "border-t-2 border-positive/30" : "border-t border-positive/20"} bg-positive/5 ${hasEntries ? "cursor-pointer hover:bg-positive/10" : ""}`}
                  onClick={() => hasEntries && toggleGroup(`__income_${key}`)}
                >
                  <td className="px-4 py-2.5 font-semibold text-sm text-positive">
                    <div className="flex items-center gap-2">
                      {hasEntries ? (
                        isGroupCollapsed ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )
                      ) : (
                        <span className="w-3.5" />
                      )}
                      {idx === 0 && <TrendingUp className="w-3.5 h-3.5" />}
                      <span>{label}</span>
                      <span 
                        className="text-[10px] text-muted-foreground/80 font-normal ml-2 flex items-center gap-0.5 select-none" 
                        title="Income totals are compiled dynamically from your real transactions. To edit, go to the Transactions page."
                      >
                        <Info className="w-3 h-3 text-muted-foreground/50" />
                        (Compiled from Transactions)
                      </span>
                    </div>
                  </td>
                  <td colSpan={2} />
                  <td className="px-4 py-2.5 text-right">
                    {groupTotal > 0 ? (
                      <span className="tabular-nums text-positive font-medium">
                        {fmtBudget(groupTotal)}
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Received
                      </span>
                    )}
                  </td>
                  <td />
                </tr>
                {!isGroupCollapsed &&
                  hasEntries &&
                  Object.entries(byPayee)
                    .sort(([, a], [, b]) => b - a)
                    .map(([payee, amount]) => (
                      <tr
                        key={payee}
                        className="border-t border-border/30 hover:bg-muted/10"
                      >
                        <td className="px-4 py-2 pl-10 text-sm text-muted-foreground">
                          {payee}
                        </td>
                        <td colSpan={2} />
                        <td className="px-4 py-2 text-right tabular-nums text-positive font-medium">
                          {fmtBudget(amount)}
                        </td>
                        <td />
                      </tr>
                    ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>

    </div>
  );
}

// ─── Transaction Dialog ────────────────────────────────────────────────────────

function AddTransactionDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusCircle className="w-4 h-4 mr-1" />
          Add Transaction
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[500px] md:max-w-[760px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 py-3.5 border-b border-border bg-muted/20 flex-shrink-0">
          <DialogTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-1.5 select-none">
            <Coins className="w-4 h-4 text-primary" /> New Transaction
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col max-h-[80vh] min-h-0">
          <TransactionForm
            mode="create"
            onSuccess={() => setOpen(false)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Recurring Panel ─────────────────────────────────────────────────────────

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

function AddRecurringDialog({
  accounts,
  envelopes,
  onAdd,
}: {
  accounts: any[];
  envelopes: any[];
  onAdd: (data: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"income" | "expense">("expense");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [envelopeId, setEnvelopeId] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [nextDate, setNextDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  const submit = () => {
    if (!payee.trim() || !amount || !accountId) return;
    onAdd({
      payee: payee.trim(),
      amount: parseFloat(amount),
      type,
      account_id: accountId,
      envelope_id: envelopeId || null,
      frequency,
      next_date: nextDate,
      end_date: endDate || null,
      notes: notes || null,
    });
    setOpen(false);
    setPayee("");
    setAmount("");
    setNotes("");
    setEndDate("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
          <PlusCircle className="w-3 h-3" />
          Add Recurring
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New Recurring Transaction</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label>Payee</Label>
            <Input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="e.g. Netflix"
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as any)}
                className={sel}
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1000"
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label>Account</Label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className={sel}
            >
              {accounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>
              Category{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <select
              value={envelopeId}
              onChange={(e) => setEnvelopeId(e.target.value)}
              className={sel}
            >
              <option value="">None</option>
              {envelopes.map((e: any) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Frequency</Label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                className={sel}
              >
                {Object.entries(FREQ_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>First date</Label>
              <Input
                type="date"
                value={nextDate}
                onChange={(e) => setNextDate(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label>
              End date{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Notes{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button
            className="w-full"
            onClick={submit}
            disabled={!payee.trim() || !amount || !accountId}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RecurringPanel({
  recurring,
  accounts,
  envelopes,
  onDelete,
  fmtBudget,
}: {
  recurring: any[];
  accounts: any[];
  envelopes: any[];
  onDelete: (id: string) => void;
  fmtBudget: (n: number) => string;
}) {
  const { mutate: createRecurring } = useCreateRecurring();
  const accountNameById = Object.fromEntries(
    accounts.map((a: any) => [a.id, a.name])
  );

  if (recurring.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <AddRecurringDialog
            accounts={accounts}
            envelopes={envelopes}
            onAdd={(data) =>
              createRecurring(data, {
                onSuccess: () => toast.success("Recurring transaction added"),
                onError: (e) => toast.error(e.message),
              })
            }
          />
        </div>
        <div className="text-center py-12 text-muted-foreground text-sm border rounded-lg">
          <CalendarClock className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="font-medium mb-1">No recurring transactions</p>
          <p className="text-xs">
            Add salary, rent, subscriptions — they'll be logged automatically
            each period.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <AddRecurringDialog
          accounts={accounts}
          envelopes={envelopes}
          onAdd={(data) =>
            createRecurring(data, {
              onSuccess: () => toast.success("Recurring transaction added"),
              onError: (e) => toast.error(e.message),
            })
          }
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Payee</TableHead>
            <TableHead>Next</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {recurring.map((r: any) => (
            <TableRow key={r.id} className={r.is_active ? "" : "opacity-40"}>
              <TableCell>
                <div className="text-sm font-medium">{r.payee}</div>
                <div className="text-xs text-muted-foreground">
                  {FREQ_LABELS[r.frequency]} ·{" "}
                  {accountNameById[r.account_id] ?? r.account_id}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {r.next_date}
              </TableCell>
              <TableCell
                className={`text-right text-sm font-medium tabular-nums ${r.type === "income" ? "text-positive" : "text-negative"}`}
              >
                {r.type === "income" ? "+" : "−"}
                {fmtBudget(r.amount)}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(r.id)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CopyBudgetButton({ selectedMonth }: { selectedMonth: string }) {
  const { mutate: copyBudget, isPending } = useCopyPreviousMonthBudget();

  const handleCopy = () => {
    const confirmMsg = "Are you sure you want to copy the budgeted amounts and envelopes from the previous month? This will overwrite your budgeted amounts for matching envelopes in the current month.";
    if (window.confirm(confirmMsg)) {
      copyBudget(selectedMonth, {
        onSuccess: (res: any) => {
          toast.success(`Copied and updated ${res.count} envelope budgets successfully!`);
        },
        onError: (e) => toast.error(e.message),
      });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 h-9 text-xs"
      onClick={handleCopy}
      disabled={isPending}
    >
      <Copy className={`w-3.5 h-3.5 ${isPending ? "animate-pulse" : ""}`} />
      {isPending ? "Copying..." : "Copy Last Month's Budget"}
    </Button>
  );
}

function ClearBudgetButton({ selectedMonth }: { selectedMonth: string }) {
  const { mutate: clearBudget, isPending } = useClearMonthBudget();

  const handleClear = () => {
    const confirmMsg = "Are you sure you want to clear the budgeted amounts for the current month? This will set all budgeted amounts in the current month to 0.00.";
    if (window.confirm(confirmMsg)) {
      clearBudget(selectedMonth, {
        onSuccess: (res: any) => {
          toast.success(`Cleared ${res.count} envelope budgets successfully!`);
        },
        onError: (e) => toast.error(e.message),
      });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 h-9 text-xs text-negative hover:bg-negative/10 border-negative/30 hover:border-negative/50"
      onClick={handleClear}
      disabled={isPending}
    >
      <Trash2 className={`w-3.5 h-3.5 ${isPending ? "animate-pulse" : ""}`} />
      {isPending ? "Clearing..." : "Clear Budget"}
    </Button>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function BudgetPage() {
  const { selectedMonth, defaultCurrency } = useAppStore();
  const {
    data: envelopesData,
    isLoading: envLoading,
    error: envError,
  } = useEnvelopes(selectedMonth);
  const { data: groupsData, isLoading: groupsLoading } = useEnvelopeGroups();
  const { data: summary } = useMonthlySummary(selectedMonth);
  const { data: rates = {} } = useExchangeRates();
  const { mutate: createGroup, isPending: creatingGroup } =
    useCreateEnvelopeGroup();

  const [drillEnvelope, setDrillEnvelope] = useState<DrillEnvelope | null>(null);

  // Converts an INR amount to the user's global default currency and formats it
  const fmtBudget = (amountInr: number) =>
    formatCurrency(
      convertFromINR(amountInr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const allEnvelopes: any[] = (envelopesData as any)?.envelopes ?? [];
  const groups: { id: string; name: string; sort_order: number }[] =
    groupsData?.groups ?? [];

  const INCOME_GROUP_NAMES = new Set([
    "Income",
    "Cashback",
    "Starting Balances",
  ]);

  // Group envelopes by group_id — exclude income groups (rendered separately below)
  const groupedEnvelopes = groups
    .filter((g) => !INCOME_GROUP_NAMES.has(g.name))
    .map((g) => ({
      group: g,
      envelopes: allEnvelopes.filter((e) => e.group_id === g.id),
    }));
  // Orphaned envelopes (no matching group in current list) — shouldn't normally happen
  const orphaned = allEnvelopes.filter(
    (e) => !groups.find((g) => g.id === e.group_id)
  );

  const incomeGroupIds = new Set(
    groups.filter((g) => INCOME_GROUP_NAMES.has(g.name)).map((g) => g.id)
  );

  // To Budget = income received this month − total already assigned to envelopes (in INR)
  // Exclude income groups — they don't consume budget
  const totalBudgeted = allEnvelopes
    .filter((e) => !incomeGroupIds.has(e.group_id))
    .reduce((s, e) => s + (e.budgeted_inr ?? e.budgeted), 0);
  const carryover = summary?.carryover_from_previous ?? 0;
  const toBudget = summary
    ? summary.total_income + carryover - totalBudgeted
    : null;

  const [year, mon] = selectedMonth.split("-").map(Number);
  const dateFrom = `${selectedMonth}-01`;
  const dateTo = `${selectedMonth}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;

  const totalSpentEnvelopes = allEnvelopes
    .filter((e) => !incomeGroupIds.has(e.group_id))
    .reduce((s, e) => s + (e.spent ?? 0), 0);
  const uncategorizedAmount = Math.max(
    0,
    (summary?.total_expenses ?? 0) - totalSpentEnvelopes
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Budget</h1>
          {summary && (
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
              <span>Income: </span>
              <span className="text-positive font-medium">
                {fmtBudget(summary.total_income)}
              </span>
              <span>·</span>
              <span>Expenses: </span>
              <span className="text-negative font-medium">
                {fmtBudget(summary.total_expenses)}
              </span>
              {uncategorizedAmount > 0.01 && (
                <>
                  <span>·</span>
                  <button
                    onClick={() =>
                      setDrillEnvelope({
                        id: "_uncategorised_",
                        name: "Uncategorised Transactions",
                        spent: uncategorizedAmount,
                        budgeted_inr: 0,
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-negative/10 text-negative hover:bg-negative/20 active:scale-95 transition-all duration-150 border border-negative/20 cursor-pointer shadow-sm"
                    title="Click to view uncategorised transactions"
                  >
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-negative opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-negative"></span>
                    </span>
                    <span>Uncategorised: {fmtBudget(uncategorizedAmount)}</span>
                  </button>
                </>
              )}
              <span>·</span>
              <span>Net: </span>
              <span className="font-medium">{fmtBudget(summary.net)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClearBudgetButton selectedMonth={selectedMonth} />
          <CopyBudgetButton selectedMonth={selectedMonth} />
          <MonthSelector />
          <AddTransactionDialog />
        </div>
      </div>

      {/* To Budget banner */}
      {toBudget !== null && (
        <div
          className={`flex items-center justify-between rounded-3xl px-5 py-4 border border-border/80 border-b-2 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-0.5 hover:shadow-sm ${
            toBudget > 0
              ? "bg-positive/10 border-positive/30 border-b-positive/50"
              : toBudget < 0
                ? "bg-negative/10 border-negative/30 border-b-negative/50"
                : "bg-muted/50 border-border"
          }`}
        >
          <div>
            <p className="text-sm font-semibold">
              {toBudget > 0
                ? "Ready to assign"
                : toBudget < 0
                  ? "Over-budgeted"
                  : "Fully assigned"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {toBudget > 0
                ? `${fmtBudget(toBudget)} available${
                    carryover > 0.01
                      ? ` (incl. ${fmtBudget(carryover)} leftover from prior months)`
                      : carryover < -0.01
                        ? ` (incl. ${fmtBudget(carryover)} overspent in prior months)`
                        : ""
                  }`
                : toBudget < 0
                  ? `You've budgeted ${fmtBudget(-toBudget)} more than you've received${
                      carryover > 0.01
                        ? ` (incl. ${fmtBudget(carryover)} leftover from prior months)`
                        : carryover < -0.01
                          ? ` (incl. ${fmtBudget(carryover)} overspent in prior months)`
                          : ""
                    }`
                  : "Every unit of income is assigned — nice!"}
            </p>
          </div>
          <span
            className={`text-xl font-bold tabular-nums ${toBudget > 0 ? "text-positive" : toBudget < 0 ? "text-negative" : "text-muted-foreground"}`}
          >
            {fmtBudget(Math.abs(toBudget))}
          </span>
        </div>
      )}

      {/* Envelope columns */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
            Envelopes
          </h2>
          <AddCategoryDialog
            onAdd={(name) =>
              createGroup(name, {
                onSuccess: () => toast.success(`Category "${name}" created`),
                onError: (e) => toast.error(e.message),
              })
            }
            isPending={creatingGroup}
          />
        </div>

        {envError && (
          <Alert variant="destructive">
            <AlertDescription>Failed to load envelopes.</AlertDescription>
          </Alert>
        )}

        {envLoading || groupsLoading ? (
          <div className="rounded-lg border overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-4 px-4 py-3 border-b">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-24 ml-auto" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm border rounded-lg">
            <p className="font-medium mb-1">No categories yet</p>
            <p className="text-xs">
              Click "Add Category" to create your first one (e.g. Needs, Wants,
              Savings).
            </p>
          </div>
        ) : (
          <>
            <BudgetTable
              groupedEnvelopes={groupedEnvelopes}
              selectedMonth={selectedMonth}
              groups={groups}
              fmtBudget={fmtBudget}
              setDrillEnvelope={setDrillEnvelope}
            />
            {orphaned.length > 0 && (
              <div className="text-xs text-muted-foreground px-1">
                {orphaned.length} uncategorised envelope
                {orphaned.length > 1 ? "s" : ""} hidden.
              </div>
            )}
          </>
        )}
      </div>

      <EnvelopeTransactionsSheet
        envelope={drillEnvelope}
        dateFrom={dateFrom}
        dateTo={dateTo}
        fmtBudget={fmtBudget}
        onClose={() => setDrillEnvelope(null)}
      />
    </div>
  );
}
