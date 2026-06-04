import { convertFromINR, formatCurrency } from "@finwise/shared/utils";
import { TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAccounts,
  useExchangeRates,
} from "@/modules/budget/hooks/useBudget";
import {
  useNetWorth,
  useNetWorthHistory,
} from "@/modules/dashboard/hooks/useDashboard";
import { useAppStore } from "@/stores/app.store";

const PERIOD_OPTIONS = [
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
];

const TYPE_COLORS: Record<string, string> = {
  checking: "#3b82f6",
  savings: "#22c55e",
  investment: "#8b5cf6",
  cash: "#f59e0b",
  credit: "#ef4444",
  loan: "#f97316",
};

const TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  cash: "Cash",
  credit: "Credit Cards",
  loan: "Loans",
};

function formatShort(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

export default function NetWorthPage() {
  const [periodMonths, setPeriodMonths] = useState(6);
  const { defaultCurrency } = useAppStore();
  const { data: rates = {} } = useExchangeRates();
  const { data: nwData } = useNetWorth();
  const { data: historyData, isLoading: histLoading } =
    useNetWorthHistory(periodMonths);
  const { data: accountsData } = useAccounts();

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const history = historyData?.history ?? [];
  const allAccounts = accountsData?.accounts ?? [];

  // Chart data — month label + values already converted to display currency
  const chartData = history.map((h) => ({
    month: new Date(`${h.month}-01`).toLocaleString("default", {
      month: "short",
      year: "2-digit",
    }),
    total: convertFromINR(h.total_inr, defaultCurrency as any, rates),
    cash: convertFromINR(h.cash_inr, defaultCurrency as any, rates),
    investments: convertFromINR(
      h.investments_inr,
      defaultCurrency as any,
      rates
    ),
    debt: convertFromINR(h.debt_inr, defaultCurrency as any, rates),
  }));

  // Period change
  const first = history[0];
  const last = history[history.length - 1];
  const periodChange = first && last ? last.total_inr - first.total_inr : null;
  const periodChangePct =
    first && last && first.total_inr > 0
      ? ((last.total_inr - first.total_inr) / first.total_inr) * 100
      : null;

  // Group accounts by type
  const onBudget = allAccounts.filter((a: any) => !a.off_budget && a.is_active);
  const assetTypes = ["checking", "savings", "cash", "investment"];
  const liabilityTypes = ["credit", "loan"];

  const assetAccounts = onBudget.filter((a: any) =>
    assetTypes.includes(a.type)
  );
  const liabilityAccounts = onBudget.filter((a: any) =>
    liabilityTypes.includes(a.type)
  );

  const totalAssets =
    assetAccounts.reduce(
      (s: number, a: any) => s + Math.max(0, a.balance_inr),
      0
    ) +
    (nwData?.breakdown.investments_inr ?? 0) +
    (nwData?.breakdown.policies_inr ?? 0);
  const totalLiabilities = liabilityAccounts.reduce(
    (s: number, a: any) => s + a.balance_inr,
    0
  );

  // Breakdown bar data for assets
  const assetByType: Record<string, number> = {};
  for (const a of assetAccounts) {
    const k = a.type;
    assetByType[k] = (assetByType[k] ?? 0) + Math.max(0, a.balance_inr);
  }
  if (nwData?.breakdown.investments_inr)
    assetByType.investment =
      (assetByType.investment ?? 0) + nwData.breakdown.investments_inr;

  const assetEntries = Object.entries(assetByType).sort((a, b) => b[1] - a[1]);
  const liabilityByType: Record<string, number> = {};
  for (const a of liabilityAccounts) {
    liabilityByType[a.type] =
      (liabilityByType[a.type] ?? 0) + a.balance_inr;
  }
  const liabilityEntries = Object.entries(liabilityByType).sort(
    (a, b) => a[1] - b[1]
  );

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="backdrop-blur-md bg-background/80 border border-border/50 shadow-xl rounded-xl p-3 text-xs flex flex-col gap-1 min-w-[140px] animate-in fade-in-50 duration-200">
          <p className="font-semibold text-muted-foreground">{label}</p>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-2.5 h-2.5 rounded-full bg-[#6c7a9c] shadow-[0_0_8px_rgba(108,122,156,0.4)]" />
            <p className="font-bold tabular-nums text-foreground">
              {formatCurrency(payload[0].value, defaultCurrency as any)}
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground leading-none">Net Worth</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Net Worth</h1>
          {nwData && (
            <div className="flex items-center gap-3 mt-1">
              <span className="text-3xl font-bold">
                {fmt(nwData.total_inr)}
              </span>
              {periodChange !== null && (
                <span
                  className={`flex items-center gap-1 text-sm font-medium ${periodChange >= 0 ? "text-positive" : "text-negative"}`}
                >
                  {periodChange >= 0 ? (
                    <TrendingUp className="w-4 h-4" />
                  ) : (
                    <TrendingDown className="w-4 h-4" />
                  )}
                  {periodChange >= 0 ? "+ " : ""}
                  {fmt(periodChange)} ({periodChangePct?.toFixed(1)}%)
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex rounded-lg border overflow-hidden text-sm">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setPeriodMonths(opt.months)}
              className={`px-3 py-1.5 font-medium transition-colors ${periodMonths === opt.months ? "bg-foreground text-background" : "hover:bg-muted text-muted-foreground"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card p-5 border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30">
        {histLoading ? (
          <Skeleton className="h-52 w-full" />
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-16">
            No data yet.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart
              data={chartData}
              margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8da99a" stopOpacity={0.25} />
                  <stop offset="50%" stopColor="#7aa892" stopOpacity={0.10} />
                  <stop offset="100%" stopColor="#7aa892" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="nwStrokeGrad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#8da99a" />
                  <stop offset="100%" stopColor="#7aa892" />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="4 4"
                className="stroke-border/40"
                vertical={false}
              />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                tickLine={false}
                axisLine={false}
                dy={6}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatShort(v)}
                width={50}
              />
              <Tooltip 
                content={<CustomTooltip />} 
                cursor={{ stroke: "currentColor", strokeOpacity: 0.08, strokeWidth: 1.5 }} 
              />
              <Area
                type="natural"
                dataKey="total"
                stroke="url(#nwStrokeGrad)"
                strokeWidth={2.5}
                fill="url(#nwGrad)"
                activeDot={{
                  r: 5,
                  stroke: "#8da99a",
                  strokeWidth: 2,
                  fill: "#ffffff",
                }}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Summary + Accounts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Assets / Liabilities summary */}
        <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card p-5 border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30 space-y-5">
          <p className="font-semibold text-sm">Summary</p>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Assets</span>
              <span className="font-semibold">{fmt(totalAssets)}</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden flex gap-0.5">
              {assetEntries.map(([type, val]) => (
                <div
                  key={type}
                  className="h-full"
                  style={{
                    width: `${(val / totalAssets) * 100}%`,
                    background: TYPE_COLORS[type] ?? "#94a3b8",
                  }}
                />
              ))}
            </div>
            {assetEntries.map(([type, val]) => (
              <div
                key={type}
                className="flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: TYPE_COLORS[type] ?? "#94a3b8" }}
                  />
                  <span className="text-muted-foreground">
                    {TYPE_LABELS[type] ?? type}
                  </span>
                </div>
                <span className="tabular-nums">{fmt(val)}</span>
              </div>
            ))}
          </div>

          {totalLiabilities > 0 && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Liabilities</span>
                <span className="font-semibold text-negative">
                  {fmt(totalLiabilities)}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden flex gap-0.5">
                {liabilityEntries.map(([type, val]) => (
                  <div
                    key={type}
                    className="h-full"
                    style={{
                      width: `${(val / totalLiabilities) * 100}%`,
                      background: TYPE_COLORS[type] ?? "#94a3b8",
                    }}
                  />
                ))}
              </div>
              {liabilityEntries.map(([type, val]) => (
                <div
                  key={type}
                  className="flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ background: TYPE_COLORS[type] ?? "#94a3b8" }}
                    />
                    <span className="text-muted-foreground">
                      {TYPE_LABELS[type] ?? type}
                    </span>
                  </div>
                  <span className="tabular-nums text-negative">{fmt(val)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Account list grouped by type */}
        <div className="lg:col-span-2 space-y-4">
          {[
            {
              label: "Cash & Checking",
              types: ["checking", "cash", "savings"],
              isLiability: false,
            },
            { label: "Debt", types: ["credit", "loan"], isLiability: true },
          ].map((section) => {
            const sectionAccounts = onBudget.filter((a: any) =>
              section.types.includes(a.type)
            );
            if (sectionAccounts.length === 0) return null;
            const sectionTotal = sectionAccounts.reduce(
              (s: number, a: any) => s + a.balance_inr,
              0
            );
            return (
              <div
                key={section.label}
                className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30 overflow-hidden"
              >
                <div className="px-4 py-3 border-b flex justify-between items-center bg-muted/30">
                  <span className="font-semibold text-sm">{section.label}</span>
                  <span
                    className={`text-sm font-semibold tabular-nums ${section.isLiability ? "text-negative" : ""}`}
                  >
                    {sectionTotal >= 0 ? "+ " : ""}
                    {fmt(sectionTotal)}
                  </span>
                </div>
                <div className="divide-y">
                  {sectionAccounts.map((a: any) => (
                    <div
                      key={a.id}
                      className="px-4 py-3 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
                          style={{
                            background: TYPE_COLORS[a.type] ?? "#94a3b8",
                          }}
                        >
                          {a.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{a.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {TYPE_LABELS[a.type] ?? a.type} · {a.currency}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-sm font-medium tabular-nums ${a.balance_inr < 0 ? "text-negative" : ""}`}
                      >
                        {formatCurrency(a.balance, a.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
