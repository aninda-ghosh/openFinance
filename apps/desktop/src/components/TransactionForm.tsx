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
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useAccounts,
  useCreateTransaction,
  useCreateTransfer,
  useDeleteTransaction,
  useEnvelopes,
  useTransactions,
  useUpdateTransaction,
} from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import { formatCurrency } from "@openfinance/shared/utils";

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

type TabType = "expense" | "income" | "transfer";
type IncomeCategory = "income" | "cashback" | "starting_balance";

export type TransactionFormProps = {
  mode?: "create" | "edit";
  /** Transaction being edited (required when mode="edit") */
  transaction?: any;
  /** Pre-select this account in create mode (e.g. account detail sheet) */
  defaultAccountId?: string;
  /** Called after the success animation completes (close drawer / dialog) */
  onSuccess?: () => void;
  /** Called after a successful delete in edit mode */
  onDeleted?: () => void;
  className?: string;
};

function AccountChip({
  account,
  isSelected,
  disabled,
  onSelect,
}: {
  account: any;
  isSelected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex-shrink-0 w-36 rounded-2xl border p-3.5 flex flex-col justify-between text-left transition-all duration-300 shadow-sm relative overflow-hidden select-none",
        isSelected
          ? "border-primary bg-primary/5 ring-1 ring-primary/30 shadow-md shadow-primary/5"
          : "border-border/60 bg-card hover:bg-muted/40 hover:border-primary/20 shadow-sm",
        disabled && "cursor-not-allowed opacity-70"
      )}
    >
      {isSelected && (
        <div className="absolute top-2 right-2 w-3.5 h-3.5 rounded-full bg-primary flex items-center justify-center border border-background">
          <Check className="w-2.5 h-2.5 text-white" />
        </div>
      )}
      <div className="flex flex-col">
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/80 uppercase truncate leading-normal">
          {account.institution || account.type}
        </span>
        <span className="text-xs font-semibold text-foreground truncate mt-0.5 max-w-[100px]">
          {account.name}
        </span>
      </div>
      <div className="mt-3">
        <span className="text-xs font-medium text-muted-foreground/75 block leading-none">
          Balance
        </span>
        <span className="text-xs font-semibold text-foreground tracking-tight tabular-nums mt-1 block">
          {formatCurrency(account.balance, account.currency as any)}
        </span>
      </div>
    </button>
  );
}

function EnvelopeTrigger({
  envelopes,
  envelopeId,
  onOpen,
}: {
  envelopes: any[];
  envelopeId: string;
  onOpen: () => void;
}) {
  const selected = envelopes.find((e) => e.id === envelopeId);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full border border-border/60 hover:border-primary/30 bg-card hover:bg-muted/40 rounded-2xl px-3.5 py-3.5 flex items-center justify-between transition-all outline-none focus:ring-2 focus:ring-primary/10 font-semibold text-left shadow-sm"
    >
      <div className="flex flex-col">
        {selected ? (
          <>
            <span className="text-[10px] font-semibold tracking-wider text-primary/80 uppercase">
              {selected.group_name || "Budget Group"}
            </span>
            <span className="text-xs font-extrabold text-foreground mt-0.5">
              {selected.name}
            </span>
          </>
        ) : (
          <span className="text-xs font-semibold text-muted-foreground">
            Uncategorised / Select Category...
          </span>
        )}
      </div>
      <ChevronDown className="w-4 h-4 text-muted-foreground" />
    </button>
  );
}

