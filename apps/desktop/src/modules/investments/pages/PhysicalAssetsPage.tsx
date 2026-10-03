import type { InvestmentResponse } from "@openfinance/shared/api-contracts";
import { isPhysicalAsset } from "@openfinance/shared/constants";
import { SUPPORTED_CURRENCIES } from "@openfinance/shared/schemas";
import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import { Car, Pencil, PlusCircle, RefreshCcw, Trash2, TrendingDown } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import {
  useCreateInvestment,
  useDeleteInvestment,
  useInvestments,
  useUpdateInvestment,
} from "../hooks/useInvestments";

/**
 * Things you own rather than invest in — today, vehicles. Stored as
 * `investments` rows with asset_type "vehicle" so they reuse value history,
 * but the server keeps them out of every portfolio figure and reports them in
 * net worth under "Physical assets".
 *
 * The value shown is derived: the last quote you entered, depreciated at the
 * yearly rate (if any) from the quote's date. Entering a new quote re-anchors
 * the curve, so a real valuation always wins.
 */

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type FormState = {
  name: string;
  currency: string;
  purchase_value: string;
  purchase_date: string;
  current_value: string;
  depreciation_rate: string;
  notes: string;
};

function VehicleFormDialog({
  vehicle,
  trigger,
}: {
  vehicle?: InvestmentResponse;
  trigger: React.ReactNode;
}) {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { mutate: create, isPending: creating } = useCreateInvestment();
  const { mutate: update, isPending: updating } = useUpdateInvestment();
  const [open, setOpen] = useState(false);

  const initial = (): FormState => ({
    name: vehicle?.name ?? "",
    currency: vehicle?.currency ?? defaultCurrency,
    purchase_value: vehicle ? String(vehicle.purchase_value) : "",
    purchase_date: vehicle?.purchase_date ?? "",
    // Editing shows today's derived value; leaving it untouched keeps the curve.
    current_value: vehicle ? String(vehicle.current_value) : "",
    depreciation_rate:
      vehicle?.depreciation_rate != null ? String(vehicle.depreciation_rate) : "15",
    notes: vehicle?.notes ?? "",
  });
  const [form, setForm] = useState<FormState>(initial);
  const set =
    (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = () => {
    const purchase = Number.parseFloat(form.purchase_value);
    const current = Number.parseFloat(form.current_value);
    const rateText = form.depreciation_rate.trim();
    const rate = rateText === "" ? null : Number.parseFloat(rateText);

    if (!form.name.trim()) return toast.error("Give the vehicle a name.");
    if (!(purchase > 0)) return toast.error("Enter what you paid for it.");
    if (!form.purchase_date) return toast.error("Enter the purchase date.");
    if (!(current >= 0)) return toast.error("Enter what it's worth today.");
    if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 100))
      return toast.error("Depreciation must be between 0 and 100% per year.");

    const payload = {
      name: form.name.trim(),
      asset_type: "vehicle" as const,
      currency: form.currency as InvestmentResponse["currency"],
      purchase_value: purchase,
      purchase_date: form.purchase_date,
      current_value: current,
      depreciation_rate: rate && rate > 0 ? rate : null,
      notes: form.notes.trim() || undefined,
    };
    const done = {
      onSuccess: () => {
        toast.success(vehicle ? "Vehicle updated" : "Vehicle added to your net worth");
        setOpen(false);
      },
      onError: (e: Error) => toast.error(e.message),
    };
    if (vehicle) update({ id: vehicle.id, data: payload }, done);
    else create({ ...payload, current_value_at: today() }, done);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setForm(initial());
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{vehicle ? "Edit vehicle" : "Add vehicle"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="veh-name">Name</Label>
            <Input
              id="veh-name"
              placeholder="e.g. 2021 Honda Civic"
              value={form.name}
              onChange={set("name")}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="veh-paid">Purchase price</Label>
              <Input
                id="veh-paid"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.purchase_value}
                onChange={set("purchase_value")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="veh-ccy">Currency</Label>
              <select
                id="veh-ccy"
                value={form.currency}
                onChange={set("currency")}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {SUPPORTED_CURRENCIES.map((c: string) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="veh-date">Purchase date</Label>
            <Input
              id="veh-date"
              type="date"
              value={form.purchase_date}
              onChange={set("purchase_date")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="veh-value">Value today</Label>
            <Input
              id="veh-value"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.current_value}
              onChange={set("current_value")}
            />
            <p className="text-[11px] text-muted-foreground">
              A private-party estimate (e.g. Kelley Blue Book or Edmunds).
              {vehicle && " Change it to record a new quote; leave it to keep the current curve."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="veh-rate">Automatic depreciation (% per year)</Label>
            <Input
              id="veh-rate"
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.5"
              placeholder="Leave empty to change the value only by hand"
              value={form.depreciation_rate}
              onChange={set("depreciation_rate")}
            />
            <p className="text-[11px] text-muted-foreground">
              The value drifts down daily at this rate from your last quote. Cars
              typically lose 10–20% a year.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="veh-notes">Notes (optional)</Label>
            <Input id="veh-notes" value={form.notes} onChange={set("notes")} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={creating || updating}>
              {vehicle ? "Save" : "Add vehicle"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewQuoteDialog({ vehicle }: { vehicle: InvestmentResponse }) {
  const { mutate: update, isPending } = useUpdateInvestment();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const submit = () => {
    const v = Number.parseFloat(value);
    if (!(v >= 0)) return toast.error("Enter the new value.");
    update(
      {
        id: vehicle.id,
        data: { current_value: v, current_value_at: today(), current_value_source: "manual quote" },
      },
      {
        onSuccess: () => {
          toast.success("New value recorded");
          setOpen(false);
        },
        onError: (e: Error) => toast.error(e.message),
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setValue("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Record a new value">
          <RefreshCcw className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">New value for {vehicle.name}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Currently {formatCurrency(vehicle.current_value, vehicle.currency)}. A new
          quote replaces the estimate
          {vehicle.depreciation_rate ? " and depreciation continues from it." : "."}
        </p>
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          autoFocus
          placeholder={String(vehicle.current_value)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={isPending}>
            Save value
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteVehicleButton({ vehicle }: { vehicle: InvestmentResponse }) {
  const { mutate: del } = useDeleteInvestment();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-negative"
          title="Remove vehicle"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Remove "{vehicle.name}"?</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Use this when you sell it or it's written off. Its value and history
          are removed from your net worth.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() =>
              del(vehicle.id, {
                onSuccess: () => {
                  toast.success("Vehicle removed");
                  setOpen(false);
                },
                onError: (e: Error) => toast.error(e.message),
              })
            }
          >
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PhysicalAssetsPage() {
  const { data, isLoading } = useInvestments();
  const { data: rates = {} } = useExchangeRates();
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const fmt = (inr: number) =>
    formatCurrency(convertFromINR(inr, defaultCurrency as any, rates), defaultCurrency as any);

  const vehicles = (data?.investments ?? []).filter((i) => isPhysicalAsset(i.asset_type));
  const totalInr = vehicles.reduce((s, v) => s + v.current_value_inr, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Physical Assets</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Vehicles you own outright. Counted in net worth, kept out of your
            investment returns.
          </p>
        </div>
        <VehicleFormDialog
          trigger={
            <Button size="sm">
              <PlusCircle className="w-4 h-4 mr-1" />
              Add Vehicle
            </Button>
          }
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : vehicles.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm border border-dashed rounded-2xl bg-muted/10 space-y-2">
          <Car className="w-10 h-10 mx-auto opacity-25" />
          <p>No vehicles yet.</p>
          <p className="text-xs">
            Paid off a car loan? Add the car here so its value counts toward your
            net worth.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {vehicles.map((v) => {
              const lostSincePurchase = v.purchase_value - v.current_value;
              return (
                <Card key={v.id} className="shadow-sm border border-border/80">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                          <Car className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{v.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            Bought {fmtDate(v.purchase_date)} for{" "}
                            {formatCurrency(v.purchase_value, v.currency)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <NewQuoteDialog vehicle={v} />
                        <VehicleFormDialog
                          vehicle={v}
                          trigger={
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit">
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          }
                        />
                        <DeleteVehicleButton vehicle={v} />
                      </div>
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                          Worth today
                        </p>
                        <p className="text-xl font-bold tabular-nums">
                          {formatCurrency(v.current_value, v.currency)}
                        </p>
                        {v.currency !== defaultCurrency && (
                          <p className="text-[11px] text-muted-foreground">
                            ≈ {fmt(v.current_value_inr)}
                          </p>
                        )}
                      </div>
                      {lostSincePurchase > 0 && (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <TrendingDown className="w-3 h-3" />
                          {formatCurrency(lostSincePurchase, v.currency)} since purchase
                        </p>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground border-t pt-2">
                      {v.depreciation_rate
                        ? `Depreciating ${v.depreciation_rate}%/yr from ${formatCurrency(v.quoted_value, v.currency)} on ${fmtDate(v.current_value_at)}`
                        : `Last valued ${fmtDate(v.current_value_at)} · changes only when you update it`}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground text-right">
            Total physical assets: <span className="font-semibold text-foreground">{fmt(totalInr)}</span>
          </p>
        </>
      )}
    </div>
  );
}
