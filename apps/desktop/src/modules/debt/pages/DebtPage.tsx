import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import { CreditCard, Coins, Pencil, PlusCircle, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
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
import { useAppStore } from "@/stores/app.store";
import { AccountFormDialog } from "@/components/AccountFormDialog";
import { budgetApi } from "@/modules/budget/api";

function formatDateLabel(dateStr: string) {
  if (!dateStr) return "";
  try {
    const parts = dateStr.slice(0, 10).split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (isNaN(d.getTime())) return dateStr;
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

// ─── Make Payment Dialog ──────────────────────────────────────────────────────

function PaymentDialog({
  debtAccount,
  budgetAccounts,
  trigger,
}: {
  debtAccount: any;
  budgetAccounts: any[];
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [fromAccount, setFromAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [envelope, setEnvelope] = useState("");
  const { mutate: createTransfer, isPending } = useCreateTransfer();
  const { selectedMonth } = useAppStore();
  const { data: envelopesData } = useEnvelopes(selectedMonth);

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

  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  const reset = () => {
    setFromAccount("");
    setAmount("");
    setDate(new Date().toISOString().slice(0, 10));
    setNotes("");
    setEnvelope("");
  };

  const fromAcc = budgetAccounts.find((a: any) => a.id === fromAccount);
  const sameCurrency = fromAcc?.currency === debtAccount.currency;

  const submit = () => {
    if (!fromAccount || !amount) return;
    const fromAmt = parseFloat(amount);
    createTransfer(
      {
        from_account_id: fromAccount,
        to_account_id: debtAccount.id,
        amount: fromAmt,
        to_amount: sameCurrency ? fromAmt : fromAmt,
        date,
        notes: notes.trim() || undefined,
        envelope_id: envelope || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Payment recorded");
          setOpen(false);
          reset();
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
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Make Payment — {debtAccount.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label>Pay From</Label>
            <select
              value={fromAccount}
              onChange={(e) => setFromAccount(e.target.value)}
              className={sel}
            >
              <option value="">Select account…</option>
              {budgetAccounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Amount ({debtAccount.currency})</Label>
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-1"
            />
          </div>
          {envelopesByGroup.length > 0 && (
            <div>
              <Label>
                Category{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
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
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
              placeholder="e.g. Monthly EMI"
              className="mt-1"
            />
          </div>
          <Button
            className="w-full"
            onClick={submit}
            disabled={isPending || !fromAccount || !amount}
          >
            Record Payment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Transaction History Sheet ────────────────────────────────────────────────

function TransactionSheet({
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
  const { data } = useTransactions({ account_id: account.id, limit: 100 });
  const { mutate: deleteTxn } = useDeleteTransaction();
  const { mutate: createTxn, isPending: creating } = useCreateTransaction();
  const { mutate: createTransfer, isPending: transferring } = useCreateTransfer();
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

  const [tab, setTab] = useState<"income" | "expense" | "transfer">("expense");
  const [transferDir, setTransferDir] = useState<"out" | "in">("out");
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [toAccount, setToAccount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [envelope, setEnvelope] = useState("");
  const [incomeCat, setIncomeCat] = useState<"income" | "cashback" | "starting_balance">("cashback");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const resetForm = () => {
    setPayee("");
    setAmount("");
    setToAccount("");
    setToAmount("");
    setEnvelope("");
    setIncomeCat("cashback");
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
          envelope_id: tab === "expense" && envelope ? envelope : undefined,
          income_category: tab === "income" ? incomeCat : undefined,
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

  const selClass =
    "w-full border rounded-md px-2 py-1 text-xs mt-1 h-8 bg-background focus:ring-1 focus:ring-primary";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:w-[600px] sm:max-w-none flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 pt-5 pb-4 border-b flex-shrink-0 pr-14">
          <SheetTitle className="text-base font-semibold">{account.name}</SheetTitle>
          <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
            <span>Balance:</span>
            <span className={`font-semibold ${account.balance < 0 ? "text-negative" : "text-positive"}`}>
              {account.balance >= 0 ? "+ " : ""}
              {formatCurrency(account.balance, account.currency)}
            </span>
            {showHint && (
              <span className="text-xs text-muted-foreground">
                ≈ {account.balance_inr >= 0 ? "+ " : ""}
                {fmtDefault(account.balance_inr)}
              </span>
            )}
            <Badge variant="secondary" className="text-[10px] capitalize">
              {account.type}
            </Badge>
            <span className="text-[10px] bg-muted rounded px-1.5 py-0.5 font-bold">
              {account.currency}
            </span>
          </div>
        </SheetHeader>

        {/* Floating Quick Entry Form */}
        <div className="bg-card border border-border/30 rounded-3xl p-5 shadow-sm mx-6 my-4 flex-shrink-0 animate-fade-in">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80 mb-3 flex items-center gap-1.5 select-none">
            <Coins className="w-3.5 h-3.5 text-primary" /> Add Record
          </p>
          <div className="flex rounded-xl bg-muted p-1 gap-1 text-xs mb-4 select-none">
            {(["expense", "income", "transfer"] as const).map((t) => (
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
                  Receive into {account.name}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">
                    {transferDir === "out" ? "Recipient Account" : "Sender Account"}
                  </Label>
                  <select
                    value={toAccount}
                    onChange={(e) => {
                      setToAccount(e.target.value);
                      setToAmount("");
                    }}
                    className={selClass}
                  >
                    <option value="">Select Account</option>
                    {allAccounts
                      .filter((a) => a.id !== account.id)
                      .map((a) => (
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
                    step="any"
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
                      ? `Amount Received (${otherAcc.currency})`
                      : `Amount Deducted (${otherAcc.currency})`}
                  </Label>
                  <Input
                    type="number"
                    step="any"
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
                    placeholder="Credit card payment"
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
                      Envelope Category{" "}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </Label>
                    <select
                      value={envelope}
                      onChange={(e) => setEnvelope(e.target.value)}
                      className={selClass}
                    >
                      <option value="">Select Envelope</option>
                      {envelopesByGroup.map(({ groupId, groupName, items }) => (
                        <optgroup key={groupId} label={groupName}>
                          {items.map((env) => (
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
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Payee / Payer</Label>
                  <Input
                    value={payee}
                    onChange={(e) => setPayee(e.target.value)}
                    placeholder={
                      tab === "income" ? "e.g. Dividend" : "e.g. Supermarket"
                    }
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground font-bold select-none">Amount ({account.currency})</Label>
                  <Input
                    type="number"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 h-9 rounded-xl text-xs border border-border/60 bg-background focus-visible:ring-2 focus-visible:ring-primary/10 focus-visible:border-primary transition-all duration-200 font-semibold shadow-sm"
                  />
                </div>

                {tab === "expense" && envelopesByGroup.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground font-bold select-none">Category</Label>
                    <select
                      value={envelope}
                      onChange={(e) => setEnvelope(e.target.value)}
                      className={selClass}
                    >
                      <option value="">Uncategorised</option>
                      {envelopesByGroup.map(({ groupId, groupName, items }) => (
                        <optgroup key={groupId} label={groupName}>
                          {items.map((env) => (
                            <option key={env.id} value={env.id}>
                              {env.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                )}

                {tab === "income" && (
                  <div>
                    <Label className="text-xs text-muted-foreground font-bold select-none">Category</Label>
                    <select
                      value={incomeCat}
                      onChange={(e) => setIncomeCat(e.target.value as any)}
                      className={selClass}
                    >
                      <option value="cashback">Cashback / Refund</option>
                      <option value="income">Income / Salary</option>
                      <option value="starting_balance">Starting Balance</option>
                    </select>
                  </div>
                )}

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
            <p className="text-sm text-muted-foreground text-center py-16">
              No transactions recorded yet.
            </p>
          ) : (
            <div className="flex flex-col">
              {txns.map((t: any, i: number) => {
                const showDateHeader = i === 0 || t.date !== txns[i - 1].date;
                return (
                  <div key={t.id} className="flex flex-col">
                    {showDateHeader && (
                      <div className="bg-muted/40 px-6 py-2 border-y border-border/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 select-none sticky top-0 backdrop-blur z-10">
                        {formatDateLabel(t.date)}
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/30 group/row transition-colors relative border-b border-border/20 last:border-0 bg-background/5">
                      {/* Left Column: Payee & Category Badges */}
                      <div className="min-w-0 flex-1 pr-4">
                        <p className="text-xs font-semibold truncate text-foreground">{t.payee}</p>
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {t.envelope_name && (
                            <span className="bg-indigo-500/10 text-indigo-500 font-medium px-1.5 py-0.5 rounded text-[10px] border border-indigo-500/20">
                              {t.envelope_name}
                            </span>
                          )}
                          {t.type === "transfer" && (
                            <span className="bg-info/10 text-info font-medium px-1.5 py-0.5 rounded text-[10px] border border-info/20 capitalize">
                              transfer
                            </span>
                          )}
                          {t.type === "income" && t.income_category && (
                            <span className="bg-positive/10 text-positive font-medium px-1.5 py-0.5 rounded text-[10px] border border-positive/20 capitalize">
                              {t.income_category.replace("_", " ")}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6 ml-4 flex-shrink-0 pr-8">
                        {/* Amount Column */}
                        <div className="text-right w-24">
                          <p
                            className={`text-xs font-bold tabular-nums ${
                              t.type === "transfer"
                                ? "text-info"
                                : t.type === "income"
                                  ? "text-positive"
                                  : "text-negative"
                            }`}
                          >
                            {t.type === "transfer"
                              ? t.payee === "Transfer in"
                                ? "+"
                                : "−"
                              : t.type === "income"
                                ? "+"
                                : "−"}
                            {formatCurrency(t.amount, account.currency)}
                          </p>
                          {showHint && (
                            <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                              ≈ {t.amount * (rates[account.currency] ?? 1) >= 0 ? "+ " : ""}
                              {fmtDefault(t.amount * (rates[account.currency] ?? 1))}
                            </p>
                          )}
                        </div>

                        {/* Running Balance Column */}
                        <div className="text-right w-24">
                          <p className="text-xs font-semibold tabular-nums text-foreground/80">
                            {formatCurrency(runningBalances[t.id] ?? 0, account.currency)}
                          </p>
                        </div>
                      </div>

                      {/* Float Delete Button */}
                      <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity absolute right-4 top-1/2 -translate-y-1/2 bg-background/95 backdrop-blur shadow border rounded px-1 z-10">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:bg-muted"
                          onClick={() => {
                            const confirmMsg = t.type === "transfer"
                              ? "This transaction is a transfer. Deleting it will automatically delete the matching leg in the other involved account to preserve balance integrity. Are you sure you want to proceed?"
                              : "Are you sure you want to delete this transaction?";
                            if (window.confirm(confirmMsg)) {
                              deleteTxn(t.id, {
                                onSuccess: () => toast.success("Deleted"),
                                onError: (e) => toast.error(e.message),
                              });
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DebtPage({ embed }: { embed?: boolean }) {
  const { data: accountsData, isLoading } = useAccounts();
  const { mutate: createAccount, isPending: creating } = useCreateAccount();
  const { mutate: updateAccount, isPending: updating } = useUpdateAccount();
  const { mutate: deleteAccount } = useDeleteAccount();
  const [sheetAccount, setSheetAccount] = useState<any | null>(null);
  const [activeDonutIndex, setActiveDonutIndex] = useState<number | null>(null);

  const activeSheetAccount =
    sheetAccount &&
    accountsData?.accounts?.find((a: any) => a.id === sheetAccount.id);

  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { data: rates = {} } = useExchangeRates();
  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const allAccounts = accountsData?.accounts ?? [];
  const debtAccounts = allAccounts.filter(
    (a: any) => ["credit", "loan", "debt"].includes(a.type) && a.is_active
  );
  const budgetAccounts = allAccounts.filter((a: any) => !a.off_budget);

  const totalDebtInr = debtAccounts.reduce(
    (s: number, a: any) => s + a.balance_inr,
    0
  );

  const COLORS = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-6)",
    "var(--chart-7)",
    "var(--chart-8)",
  ];

  const donutData = useMemo(() => {
    return debtAccounts
      .map((a: any) => ({
        name: a.name,
        value: a.balance_inr < 0 ? -a.balance_inr : 0,
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [debtAccounts]);

  return (
    <div className={embed ? "space-y-6 w-full" : "p-6 space-y-6"}>
      {/* Header */}
      {embed ? (
        <div className="flex justify-end items-center">
          <AccountFormDialog
            title="Add Debt Account"
            trigger={
              <Button size="sm">
                <PlusCircle className="w-4 h-4 mr-1.5" />
                Add Debt
              </Button>
            }
            initial={{
              name: "",
              type: "credit",
              currency: defaultCurrency,
              balance: 0,
              off_budget: true,
            }}
            isPending={creating}
            onSubmit={(data) => {
              const finalBalance = ["credit", "loan", "debt"].includes(data.type) && data.balance > 0 
                ? -data.balance 
                : data.balance;
              createAccount({ ...data, balance: finalBalance } as any, {
                onSuccess: () => toast.success("Debt account added"),
                onError: (e) => toast.error(e.message),
              });
            }}
          />
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Debt</h1>
            {debtAccounts.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Total balance:{" "}
                <span className={`font-semibold ${totalDebtInr < 0 ? "text-negative" : "text-positive"}`}>
                  {totalDebtInr >= 0 ? "+ " : ""}
                  {fmt(totalDebtInr)}
                </span>
              </p>
            )}
          </div>
          <AccountFormDialog
            title="Add Debt Account"
            trigger={
              <Button size="sm">
                <PlusCircle className="w-4 h-4 mr-1.5" />
                Add Debt
              </Button>
            }
            initial={{
              name: "",
              type: "credit",
              currency: defaultCurrency,
              balance: 0,
              off_budget: true,
            }}
            isPending={creating}
            onSubmit={(data) => {
              const finalBalance = ["credit", "loan", "debt"].includes(data.type) && data.balance > 0 
                ? -data.balance 
                : data.balance;
              createAccount({ ...data, balance: finalBalance } as any, {
                onSuccess: () => toast.success("Debt account added"),
                onError: (e) => toast.error(e.message),
              });
            }}
          />
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : debtAccounts.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm space-y-2">
          <CreditCard className="w-10 h-10 mx-auto opacity-20" />
          <p>No debt accounts yet.</p>
          <p className="text-xs">
            Add a loan or credit card to track what you owe and make payments.
          </p>
        </div>
      ) : (
        <>
          {/* Liabilities breakdown */}
          {donutData.length > 0 && (
            <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm animate-in fade-in-50 duration-300 mb-6">
              <CardHeader className="pt-5 pb-1 px-6">
                <CardTitle className="text-sm font-semibold tracking-tight">Outstanding Debt Allocation</CardTitle>
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
                      {activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].name : "Total Debt"}
                    </span>
                    <span className="text-sm font-extrabold tracking-tight mt-0.5 tabular-nums text-foreground truncate max-w-[110px]">
                      {activeDonutIndex !== null && donutData[activeDonutIndex] ? `−${fmt(donutData[activeDonutIndex].value)}` : fmt(totalDebtInr)}
                    </span>
                  </div>
                </div>

                {/* Premium Legend Grid */}
                <div className="flex flex-col gap-1.5 w-full flex-1">
                  {donutData.map((d, i) => {
                    const pct = totalDebtInr > 0 ? (d.value / totalDebtInr) * 100 : 0;
                    return (
                      <div
                        key={d.name}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/40 transition-colors border border-transparent hover:border-border/30"
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0 shadow-sm border border-black/10"
                            style={{ background: COLORS[i % COLORS.length] }}
                          />
                          <span className="font-semibold text-xs md:text-sm text-muted-foreground hover:text-foreground transition-colors truncate max-w-40 sm:max-w-xs">
                            {d.name}
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

          <Card>
          <CardHeader>
            <CardTitle className="text-sm">Accounts</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
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
                  <th className="w-40 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {debtAccounts.map((a: any) => {
                  const showConversion = a.currency !== defaultCurrency;
                  return (
                    <tr
                      key={a.id}
                      className="hover:bg-muted/20 transition-colors group cursor-pointer"
                      onClick={() => setSheetAccount(a)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">{a.name}</div>
                        {a.institution && (
                          <div className="text-xs text-muted-foreground">
                            {a.institution}
                          </div>
                        )}
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
                        <div className={`font-semibold tabular-nums ${a.balance < 0 ? "text-negative" : "text-positive"}`}>
                          {a.balance >= 0 ? "+ " : ""}
                          {formatCurrency(a.balance, a.currency)}
                        </div>
                        {showConversion && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            ≈ {a.balance_inr >= 0 ? "+ " : ""}
                            {fmt(a.balance_inr)}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex gap-1.5 justify-end">
                          <PaymentDialog
                            debtAccount={a}
                            budgetAccounts={budgetAccounts}
                            trigger={
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                              >
                                Make Payment
                              </Button>
                            }
                          />
                          <AccountFormDialog
                            title="Edit Debt Account"
                            trigger={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            }
                            isPending={updating}
                            initial={{
                              name: a.name,
                              type: a.type,
                              currency: a.currency,
                              balance: a.balance,
                              institution: a.institution ?? "",
                              is_active: a.is_active ?? true,
                              off_budget: a.off_budget ?? true,
                            }}
                            onSubmit={(data) => {
                              const finalBalance = ["credit", "loan", "debt"].includes(data.type) && data.balance > 0 
                                ? -data.balance 
                                : data.balance;
                              updateAccount(
                                {
                                  id: a.id,
                                  data: {
                                    name: data.name,
                                    type: data.type,
                                    currency: data.currency,
                                    balance: finalBalance,
                                    institution: data.institution,
                                    is_active: data.is_active,
                                    off_budget: data.off_budget,
                                  },
                                },
                                {
                                  onSuccess: () => toast.success("Updated"),
                                  onError: (e) => toast.error(e.message),
                                }
                              );
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={async () => {
                              try {
                                const txnsData = await budgetApi.getTransactions({ account_id: a.id, limit: 200 });
                                const hasTransfers = txnsData.transactions.some((t: any) => t.type === "transfer" || t.transfer_pair_id != null);
                                if (hasTransfers) {
                                  alert("This account cannot be deleted because it contains transactions involving transfers. To preserve double-entry integrity, please delete the transfers individually first from their respective accounts.");
                                  return;
                                }
                                if (window.confirm(`Are you sure you want to delete the debt account "${a.name}"? This will permanently delete the account and all associated transactions.`)) {
                                  deleteAccount(a.id, {
                                    onSuccess: () => toast.success("Deleted"),
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
              <tfoot>
                <tr className="border-t bg-muted/30">
                  <td colSpan={2} className="px-4 py-3 text-sm font-semibold">
                    Total
                  </td>
                  <td className={`px-4 py-3 text-right font-semibold tabular-nums ${totalDebtInr < 0 ? "text-negative" : "text-positive"}`}>
                    {totalDebtInr >= 0 ? "+ " : ""}
                    {fmt(totalDebtInr)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
        </>
      )}

      {sheetAccount && (
        <TransactionSheet
          account={activeSheetAccount || sheetAccount}
          open={!!sheetAccount}
          onOpenChange={(open) => {
            if (!open) setSheetAccount(null);
          }}
          allAccounts={allAccounts}
        />
      )}
    </div>
  );
}
