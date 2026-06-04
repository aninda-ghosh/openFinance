import {
  ArrowRightLeft,
  Calendar,
  Check,
  ChevronDown,
  Coins,
  FileText,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useAccounts,
  useCreateTransaction,
  useCreateTransfer,
  useEnvelopes,
  useTransactions,
} from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import { formatCurrency } from "@finwise/shared/utils";

const getCurrencySymbol = (currencyCode: string): string => {
  const map: Record<string, string> = {
    USD: "$",
    INR: "₹",
    EUR: "€",
    GBP: "£",
    CAD: "$",
    AUD: "$",
    JPY: "¥",
  };
  return map[currencyCode.toUpperCase()] || currencyCode;
};

export default function QuickAddPage() {
  const navigate = useNavigate();
  const { selectedMonth, defaultCurrency } = useAppStore();

  const { data: accountsData } = useAccounts();
  const { data: envelopesData } = useEnvelopes(selectedMonth);
  // Fetch transactions to build predictive payees and envelopes
  const { data: transactionsData } = useTransactions({ limit: 150 });

  const { mutate: createTxn, isPending: creatingTxn } = useCreateTransaction();
  const { mutate: createTransfer, isPending: creatingTransfer } =
    useCreateTransfer();

  const accounts = useMemo(() => {
    return (accountsData?.accounts ?? []).filter((a) => !a.off_budget);
  }, [accountsData]);
  const envelopes = useMemo(() => {
    return envelopesData?.envelopes ?? [];
  }, [envelopesData]);
  const transactions = transactionsData?.transactions ?? [];

  // Form states
  const [tab, setTab] = useState<"expense" | "income" | "transfer">("expense");
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [envelopeId, setEnvelopeId] = useState("");
  const [incomeCategory, setIncomeCategory] = useState<
    "income" | "cashback" | "starting_balance"
  >("income");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  // Custom UI overlay states
  const [showEnvelopeSelect, setShowEnvelopeSelect] = useState(false);
  const [envSearchQuery, setEnvSearchQuery] = useState("");

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [successAnimation, setSuccessAnimation] = useState(false);

  const amountRef = useRef<HTMLInputElement>(null);

  // Set default account when accounts are loaded or default base currency changes
  useEffect(() => {
    if (accounts.length > 0) {
      // Find first active liquid account matching default base currency, or any active liquid account, or any account
      const defaultAcc =
        accounts.find(
          (a) =>
            a.is_active &&
            ["checking", "savings", "cash"].includes(a.type) &&
            a.currency === defaultCurrency
        ) ||
        accounts.find(
          (a) => a.is_active && ["checking", "savings", "cash"].includes(a.type)
        ) ||
        accounts[0];

      if (defaultAcc && !accountId) {
        setAccountId(defaultAcc.id);
      }

      if (accounts.length > 1 && !toAccountId) {
        const nextAcc =
          accounts.find(
            (a) =>
              a.id !== defaultAcc.id &&
              a.is_active &&
              a.currency === defaultCurrency
          ) ||
          accounts.find((a) => a.id !== defaultAcc.id && a.is_active) ||
          accounts[1];
        if (nextAcc) {
          setToAccountId(nextAcc.id);
        }
      }
    }
  }, [accounts, toAccountId, accountId, defaultCurrency]);

  // Focus Amount input on open
  useEffect(() => {
    setTimeout(() => {
      amountRef.current?.focus();
    }, 150);
  }, []);

  // Calculate top 5 payees and predictive envelopes based on transaction history
  const { topPayees, predictiveEnvelopes } = useMemo(() => {
    if (!transactions || transactions.length === 0) {
      return { topPayees: [], predictiveEnvelopes: {} };
    }

    const payeeCounts: Record<string, number> = {};
    const payeeEnvelopes: Record<string, Record<string, number>> = {};

    transactions.forEach((tx) => {
      if (tx.type !== "expense") return;
      const pName = tx.payee.trim();
      if (!pName) return;

      // Count payee
      payeeCounts[pName] = (payeeCounts[pName] || 0) + 1;

      // Map envelope
      if (tx.envelope_id) {
        if (!payeeEnvelopes[pName]) {
          payeeEnvelopes[pName] = {};
        }
        payeeEnvelopes[pName][tx.envelope_id] =
          (payeeEnvelopes[pName][tx.envelope_id] || 0) + 1;
      }
    });

    // Select top 5 payees
    const sortedPayees = Object.entries(payeeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    // Map each payee to its most frequent envelope
    const predictiveMap: Record<string, string> = {};
    Object.entries(payeeEnvelopes).forEach(([payeeName, envs]) => {
      const bestEnv = Object.entries(envs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bestEnv) {
        predictiveMap[payeeName.toLowerCase()] = bestEnv;
      }
    });

    return { topPayees: sortedPayees, predictiveEnvelopes: predictiveMap };
  }, [transactions]);

  // Auto-categorize category when payee changes
  const handlePayeeChange = (value: string) => {
    setPayee(value);
    const lowercasePayee = value.trim().toLowerCase();
    if (predictiveEnvelopes[lowercasePayee]) {
      setEnvelopeId(predictiveEnvelopes[lowercasePayee]);
    }
  };

  // Group and filter envelopes by search query
  const filteredEnvelopesByGroup = useMemo(() => {
    const query = envSearchQuery.toLowerCase().trim();
    interface EnvelopeGroup {
      groupId: string;
      groupName: string;
      items: typeof envelopes;
    }
    return envelopes.reduce<EnvelopeGroup[]>((acc, env) => {
      if (
        query &&
        !env.name.toLowerCase().includes(query) &&
        !env.group_name.toLowerCase().includes(query)
      ) {
        return acc;
      }
      const existing = acc.find((g) => g.groupId === env.group_id);
      if (existing) {
        existing.items.push(env);
      } else {
        acc.push({
          groupId: env.group_id,
          groupName: env.group_name,
          items: [env],
        });
      }
      return acc;
    }, []);
  }, [envelopes, envSearchQuery]);

  // Determine YNAB boundaries and validation
  const fromAccount = accounts.find((a) => a.id === accountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);

  // YNAB boundary crossing: On-Budget -> Off-Budget transfer
  const isBoundaryCrossing = useMemo(() => {
    if (tab !== "transfer" || !fromAccount || !toAccount) return false;
    return !fromAccount.off_budget && toAccount.off_budget;
  }, [tab, fromAccount, toAccount]);

  // Quick action key helper
  const handleKeyboardInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!payee && tab !== "transfer") {
        document.getElementById("payee-input")?.focus();
      } else {
        handleSubmit();
      }
    }
  };

  const handleSubmit = () => {
    const numericAmount = parseFloat(amount);
    if (!numericAmount || numericAmount <= 0) {
      toast.error("Please enter a valid positive amount.");
      return;
    }

    if (tab === "transfer") {
      if (!accountId || !toAccountId) {
        toast.error("Please select both source and destination accounts.");
        return;
      }
      if (accountId === toAccountId) {
        toast.error("Source and destination accounts must be different.");
        return;
      }

      // If On-Budget -> Off-Budget, envelope is strictly required
      if (isBoundaryCrossing && !envelopeId) {
        toast.error(
          "Envelope category is required for transfers crossing the YNAB boundary (On-Budget to Off-Budget)."
        );
        return;
      }

      createTransfer(
        {
          from_account_id: accountId,
          to_account_id: toAccountId,
          amount: numericAmount,
          to_amount: numericAmount, // Default simple transfer
          date,
          notes: notes || payee || undefined,
          envelope_id: envelopeId || undefined,
        },
        {
          onSuccess: () => {
            playSuccessAnimation();
          },
          onError: (e: any) => {
            toast.error("Intent Unfulfilled: Transfer Not Saved", {
              description: e?.message || "Failed to record transfer. Please check your connection and try again.",
              duration: 6000,
            });
          },
        }
      );
    } else {
      if (!accountId) {
        toast.error("Please select an account.");
        return;
      }
      if (!payee.trim()) {
        toast.error("Please enter a payee.");
        return;
      }
      if (
        tab === "expense" &&
        fromAccount &&
        !fromAccount.off_budget &&
        !envelopeId
      ) {
        toast.error("An envelope category is required for On-Budget expenses.");
        return;
      }

      createTxn(
        {
          account_id: accountId,
          payee: payee.trim(),
          amount: numericAmount,
          type: tab,
          date,
          envelope_id: envelopeId || undefined,
          notes: notes || undefined,
          ...(tab === "income" ? { income_category: incomeCategory } : {}),
        },
        {
          onSuccess: () => {
            playSuccessAnimation();
          },
          onError: (e: any) => {
            toast.error("Intent Unfulfilled: Transaction Not Saved", {
              description: e?.message || "Failed to add transaction. Please check your connection and try again.",
              duration: 6000,
            });
          },
        }
      );
    }
  };

  const playSuccessAnimation = () => {
    setSuccessAnimation(true);
    setTimeout(() => {
      navigate(-1);
    }, 1000);
  };

  return (
    <div className="w-full flex flex-col h-full bg-background relative overflow-hidden">
      {/* Premium Custom Envelope Selector Overlay */}
      {showEnvelopeSelect && (
        <div className="absolute inset-0 z-50 flex flex-col bg-card animate-slide-up">
          <div className="max-w-md mx-auto w-full flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/20">
              <span className="text-[11px] font-semibold text-primary/90 tracking-wide dark:text-primary/80 flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-primary" />
                Select Budget Envelope
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowEnvelopeSelect(false);
                  setEnvSearchQuery("");
                }}
                className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Input Box */}
            <div className="px-5 py-3 border-b border-border/40 flex items-center relative">
              <input
                type="text"
                placeholder="Search category or group..."
                value={envSearchQuery}
                onChange={(e) => setEnvSearchQuery(e.target.value)}
                className="w-full border border-border/80 focus:border-primary rounded-xl pl-9 pr-3.5 py-2.5 text-sm font-semibold bg-background outline-none transition-all focus:ring-1 focus:ring-primary"
              />
              <Search className="absolute left-8 w-4 h-4 text-muted-foreground select-none pointer-events-none" />
            </div>

            {/* List scrollable area */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {filteredEnvelopesByGroup.length === 0 ? (
                <div className="text-center py-8 text-xs text-muted-foreground font-semibold">
                  No matching envelopes found
                </div>
              ) : (
                filteredEnvelopesByGroup.map(({ groupId, groupName, items }) => (
                  <div key={groupId} className="space-y-1.5">
                    <h3 className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide/80 border-b border-border/10 pb-0.5">
                      {groupName}
                    </h3>
                    <div className="grid grid-cols-1 gap-2">
                      {items.map((env) => {
                        const isSelected = env.id === envelopeId;
                        const pctSpent =
                          env.budgeted_inr > 0 ? (env.spent / env.budgeted_inr) * 100 : 0;
                        const remaining = env.budgeted - (env.budgeted_inr > 0 ? (env.spent / env.budgeted_inr) * env.budgeted : 0);
                        return (
                          <button
                            key={env.id}
                            type="button"
                            onClick={() => {
                              setEnvelopeId(env.id);
                              setShowEnvelopeSelect(false);
                              setEnvSearchQuery("");
                            }}
                            className={cn(
                              "w-full text-left rounded-xl border p-3 flex flex-col justify-between transition-all duration-150 select-none shadow-sm",
                              isSelected
                                ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                                : "border-border/60 bg-background hover:bg-muted/40 hover:border-muted-foreground/20"
                            )}
                          >
                            <div className="flex justify-between items-center w-full">
                              <span className="text-sm font-semibold text-foreground">
                                {env.name}
                              </span>
                              <span className="text-xs font-bold tabular-nums text-muted-foreground">
                                {remaining >= 0 ? "+" : ""}{formatCurrency(remaining, env.budget_currency as any)}
                              </span>
                            </div>

                            {/* Budget Progress Bar */}
                            <div className="w-full mt-2.5 space-y-1.5">
                              <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all duration-300",
                                    pctSpent >= 100
                                      ? "bg-negative"
                                      : pctSpent >= 85
                                      ? "bg-amber-500"
                                      : "bg-primary"
                                  )}
                                  style={{
                                    width: `${Math.min(100, pctSpent)}%`,
                                  }}
                                />
                              </div>
                              <div className="flex justify-between items-center text-xs font-semibold text-muted-foreground/90 leading-none">
                                <span>Spent: {pctSpent.toFixed(0)}%</span>
                                <span>
                                  Budget: {formatCurrency(env.budgeted, env.budget_currency as any)}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Clear Button */}
            <div className="p-4 border-t border-border/40 bg-muted/10">
              <button
                type="button"
                onClick={() => {
                  setEnvelopeId("");
                  setShowEnvelopeSelect(false);
                  setEnvSearchQuery("");
                }}
                className="w-full py-3 bg-background border border-border hover:bg-muted/30 text-xs font-extrabold rounded-xl transition-all"
              >
                Clear Selector (Uncategorised)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success Pulse overlay */}
      {successAnimation && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-card/90 backdrop-blur-sm animate-fade-in">
          <div className="w-16 h-16 rounded-full bg-positive/10 border-2 border-positive flex items-center justify-center animate-scale-up-pulse shadow-lg shadow-positive/20">
            <Check className="w-8 h-8 text-positive" />
          </div>
          <p className="text-sm font-semibold text-foreground mt-4 tracking-wide">
            Transaction Logged Successfully
          </p>
        </div>
      )}

      <div className="border-b border-border bg-muted/5 flex-shrink-0">
        <div className="max-w-md mx-auto w-full flex items-center justify-center py-3">
          <div className="flex items-center gap-1.5">
            <Coins className="w-4 h-4 text-primary animate-pulse" />
            <h2 className="text-base font-semibold tracking-tight">
              Add Transaction
            </h2>
          </div>
        </div>
      </div>

      <div className="px-5 pt-3 flex-shrink-0">
        <div className="max-w-md mx-auto w-full">
          <div className="flex rounded-xl bg-muted/40 p-1 text-sm font-semibold backdrop-blur-md border border-border/5">
            {(["expense", "income", "transfer"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  setEnvelopeId("");
                }}
                className={cn(
                  "flex-1 py-2 rounded-lg capitalize transition-all duration-300 relative select-none",
                  tab === t
                    ? "bg-primary text-primary-foreground shadow-sm font-semibold active:scale-[0.98]"
                    : "text-muted-foreground/85 hover:text-foreground font-medium"
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Form area: Fully scrollable and takes up dynamic space */}
      <div className="flex-1 overflow-y-auto px-5 py-3 no-scrollbar">
        <div className="max-w-md mx-auto w-full space-y-3">
          {/* Amount input block */}
          <div className="relative rounded-3xl border border-border/40 bg-card p-6 flex flex-col justify-center items-center shadow-sm hover:border-primary/20 focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/5 transition-all duration-300">
            <span className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide">
              Amount
            </span>
            <div className="flex items-center justify-center gap-1 mt-2.5 w-full">
              <span className="text-4xl font-light text-muted-foreground/60 select-none leading-none">
                {getCurrencySymbol(fromAccount?.currency ?? defaultCurrency)}
              </span>
              <input
                ref={amountRef}
                type="number"
                inputMode="decimal"
                pattern="[0-9]*"
                placeholder="0.00"
                value={amount}
                onKeyDown={handleKeyboardInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setAmount(val);
                }}
                style={{ width: `${Math.max(1.5, (amount || "0.00").length) * 1.65}rem` }}
                className="bg-transparent border-0 outline-none focus:ring-0 text-5xl font-semibold tracking-tight text-foreground p-0 text-left min-w-[2rem] font-sans leading-none"
              />
            </div>
          </div>

          {/* Account Selector (CC Card Chips) */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              {tab === "transfer" ? "From Account" : "Select Account"}
            </label>
            <div className="flex gap-2.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
              {accounts.map((a) => {
                const isSelected = a.id === accountId;
                return (
                  <button
                    key={a.id}
                    onClick={() => setAccountId(a.id)}
                    className={cn(
                      "flex-shrink-0 w-36 rounded-2xl border p-3.5 flex flex-col justify-between text-left transition-all duration-300 shadow-sm relative overflow-hidden select-none",
                      isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30 shadow-md shadow-primary/5"
                        : "border-border/60 bg-card hover:bg-muted/40 hover:border-primary/20 shadow-sm"
                    )}
                  >
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-3.5 h-3.5 rounded-full bg-primary flex items-center justify-center border border-background">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    )}
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide truncate leading-normal">
                        {a.institution || a.type}
                      </span>
                      <span className="text-sm font-semibold text-foreground truncate mt-0.5 max-w-[100px]">
                        {a.name}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <span className="text-xs font-medium text-muted-foreground/75 block leading-none">
                        Balance
                      </span>
                      <span className="text-sm font-semibold text-foreground tracking-tight tabular-nums mt-1 block">
                        {formatCurrency(a.balance, a.currency as any)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Destination Selector for Transfers */}
          {tab === "transfer" && (
            <div className="space-y-2 pt-1 border-t border-border/5">
              <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
                To Account
              </label>
              <div className="flex gap-2.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
                {accounts
                  .filter((a) => a.id !== accountId)
                  .map((a) => {
                    const isSelected = a.id === toAccountId;
                    return (
                      <button
                        key={a.id}
                        onClick={() => setToAccountId(a.id)}
                        className={cn(
                          "flex-shrink-0 w-36 rounded-xl border p-2.5 flex flex-col justify-between text-left transition-all duration-200 shadow-sm relative overflow-hidden select-none",
                           isSelected
                             ? "border-2 border-primary bg-primary/10 shadow-sm"
                             : "border border-border/15 bg-background hover:bg-muted/20 hover:border-muted-foreground/10 shadow-sm"
                        )}
                      >
                        {isSelected && (
                          <div className="absolute top-2 right-2 w-3.5 h-3.5 rounded-full bg-primary flex items-center justify-center border border-background">
                            <Check className="w-2.5 h-2.5 text-white" />
                          </div>
                        )}
                        <div className="flex flex-col">
                          <span className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide truncate leading-normal">
                            {a.institution || a.type}
                          </span>
                          <span className="text-sm font-semibold text-foreground truncate mt-0.5 max-w-[100px]">
                            {a.name}
                          </span>
                        </div>
                        <div className="mt-1.5">
                          <span className="text-xs font-medium text-muted-foreground/75 block leading-none">
                            Balance
                          </span>
                          <span className="text-sm font-semibold text-foreground tracking-tight tabular-nums mt-1 block">
                            {formatCurrency(a.balance, a.currency as any)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Payee panel */}
          {tab !== "transfer" && (
            <div className="space-y-1.5">
              <label
                className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block"
                htmlFor="payee-input"
              >
                Payee / Source
              </label>
              <div className="relative flex items-center">
                <input
                  id="payee-input"
                  type="text"
                  placeholder={
                    tab === "income" ? "e.g. Salary, Dividend" : "e.g. Starbucks, Uber"
                  }
                  value={payee}
                  onChange={(e) => handlePayeeChange(e.target.value)}
                  className="w-full border border-border/60 focus:border-primary/40 bg-background/40 focus:bg-background rounded-2xl pl-9 pr-4 py-3.5 text-xs outline-none transition-all focus:ring-2 focus:ring-primary/10 font-medium shadow-sm"
                />
                <Sparkles className="absolute left-3 w-4 h-4 text-primary/80 select-none pointer-events-none" />
              </div>
            </div>
          )}

          {/* Predictive Payee Pills Horizontal Scroll */}
          {tab !== "transfer" && topPayees.length > 0 && !payee && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-primary/95 flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5 text-primary/80 animate-pulse" /> Recent
                Payees
              </span>
              <div className="flex gap-1.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
                {topPayees.map((p) => (
                  <button
                    key={p}
                    onClick={() => handlePayeeChange(p)}
                    className="flex-shrink-0 px-3.5 py-1.5 rounded-full border border-border/60 hover:border-primary/30 bg-card hover:bg-primary/5 text-xs font-medium text-muted-foreground hover:text-primary transition-all duration-200 shadow-sm"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Premium Custom Envelope Selector Trigger */}
          {tab === "expense" && envelopes.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
                Budget Envelope Category
                {fromAccount && !fromAccount.off_budget ? (
                  <span className="text-negative/85 font-bold ml-1">*Required</span>
                ) : (
                  <span className="text-muted-foreground ml-1">
                    (Optional for Off-Budget)
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => setShowEnvelopeSelect(true)}
                className="w-full border border-border/60 hover:border-primary/30 bg-card hover:bg-muted/40 rounded-2xl px-3.5 py-3.5 flex items-center justify-between transition-all outline-none focus:ring-2 focus:ring-primary/10 font-semibold text-left shadow-sm"
              >
                <div className="flex flex-col">
                  {envelopeId ? (
                    <>
                      <span className="text-[11px] font-semibold text-primary/90 tracking-wide">
                        {envelopes.find((e) => e.id === envelopeId)
                          ?.group_name || "Budget Group"}
                      </span>
                      <span className="text-sm font-bold text-foreground mt-0.5">
                        {envelopes.find((e) => e.id === envelopeId)?.name ||
                          "Select Envelope..."}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm font-semibold text-muted-foreground">
                      Uncategorised / Select Category...
                    </span>
                  )}
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          )}

          {/* Custom Income Category Tag Selector */}
          {tab === "income" && (
            <div className="space-y-2">
              <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
                Income Category
              </label>
              <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
                {([
                  { value: "income", label: "Salary / Income" },
                  { value: "cashback", label: "Cashback / Refund" },
                  { value: "starting_balance", label: "Starting Balance" },
                ] as const).map((item) => {
                  const isSelected = incomeCategory === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setIncomeCategory(item.value)}
                      className={cn(
                        "flex-shrink-0 px-4 py-2 rounded-2xl border text-xs font-semibold transition-all duration-200 select-none shadow-sm",
                        isSelected
                          ? "border-positive bg-positive/10 text-positive font-extrabold shadow-sm"
                          : "border-border/15 bg-background hover:bg-muted/20 text-muted-foreground hover:text-foreground shadow-sm"
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* YNAB Boundary Crossing Warning or Helper Info */}
          {tab === "transfer" && (
            <div className="space-y-3">
              {isBoundaryCrossing ? (
                <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5 text-xs font-semibold leading-relaxed text-primary dark:text-primary-foreground/90 shadow-sm">
                  <div className="flex gap-1.5 font-bold uppercase tracking-wider text-xs text-primary dark:text-primary/80 mb-1">
                    <ArrowRightLeft className="w-3.5 h-3.5" /> YNAB Envelope
                    Boundary Crossing
                  </div>
                  You are transferring funds from an <strong>On-Budget</strong>{" "}
                  account to an <strong>Off-Budget</strong> account. Since the
                  funds are leaving your liquid budget envelopes, you must
                  select an envelope category to log the outflow.
                  <div className="mt-3">
                    <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide mb-1 block">
                      Enforcement Envelope Category{" "}
                      <span className="text-negative/85 font-bold">*Required</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowEnvelopeSelect(true)}
                      className="w-full border border-primary/15 hover:border-primary/50 bg-background hover:bg-muted rounded-xl px-3 py-2.5 flex items-center justify-between transition-all outline-none font-bold text-left shadow-sm"
                    >
                      <span className="text-sm font-semibold text-foreground truncate">
                        {envelopes.find((e) => e.id === envelopeId)?.name ||
                          "Select Category..."}
                      </span>
                      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/10 bg-background p-3 text-xs font-semibold text-muted-foreground text-center shadow-sm">
                  🔄 This transfer is <strong>Budget-Neutral</strong>. No
                  envelope category is required as the funds remain within the
                  same budget boundary.
                </div>
              )}
            </div>
          )}

          {/* Advanced fields expander button */}
          <div className="flex justify-center border-t border-border/5 pt-2">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs font-bold text-muted-foreground hover:text-foreground flex items-center gap-1 py-1 px-2 rounded-md hover:bg-muted/40 transition-colors"
            >
              {showAdvanced
                ? "Hide Optional Details"
                : "Show Optional Details (Date, Notes)"}
            </button>
          </div>

          {/* Advanced Fields (Date and Notes) */}
          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 text-xs animate-fade-in">
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide mb-1 block flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-primary" /> Date
                </label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full border border-border/60 focus:border-primary/40 bg-background/40 focus:bg-background rounded-2xl px-3.5 py-3 text-xs outline-none transition-all focus:ring-2 focus:ring-primary/10 font-medium shadow-sm"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide mb-1 block flex items-center gap-1">
                  <FileText className="w-3 h-3 text-primary" /> Notes
                </label>
                <input
                  type="text"
                  placeholder="Memo / notes..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full border border-border/60 focus:border-primary/40 bg-background/40 focus:bg-background rounded-2xl px-3.5 py-3 text-xs outline-none transition-all focus:ring-2 focus:ring-primary/10 font-medium shadow-sm"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sticky Bottom Actions */}
      <div className="border-t border-border bg-background p-3 flex-shrink-0">
        <div className="max-w-md mx-auto w-full">
          <button
            onClick={handleSubmit}
            disabled={creatingTxn || creatingTransfer || !amount}
            className="w-full py-3.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold tracking-wide text-sm rounded-2xl shadow-lg hover:shadow-primary/10 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2"
          >
            {creatingTxn || creatingTransfer ? (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              "Log Transaction"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
