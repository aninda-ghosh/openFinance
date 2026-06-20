import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import {
  Coins,
  Landmark,
  Pencil,
  PiggyBank,
  PlusCircle,
  Trash2,
  Wallet,
  ArrowLeftRight,
  FileText,
} from "lucide-react";
import { Fragment, useMemo, useState, useEffect } from "react";
import { toast } from "sonner";
import { InvestmentDocuments } from "@/modules/investments/components/InvestmentDocuments";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  useDeleteAccount,
  useDeleteTransaction,
  useExchangeRates,
  useTransactions,
  useUpdateAccount,
} from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import { AccountFormDialog } from "@/components/AccountFormDialog";
import TransactionForm from "@/components/TransactionForm";

const LIQUID_TYPES = ["checking", "savings", "cash"];

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

// Helper component for confirming deletions
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
        </DialogHeader>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {description}
        </p>
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

// ─── Dynamic Account Details & Transactions Sheet ─────────────────────────────
function AccountDetailSheet({
  account,
  open,
  onOpenChange,
}: {
  account: any;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data } = useTransactions({ account_id: account?.id, limit: 150 });
  const { mutate: deleteTxn } = useDeleteTransaction();
  const { defaultCurrency } = useAppStore();
  const { data: rates = {} } = useExchangeRates();

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

  const [activeTab, setActiveTab] = useState<"transactions" | "documents">("transactions");

  useEffect(() => {
    if (!open) {
      setActiveTab("transactions");
    }
  }, [open, account?.id]);

  const showHint = account?.currency !== defaultCurrency;
  const fmtDefault = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  // Edit via shared TransactionForm dialog
  const [editingTxn, setEditingTxn] = useState<any | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:w-[600px] sm:max-w-none flex flex-col p-0 gap-0"
      >
        <SheetHeader className="px-6 pt-5 pb-4 border-b flex-shrink-0 pr-14">
          <SheetTitle className="text-base font-semibold">
            {account?.name}
          </SheetTitle>
          <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
            <span>Balance:</span>
            <span className="font-semibold text-foreground">
              {account && formatCurrency(account.balance, account.currency)}
            </span>
            {showHint && account && (
              <span className="text-xs text-muted-foreground">
                ≈ {fmtDefault(account.balance_inr)}
              </span>
            )}
            <Badge variant="secondary" className="text-xs capitalize">
              {account?.type}
            </Badge>
            <Badge
              variant={account?.off_budget ? "outline" : "default"}
              className="text-xs"
            >
              {account?.off_budget ? "Off Budget" : "On Budget"}
            </Badge>
          </div>
        </SheetHeader>

        <div className="flex border-b px-6 bg-muted/10 flex-shrink-0">
          <button
            onClick={() => setActiveTab("transactions")}
            className={`flex-1 py-3 text-sm font-semibold border-b-2 transition-all flex items-center justify-center gap-2 ${
              activeTab === "transactions"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <ArrowLeftRight className="w-4 h-4" />
            Transactions
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

        {activeTab === "transactions" ? (
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Floating Quick Entry Form */}
            <div className="bg-card border border-border/30 rounded-3xl shadow-sm mx-6 my-4 overflow-hidden animate-fade-in">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80 px-5 pt-4 flex items-center gap-1.5 select-none">
                <Coins className="w-3.5 h-3.5 text-primary" /> Add Record
              </p>
              <TransactionForm
                key={account?.id}
                mode="create"
                defaultAccountId={account?.id}
                layout="single"
              />
            </div>

            {/* Transaction History Log */}
            <div>
              {txns.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground text-xs leading-relaxed">
                  No transactions listed for this account.
                </div>
              ) : (
                <div className="flex flex-col">
                  {txns.map((t: any, i: number) => {
                    const showDateHeader = i === 0 || t.date !== txns[i - 1].date;
                    return (
                      <Fragment key={t.id}>
                        {showDateHeader && (
                          <div className="bg-muted/40 px-6 py-2 border-y border-border/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 select-none sticky top-0 backdrop-blur z-10">
                            {formatDateLabel(t.date)}
                          </div>
                        )}
                        
                        <div className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/20 group/txn transition-colors relative border-b border-border/20 last:border-0 bg-background/5">
                            {/* Left Column: Payee name and dynamic badges */}
                            <div className="min-w-0 flex-1 pr-4">
                              <p className="text-xs font-semibold text-foreground truncate pr-10">
                                {t.payee}
                              </p>
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
                            
                            {/* Right Column: Stacked Amount & Running Balance */}
                            <div className="text-right flex-shrink-0 pr-8">
                              <p
                                className={`text-xs font-bold tabular-nums ${
                                  t.type === "income"
                                    ? "text-positive"
                                    : t.type === "expense"
                                      ? "text-negative"
                                      : "text-info"
                                }`}
                              >
                                {t.type === "income"
                                  ? "+"
                                  : t.type === "expense"
                                    ? "−"
                                    : "⇄"}
                                {account &&
                                  formatCurrency(t.amount, account.currency)}
                              </p>
                              {showHint && account && (
                                <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                                  ≈{" "}
                                  {fmtDefault(
                                    t.amount * (rates[account.currency] ?? 1)
                                  )}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground/80 font-semibold tabular-nums mt-1">
                                {account &&
                                  formatCurrency(runningBalances[t.id] ?? 0, account.currency)}
                              </p>
                            </div>

                            {/* Float Edit/Delete Buttons */}
                            <div className="flex items-center gap-1 opacity-0 group-hover/txn:opacity-100 transition-opacity absolute right-4 top-1/2 -translate-y-1/2 bg-background/95 backdrop-blur shadow border rounded px-1 z-10">
                              <button
                                className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
                                onClick={() => setEditingTxn(t)}
                                title="Edit transaction"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <ConfirmDialog
                                trigger={
                                  <button className="p-1 text-muted-foreground hover:text-negative hover:bg-muted rounded transition-colors">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                }
                                title="Delete transaction?"
                                description={
                                  t.type === "transfer"
                                    ? "This transaction is a transfer. Deleting it will automatically delete the matching leg in the other involved account to preserve balance integrity."
                                    : "This transaction record will be permanently deleted from the balance."
                                }
                                onConfirm={() =>
                                  deleteTxn(t.id, {
                                    onSuccess: () => toast.success("Record deleted"),
                                    onError: (e) => toast.error(e.message),
                                  })
                                }
                              />
                            </div>
                          </div>
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {account && (
              <InvestmentDocuments
                investmentId={account.id}
                investment={account}
                isAccount
              />
            )}
          </div>
        )}

        {/* Edit Transaction Dialog (shared form) */}
        <Dialog
          open={editingTxn !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setEditingTxn(null);
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            className="max-w-[500px] md:max-w-[760px] p-0 gap-0 overflow-hidden"
          >
            <DialogHeader className="px-5 py-3.5 border-b border-border bg-muted/20 flex-shrink-0">
              <DialogTitle className="text-sm font-semibold tracking-tight">
                Edit Transaction
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col max-h-[80vh] min-h-0">
              {editingTxn && (
                <TransactionForm
                  key={editingTxn.id}
                  mode="edit"
                  transaction={editingTxn}
                  onSuccess={() => setEditingTxn(null)}
                  onDeleted={() => setEditingTxn(null)}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main SavingsCheckingPage ──────────────────────────────────────────────────
export default function SavingsCheckingPage({ embed }: { embed?: boolean }) {
  const { data: accountsData, isLoading, error } = useAccounts();
  const { mutate: createAccount, isPending: creating } = useCreateAccount();
  const { mutate: updateAccount, isPending: updating } = useUpdateAccount();
  const { mutate: deleteAccount } = useDeleteAccount();
  const { defaultCurrency } = useAppStore();
  const { data: rates = {} } = useExchangeRates();

  const [selectedAccount, setSelectedAccount] = useState<any | null>(null);
  const [activeDonutIndex, setActiveDonutIndex] = useState<number | null>(null);

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  // Filter liquid accounts: checking, savings, cash (on-budget only)
  const liquidAccounts = (accountsData?.accounts ?? []).filter(
    (a) => LIQUID_TYPES.includes(a.type) && !a.off_budget
  );

  // Dynamic aggregations
  const totalInr = liquidAccounts.reduce(
    (sum, a) => sum + (a.balance_inr ?? 0),
    0
  );
  const onBudgetInr = totalInr;

  // Determine active sheet account (refresh with fresh data from server)
  const activeSheetAccount =
    selectedAccount &&
    accountsData?.accounts?.find((a) => a.id === selectedAccount.id);

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
    return liquidAccounts
      .map((a) => ({
        name: a.name,
        value: a.balance_inr ?? 0,
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [liquidAccounts]);

  return (
    <div className={embed ? "space-y-6 w-full" : "p-4 md:p-6 space-y-6 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"}>
      {embed ? (
        <div className="flex justify-end items-center">
          <AccountFormDialog
            title="Add Liquid Account"
            trigger={
              <Button size="sm" className="font-semibold text-xs h-9">
                <PlusCircle className="w-4 h-4 mr-1.5" />
                Add Account
              </Button>
            }
            isPending={creating}
            onSubmit={(data) =>
              createAccount(data as any, {
                onSuccess: () => toast.success("Account created successfully"),
                onError: (e) => toast.error(e.message),
              })
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">Savings & Checking</h1>
            <p className="text-xs text-muted-foreground">Manage your liquid assets, bank checking, and cash balances.</p>
          </div>
          <AccountFormDialog
            title="Add Liquid Account"
            trigger={
              <Button size="sm" className="font-semibold text-xs h-9">
                <PlusCircle className="w-4 h-4 mr-1.5" />
                Add Account
              </Button>
            }
            isPending={creating}
            onSubmit={(data) =>
              createAccount(data as any, {
                onSuccess: () => toast.success("Account created successfully"),
                onError: (e) => toast.error(e.message),
              })
            }
          />
        </div>
      )}

      {/* Aggregate Balance Dashboard Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent ">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Total Liquid Balances
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary">
                <Landmark className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-28 mt-2" />
            ) : (
              <p className="text-lg md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary">
                {fmt(totalInr)}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Calculated across on-budget checking, savings, and cash
            </p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent ">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                On-Budget Envelope Total
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary">
                <Wallet className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-28 mt-2" />
            ) : (
              <p className="text-lg md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary">
                {fmt(onBudgetInr)}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Available for envelope budgeting
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Cash & Checking breakdown */}
      {!isLoading && liquidAccounts.length > 0 && donutData.length > 0 && (
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm animate-in fade-in-50 duration-300">
          <CardHeader className="pt-5 pb-1 px-6">
            <CardTitle className="text-sm font-semibold tracking-tight">Liquid Asset Allocation</CardTitle>
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
                <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground/80 truncate max-w-[110px] leading-tight">
                  {activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].name : "Total Cash"}
                </span>
                <span className="text-sm font-extrabold tracking-tight mt-0.5 tabular-nums text-foreground truncate max-w-[110px]">
                  {fmt(activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].value : totalInr)}
                </span>
              </div>
            </div>

            {/* Premium Legend Grid */}
            <div className="flex flex-col gap-1.5 w-full flex-1">
              {donutData.map((d, i) => {
                const pct = totalInr > 0 ? (d.value / totalInr) * 100 : 0;
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
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground w-14 text-center">
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

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Error loading savings and checking accounts.
          </AlertDescription>
        </Alert>
      )}

      {/* Accounts List Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : liquidAccounts.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground text-sm leading-relaxed border border-dashed rounded-2xl bg-muted/10">
          No Checking, Savings, or Cash accounts yet.
          <br />
          Click "Add Account" above to create your first liquid asset.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {liquidAccounts.map((a) => {
            const isBase = a.currency === defaultCurrency;
            const displayBal = formatCurrency(a.balance, a.currency);
            const displayBase = fmt(a.balance_inr);
            const IconComponent =
              a.type === "savings"
                ? PiggyBank
                : a.type === "cash"
                  ? Coins
                  : Landmark;

            return (
              <Card
                key={a.id}
                onClick={() => setSelectedAccount(a)}
                className="group relative cursor-pointer overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent"
              >
                <CardContent className="pt-4 pb-4 px-4 flex items-center justify-between gap-4 h-full relative">
                  {/* Left: Account Info */}
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm truncate text-foreground/90 group-hover:text-primary transition-colors pr-6">
                      {a.name}
                    </h3>
                    <div className="flex gap-1.5 mt-1.5 flex-wrap">
                      <Badge
                        variant="secondary"
                        className="text-xs px-1.5 py-0 capitalize flex items-center gap-1"
                      >
                        <IconComponent className="w-2.5 h-2.5" />
                        {a.type}
                      </Badge>
                      <Badge
                        variant={a.off_budget ? "outline" : "default"}
                        className={`text-xs px-1.5 py-0 ${
                          a.off_budget
                            ? "text-amber-500 border-amber-500/20"
                            : "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/10"
                        }`}
                      >
                        {a.off_budget ? "Off-Budget" : "On-Budget"}
                      </Badge>
                    </div>
                  </div>

                  {/* Right: Amount & Base conversion */}
                  <div className="text-right flex-shrink-0 flex flex-col justify-center items-end">
                    <p className="text-base font-bold tabular-nums text-foreground/90 leading-none">
                      {displayBal}
                    </p>
                    {!isBase && (
                      <p className="text-xs text-muted-foreground font-medium tabular-nums mt-1 leading-none">
                        ≈ {displayBase}
                      </p>
                    )}
                  </div>

                  {/* Hover toolbar (overlay top-right) */}
                  <div
                    className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-200 bg-background/90 backdrop-blur-md rounded-lg p-0.5 shadow-md border border-border/80"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AccountFormDialog
                      title="Edit Account"
                      initial={{
                        name: a.name,
                        type: a.type,
                        currency: a.currency,
                        balance: a.balance,
                        off_budget: a.off_budget,
                        institution: a.institution ?? "",
                        is_active: a.is_active ?? true,
                      }}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                      }
                      isPending={updating}
                      onSubmit={(data) =>
                        updateAccount(
                          { id: a.id, data: data as any },
                          {
                            onSuccess: () =>
                              toast.success(
                                "Account settings updated successfully"
                              ),
                          }
                        )
                      }
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-negative hover:bg-muted"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      }
                      title={`Delete account "${a.name}"?`}
                      description="This will permanently delete the account, and all associated transactions. Transactions will no longer affect your envelopes."
                      onConfirm={() =>
                        deleteAccount(a.id, {
                          onSuccess: () =>
                            toast.success("Account deleted successfully"),
                          onError: (e) => toast.error(e.message),
                        })
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Account Transactions Sheet */}
      {selectedAccount && (
        <AccountDetailSheet
          account={activeSheetAccount || selectedAccount}
          open={!!selectedAccount}
          onOpenChange={(open) => {
            if (!open) setSelectedAccount(null);
          }}
        />
      )}
    </div>
  );
}
