import type { InvestmentResponse } from "@openfinance/shared/api-contracts";
import { SUPPORTED_CURRENCIES } from "@openfinance/shared/schemas";
import {
  convertFromINR,
  formatCurrency,
  formatINR,
} from "@openfinance/shared/utils";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Coins,
  Layers,
  List,
  Pencil,
  PlusCircle,
  RefreshCw,
  Trash2,
  History,
  FileText,
} from "lucide-react";
import { useState, useMemo, Fragment, useEffect } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { AccountFormDialog } from "@/components/AccountFormDialog";
import { useAppStore } from "@/stores/app.store";
import {
  useAccounts,
  useCreateAccount,
  useCreateTransaction,
  useCreateTransfer,
  useDeleteAccount,
  useDeleteTransaction,
  useEnvelopes,
  useExchangeRates,
  useTransactions,
  useUpdateAccount,
} from "@/modules/budget/hooks/useBudget";
import {
  useCreateInvestment,
  useDeleteInvestment,
  useInvestments,
  usePortfolioSummary,
  useRefreshPrice,
  useUpdateInvestment,
  useValueHistory,
} from "../hooks/useInvestments";
import { budgetApi } from "@/modules/budget/api";
import { InvestmentDocuments } from "../components/InvestmentDocuments";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
];
const ASSET_TYPES = [
  "mutual_fund",
  "stock",
  "etf",
  "fd",
  "savings",
  "bond",
  "real_estate",
  "cash",
  "structured",
  "other",
];
const ASSET_LABELS: Record<string, string> = {
  mutual_fund: "Mutual Fund",
  stock: "Stock",
  etf: "ETF",
  fd: "FD",
  savings: "Savings Account",
  bond: "Bond",
  real_estate: "Real Estate",
  cash: "Cash",
  structured: "Structured",
  other: "Other",
  investment: "Investment Account",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function MoneyCell({
  native,
  nativeCurrency,
  inr,
}: {
  native: number;
  nativeCurrency: string;
  inr: number;
}) {
  const isINR = nativeCurrency === "INR";
  return (
    <div className="text-right">
      <div className="font-medium tabular-nums">
        {formatCurrency(native, nativeCurrency as any)}
      </div>
      {!isINR && (
        <div className="text-xs text-muted-foreground tabular-nums">
          ≈ {formatINR(inr)}
        </div>
      )}
    </div>
  );
}

function GainLossCell({
  inv,
  fmt,
}: {
  inv: InvestmentResponse;
  fmt: (inr: number) => string;
}) {
  const pos = inv.gain_loss_inr >= 0;
  const pct = inv.gain_loss_pct;
  return (
    <div
      className={`text-right font-medium tabular-nums ${pos ? "text-positive" : "text-negative"}`}
    >
      <div>
        {pos ? "+" : ""}
        {fmt(inv.gain_loss_inr)}
      </div>
      <div className="text-xs opacity-80">
        {pos ? "+" : ""}
        {pct.toFixed(2)}%
      </div>
    </div>
  );
}

function formatDateLabel(dateStr: string) {
  if (!dateStr) return "";
  try {
    const parts = dateStr.slice(0, 10).split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (Number.isNaN(d.getTime())) return dateStr;
    
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    
    const formatKey = (date: Date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const targetKey = dateStr.slice(0, 10);
    
    if (targetKey === formatKey(today)) {
      return "Today, " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    if (targetKey === formatKey(yesterday)) {
      return "Yesterday, " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    
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

// ─── Linked Account Transactions Sheet ───────────────────────────────────────

function LinkedAccountSheet({
  account,
  open,
  onOpenChange,
  allAccounts,
}: {
  account: any;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  allAccounts: any[];
}) {
  const { data } = useTransactions({ account_id: account.id, limit: 200 });
  const { mutate: deleteTxn } = useDeleteTransaction();
  const { mutate: createTxn, isPending: creating } = useCreateTransaction();
  const { mutate: createTransfer, isPending: transferring } =
    useCreateTransfer();
  const { defaultCurrency, selectedMonth } = useAppStore();
  const { data: rates = {} } = useExchangeRates();
  const { data: envelopesData } = useEnvelopes(selectedMonth);

  const txns = data?.transactions ?? [];

  const runningBalances = useMemo(() => {
    const balances: Record<string, number> = {};
    let current = account?.balance ?? 0;
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      balances[t.id] = current;
      
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
      current -= delta;
    }
    return balances;
  }, [txns, account?.balance]);

  const showHint = account.currency !== defaultCurrency;
  const fmtDefault = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const allEnvelopes = (envelopesData as any)?.envelopes ?? [];
  const envelopesByGroup = (allEnvelopes as any[]).reduce<
    { groupId: string; groupName: string; items: any[] }[]
  >((acc, env: any) => {
    const existing = acc.find((g) => g.groupId === env.group_id);
    if (existing) existing.items.push(env);
    else
      acc.push({
        groupId: env.group_id,
        groupName: env.group_name ?? "Other",
        items: [env],
      });
    return acc;
  }, []);

  const [tab, setTab] = useState<"income" | "expense" | "transfer">("income");
  const [transferDir, setTransferDir] = useState<"out" | "in">("out");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [toAccount, setToAccount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [envelope, setEnvelope] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const resetForm = () => {
    setPayee("");
    setAmount("");
    setToAccount("");
    setToAmount("");
    setEnvelope("");
    setDate(new Date().toISOString().slice(0, 10));
  };

  const otherAcc = allAccounts.find((a: any) => a.id === toAccount);
  const sameCurrency = otherAcc?.currency === account.currency;

  const submitTxn = () => {
    if (tab === "transfer") {
      if (!toAccount || !amount) return;
      const fromId = transferDir === "out" ? account.id : toAccount;
      const toId = transferDir === "out" ? toAccount : account.id;
      const fromAmt = parseFloat(amount);
      const toAmt = sameCurrency ? fromAmt : parseFloat(toAmount || amount);
      createTransfer(
        {
          from_account_id: fromId,
          to_account_id: toId,
          amount: fromAmt,
          to_amount: toAmt,
          date,
          notes: payee || undefined,
          envelope_id: envelope || undefined,
        },
        {
          onSuccess: () => {
            toast.success("Transfer recorded");
            resetForm();
          },
          onError: (e) => {
            toast.error("Intent Unfulfilled: Transfer Not Saved", {
              description: e?.message || "Failed to record transfer. Please check your connection and try again.",
              duration: 6000,
            });
          },
        }
      );
    } else {
      if (!payee.trim() || !amount) return;
      createTxn(
        {
          account_id: account.id,
          payee: payee.trim(),
          amount: parseFloat(amount),
          type: tab,
          date,
        },
        {
          onSuccess: () => {
            toast.success("Transaction added");
            resetForm();
          },
          onError: (e) => {
            toast.error("Intent Unfulfilled: Transaction Not Saved", {
              description: e?.message || "Failed to add transaction. Please check your connection and try again.",
              duration: 6000,
            });
          },
        }
      );
    }
  };

  const sel =
    "w-full border border-border/60 rounded-xl px-2.5 py-1.5 text-xs mt-1 h-9 bg-background focus:ring-2 focus:ring-primary/10 focus:border-primary transition-all duration-200 font-semibold cursor-pointer shadow-sm";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:w-[640px] sm:max-w-none flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 pt-5 pb-4 border-b flex-shrink-0 pr-14">
          <SheetTitle className="text-lg">{account.name}</SheetTitle>
          <p className="text-sm text-muted-foreground">
            Balance:{" "}
            <span className="font-semibold text-foreground">
              {formatCurrency(account.balance, account.currency)}
            </span>
            {showHint && (
              <span className="ml-1.5 text-xs">
                ≈ {fmtDefault(account.balance_inr)}
              </span>
            )}
            <span className="ml-2 text-xs bg-muted rounded px-1.5 py-0.5">
              {account.currency}
            </span>
          </p>
        </SheetHeader>

        {/* Floating Quick Entry Form */}
        <div className="bg-card border border-border/30 rounded-3xl p-5 shadow-sm mx-6 my-4 flex-shrink-0 animate-fade-in">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80 mb-3 flex items-center gap-1.5 select-none">
            <Coins className="w-3.5 h-3.5 text-primary" /> Add Record
          </p>
          <div className="flex rounded-xl bg-muted p-1 gap-1 text-xs mb-4 select-none">
            {(["income", "expense", "transfer"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  resetForm();
                }}
                className={`flex-1 py-1.5 capitalize font-bold rounded-lg transition-all duration-200 relative select-none ${
                  tab === t
                    ? "bg-primary text-primary-foreground shadow-sm active:scale-[0.98]"
                    : "text-muted-foreground/80 hover:text-foreground font-semibold"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "transfer" ? (
            <div className="space-y-3 text-xs animate-fade-in">
              <div className="flex rounded-xl bg-muted p-1 gap-1 text-xs mb-2 select-none">
                <button
                  onClick={() => {
                    setTransferDir("out");
                    setToAccount("");
                    setToAmount("");
                  }}
                  className={`flex-1 py-1 capitalize font-bold rounded-lg transition-all duration-200 relative select-none ${
                    transferDir === "out"
                      ? "bg-background text-foreground shadow-sm active:scale-[0.98]"
                      : "text-muted-foreground/80 hover:text-foreground font-semibold"
                  }`}
                >
                  Send from {account.name}
                </button>
                <button
                  onClick={() => {
                    setTransferDir("in");
                    setToAccount("");
                    setToAmount("");
                  }}
                  className={`flex-1 py-1 capitalize font-bold rounded-lg transition-all duration-200 relative select-none ${
                    transferDir === "in"
                      ? "bg-background text-foreground shadow-sm active:scale-[0.98]"
                      : "text-muted-foreground/80 hover:text-foreground font-semibold"
                  }`}
                >
                  Deposit into {account.name}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">
                    {transferDir === "out" ? "To account" : "From account"}
                  </Label>
                  <select
                    value={toAccount}
                    onChange={(e) => {
                      setToAccount(e.target.value);
                      setToAmount("");
                    }}
                    className={sel}
                  >
                    <option value="">Select account</option>
                    {allAccounts
                      .filter((a: any) => a.id !== account.id)
                      .map((a: any) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.currency})
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Amount ({account.currency})</Label>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
              </div>
              {!sameCurrency && otherAcc && (
                <div className="animate-fade-in">
                  <Label className="text-xs text-muted-foreground font-bold select-none">
                    {transferDir === "out"
                      ? `Received (${otherAcc.currency})`
                      : `Deducted (${otherAcc.currency})`}
                  </Label>
                  <Input
                    type="number"
                    value={toAmount}
                    onChange={(e) => setToAmount(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Notes (optional)</Label>
                  <Input
                    value={payee}
                    onChange={(e) => setPayee(e.target.value)}
                    placeholder="e.g. Monthly transfer"
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Date</Label>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
                {envelopesByGroup.length > 0 && (
                  <div className="col-span-2">
                    <Label className="text-xs text-muted-foreground font-bold select-none">
                      Category{" "}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </Label>
                    <select
                      value={envelope}
                      onChange={(e) => setEnvelope(e.target.value)}
                      className={sel}
                    >
                      <option value="">None</option>
                      {envelopesByGroup.map(({ groupId, groupName, items }) => (
                        <optgroup key={groupId} label={groupName}>
                          {items.map((env: any) => (
                            <option key={env.id} value={env.id}>
                              {env.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <Button
                className="w-full h-9 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-bold tracking-wide text-xs shadow-md hover:shadow-primary/10 active:scale-[0.98] transition-all duration-200 mt-2"
                onClick={submitTxn}
                disabled={
                  transferring ||
                  !toAccount ||
                  !amount ||
                  (!sameCurrency && !toAmount && !!otherAcc)
                }
              >
                Record Transfer
              </Button>
            </div>
          ) : (
            <div className="space-y-3 text-xs animate-fade-in">
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Payee</Label>
                  <Input
                    value={payee}
                    onChange={(e) => setPayee(e.target.value)}
                    placeholder={tab === "income" ? "e.g. Interest" : "e.g. Fee"}
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Amount ({account.currency})</Label>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Date</Label>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
              </div>
              <Button
                className="w-full h-9 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-bold tracking-wide text-xs shadow-md hover:shadow-primary/10 active:scale-[0.98] transition-all duration-200 mt-2"
                onClick={submitTxn}
                disabled={creating || !payee.trim() || !amount}
              >
                Record {tab}
              </Button>
            </div>
          )}
        </div>

        {/* Transaction list */}
        <div className="flex-1 overflow-y-auto">
          {txns.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground text-xs leading-relaxed select-none">
              No transactions listed for this account.
            </div>
          ) : (
            <div className="flex flex-col">
              {txns.map((t: any, i: number) => {
                const showDateHeader = i === 0 || t.date !== txns[i - 1].date;
                return (
                  <Fragment key={t.id}>
                    {showDateHeader && (
                      <div className="bg-muted/40 px-6 py-2 border-y border-border/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 select-none sticky top-0 backdrop-blur z-10 animate-fade-in">
                        {formatDateLabel(t.date)}
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/20 group/txn transition-colors relative border-b border-border/20 last:border-0 bg-background/5">
                      {/* Left: Payee + Badges */}
                      <div className="min-w-0 flex-1 pr-4">
                        <p className="text-xs font-bold text-foreground truncate pr-10">
                          {t.payee}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {t.type === "transfer" && (
                            <span className="bg-blue-500/10 text-blue-500 font-bold px-1.5 py-0.5 rounded text-[9px] border border-blue-500/10 select-none">
                              Transfer
                            </span>
                          )}
                          {t.income_category && (
                            <span className="bg-primary/10 text-primary font-bold px-1.5 py-0.5 rounded text-[9px] border border-primary/10 select-none capitalize">
                              {t.income_category.replace("_", " ")}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right: Stacked Amount & Running Balance */}
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <div className="text-right">
                          <p
                            className={`text-xs font-extrabold tabular-nums select-all ${
                              t.type === "income"
                                ? "text-positive"
                                : t.type === "expense"
                                ? "text-negative"
                                : "text-primary"
                            }`}
                          >
                            {t.type === "income"
                              ? "+"
                              : t.type === "expense"
                              ? "−"
                              : "⇄"}
                            {formatCurrency(t.amount, account.currency)}
                          </p>
                          <p className="text-[10px] text-muted-foreground/80 font-bold tabular-nums mt-1 select-all">
                            {formatCurrency(runningBalances[t.id] ?? 0, account.currency)}
                          </p>
                          {showHint && (
                            <p className="text-[9px] text-muted-foreground/60 font-semibold tabular-nums mt-0.5">
                              ≈{" "}
                              {fmtDefault(
                                t.amount * (rates[account.currency] ?? 1)
                              )}
                            </p>
                          )}
                        </div>

                        {/* Action buttons (float on hover) */}
                        <div className="opacity-0 group-hover/txn:opacity-100 flex items-center gap-1 bg-background/90 backdrop-blur rounded-lg p-0.5 border border-border/40 shadow-md transition-opacity duration-150 absolute right-4 top-1/2 -translate-y-1/2 z-20">
                          <button
                            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-negative transition-colors duration-150"
                            onClick={() => {
                              const confirmMsg = t.type === "transfer"
                                ? "This transaction is a transfer. Deleting it will automatically delete the matching leg in the other involved account to preserve balance integrity. Are you sure you want to proceed?"
                                : "Are you sure you want to delete this transaction?";
                              if (window.confirm(confirmMsg)) {
                                deleteTxn(t.id, {
                                  onSuccess: () => toast.success("Deleted"),
                                });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Linked Account Edit Dialog ───────────────────────────────────────────────

function LinkedAccountEditDialog({
  account,
  trigger,
}: {
  account: any;
  trigger: React.ReactNode;
}) {
  const { mutate: update, isPending } = useUpdateAccount();

  const submit = (data: any) => {
    update(
      {
        id: account.id,
        data,
      },
      {
        onSuccess: () => {
          toast.success("Account updated");
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  return (
    <AccountFormDialog
      title="Edit Account"
      trigger={trigger}
      initial={account}
      onSubmit={submit}
      isPending={isPending}
    />
  );
}

// ─── Add Linked Account Dialog ────────────────────────────────────────────────

function AddLinkedAccountDialog({ trigger }: { trigger: React.ReactNode }) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { mutate: create, isPending } = useCreateAccount();

  const submit = (data: any) => {
    create(
      data,
      {
        onSuccess: () => {
          toast.success("Account added");
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  return (
    <AccountFormDialog
      title="Add Investment Account"
      trigger={trigger}
      initial={{
        name: "",
        type: "investment",
        currency: defaultCurrency,
        balance: 0,
        off_budget: true,
      }}
      onSubmit={submit}
      isPending={isPending}
    />
  );
}

// ─── Update Value Dialog ──────────────────────────────────────────────────────

function UpdateValueDialog({
  account,
  trigger,
}: {
  account: any;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [newValue, setNewValue] = useState("");
  const { mutate: createTxn, isPending } = useCreateTransaction();

  const currentBalance = account.balance as number;
  const parsed = parseFloat(newValue);
  const delta = !Number.isNaN(parsed) ? parsed - currentBalance : null;
  const isGain = delta !== null && delta > 0;

  const submit = () => {
    if (delta === null || delta === 0) {
      setOpen(false);
      return;
    }
    createTxn(
      {
        account_id: account.id,
        payee: "Valuation Update",
        amount: Math.abs(delta),
        type: isGain ? "income" : "expense",
        date: new Date().toISOString().slice(0, 10),
        notes: `Value updated from ${formatCurrency(currentBalance, account.currency)} to ${formatCurrency(parsed, account.currency)}`,
      },
      {
        onSuccess: () => {
          toast.success("Value updated");
          setOpen(false);
          setNewValue("");
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setNewValue(String(currentBalance));
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Update Value — {account.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current value: </span>
            <span className="font-semibold">
              {formatCurrency(currentBalance, account.currency)}
            </span>
          </div>
          <div>
            <Label>New Value ({account.currency})</Label>
            <Input
              type="number"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={String(currentBalance)}
              className="mt-1"
              autoFocus
            />
          </div>
          {delta !== null && delta !== 0 && (
            <div
              className={`rounded-md px-3 py-2 text-sm font-medium ${isGain ? "bg-positive/10 text-positive" : "bg-negative/10 text-negative"}`}
            >
              {isGain ? "Gain" : "Loss"}: {isGain ? "+" : "−"}
              {formatCurrency(Math.abs(delta), account.currency)} will be
              recorded as a {isGain ? "income" : "expense"} transaction.
            </div>
          )}
          <Button
            className="w-full"
            onClick={submit}
            disabled={isPending || delta === null || delta === 0}
          >
            Record Update
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add / Edit Dialog ────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  asset_type: "mutual_fund",
  currency: "INR",
  purchase_value: "",
  current_value: "",
  purchase_date: new Date().toISOString().slice(0, 10),
  units: "",
  notes: "",
  account_id: "",
};

function InvestmentFormDialog({
  trigger,
  title,
  initial,
  onSubmit,
  isPending,
}: {
  trigger: React.ReactNode;
  title: string;
  initial?: typeof EMPTY_FORM;
  onSubmit: (data: any) => void;
  isPending: boolean;
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const emptyForm = { ...EMPTY_FORM, currency: defaultCurrency };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initial ?? emptyForm);
  const set =
    (k: string) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >
    ) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const { data: accountsData } = useAccounts();
  const parentAccounts = (accountsData?.accounts ?? []).filter((a: any) =>
    ["investment", "checking", "savings", "cash"].includes(a.type)
  );

  const isINR = form.currency === "INR";

  const submit = () => {
    if (!form.name.trim() || !form.purchase_value || !form.purchase_date)
      return;
    onSubmit({
      name: form.name.trim(),
      asset_type: form.asset_type,
      currency: form.currency,
      purchase_value: parseFloat(form.purchase_value),
      current_value: parseFloat(form.current_value || form.purchase_value),
      purchase_date: form.purchase_date,
      units: form.units ? parseFloat(form.units) : undefined,
      notes: form.notes || undefined,
      account_id: form.account_id || null,
    });
    setOpen(false);
  };

  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setForm(initial ?? emptyForm);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={set("name")}
              placeholder="e.g. S&P 500 Index Fund"
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Asset Type</Label>
              <select
                value={form.asset_type}
                onChange={set("asset_type")}
                className={sel}
              >
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ASSET_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Currency</Label>
              <select
                value={form.currency}
                onChange={set("currency")}
                className={sel}
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Purchase Value{" "}
                <span className="text-muted-foreground text-xs">
                  ({form.currency})
                </span>
              </Label>
              <Input
                type="number"
                value={form.purchase_value}
                onChange={set("purchase_value")}
                placeholder="50000"
                className="mt-1"
              />
            </div>
            <div>
              <Label>
                Current Value{" "}
                <span className="text-muted-foreground text-xs">
                  ({form.currency})
                </span>
              </Label>
              <Input
                type="number"
                value={form.current_value}
                onChange={set("current_value")}
                placeholder="55000"
                className="mt-1"
              />
            </div>
          </div>

          {!isINR && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
              Values are in <strong>{form.currency}</strong>. The INR equivalent
              will be calculated automatically using stored exchange rates.
              Refresh rates in Settings if needed.
            </p>
          )}

          <div>
            <Label>Parent Account</Label>
            <select
              value={form.account_id || ""}
              onChange={set("account_id")}
              className={sel}
            >
              <option value="">No parent account (Standalone)</option>
              {parentAccounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Units{" "}
                <span className="text-muted-foreground text-xs">
                  (optional)
                </span>
              </Label>
              <Input
                type="number"
                value={form.units}
                onChange={set("units")}
                placeholder="100.5"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Purchase Date</Label>
              <Input
                type="date"
                value={form.purchase_date}
                onChange={set("purchase_date")}
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <Label>
              Notes{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={form.notes}
              onChange={set("notes")}
              placeholder="e.g. monthly auto-invest, direct"
              className="mt-1"
            />
          </div>

          <Button
            className="w-full"
            onClick={submit}
            disabled={isPending || !form.name.trim() || !form.purchase_value}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Investment History Sheet ─────────────────────────────────────────────────

function InvestmentHistorySheet({
  inv,
  open,
  onOpenChange,
  fmt,
}: {
  inv: InvestmentResponse | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fmt: (inr: number) => string;
}) {
  const { data: historyData, isLoading } = useValueHistory(inv?.id ?? null);
  const history = historyData?.history ?? [];
  const [activeTab, setActiveTab] = useState<"history" | "documents">("history");

  useEffect(() => {
    if (!open) {
      setActiveTab("history");
    }
  }, [open, inv?.id]);

  const fmtNative = (v: number) =>
    inv ? formatCurrency(v, inv.currency as any) : String(v);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:w-[480px] sm:max-w-none flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 pt-5 pb-4 border-b pr-14 flex-shrink-0">
          <SheetTitle className="text-base leading-tight truncate">
            {inv?.name}
          </SheetTitle>
          <div className="flex gap-1 mt-1 flex-wrap">
            <Badge variant="secondary" className="text-xs">
              {ASSET_LABELS[inv?.asset_type ?? ""] ?? inv?.asset_type}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {inv?.currency}
            </Badge>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Purchase</p>
              <p className="font-semibold">
                {inv ? fmtNative(inv.purchase_value) : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {inv?.purchase_date}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Current</p>
              <p className="font-semibold">
                {inv ? fmtNative(inv.current_value) : "—"}
              </p>
              {inv?.current_value_at && (
                <p className="text-xs text-muted-foreground">
                  {new Date(inv.current_value_at).toLocaleDateString()}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Gain / Loss</p>
              <p
                className={`font-semibold ${(inv?.gain_loss_inr ?? 0) >= 0 ? "text-positive" : "text-negative"}`}
              >
                {inv ? fmt(inv.gain_loss_inr) : "—"}
              </p>
              <p
                className={`text-xs ${(inv?.gain_loss_pct ?? 0) >= 0 ? "text-positive" : "text-negative"}`}
              >
                {inv
                  ? `${inv.gain_loss_pct >= 0 ? "+" : ""}${inv.gain_loss_pct.toFixed(2)}%`
                  : ""}
              </p>
            </div>
          </div>
        </SheetHeader>

        <div className="flex border-b px-6 bg-muted/10 flex-shrink-0">
          <button
            onClick={() => setActiveTab("history")}
            className={`flex-1 py-3 text-sm font-semibold border-b-2 transition-all flex items-center justify-center gap-2 ${
              activeTab === "history"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="w-4 h-4" />
            Value History
          </button>
          <button
            onClick={() => setActiveTab("documents")}
            className={`flex-1 py-3 text-sm font-semibold border-b-2 transition-all flex items-center justify-center gap-2 ${
              activeTab === "documents"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileText className="w-4 h-4" />
            Documents
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {activeTab === "history" ? (
            <>
              {isLoading ? (
                <div className="px-6 space-y-3 pt-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : history.length === 0 ? (
                <p className="px-6 py-8 text-sm text-muted-foreground text-center">
                  No history yet — edits and price refreshes will appear here.
                </p>
              ) : (
                <div className="flex flex-col">
                  {history.map((entry, idx) => {
                    const dateStr = entry.changed_at.slice(0, 10);
                    const showDateHeader =
                      idx === 0 ||
                      dateStr !== history[idx - 1].changed_at.slice(0, 10);
                    const delta =
                      entry.previous_value !== null
                        ? entry.new_value - entry.previous_value
                        : null;
                    const isUp = delta !== null && delta >= 0;
                    const timeString = new Date(
                      entry.changed_at
                    ).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    });

                    return (
                      <Fragment key={entry.id}>
                        {showDateHeader && (
                          <div className="bg-muted/40 px-6 py-2 border-y border-border/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 select-none sticky top-0 backdrop-blur z-10 animate-fade-in">
                            {formatDateLabel(entry.changed_at)}
                          </div>
                        )}
                        <div className="px-6 py-3.5 hover:bg-muted/20 group/row transition-colors relative border-b border-border/20 last:border-0 bg-background/5 flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded-sm font-medium ${
                                  entry.source === "manual"
                                    ? "bg-info/10 text-info"
                                    : "bg-violet-500/10 text-violet-500"
                                }`}
                              >
                                {entry.source === "manual"
                                  ? "Manual edit"
                                  : "Auto refresh"}
                              </span>
                              {idx === 0 && (
                                <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-sm">
                                  latest
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground/80 mt-1.5 font-medium">
                              {timeString}
                            </p>
                            {entry.previous_value !== null && (
                              <p className="text-xs text-muted-foreground/80 mt-1">
                                {fmtNative(entry.previous_value)} →{" "}
                                {fmtNative(entry.new_value)}
                              </p>
                            )}
                            {entry.notes && entry.source === "manual" && (
                              <p className="text-xs text-muted-foreground/60 mt-1 italic truncate">
                                {entry.notes}
                              </p>
                            )}
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-bold text-foreground">
                              {fmtNative(entry.new_value)}
                            </p>
                            {delta !== null && (
                              <p
                                className={`text-xs font-bold mt-1 ${isUp ? "text-positive" : "text-negative"}`}
                              >
                                {isUp ? "+" : ""}
                                {fmtNative(delta)}
                              </p>
                            )}
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="px-6 py-5">
              {inv && (
                <InvestmentDocuments
                  investmentId={inv.id}
                  investment={inv}
                />
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InvestmentsPage({ embed }: { embed?: boolean }) {
  const { data, isLoading, error } = useInvestments();
  const { data: portfolio } = usePortfolioSummary();
  const { mutate: refreshPrice } = useRefreshPrice();
  const { mutate: deleteInv } = useDeleteInvestment();
  const { mutate: createInv, isPending: creating } = useCreateInvestment();
  const { mutate: updateInv, isPending: updating } = useUpdateInvestment();
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [selectedInv, setSelectedInv] = useState<InvestmentResponse | null>(
    null
  );
  const { data: accountsData } = useAccounts();
  const { mutate: deleteAccount } = useDeleteAccount();
  const [sheetAccount, setSheetAccount] = useState<any | null>(null);
  const [activeDonutIndex, setActiveDonutIndex] = useState<number | null>(null);

  const [groupByType, setGroupByType] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const groupedInvestments = useMemo(() => {
    if (!data?.investments) return [];

    const groups: Record<string, InvestmentResponse[]> = {};
    data.investments.forEach((inv) => {
      const type = inv.asset_type || "other";
      if (!groups[type]) groups[type] = [];
      groups[type].push(inv);
    });

    return Object.entries(groups).map(([type, items]) => {
      const purchaseSumINR = items.reduce((sum, item) => sum + (item.purchase_value_inr || 0), 0);
      const currentSumINR = items.reduce((sum, item) => sum + (item.current_value_inr || 0), 0);
      const gainLossSumINR = items.reduce((sum, item) => sum + (item.gain_loss_inr || 0), 0);
      const gainLossPct = purchaseSumINR > 0 ? (gainLossSumINR / purchaseSumINR) * 100 : 0;

      return {
        type,
        items,
        purchaseSumINR,
        currentSumINR,
        gainLossSumINR,
        gainLossPct,
      };
    }).sort((a, b) => {
      const labelA = ASSET_LABELS[a.type] ?? a.type;
      const labelB = ASSET_LABELS[b.type] ?? b.type;
      return labelA.localeCompare(labelB);
    });
  }, [data?.investments]);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [type]: !prev[type],
    }));
  };

  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { data: rates = {} } = useExchangeRates();
  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const linkedAccounts = (accountsData?.accounts ?? []).filter(
    (a) => a.off_budget && ["investment", "savings", "checking", "cash"].includes(a.type)
  );

  const donutData = portfolio
    ? Object.entries(portfolio.by_asset_type)
        .map(([name, value]) => ({
          name,
          value,
        }))
        .filter((d) => d.value > 0)
    : [];

  return (
    <div className={embed ? "space-y-6 w-full" : "p-6 space-y-6"}>
      {/* Header */}
      {embed ? (
        <div className="flex justify-end items-center">
          <InvestmentFormDialog
            title="Add Investment"
            trigger={
              <Button size="sm">
                <PlusCircle className="w-4 h-4 mr-1" />
                Add Investment
              </Button>
            }
            isPending={creating}
            onSubmit={(data) =>
              createInv(data, {
                onSuccess: () => toast.success("Investment added successfully"),
                onError: (e) => toast.error(e.message),
              })
            }
          />
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Investments</h1>
            {portfolio && (
              <p className="text-sm text-muted-foreground">
                Portfolio:{" "}
                <span className="font-semibold text-foreground">
                  {fmt(portfolio.total_inr)}
                </span>
              </p>
            )}
          </div>
          <InvestmentFormDialog
            title="Add Investment"
            trigger={
              <Button size="sm">
                <PlusCircle className="w-4 h-4 mr-1" />
                Add Investment
              </Button>
            }
            isPending={creating}
            onSubmit={(data) =>
              createInv(data, {
                onSuccess: () => toast.success("Investment added successfully"),
                onError: (e) => toast.error(e.message),
              })
            }
          />
        </div>
      )}

      {/* Portfolio breakdown */}
      {portfolio && donutData.length > 0 && (
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-5 pb-1 px-6">
            <CardTitle className="text-sm font-semibold tracking-tight">Portfolio Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col md:flex-row items-center gap-8 md:gap-12 py-6">
            {/* Centered Donut Chart */}
            <div className="relative w-[180px] h-[180px] flex-shrink-0 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={75}
                    paddingAngle={3}
                    cornerRadius={5}
                    onMouseEnter={(_, index) => setActiveDonutIndex(index)}
                    onMouseLeave={() => setActiveDonutIndex(null)}
                  >
                    {donutData.map((_, i) => {
                      const isHovered = activeDonutIndex === i;
                      return (
                        <Cell 
                          key={i} 
                          fill={COLORS[i % COLORS.length]} 
                          stroke="none"
                          strokeWidth={0}
                          style={{
                            outline: "none",
                            filter: isHovered ? "drop-shadow(0 0 6px rgba(99,102,241,0.3))" : "none",
                            transition: "all 0.2s ease-in-out",
                          }}
                        />
                      );
                    })}
                  </Pie>
                  <Tooltip formatter={(v) => fmt(Number(v))} content={<></>} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center p-2">
                <span className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/80 truncate max-w-[110px] leading-tight">
                  {activeDonutIndex !== null && donutData[activeDonutIndex] ? (ASSET_LABELS[donutData[activeDonutIndex].name] ?? donutData[activeDonutIndex].name) : "Total Portfolio"}
                </span>
                <span className="text-sm font-extrabold tracking-tight mt-0.5 tabular-nums text-foreground truncate max-w-[110px]">
                  {fmt(activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].value : portfolio.total_inr)}
                </span>
              </div>
            </div>

            {/* Premium Legend Grid */}
            <div className="flex flex-col gap-1.5 w-full flex-1">
              {donutData.map((d, i) => {
                const pct =
                  portfolio.total_inr > 0
                    ? (d.value / portfolio.total_inr) * 100
                    : 0;
                return (
                  <div key={d.name} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/40 transition-colors border border-transparent hover:border-border/30">
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0 shadow-sm border border-black/10"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      <span className="font-semibold text-xs md:text-sm text-muted-foreground hover:text-foreground transition-colors">
                        {ASSET_LABELS[d.name] ?? d.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-xs md:text-sm tabular-nums text-foreground">
                        {fmt(d.value)}
                      </span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground w-14 text-center">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Linked Accounts (off-budget savings / investment accounts) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Linked Accounts</CardTitle>
          <AddLinkedAccountDialog
            trigger={
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <PlusCircle className="w-3.5 h-3.5 mr-1" />
                Add Account
              </Button>
            }
          />
        </CardHeader>
        {linkedAccounts.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground text-center py-4">
              No linked accounts. Add a savings or investment account to
              transfer money here from Budget.
            </p>
          </CardContent>
        ) : (
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm min-w-[400px]">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Account
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Type
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                    Balance
                  </th>
                  <th className="w-32" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {linkedAccounts.map((a) => {
                  const showConverted = a.currency !== defaultCurrency;
                  const displayBalance = formatCurrency(
                    a.balance,
                    a.currency as any
                  );
                  const inrBalance = fmt(a.balance_inr);
                  return (
                    <tr
                      key={a.id}
                      className="hover:bg-muted/20 transition-colors group cursor-pointer"
                      onClick={() => setSheetAccount(a)}
                    >
                      <td className="px-4 py-3 font-medium">
                        {a.name} ({a.currency})
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className="text-xs capitalize"
                        >
                          {a.type}
                        </Badge>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {a.currency}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-medium tabular-nums">
                          {displayBalance}
                        </div>
                        {showConverted && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            ≈ {inrBalance}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <UpdateValueDialog
                            account={a}
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Update current value"
                              >
                                <ArrowUpDown className="w-3 h-3" />
                              </Button>
                            }
                          />
                          <LinkedAccountEditDialog
                            account={a}
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Edit account"
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="Delete account"
                            onClick={async () => {
                              try {
                                const txnsData = await budgetApi.getTransactions({ account_id: a.id, limit: 200 });
                                const hasTransfers = txnsData.transactions.some((t: any) => t.type === "transfer" || t.transfer_pair_id != null);
                                if (hasTransfers) {
                                  alert("This account cannot be deleted because it contains transactions involving transfers. To preserve double-entry integrity, please delete the transfers individually first from their respective accounts.");
                                  return;
                                }
                                if (window.confirm(`Are you sure you want to delete the linked account "${a.name}"? This will permanently delete the account and all associated transfer history.`)) {
                                  deleteAccount(a.id, {
                                    onSuccess: () =>
                                      toast.success("Account deleted"),
                                    onError: (e) => toast.error(e.message),
                                  });
                                }
                              } catch (e: any) {
                                toast.error("Failed to check for associated transfers");
                              }
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>

      {sheetAccount && (
        <LinkedAccountSheet
          account={sheetAccount}
          open={!!sheetAccount}
          onOpenChange={(open) => {
            if (!open) setSheetAccount(null);
          }}
          allAccounts={accountsData?.accounts ?? []}
        />
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>Failed to load investments.</AlertDescription>
        </Alert>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : !data || data.investments.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No investments yet — add your first one.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Custom premium toggle bar */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Holdings</h2>
            <div className="flex bg-muted/40 p-0.5 rounded-lg border border-border/30 backdrop-blur-sm shadow-sm select-none">
              <button
                onClick={() => setGroupByType(true)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider transition-all duration-200 ${
                  groupByType
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Layers className="w-3 h-3" />
                Group by Type
              </button>
              <button
                onClick={() => setGroupByType(false)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider transition-all duration-200 ${
                  !groupByType
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <List className="w-3 h-3" />
                Flat List
              </button>
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto shadow-sm">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Name
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                    Type
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                    Purchase
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                    Current
                  </th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                    Gain / Loss
                  </th>
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {groupByType ? (
                  groupedInvestments.map((g) => {
                    const isCollapsed = !!collapsedGroups[g.type];
                    const pos = g.gainLossSumINR >= 0;
                    return (
                      <Fragment key={g.type}>
                        <tr
                          onClick={() => toggleGroup(g.type)}
                          className="bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer select-none font-semibold border-b border-t first:border-t-0"
                        >
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2">
                              {isCollapsed ? (
                                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200" />
                              )}
                              <span className="text-foreground font-bold tracking-tight">
                                {ASSET_LABELS[g.type] ?? g.type}
                              </span>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted/80 text-muted-foreground">
                                {g.items.length} {g.items.length === 1 ? "holding" : "holdings"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3.5" />
                          <td className="px-4 py-3.5 text-right font-bold tabular-nums">
                            {fmt(g.purchaseSumINR)}
                          </td>
                          <td className="px-4 py-3.5 text-right font-bold tabular-nums">
                            {fmt(g.currentSumINR)}
                          </td>
                          <td className="px-4 py-3.5">
                            <div className={`text-right font-bold tabular-nums ${pos ? "text-positive" : "text-negative"}`}>
                              <div>
                                {pos ? "+" : ""}
                                {fmt(g.gainLossSumINR)}
                              </div>
                              <div className="text-[10px] font-extrabold opacity-80 mt-0.5">
                                {pos ? "+" : ""}
                                {g.gainLossPct.toFixed(2)}%
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5" />
                        </tr>
                        {!isCollapsed &&
                          g.items.map((inv) => (
                            <tr
                              key={inv.id}
                              className="hover:bg-muted/10 transition-colors cursor-pointer border-b border-border/40 last:border-b-0"
                              onClick={() => setSelectedInv(inv)}
                            >
                              <td className="px-4 py-3 pl-8">
                                <div className="font-medium flex items-center gap-1.5 flex-wrap">
                                  <span className="text-foreground/90">{inv.name}</span>
                                  {inv.account_id ? (
                                    (() => {
                                      const acc = (accountsData?.accounts ?? []).find(
                                        (a: any) => a.id === inv.account_id
                                      );
                                      return acc ? (
                                        <Badge
                                          variant="outline"
                                          className="text-[9px] h-4 px-1 py-0 bg-indigo-500/5 text-indigo-600 dark:text-indigo-400 border-indigo-500/20 capitalize font-normal select-none"
                                        >
                                          {acc.name} ({acc.currency})
                                        </Badge>
                                      ) : null;
                                    })()
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] h-4 px-1.5 py-0 bg-muted text-muted-foreground border-muted-foreground/20 capitalize font-medium select-none"
                                    >
                                      Standalone
                                    </Badge>
                                  )}
                                </div>
                                {inv.units && (
                                  <div className="text-xs text-muted-foreground/80 mt-0.5">
                                    {inv.units} units
                                  </div>
                                )}
                                {inv.current_value_at && (
                                  <div className="text-xs text-muted-foreground/80 mt-0.5">
                                    Updated{" "}
                                    {new Date(inv.current_value_at).toLocaleDateString()}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant="secondary" className="text-[10px] font-medium bg-muted/60 text-muted-foreground">
                                  {ASSET_LABELS[inv.asset_type] ?? inv.asset_type}
                                </Badge>
                                <div className="text-xs text-muted-foreground/80 mt-0.5">
                                  {inv.currency}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <MoneyCell
                                  native={inv.purchase_value}
                                  nativeCurrency={inv.currency}
                                  inr={inv.purchase_value_inr}
                                />
                              </td>
                              <td className="px-4 py-3">
                                <MoneyCell
                                  native={inv.current_value}
                                  nativeCurrency={inv.currency}
                                  inr={inv.current_value_inr}
                                />
                              </td>
                              <td className="px-4 py-3">
                                <GainLossCell inv={inv} fmt={fmt} />
                              </td>
                              <td
                                className="px-4 py-3"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="flex gap-1 justify-end">
                                  <InvestmentFormDialog
                                    title="Edit Investment"
                                    trigger={
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        title="Edit investment"
                                      >
                                        <Pencil className="w-3 h-3" />
                                      </Button>
                                    }
                                    isPending={updating}
                                    initial={{
                                      name: inv.name,
                                      asset_type: inv.asset_type as any,
                                      currency: inv.currency as any,
                                      purchase_value: String(inv.purchase_value),
                                      current_value: String(inv.current_value),
                                      purchase_date: inv.purchase_date,
                                      units: inv.units != null ? String(inv.units) : "",
                                      notes: inv.notes ?? "",
                                      account_id: inv.account_id ?? "",
                                    }}
                                    onSubmit={(data) =>
                                      updateInv(
                                        { id: inv.id, data },
                                        {
                                          onSuccess: () =>
                                            toast.success("Investment updated"),
                                          onError: (e) => toast.error(e.message),
                                        }
                                      )
                                    }
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    disabled={refreshingId === inv.id}
                                    title="Refresh price from web"
                                    onClick={() => {
                                      setRefreshingId(inv.id);
                                      refreshPrice(inv.id, {
                                        onSuccess: () => {
                                          toast.success("Price refreshed");
                                          setRefreshingId(null);
                                        },
                                        onError: (e) => {
                                          toast.error(e.message);
                                          setRefreshingId(null);
                                        },
                                      });
                                    }}
                                  >
                                    <RefreshCw
                                      className={`w-3 h-3 ${refreshingId === inv.id ? "animate-spin" : ""}`}
                                    />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-destructive"
                                    title="Delete investment"
                                    onClick={() => {
                                      if (window.confirm(`Are you sure you want to delete the investment "${inv.name}"?`)) {
                                        deleteInv(inv.id, {
                                          onSuccess: () => toast.success("Deleted"),
                                          onError: (e) => toast.error(e.message),
                                        });
                                      }
                                    }}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })
                ) : (
                  data.investments.map((inv) => (
                    <tr
                      key={inv.id}
                      className="hover:bg-muted/20 transition-colors cursor-pointer border-b last:border-b-0"
                      onClick={() => setSelectedInv(inv)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium flex items-center gap-1.5 flex-wrap">
                          <span>{inv.name}</span>
                          {inv.account_id ? (
                            (() => {
                              const acc = (accountsData?.accounts ?? []).find(
                                (a: any) => a.id === inv.account_id
                              );
                              return acc ? (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] h-4 px-1 py-0 bg-indigo-500/5 text-indigo-600 dark:text-indigo-400 border-indigo-500/20 capitalize font-normal select-none"
                                >
                                  {acc.name} ({acc.currency})
                                </Badge>
                              ) : null;
                            })()
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[9px] h-4 px-1.5 py-0 bg-muted text-muted-foreground border-muted-foreground/20 capitalize font-medium select-none"
                            >
                              Standalone
                            </Badge>
                          )}
                        </div>
                        {inv.units && (
                          <div className="text-xs text-muted-foreground">
                            {inv.units} units
                          </div>
                        )}
                        {inv.current_value_at && (
                          <div className="text-xs text-muted-foreground">
                            Updated{" "}
                            {new Date(inv.current_value_at).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className="text-xs">
                          {ASSET_LABELS[inv.asset_type] ?? inv.asset_type}
                        </Badge>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {inv.currency}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <MoneyCell
                          native={inv.purchase_value}
                          nativeCurrency={inv.currency}
                          inr={inv.purchase_value_inr}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <MoneyCell
                          native={inv.current_value}
                          nativeCurrency={inv.currency}
                          inr={inv.current_value_inr}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <GainLossCell inv={inv} fmt={fmt} />
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex gap-1 justify-end">
                          <InvestmentFormDialog
                            title="Edit Investment"
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Edit investment"
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            }
                            isPending={updating}
                            initial={{
                              name: inv.name,
                              asset_type: inv.asset_type as any,
                              currency: inv.currency as any,
                              purchase_value: String(inv.purchase_value),
                              current_value: String(inv.current_value),
                              purchase_date: inv.purchase_date,
                              units: inv.units != null ? String(inv.units) : "",
                              notes: inv.notes ?? "",
                              account_id: inv.account_id ?? "",
                            }}
                            onSubmit={(data) =>
                              updateInv(
                                { id: inv.id, data },
                                {
                                  onSuccess: () =>
                                    toast.success("Investment updated"),
                                  onError: (e) => toast.error(e.message),
                                }
                              )
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={refreshingId === inv.id}
                            title="Refresh price from web"
                            onClick={() => {
                              setRefreshingId(inv.id);
                              refreshPrice(inv.id, {
                                onSuccess: () => {
                                  toast.success("Price refreshed");
                                  setRefreshingId(null);
                                },
                                onError: (e) => {
                                  toast.error(e.message);
                                  setRefreshingId(null);
                                },
                              });
                            }}
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${refreshingId === inv.id ? "animate-spin" : ""}`}
                            />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="Delete investment"
                            onClick={() => {
                              if (window.confirm(`Are you sure you want to delete the investment "${inv.name}"?`)) {
                                deleteInv(inv.id, {
                                  onSuccess: () => toast.success("Deleted"),
                                  onError: (e) => toast.error(e.message),
                                });
                              }
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <InvestmentHistorySheet
        inv={selectedInv}
        open={!!selectedInv}
        onOpenChange={(open) => {
          if (!open) setSelectedInv(null);
        }}
        fmt={fmt}
      />
    </div>
  );
}