export default function TransactionForm({
  mode = "create",
  transaction,
  defaultAccountId,
  onSuccess,
  onDeleted,
  className,
}: TransactionFormProps) {
  const isEdit = mode === "edit";
  const isTransferEdit = isEdit && transaction?.type === "transfer";

  const { selectedMonth, defaultCurrency } = useAppStore();

  const { data: accountsData } = useAccounts();
  // Predictive payees only matter when logging new transactions
  const { data: transactionsData } = useTransactions(
    isEdit ? { limit: 1 } : { limit: 150 }
  );

  const { mutate: createTxn, isPending: creatingTxn } = useCreateTransaction();
  const { mutate: createTransfer, isPending: creatingTransfer } =
    useCreateTransfer();
  const { mutate: updateTxn, isPending: updating } = useUpdateTransaction();
  const { mutate: deleteTxn, isPending: deleting } = useDeleteTransaction();

  const accounts = useMemo(
    () => accountsData?.accounts ?? [],
    [accountsData]
  );
  const transactions = transactionsData?.transactions ?? [];

  // Form states
  const [tab, setTab] = useState<TabType>(
    isEdit ? (transaction?.type ?? "expense") : "expense"
  );
  const [amount, setAmount] = useState(
    isEdit ? String(transaction?.amount ?? "") : ""
  );
  const [toAmount, setToAmount] = useState("");
  const [payee, setPayee] = useState(isEdit ? (transaction?.payee ?? "") : "");
  const [accountId, setAccountId] = useState(
    isEdit ? (transaction?.account_id ?? "") : (defaultAccountId ?? "")
  );
  const [toAccountId, setToAccountId] = useState("");
  const [envelopeId, setEnvelopeId] = useState(
    isEdit ? (transaction?.envelope_id ?? "") : ""
  );
  const [incomeCategory, setIncomeCategory] = useState<IncomeCategory>(
    isEdit ? (transaction?.income_category ?? "income") : "income"
  );
  const [date, setDate] = useState(() =>
    isEdit && transaction?.date
      ? transaction.date.slice(0, 10)
      : new Date().toISOString().slice(0, 10)
  );
  const [notes, setNotes] = useState(isEdit ? (transaction?.notes ?? "") : "");

  // Custom UI overlay states
  const [showEnvelopeSelect, setShowEnvelopeSelect] = useState(false);
  const [envSearchQuery, setEnvSearchQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // UI state
  const [showAdvanced, setShowAdvanced] = useState(isEdit);
  const [successAnimation, setSuccessAnimation] = useState(false);

  const amountRef = useRef<HTMLInputElement>(null);

  // Envelopes are month-scoped: in edit mode follow the transaction's own
  // month so the right envelope set loads
  const envelopeMonth = useMemo(() => {
    if (isEdit && date?.match(/^\d{4}-\d{2}/)) return date.slice(0, 7);
    return selectedMonth;
  }, [isEdit, date, selectedMonth]);

  const { data: envelopesData } = useEnvelopes(envelopeMonth);
  const envelopes = useMemo(
    () => envelopesData?.envelopes ?? [],
    [envelopesData]
  );

  // Set default accounts when loaded (create mode only)
  useEffect(() => {
    if (isEdit || accounts.length === 0) return;
    if (!accountId) {
      const defaultAcc =
        (defaultAccountId &&
          accounts.find((a) => a.id === defaultAccountId)) ||
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
      if (defaultAcc) setAccountId(defaultAcc.id);
    }
  }, [isEdit, accounts, accountId, defaultAccountId, defaultCurrency]);

  useEffect(() => {
    if (isEdit || accounts.length < 2 || toAccountId || !accountId) return;
    const nextAcc =
      accounts.find(
        (a) => a.id !== accountId && a.is_active && a.currency === defaultCurrency
      ) ||
      accounts.find((a) => a.id !== accountId && a.is_active) ||
      accounts.find((a) => a.id !== accountId);
    if (nextAcc) setToAccountId(nextAcc.id);
  }, [isEdit, accounts, accountId, toAccountId, defaultCurrency]);

  // Focus Amount input on mount
  useEffect(() => {
    if (!isEdit) {
      const id = setTimeout(() => amountRef.current?.focus(), 150);
      return () => clearTimeout(id);
    }
  }, [isEdit]);

  // Top 5 payees and predictive envelopes based on transaction history
  const { topPayees, predictiveEnvelopes } = useMemo(() => {
    if (isEdit || !transactions || transactions.length === 0) {
      return { topPayees: [], predictiveEnvelopes: {} as Record<string, string> };
    }

    const payeeCounts: Record<string, number> = {};
    const payeeEnvelopes: Record<string, Record<string, number>> = {};

    transactions.forEach((tx) => {
      if (tx.type !== "expense") return;
      const pName = tx.payee.trim();
      if (!pName) return;

      payeeCounts[pName] = (payeeCounts[pName] || 0) + 1;

      if (tx.envelope_id) {
        if (!payeeEnvelopes[pName]) {
          payeeEnvelopes[pName] = {};
        }
        payeeEnvelopes[pName][tx.envelope_id] =
          (payeeEnvelopes[pName][tx.envelope_id] || 0) + 1;
      }
    });

    const sortedPayees = Object.entries(payeeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const predictiveMap: Record<string, string> = {};
    Object.entries(payeeEnvelopes).forEach(([payeeName, envs]) => {
      const bestEnv = Object.entries(envs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bestEnv) {
        predictiveMap[payeeName.toLowerCase()] = bestEnv;
      }
    });

    return { topPayees: sortedPayees, predictiveEnvelopes: predictiveMap };
  }, [isEdit, transactions]);

  // Auto-categorize when payee changes
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

  const fromAccount = accounts.find((a) => a.id === accountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);

  // YNAB boundary crossing: On-Budget -> Off-Budget transfer
  const isBoundaryCrossing = useMemo(() => {
    if (tab !== "transfer" || !fromAccount || !toAccount) return false;
    return !fromAccount.off_budget && toAccount.off_budget;
  }, [tab, fromAccount, toAccount]);

  // Cross-currency transfers need an explicit destination amount
  const isCrossCurrency =
    tab === "transfer" &&
    !!fromAccount &&
    !!toAccount &&
    fromAccount.currency !== toAccount.currency;

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

  const playSuccessAnimation = () => {
    setSuccessAnimation(true);
    setTimeout(() => {
      setSuccessAnimation(false);
      if (!isEdit) {
        // Clear entry fields so an always-mounted form (account sheet) is
        // ready for the next record; keep tab, accounts, and date
        setAmount("");
        setToAmount("");
        setPayee("");
        setEnvelopeId("");
        setNotes("");
      }
      onSuccess?.();
    }, 1000);
  };

  const handleSubmit = () => {
    if (isEdit) {
      handleSaveEdit();
      return;
    }

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
      if (isBoundaryCrossing && !envelopeId) {
        toast.error(
          "Envelope category is required for transfers crossing the YNAB boundary (On-Budget to Off-Budget)."
        );
        return;
      }
      const numericToAmount = isCrossCurrency
        ? parseFloat(toAmount)
        : numericAmount;
      if (isCrossCurrency && (!numericToAmount || numericToAmount <= 0)) {
        toast.error(
          `Please enter the amount received in ${toAccount?.currency}.`
        );
        return;
      }

      createTransfer(
        {
          from_account_id: accountId,
          to_account_id: toAccountId,
          amount: numericAmount,
          to_amount: numericToAmount,
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
              description:
                e?.message ||
                "Failed to record transfer. Please check your connection and try again.",
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
              description:
                e?.message ||
                "Failed to add transaction. Please check your connection and try again.",
              duration: 6000,
            });
          },
        }
      );
    }
  };

  const handleSaveEdit = () => {
    if (!transaction) return;

    // Transfer legs must stay symmetric — the API only accepts date and
    // notes; everything else requires delete & recreate
    if (isTransferEdit) {
      updateTxn(
        { id: transaction.id, data: { date, notes: notes.trim() } },
        {
          onSuccess: () => playSuccessAnimation(),
          onError: (e: any) => toast.error(e.message),
        }
      );
      return;
    }

    const numericAmount = parseFloat(amount);
    if (!payee.trim() || isNaN(numericAmount) || numericAmount <= 0) {
      toast.error("Please enter a payee and a valid positive amount.");
      return;
    }

    const patch: any = {
      payee: payee.trim(),
      amount: numericAmount,
      date,
      notes: notes.trim(),
      envelope_id: tab === "expense" && envelopeId ? envelopeId : null,
      income_category: tab === "income" ? incomeCategory : null,
    };
    if (tab !== transaction.type) {
      patch.type = tab;
    }

    updateTxn(
      { id: transaction.id, data: patch },
      {
        onSuccess: () => playSuccessAnimation(),
        onError: (e: any) => toast.error(e.message),
      }
    );
  };

  const handleDelete = () => {
    if (!transaction) return;
    deleteTxn(transaction.id, {
      onSuccess: () => {
        toast.success("Transaction deleted");
        setConfirmDelete(false);
        onDeleted?.();
      },
      onError: (e: any) => toast.error(e.message),
    });
  };

  const pending = creatingTxn || creatingTransfer || updating;

  const visibleTabs: TabType[] = isEdit
    ? isTransferEdit
      ? ["transfer"]
      : ["expense", "income"]
    : ["expense", "income", "transfer"];

  return (
    <div className={cn("relative flex flex-col h-full min-h-0", className)}>
      {/* Premium Custom Envelope Selector Overlay */}
      {showEnvelopeSelect && (
        <div className="absolute inset-0 z-50 flex flex-col bg-card animate-slide-up">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-muted/20">
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
              className="w-full border border-border/80 focus:border-primary rounded-xl pl-9 pr-3.5 py-2.5 text-xs bg-background outline-none transition-all focus:ring-1 focus:ring-primary font-bold"
            />
            <Search className="absolute left-8 w-4 h-4 text-muted-foreground select-none pointer-events-none" />
          </div>

          {/* List scrollable area */}
          <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-4">
            {filteredEnvelopesByGroup.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground font-semibold">
                No matching envelopes found
              </div>
            ) : (
              filteredEnvelopesByGroup.map(({ groupId, groupName, items }) => (
                <div key={groupId} className="space-y-1.5">
                  <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground/80 uppercase border-b border-border/10 pb-0.5">
                    {groupName}
                  </h3>
                  <div className="grid grid-cols-1 gap-2">
                    {items.map((env) => {
                      const isSelected = env.id === envelopeId;
                      const pctSpent =
                        env.budgeted_inr > 0
                          ? (env.spent / env.budgeted_inr) * 100
                          : 0;
                      const remaining =
                        env.budgeted -
                        (env.budgeted_inr > 0
                          ? (env.spent / env.budgeted_inr) * env.budgeted
                          : 0);
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
                            <span className="text-xs font-bold text-foreground">
                              {env.name}
                            </span>
                            <span className="text-xs font-extrabold tabular-nums text-muted-foreground">
                              {remaining >= 0 ? "+" : ""}
                              {formatCurrency(
                                remaining,
                                env.budget_currency as any
                              )}
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
                            <div className="flex justify-between items-center text-xs text-muted-foreground leading-none font-bold">
                              <span>Spent: {pctSpent.toFixed(0)}%</span>
                              <span>
                                Budget:{" "}
                                {formatCurrency(
                                  env.budgeted,
                                  env.budget_currency as any
                                )}
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
      )}

      {/* Success Pulse overlay */}
      {successAnimation && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-card/90 backdrop-blur-sm animate-fade-in">
          <div className="w-16 h-16 rounded-full bg-positive/10 border-2 border-positive flex items-center justify-center animate-scale-up-pulse shadow-lg shadow-positive/20">
            <Check className="w-8 h-8 text-positive" />
          </div>
          <p className="text-sm font-semibold text-foreground mt-4 tracking-wide">
            {isEdit
              ? "Transaction Updated Successfully"
              : "Transaction Logged Successfully"}
          </p>
        </div>
      )}

      {/* Segmented Controller (Tabs) */}
      <div className="px-5 pt-3.5 flex-shrink-0">
        <div className="flex rounded-xl bg-muted/40 p-1 text-xs font-semibold backdrop-blur-md border border-border/10">
          {visibleTabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                if (isEdit && isTransferEdit) return;
                setTab(t);
                if (!isEdit) setEnvelopeId("");
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

      {/* Form area: Fully scrollable and takes up dynamic space */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-4">
        {/* Amount input block */}
        <div
          className={cn(
            "relative rounded-3xl border border-border/40 bg-card p-6 flex flex-col justify-center items-center shadow-sm transition-all duration-300",
            isTransferEdit
              ? "opacity-60"
              : "hover:border-primary/20 focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/5"
          )}
        >
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
              disabled={isTransferEdit}
              onKeyDown={handleKeyboardInput}
              onChange={(e) => setAmount(e.target.value)}
              style={{
                width: `${Math.max(1.5, (amount || "0.00").length) * 1.65}rem`,
              }}
              className="bg-transparent border-0 outline-none focus:ring-0 text-5xl font-semibold tracking-tight text-foreground p-0 text-left min-w-[2rem] font-sans leading-none disabled:cursor-not-allowed"
            />
          </div>
          {isTransferEdit && (
            <p className="text-[10px] text-muted-foreground mt-2 text-center font-semibold">
              Transfer amounts can't be edited — delete and recreate the
              transfer to change them.
            </p>
          )}
        </div>

        {/* Account Selector (CC Card Chips) */}
        <div className="space-y-2">
          <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
            {tab === "transfer" ? "From Account" : "Select Account"}
            {isEdit && (
              <span className="text-muted-foreground ml-1">(locked)</span>
            )}
          </label>
          <div className="flex gap-2.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
            {(isEdit
              ? accounts.filter((a) => a.id === accountId)
              : accounts
            ).map((a) => (
              <AccountChip
                key={a.id}
                account={a}
                isSelected={a.id === accountId}
                disabled={isEdit}
                onSelect={() => setAccountId(a.id)}
              />
            ))}
          </div>
        </div>

        {/* Destination Selector for Transfers */}
        {tab === "transfer" && !isEdit && (
          <div className="space-y-2 pt-1 border-t border-border/5">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              To Account
            </label>
            <div className="flex gap-2.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
              {accounts
                .filter((a) => a.id !== accountId)
                .map((a) => (
                  <AccountChip
                    key={a.id}
                    account={a}
                    isSelected={a.id === toAccountId}
                    onSelect={() => setToAccountId(a.id)}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Cross-currency destination amount */}
        {isCrossCurrency && !isEdit && (
          <div className="space-y-1.5 animate-fade-in">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              Amount Received ({toAccount?.currency})
              <span className="text-negative/85 font-bold ml-1">*Required</span>
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              placeholder="0.00"
              value={toAmount}
              onChange={(e) => setToAmount(e.target.value)}
              className="w-full border border-border/60 focus:border-primary/40 bg-background/40 focus:bg-background rounded-2xl px-3.5 py-3.5 text-xs outline-none transition-all focus:ring-2 focus:ring-primary/10 font-medium shadow-sm"
            />
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
                  tab === "income"
                    ? "e.g. Salary, Dividend"
                    : "e.g. Starbucks, Uber"
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
              <Sparkles className="w-2.5 h-2.5 text-primary/80 animate-pulse" />{" "}
              Recent Payees
            </span>
            <div className="flex gap-1.5 overflow-x-auto pb-1 max-w-full no-scrollbar">
              {topPayees.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handlePayeeChange(p)}
                  className="flex-shrink-0 px-3.5 py-1.5 rounded-full border border-border/60 hover:border-primary/30 bg-card hover:bg-primary/5 text-xs font-medium text-muted-foreground hover:text-primary transition-all duration-200 shadow-sm"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Envelope Selector for Expenses */}
        {tab === "expense" && envelopes.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              Budget Envelope Category
              {fromAccount && !fromAccount.off_budget ? (
                <span className="text-negative/85 font-bold ml-1">
                  *Required
                </span>
              ) : (
                <span className="text-muted-foreground ml-1">
                  (Optional for Off-Budget)
                </span>
              )}
            </label>
            <EnvelopeTrigger
              envelopes={envelopes}
              envelopeId={envelopeId}
              onOpen={() => setShowEnvelopeSelect(true)}
            />
          </div>
        )}

        {/* Custom Income Category Tag Selector */}
        {tab === "income" && (
          <div className="space-y-2">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              Income Category
            </label>
            <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
              {(
                [
                  { value: "income", label: "Salary / Income" },
                  { value: "cashback", label: "Cashback / Refund" },
                  { value: "starting_balance", label: "Starting Balance" },
                ] as const
              ).map((item) => {
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

        {/* Transfer envelope & boundary info */}
        {tab === "transfer" && !isEdit && (
          <div className="space-y-3">
            {isBoundaryCrossing && (
              <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5 text-xs leading-relaxed text-primary dark:text-primary-foreground/90 shadow-sm">
                <div className="flex gap-1.5 font-bold uppercase tracking-wider text-xs text-primary dark:text-primary/80 mb-1">
                  <ArrowRightLeft className="w-3.5 h-3.5" /> YNAB Envelope
                  Boundary Crossing
                </div>
                You are transferring funds from an <strong>On-Budget</strong>{" "}
                account to an <strong>Off-Budget</strong> account. Since the
                funds are leaving your liquid budget envelopes, you must select
                an envelope category to log the outflow.
              </div>
            )}

            {envelopes.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
                  Budget Envelope Category
                  {isBoundaryCrossing ? (
                    <span className="text-negative/85 font-bold ml-1">
                      *Required
                    </span>
                  ) : (
                    <span className="text-muted-foreground ml-1">
                      (Optional)
                    </span>
                  )}
                </label>
                <EnvelopeTrigger
                  envelopes={envelopes}
                  envelopeId={envelopeId}
                  onOpen={() => setShowEnvelopeSelect(true)}
                />
              </div>
            )}

            {!isBoundaryCrossing && (
              <div className="rounded-xl border border-border/10 bg-background p-3 text-xs text-muted-foreground text-center font-bold shadow-sm">
                🔄 This transfer is <strong>Budget-Neutral</strong>. An envelope
                category is optional as the funds remain within the same budget
                boundary.
              </div>
            )}
          </div>
        )}

        {/* Transfer edit: envelope is read-only */}
        {isTransferEdit && (
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-muted-foreground/80 tracking-wide block">
              Budget Envelope Category
              <span className="text-muted-foreground ml-1">(locked)</span>
            </label>
            <div className="w-full border border-border/40 bg-muted/20 rounded-2xl px-3.5 py-3.5 flex items-center justify-between text-left shadow-sm opacity-70">
              <span className="text-xs font-semibold text-foreground">
                {transaction?.envelope_name ?? "Uncategorised"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground font-semibold">
              Transfer envelopes can't be changed — delete and recreate the
              transfer instead. Only date and notes are editable.
            </p>
          </div>
        )}

        {/* Date and Notes */}
        {!isEdit && (
          <div className="flex justify-center border-t border-border/5 pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs font-bold text-muted-foreground hover:text-foreground flex items-center gap-1 py-1 px-2 rounded-md hover:bg-muted/40 transition-colors"
            >
              {showAdvanced
                ? "Hide Optional Details"
                : "Show Optional Details (Date, Notes)"}
            </button>
          </div>
        )}

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

      {/* Sticky Bottom Actions */}
      <div className="border-t border-border/10 bg-muted/20 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] flex-shrink-0 flex gap-2.5">
        {isEdit && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={pending || deleting}
            className="flex-1 py-3.5 bg-negative/10 hover:bg-negative/20 text-negative border border-negative/20 font-semibold tracking-wide text-sm rounded-2xl active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            Delete
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending || deleting || (!isTransferEdit && !amount)}
          className={cn(
            "py-3.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold tracking-wide text-sm rounded-2xl shadow-lg hover:shadow-primary/10 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2",
            isEdit ? "flex-[2]" : "w-full"
          )}
        >
          {pending ? (
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : isEdit ? (
            "Save Changes"
          ) : (
            "Log Transaction"
          )}
        </button>
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">
              Delete Transaction?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
              {transaction?.type === "transfer"
                ? "This transaction is a transfer. Deleting it will automatically delete the matching leg in the other involved account to preserve balance integrity."
                : "This transaction will be permanently removed. This will instantly adjust the account balance and any budgeted category."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end pt-3">
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-8"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs h-8"
              disabled={deleting}
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
