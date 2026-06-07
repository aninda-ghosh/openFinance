import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import { SUPPORTED_CURRENCIES } from "@openfinance/shared/schemas";
import {
  AlertTriangle,
  CalendarRange,
  Pencil,
  PlusCircle,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import {
  useCreatePolicy,
  useDeletePolicy,
  useGeneratePayouts,
  usePolicies,
  usePolicyAlerts,
  useUpdatePolicy,
} from "../hooks/usePolicies";

const EMPTY_POLICY_FORM = {
  name: "",
  provider: "",
  policy_number: "",
  start_date: new Date().toISOString().slice(0, 10),
  premium_amount: "",
  premium_frequency: "annual",
  premium_term_years: "",
  policy_term_years: "",
  maturity_date: "",
  sum_assured: "",
  maturity_value: "",
  notes: "",
  currency: "INR",
};

function AddPolicyDialog() {
  const [open, setOpen] = useState(false);
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const [form, setForm] = useState(() => ({
    ...EMPTY_POLICY_FORM,
    currency: defaultCurrency || "INR",
  }));
  const [err, setErr] = useState("");
  const { mutate, isPending } = useCreatePolicy();
  const set = (k: string) => (e: any) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    setErr("");
    const premium_amount = parseFloat(form.premium_amount);
    const premium_term_years = parseInt(form.premium_term_years, 10);
    const policy_term_years = parseInt(form.policy_term_years, 10);
    const sum_assured = parseFloat(form.sum_assured);
    const maturity_value = parseFloat(form.maturity_value);

    if (!form.name.trim()) return setErr("Policy name is required");
    if (!form.provider.trim()) return setErr("Provider is required");
    if (!form.start_date) return setErr("Start date is required");
    if (!form.maturity_date) return setErr("Maturity date is required");
    if (Number.isNaN(premium_amount) || premium_amount <= 0)
      return setErr("Enter a valid premium amount");
    if (Number.isNaN(premium_term_years) || premium_term_years <= 0)
      return setErr("Enter a valid premium term");
    if (Number.isNaN(policy_term_years) || policy_term_years <= 0)
      return setErr("Enter a valid policy term");
    if (Number.isNaN(sum_assured) || sum_assured <= 0)
      return setErr("Enter a valid sum assured");
    if (Number.isNaN(maturity_value) || maturity_value <= 0)
      return setErr("Enter a valid maturity value");

    mutate(
      {
        name: form.name.trim(),
        provider: form.provider.trim(),
        policy_number: form.policy_number.trim() || undefined,
        start_date: form.start_date,
        premium_amount,
        premium_frequency: form.premium_frequency as any,
        premium_term_years,
        policy_term_years,
        maturity_date: form.maturity_date,
        sum_assured,
        maturity_value,
        notes: form.notes.trim() || undefined,
        currency: form.currency as any,
      },
      {
        onSuccess: () => {
          toast.success("Policy added");
          setOpen(false);
          setForm({
            ...EMPTY_POLICY_FORM,
            currency: defaultCurrency || "INR",
          });
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setForm({
            ...EMPTY_POLICY_FORM,
            currency: defaultCurrency || "INR",
          });
          setErr("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusCircle className="w-4 h-4 mr-1" />
          Add Policy
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Policy</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="col-span-2">
            <Label>Policy Name</Label>
            <Input
              value={form.name}
              onChange={set("name")}
              placeholder="e.g. Term Life 20yr"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Provider</Label>
            <Input
              value={form.provider}
              onChange={set("provider")}
              placeholder="e.g. Prudential, AXA"
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Policy Number{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={form.policy_number}
              onChange={set("policy_number")}
              placeholder="123456789"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Start Date</Label>
            <Input
              type="date"
              value={form.start_date}
              onChange={set("start_date")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Maturity Date</Label>
            <Input
              type="date"
              value={form.maturity_date}
              onChange={set("maturity_date")}
              className="mt-1"
            />
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
          <div>
            <Label>Frequency</Label>
            <select
              value={form.premium_frequency}
              onChange={set("premium_frequency")}
              className={sel}
            >
              {["monthly", "quarterly", "annual"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>
              Premium Amount{" "}
              <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.premium_amount}
              onChange={set("premium_amount")}
              placeholder="50000"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Premium Term (years)</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={form.premium_term_years}
              onChange={set("premium_term_years")}
              placeholder="5"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Policy Term (years)</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={form.policy_term_years}
              onChange={set("policy_term_years")}
              placeholder="20"
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Sum Assured{" "}
              <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.sum_assured}
              onChange={set("sum_assured")}
              placeholder="1000000"
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Maturity Value{" "}
              <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.maturity_value}
              onChange={set("maturity_value")}
              placeholder="1500000"
              className="mt-1"
            />
          </div>
          <div className="col-span-2">
            <Label>
              Notes{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={form.notes}
              onChange={set("notes")}
              placeholder="e.g. whole life, auto-pay"
              className="mt-1"
            />
          </div>
          {err && <p className="col-span-2 text-sm text-destructive">{err}</p>}
          <Button className="col-span-2" onClick={submit} disabled={isPending}>
            Add Policy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneratePayoutsDialog({ policy }: { policy: any }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    start_date: "",
    end_date: "",
    amount: "",
    frequency: "annual",
    label: "Annual Payout",
  });
  const [preview, setPreview] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const { mutate, isPending } = useGeneratePayouts();
  const set = (k: string) => (e: any) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setPreview(null);
  };
  const sel = "w-full border rounded-md px-3 py-2 text-sm bg-background";

  const computePreview = () => {
    const amt = parseFloat(form.amount);
    if (!form.start_date || !form.end_date || Number.isNaN(amt) || amt <= 0) {
      setErr("Fill in all fields first");
      return;
    }
    if (form.end_date <= form.start_date) {
      setErr("End date must be after start date");
      return;
    }
    setErr("");
    const step =
      form.frequency === "monthly"
        ? 1
        : form.frequency === "quarterly"
          ? 3
          : 12;
    let count = 0;
    const cursor = new Date(form.start_date);
    const end = new Date(form.end_date);
    while (cursor <= end) {
      count++;
      cursor.setMonth(cursor.getMonth() + step);
    }
    setPreview(count);
  };

  const submit = () => {
    setErr("");
    const amount = parseFloat(form.amount);
    if (!form.start_date) return setErr("Start date is required");
    if (!form.end_date) return setErr("End date is required");
    if (form.end_date <= form.start_date)
      return setErr("End date must be after start date");
    if (Number.isNaN(amount) || amount <= 0)
      return setErr("Enter a valid amount");
    if (!form.label.trim()) return setErr("Label is required");

    mutate(
      { id: policy.id, data: { ...form, amount } },
      {
        onSuccess: (res) => {
          toast.success(
            `Created ${res.created} payout schedule entries for ${policy.name}`
          );
          setOpen(false);
          setPreview(null);
          setForm({
            start_date: "",
            end_date: "",
            amount: "",
            frequency: "annual",
            label: "Annual Payout",
          });
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
        if (!o) {
          setPreview(null);
          setErr("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Generate recurring payouts"
        >
          <CalendarRange className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Generate Payouts</DialogTitle>
          <p className="text-sm text-muted-foreground">{policy.name}</p>
        </DialogHeader>
        <div className="flex flex-col gap-4 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>First Payout Date</Label>
              <Input
                type="date"
                value={form.start_date}
                onChange={set("start_date")}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Last Payout Date</Label>
              <Input
                type="date"
                value={form.end_date}
                onChange={set("end_date")}
                className="mt-1.5"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Amount per Payout{" "}
                <span className="text-muted-foreground text-xs font-normal">
                  ({policy.currency})
                </span>
              </Label>
              <Input
                type="number"
                min="0"
                value={form.amount}
                onChange={set("amount")}
                placeholder="e.g. 200000"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Frequency</Label>
              <select
                value={form.frequency}
                onChange={set("frequency")}
                className={`${sel} mt-1.5`}
              >
                {["monthly", "quarterly", "annual"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label>Label</Label>
            <Input
              value={form.label}
              onChange={set("label")}
              placeholder="e.g. Annual Payout"
              className="mt-1.5"
            />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          {preview !== null && (
            <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              This will create{" "}
              <strong className="text-foreground">
                {preview} payout records
              </strong>{" "}
              ({form.frequency}) from {form.start_date} to {form.end_date}.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={computePreview} type="button">
              Preview
            </Button>
            <Button onClick={submit} disabled={isPending}>
              Generate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeletePolicyButton({ policy }: { policy: any }) {
  const { mutate, isPending } = useDeletePolicy();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Policy</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete <strong>{policy.name}</strong> and all
            its payout records. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={isPending}
            onClick={() =>
              mutate(policy.id, { onError: (e) => toast.error(e.message) })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EditPolicyDialog({ policy }: { policy: any }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    provider: "",
    policy_number: "",
    start_date: "",
    premium_amount: "",
    premium_frequency: "annual",
    premium_term_years: "",
    policy_term_years: "",
    maturity_date: "",
    sum_assured: "",
    maturity_value: "",
    surrender_value: "",
    notes: "",
    currency: "INR",
  });
  const [err, setErr] = useState("");
  const { mutate, isPending } = useUpdatePolicy();
  const set = (k: string) => (e: any) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const openDialog = () => {
    setForm({
      name: policy.name,
      provider: policy.provider ?? "",
      policy_number: policy.policy_number ?? "",
      start_date: policy.start_date ?? "",
      premium_amount: String(policy.premium_amount),
      premium_frequency: policy.premium_frequency ?? "annual",
      premium_term_years: String(policy.premium_term_years ?? ""),
      policy_term_years: String(policy.policy_term_years ?? ""),
      maturity_date: policy.maturity_date ?? "",
      sum_assured: String(policy.sum_assured ?? ""),
      maturity_value: String(policy.maturity_value ?? ""),
      surrender_value:
        policy.surrender_value != null ? String(policy.surrender_value) : "",
      notes: policy.notes ?? "",
      currency: policy.currency ?? "INR",
    });
    setErr("");
    setOpen(true);
  };

  const submit = () => {
    setErr("");
    const premium_amount = parseFloat(form.premium_amount);
    const premium_term_years = parseInt(form.premium_term_years, 10);
    const policy_term_years = parseInt(form.policy_term_years, 10);
    const sum_assured = parseFloat(form.sum_assured);
    const maturity_value = parseFloat(form.maturity_value);
    const surrender_value =
      form.surrender_value !== ""
        ? parseFloat(form.surrender_value)
        : undefined;

    if (!form.name.trim()) return setErr("Policy name is required");
    if (!form.provider.trim()) return setErr("Provider is required");
    if (!form.start_date) return setErr("Start date is required");
    if (!form.maturity_date) return setErr("Maturity date is required");
    if (Number.isNaN(premium_amount) || premium_amount <= 0)
      return setErr("Enter a valid premium amount");
    if (Number.isNaN(premium_term_years) || premium_term_years <= 0)
      return setErr("Enter a valid premium term");
    if (Number.isNaN(policy_term_years) || policy_term_years <= 0)
      return setErr("Enter a valid policy term");
    if (Number.isNaN(sum_assured) || sum_assured <= 0)
      return setErr("Enter a valid sum assured");
    if (Number.isNaN(maturity_value) || maturity_value <= 0)
      return setErr("Enter a valid maturity value");
    if (
      surrender_value !== undefined &&
      (Number.isNaN(surrender_value) || surrender_value < 0)
    )
      return setErr("Enter a valid surrender value");

    mutate(
      {
        id: policy.id,
        data: {
          name: form.name.trim(),
          provider: form.provider.trim(),
          policy_number: form.policy_number.trim() || undefined,
          start_date: form.start_date,
          premium_amount,
          premium_frequency: form.premium_frequency as any,
          premium_term_years,
          policy_term_years,
          maturity_date: form.maturity_date,
          sum_assured,
          maturity_value,
          currency: form.currency as any,
          ...(surrender_value !== undefined ? { surrender_value } : { surrender_value: null }),
          notes: form.notes.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success("Policy updated");
          setOpen(false);
        },
        onError: (e) => toast.error(e.message),
      }
    );
  };

  const sel = "w-full border rounded-md px-3 py-2 text-sm mt-1 bg-background";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setOpen(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(e) => {
            e.stopPropagation();
            openDialog();
          }}
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Policy</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="col-span-2">
            <Label>Policy Name</Label>
            <Input
              value={form.name}
              onChange={set("name")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Provider</Label>
            <Input
              value={form.provider}
              onChange={set("provider")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Policy Number{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={form.policy_number}
              onChange={set("policy_number")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Start Date</Label>
            <Input
              type="date"
              value={form.start_date}
              onChange={set("start_date")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Maturity Date</Label>
            <Input
              type="date"
              value={form.maturity_date}
              onChange={set("maturity_date")}
              className="mt-1"
            />
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
          <div>
            <Label>Frequency</Label>
            <select
              value={form.premium_frequency}
              onChange={set("premium_frequency")}
              className={sel}
            >
              {["monthly", "quarterly", "annual"].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>
              Premium Amount <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.premium_amount}
              onChange={set("premium_amount")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Premium Term (years)</Label>
            <Input
              type="number"
              min="1"
              value={form.premium_term_years}
              onChange={set("premium_term_years")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>Policy Term (years)</Label>
            <Input
              type="number"
              min="1"
              value={form.policy_term_years}
              onChange={set("policy_term_years")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Sum Assured <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.sum_assured}
              onChange={set("sum_assured")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Maturity Value <span className="text-muted-foreground text-xs">({form.currency})</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.maturity_value}
              onChange={set("maturity_value")}
              className="mt-1"
            />
          </div>
          <div>
            <Label>
              Surrender Value <span className="text-muted-foreground text-xs">({form.currency})</span>{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={form.surrender_value}
              onChange={set("surrender_value")}
              placeholder="optional"
              className="mt-1"
            />
          </div>
          <div className="col-span-2">
            <Label>
              Notes <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Input
              value={form.notes}
              onChange={set("notes")}
              className="mt-1"
            />
          </div>
          {err && <p className="col-span-2 text-sm text-destructive">{err}</p>}
          <Button onClick={submit} disabled={isPending} className="col-span-2 mt-2">
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PoliciesPage({ embed }: { embed?: boolean }) {
  const { data, isLoading, error } = usePolicies();
  const { data: alertsData } = usePolicyAlerts(30);
  const [activeDonutIndex, setActiveDonutIndex] = useState<number | null>(null);
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { data: rates = {} } = useExchangeRates();
  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const formatCell = (native: number, inr: number, currency: string, className?: string) => {
    const isDefault = currency === defaultCurrency;
    return (
      <div className={`text-right ${className ?? ""}`}>
        <div className="font-medium tabular-nums text-right">
          {formatCurrency(native, currency as any)}
        </div>
        {!isDefault && (
          <div className="text-xs text-muted-foreground tabular-nums mt-0.5 font-normal text-right">
            ≈ {fmt(inr)}
          </div>
        )}
      </div>
    );
  };

  const alerts = alertsData?.alerts ?? [];

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
    if (!data?.policies) return [];
    return data.policies
      .map((p) => ({
        name: p.name,
        value: p.total_invested_inr ?? 0,
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [data?.policies]);

  const totalInvestedInr = useMemo(() => {
    if (!data?.policies) return 0;
    return data.policies.reduce((sum, p) => sum + (p.total_invested_inr ?? 0), 0);
  }, [data?.policies]);

  return (
    <div className={embed ? "space-y-6 w-full" : "p-6 space-y-6"}>
      {embed ? (
        <div className="flex justify-end items-center">
          <AddPolicyDialog />
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Policies</h1>
          <AddPolicyDialog />
        </div>
      )}

      {alerts.length > 0 && (
        <Alert className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
          <AlertTriangle className="h-4 w-4 text-yellow-600" />
          <AlertDescription className="text-yellow-800 dark:text-yellow-200">
            {alerts.length} premium{alerts.length > 1 ? "s" : ""} due within 30
            days —{" "}
            {alerts
              .map((a: any) => `${a.policy_name} (${a.days_until_due}d)`)
              .join(", ")}
          </AlertDescription>
        </Alert>
      )}

      {/* Policies breakdown */}
      {!isLoading && data?.policies && data.policies.length > 0 && donutData.length > 0 && (
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm animate-in fade-in-50 duration-300">
          <CardHeader className="pt-5 pb-1 px-6">
            <CardTitle className="text-sm font-semibold tracking-tight">Policy Premium Allocation</CardTitle>
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
                  {activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].name : "Total Invested"}
                </span>
                <span className="text-sm font-extrabold tracking-tight mt-0.5 tabular-nums text-foreground truncate max-w-[110px]">
                  {fmt(activeDonutIndex !== null && donutData[activeDonutIndex] ? donutData[activeDonutIndex].value : totalInvestedInr)}
                </span>
              </div>
            </div>

            {/* Premium Legend Grid */}
            <div className="flex flex-col gap-1.5 w-full flex-1">
              {donutData.map((d, i) => {
                const pct = totalInvestedInr > 0 ? (d.value / totalInvestedInr) * 100 : 0;
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

      {error && (
        <Alert variant="destructive">
          <AlertDescription>Failed to load policies.</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : !data || data.policies.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          No policies yet. Add your first insurance policy.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>Policy</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Premium</TableHead>
                <TableHead className="text-right">Invested</TableHead>
                <TableHead className="text-right">Sum Assured</TableHead>
                <TableHead className="text-right">Maturity Value</TableHead>
                <TableHead>Maturity</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.provider}</TableCell>
                  <TableCell className="text-right">
                    <div className="font-medium tabular-nums text-right">
                      {formatCurrency(p.premium_amount, p.currency as any)}
                      <span className="text-xs text-muted-foreground font-normal">
                        /{p.premium_frequency.slice(0, 2)}
                      </span>
                    </div>
                    {p.currency !== defaultCurrency && (
                      <div className="text-xs text-muted-foreground tabular-nums mt-0.5 font-normal text-right">
                        ≈ {fmt(p.premium_amount_inr)}
                        <span className="text-[10px] opacity-80 font-normal">
                          /{p.premium_frequency.slice(0, 2)}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCell(p.total_invested, p.total_invested_inr, p.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCell(p.sum_assured, p.sum_assured_inr, p.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCell(p.maturity_value ?? 0, p.maturity_value_inr ?? 0, p.currency, "text-positive font-medium")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{p.maturity_date}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <GeneratePayoutsDialog policy={p} />
                      <EditPolicyDialog policy={p} />
                      <DeletePolicyButton policy={p} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
