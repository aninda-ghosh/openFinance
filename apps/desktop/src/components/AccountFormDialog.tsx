import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app.store";
import {
  BALANCE_ADJUSTMENT_PAYEE,
  STARTING_BALANCE_PAYEE,
  isLiabilityType,
} from "@openfinance/shared/constants";

const CURRENCIES = ["USD", "INR", "SGD", "GBP", "EUR", "JPY", "NTD"];

const DEFAULT_TYPE = "checking";

const ALL_ACCOUNT_TYPES = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "cash", label: "Cash" },
  { value: "investment", label: "Investment" },
  { value: "policy", label: "Policy" },
  { value: "credit", label: "Credit Card" },
  { value: "loan", label: "Loan" },
  { value: "debt", label: "Other Debt / Liability" },
];

/**
 * What `off_budget` should be for a given account type when the caller has not
 * said. Liquid accounts fund envelopes so they belong on-budget; investments,
 * policies and liabilities are tracked for net worth only.
 *
 * This used to be a flat `false` on the dialog, which callers then contradicted
 * per-page: DebtPage and InvestmentsPage forced `true` through `initial`, while
 * the Savings/Checking "Add Account" button passed no `initial` at all — so
 * picking "Investment" or "Credit Card" from that button produced an on-budget
 * liability by accident.
 */
const DEFAULT_OFF_BUDGET_BY_TYPE: Record<string, boolean> = {
  checking: false,
  savings: false,
  cash: false,
  investment: true,
  policy: true,
  credit: true,
  loan: true,
  debt: true,
};

/** The documented `off_budget` default for a type. Unknown types are on-budget. */
export function defaultOffBudgetForType(type: string): boolean {
  return DEFAULT_OFF_BUDGET_BY_TYPE[type] ?? false;
}

export interface AccountFormValues {
  name: string;
  type: string;
  currency: string;
  /**
   * CREATE: the opening balance. EDIT: the balance to reconcile TO — the
   * server posts the difference against the derived balance as a
   * "Balance Adjustment" transaction rather than overwriting the stored column.
   *
   * Always the user-facing MAGNITUDE. Do not negate liability balances here;
   * the server owns that sign via `isLiabilityType()`.
   */
  balance: number;
  /** Omit to accept `defaultOffBudgetForType(type)`, which tracks the type picker. */
  off_budget?: boolean;
  institution?: string;
  is_active?: boolean;
}

export function AccountFormDialog({
  trigger,
  title,
  initial,
  mode,
  onSubmit,
  isPending,
}: {
  trigger: React.ReactNode;
  title: string;
  initial?: AccountFormValues;
  /**
   * Drives the balance field's meaning: an opening balance on create, a
   * reconcile-to target on edit. Defaults by inspecting `initial` — a
   * prefilled name means an existing account — but pass it explicitly.
   */
  mode?: "create" | "edit";
  onSubmit: (data: Required<AccountFormValues>) => void;
  isPending: boolean;
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const resolvedMode = mode ?? (initial?.name?.trim() ? "edit" : "create");
  const isEdit = resolvedMode === "edit";

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState(initial?.type ?? DEFAULT_TYPE);
  const [currency, setCurrency] = useState(
    initial?.currency ?? defaultCurrency
  );
  const [balance, setBalance] = useState(String(initial?.balance ?? 0));
  const [offBudget, setOffBudget] = useState(
    initial?.off_budget ?? defaultOffBudgetForType(initial?.type ?? DEFAULT_TYPE)
  );
  // Once the user touches the checkbox we stop deriving it from the type.
  const [offBudgetTouched, setOffBudgetTouched] = useState(
    initial?.off_budget !== undefined
  );
  const [institution, setInstitution] = useState(initial?.institution ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);

  const reset = () => {
    const nextType = initial?.type ?? DEFAULT_TYPE;
    setName(initial?.name ?? "");
    setType(nextType);
    setCurrency(initial?.currency ?? defaultCurrency);
    setBalance(String(initial?.balance ?? 0));
    setOffBudget(initial?.off_budget ?? defaultOffBudgetForType(nextType));
    setOffBudgetTouched(initial?.off_budget !== undefined);
    setInstitution(initial?.institution ?? "");
    setIsActive(initial?.is_active ?? true);
  };

  useEffect(() => {
    if (open) reset();
  }, [open, initial]);

  /**
   * Keep `off_budget` in step with the type picker until the user overrides it,
   * so a caller that supplied no `off_budget` gets the documented default for
   * whatever type is actually selected rather than the default for whatever
   * type the dialog happened to open on.
   */
  const handleTypeChange = (nextType: string) => {
    setType(nextType);
    if (!offBudgetTouched) setOffBudget(defaultOffBudgetForType(nextType));
  };

  const handleSave = () => {
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      type,
      currency,
      balance: parseFloat(balance) || 0,
      off_budget: offBudget,
      institution: institution.trim() || undefined,
      is_active: isActive,
    } as any);
    setOpen(false);
    reset();
  };

  const sel =
    "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background focus:ring-1 focus:ring-primary";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <Label className="text-xs">Account Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Chase checking"
              className="mt-1 text-sm h-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Type</Label>
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value)}
                className={sel}
              >
                {ALL_ACCOUNT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Currency</Label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={sel}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs">
              {isEdit ? "Reconcile To Balance" : "Opening Balance"}
            </Label>
            <Input
              type="number"
              step="any"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="mt-1 text-sm h-9"
            />
            <p className="text-xs text-muted-foreground leading-normal mt-1">
              {isEdit
                ? `The balance this account should read after saving. Any difference from its current balance is recorded as a dated “${BALANCE_ADJUSTMENT_PAYEE}” transaction — the stored balance is never overwritten and your existing transactions stay intact.`
                : `What this account holds before any transaction you log against it. Recorded as a “${STARTING_BALANCE_PAYEE}” entry.`}
              {isLiabilityType(type) &&
                " Enter what you owe as a positive number — it is stored as a liability for you."}
            </p>
          </div>
          <div>
            <Label className="text-xs">Institution / Bank Name</Label>
            <Input
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              placeholder="e.g. Chase, HDFC, Cash"
              className="mt-1 text-sm h-9"
            />
          </div>
          <div className="space-y-2 py-1">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={offBudget}
                onChange={(e) => {
                  setOffBudget(e.target.checked);
                  setOffBudgetTouched(true);
                }}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 accent-indigo-600"
              />
              <div>
                <p className="text-xs font-semibold">Off budget</p>
                <p className="text-xs text-muted-foreground leading-normal">
                  Assets tracked for Net Worth but ignored in envelope spending
                </p>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 accent-indigo-600"
              />
              <div>
                <p className="text-xs font-semibold">Active Account</p>
                <p className="text-xs text-muted-foreground leading-normal">
                  Archived accounts are hidden but their historical logs remain in Net Worth
                </p>
              </div>
            </label>
          </div>
          <Button
            className="w-full text-xs h-9 font-semibold"
            onClick={handleSave}
            disabled={isPending || !name.trim()}
          >
            Save Account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
