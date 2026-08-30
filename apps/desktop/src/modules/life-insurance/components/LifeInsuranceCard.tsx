import type { LifeInsuranceResponse } from "@openfinance/shared/api-contracts";
import { SUPPORTED_CURRENCIES } from "@openfinance/shared/schemas";
import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import {
  AlertTriangle,
  FileText,
  HeartPulse,
  Pencil,
  PlusCircle,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { InvestmentDocuments } from "@/modules/investments/components/InvestmentDocuments";
import { useAppStore } from "@/stores/app.store";
import {
  useCreateLifeInsurance,
  useDeleteLifeInsurance,
  useLifeInsurance,
  useUpdateLifeInsurance,
} from "../hooks/useLifeInsurance";

const FREQUENCIES = [
  { value: "", label: "—" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annual", label: "Annual" },
];

const FREQUENCY_LABELS: Record<string, string> = {
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "yearly",
};

/** Renewal window that earns an amber "due soon" badge. */
const DUE_SOON_DAYS = 30;

function formatDate(dateStr: string) {
  if (!dateStr) return "—";
  const parts = dateStr.slice(0, 10).split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renewalLabel(days: number) {
  if (days < 0) {
    const n = Math.abs(days);
    return n === 1 ? "1 day overdue" : `${n} days overdue`;
  }
  if (days === 0) return "Due today";
  if (days === 1) return "in 1 day";
  if (days < 45) return `in ${days} days`;
  const months = Math.round(days / 30);
  return months === 1 ? "in 1 month" : `in ${months} months`;
}

// ─── Form dialog ──────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  insured_person: "",
  provider: "",
  policy_number: "",
  currency: "INR",
  coverage_amount: "",
  renewal_date: "",
  premium_amount: "",
  premium_frequency: "annual",
};

type FormState = typeof EMPTY_FORM;

function toFormState(p: LifeInsuranceResponse): FormState {
  return {
    name: p.name,
    insured_person: p.insured_person,
    provider: p.provider,
    policy_number: p.policy_number ?? "",
    currency: p.currency,
    coverage_amount: String(p.coverage_amount),
    renewal_date: p.renewal_date,
    premium_amount: p.premium_amount == null ? "" : String(p.premium_amount),
    premium_frequency: p.premium_frequency ?? "",
  };
}

function LifeInsuranceFormDialog({
  trigger,
  title,
  initial,
  onSubmit,
  isPending,
}: {
  trigger: React.ReactNode;
  title: string;
  initial?: FormState;
  onSubmit: (data: any) => void;
  isPending: boolean;
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const emptyForm = { ...EMPTY_FORM, currency: defaultCurrency };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initial ?? emptyForm);

  const set =
    (k: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const coverage = parseFloat(form.coverage_amount);
  const premium = form.premium_amount ? parseFloat(form.premium_amount) : null;
  const canSubmit =
    form.name.trim() !== "" &&
    form.insured_person.trim() !== "" &&
    form.provider.trim() !== "" &&
    form.renewal_date !== "" &&
    Number.isFinite(coverage) &&
    coverage > 0 &&
    (premium === null || (Number.isFinite(premium) && premium > 0));

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      name: form.name.trim(),
      insured_person: form.insured_person.trim(),
      provider: form.provider.trim(),
      policy_number: form.policy_number.trim() || undefined,
      currency: form.currency,
      coverage_amount: coverage,
      renewal_date: form.renewal_date,
      // Premium is optional on both sides: an empty box clears it rather than
      // silently keeping the previous value on an edit.
      premium_amount: premium,
      premium_frequency: premium === null ? null : form.premium_frequency || null,
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
            <Label>Policy Name</Label>
            <Input
              value={form.name}
              onChange={set("name")}
              placeholder="e.g. Term Life 1 Cr"
              className="mt-1"
            />
          </div>

          <div>
            <Label>Person Covered</Label>
            <Input
              value={form.insured_person}
              onChange={set("insured_person")}
              placeholder="e.g. Aninda Ghosh"
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Insurer</Label>
              <Input
                value={form.provider}
                onChange={set("provider")}
                placeholder="e.g. HDFC Life"
                className="mt-1"
              />
            </div>
            <div>
              <Label>
                Policy Number{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                value={form.policy_number}
                onChange={set("policy_number")}
                placeholder="e.g. 1234567890"
                className="mt-1"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Coverage Amount</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={form.coverage_amount}
                onChange={set("coverage_amount")}
                placeholder="10000000"
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
          </div>

          <div>
            <Label>Renewal Date</Label>
            <Input
              type="date"
              value={form.renewal_date}
              onChange={set("renewal_date")}
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>
                Premium{" "}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <Input
                type="number"
                inputMode="decimal"
                value={form.premium_amount}
                onChange={set("premium_amount")}
                placeholder="12000"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Frequency</Label>
              <select
                value={form.premium_frequency}
                onChange={set("premium_frequency")}
                className={sel}
                disabled={!form.premium_amount}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Life cover is tracked for reference only — it is not counted as an
            asset in your net worth or portfolio breakdown.
          </p>

          <Button
            className="w-full"
            onClick={submit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? "Saving…" : "Save Policy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Documents sheet ──────────────────────────────────────────────────────────

function LifeInsuranceDocumentsSheet({
  policy,
  onClose,
}: {
  policy: LifeInsuranceResponse | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!policy} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{policy?.name ?? "Policy"} — Documents</SheetTitle>
        </SheetHeader>
        <div className="p-4">
          {policy && (
            <>
              <p className="text-xs text-muted-foreground mb-4">
                {policy.provider}
                {policy.policy_number ? ` · ${policy.policy_number}` : ""} ·
                covers {policy.insured_person}
              </p>
              <InvestmentDocuments
                investmentId={policy.id}
                investment={policy}
                parentKind="life_insurance"
                parentLabel="policy"
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function LifeInsuranceCard() {
  const { data, isLoading, error } = useLifeInsurance();
  const { mutate: createPolicy, isPending: creating } =
    useCreateLifeInsurance();
  const { mutate: updatePolicy, isPending: updating } =
    useUpdateLifeInsurance();
  const { mutate: deletePolicy } = useDeleteLifeInsurance();
  const [docsFor, setDocsFor] = useState<LifeInsuranceResponse | null>(null);

  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { data: rates = {} } = useExchangeRates();
  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const policies = data?.policies ?? [];
  const totalCoverInr = policies.reduce(
    (sum, p) => sum + p.coverage_amount_inr,
    0
  );
  const dueSoon = policies.filter((p) => p.days_to_renewal <= DUE_SOON_DAYS);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <div className="flex items-center gap-2">
          <HeartPulse className="w-4 h-4 text-primary" />
          <CardTitle className="text-sm">Life Insurance</CardTitle>
          {policies.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {fmt(totalCoverInr)} total cover
            </span>
          )}
        </div>
        <LifeInsuranceFormDialog
          title="Add Life Insurance"
          isPending={creating}
          trigger={
            <Button size="sm" variant="outline" className="h-7 text-xs">
              <PlusCircle className="w-3.5 h-3.5 mr-1" />
              Add Policy
            </Button>
          }
          onSubmit={(payload) =>
            createPolicy(payload, {
              onSuccess: () => toast.success("Life insurance policy added"),
              onError: (e) => toast.error(e.message),
            })
          }
        />
      </CardHeader>

      {dueSoon.length > 0 && (
        <div className="px-4 pb-3">
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {dueSoon.length === 1
                ? `${dueSoon[0].name} renews ${renewalLabel(dueSoon[0].days_to_renewal)}.`
                : `${dueSoon.length} policies renew within the next ${DUE_SOON_DAYS} days.`}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <CardContent className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      ) : error ? (
        <CardContent>
          <p className="text-sm text-destructive py-2">
            Could not load life insurance policies.
          </p>
        </CardContent>
      ) : policies.length === 0 ? (
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No life insurance tracked yet. Add a policy to keep the covered
            person, cover amount, renewal date and policy document in one place.
          </p>
        </CardContent>
      ) : (
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                  Policy
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                  Covered Person
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                  Coverage
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                  Premium
                </th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">
                  Renewal
                </th>
                <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                  Document
                </th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const overdue = p.days_to_renewal < 0;
                const soon = !overdue && p.days_to_renewal <= DUE_SOON_DAYS;
                return (
                  <tr
                    key={p.id}
                    className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.provider}
                        {p.policy_number ? ` · ${p.policy_number}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{p.insured_person}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <div className="font-semibold">
                        {formatCurrency(p.coverage_amount, p.currency)}
                      </div>
                      {p.currency !== defaultCurrency && (
                        <div className="text-xs text-muted-foreground">
                          {fmt(p.coverage_amount_inr)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {p.premium_amount == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          <div>
                            {formatCurrency(p.premium_amount, p.currency)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {p.premium_frequency
                              ? FREQUENCY_LABELS[p.premium_frequency]
                              : ""}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div>{formatDate(p.renewal_date)}</div>
                      <Badge
                        variant={
                          overdue
                            ? "destructive"
                            : soon
                              ? "secondary"
                              : "outline"
                        }
                        className="mt-0.5"
                      >
                        {renewalLabel(p.days_to_renewal)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => setDocsFor(p)}
                      >
                        <FileText className="w-3.5 h-3.5" />
                        {p.document_count > 0
                          ? `${p.document_count} file${p.document_count > 1 ? "s" : ""}`
                          : "Add"}
                      </Button>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <LifeInsuranceFormDialog
                          title="Edit Life Insurance"
                          initial={toFormState(p)}
                          isPending={updating}
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              title="Edit policy"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          }
                          onSubmit={(payload) =>
                            updatePolicy(
                              { id: p.id, data: payload },
                              {
                                onSuccess: () => toast.success("Policy updated"),
                                onError: (e) => toast.error(e.message),
                              }
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          title="Delete policy"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete the life insurance policy "${p.name}"? Any documents attached to it will be deleted too.`
                              )
                            ) {
                              deletePolicy(p.id, {
                                onSuccess: () => toast.success("Policy deleted"),
                                onError: (e) => toast.error(e.message),
                              });
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
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

      <LifeInsuranceDocumentsSheet
        policy={docsFor}
        onClose={() => setDocsFor(null)}
      />
    </Card>
  );
}
