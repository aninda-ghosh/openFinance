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

const CURRENCIES = ["USD", "INR", "SGD", "GBP", "EUR", "JPY", "NTD"];

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

export interface AccountFormValues {
  name: string;
  type: string;
  currency: string;
  balance: number;
  off_budget: boolean;
  institution?: string;
  is_active?: boolean;
}

export function AccountFormDialog({
  trigger,
  title,
  initial,
  onSubmit,
  isPending,
}: {
  trigger: React.ReactNode;
  title: string;
  initial?: AccountFormValues;
  onSubmit: (data: Required<AccountFormValues>) => void;
  isPending: boolean;
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState(initial?.type ?? "checking");
  const [currency, setCurrency] = useState(
    initial?.currency ?? defaultCurrency
  );
  const [balance, setBalance] = useState(String(initial?.balance ?? 0));
  const [offBudget, setOffBudget] = useState(initial?.off_budget ?? false);
  const [institution, setInstitution] = useState(initial?.institution ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);

  const reset = () => {
    setName(initial?.name ?? "");
    setType(initial?.type ?? "checking");
    setCurrency(initial?.currency ?? defaultCurrency);
    setBalance(String(initial?.balance ?? 0));
    setOffBudget(initial?.off_budget ?? false);
    setInstitution(initial?.institution ?? "");
    setIsActive(initial?.is_active ?? true);
  };

  useEffect(() => {
    if (open) reset();
  }, [open, initial]);

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
                onChange={(e) => setType(e.target.value)}
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
            <Label className="text-xs">Current Balance</Label>
            <Input
              type="number"
              step="any"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="mt-1 text-sm h-9"
            />
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
                onChange={(e) => setOffBudget(e.target.checked)}
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
