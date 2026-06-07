import { useState, useMemo } from "react";
import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import {
  BarChart3,
  Building2,
  CalendarDays,
  DollarSign,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useAppStore } from "@/stores/app.store";
import {
  useDashboard,
  useNetWorth,
  usePortfolioBreakdown,
  useSpendingTrends,
  useTopMovers,
} from "../hooks/useDashboard";

const PIE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

// ─── Tiny stat widget ─────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  accent = "default",
  loading = false,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: "default" | "green" | "red" | "blue" | "purple" | "amber";
  loading?: boolean;
}) {
  const colors: Record<string, string> = {
    default: "text-foreground bg-muted/60",
    green: "text-positive bg-positive/10",
    red: "text-negative bg-negative/10",
    blue: "text-blue-500 bg-blue-500/10",
    purple: "text-indigo-500 bg-indigo-500/10",
    amber: "text-amber-500 bg-amber-500/10",
  };
  return (
    <Card className="flex flex-col justify-between relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
      <CardContent className="pt-3 pb-3 flex flex-col gap-1 h-full">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </p>
          <div className={`p-1.5 rounded-lg ${colors[accent]}`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
        </div>
        {loading ? (
          <>
            <Skeleton className="h-6 w-28 mt-1" />
            <Skeleton className="h-3 w-20 mt-1" />
          </>
        ) : (
          <>
            <p className="text-xl font-bold tabular-nums leading-tight">
              {value}
            </p>
            {sub && (
              <p className="text-xs text-muted-foreground leading-snug">
                {sub}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { selectedMonth, defaultCurrency } = useAppStore();
  const { data: dashboard, isLoading: dashLoading } =
    useDashboard(selectedMonth);
  const { data: netWorth, isLoading: nwLoading } = useNetWorth();
  const { data: breakdown } = usePortfolioBreakdown();
  const { data: topMovers } = useTopMovers();
  const { data: trendsData } = useSpendingTrends(6);
  const { data: rates = {} } = useExchangeRates();

  const [activeDonutIndex, setActiveDonutIndex] = useState<number | null>(null);

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const donutData =
    breakdown?.breakdown?.map((b: any) => ({
      name: b.asset_type.replace(/_/g, " "),
      value: b.value_inr,
      pct: b.percentage,
    })) ?? [];

  const totalDonutValue = useMemo(() => {
    return donutData.reduce((sum: number, item: any) => sum + item.value, 0);
  }, [donutData]);

  const activeDonut = activeDonutIndex !== null ? donutData[activeDonutIndex] : null;

  const monthLabel = (() => {
    const [y, m] = selectedMonth.split("-").map(Number);
    return new Date(y, m - 1).toLocaleString("default", {
      month: "long",
      year: "numeric",
    });
  })();

  const nw = netWorth?.total_inr ?? 0;
  const accts = netWorth?.breakdown?.cash_inr ?? 0;
  const invs = netWorth?.breakdown?.investments_inr ?? 0;
  const pols = netWorth?.breakdown?.policies_inr ?? 0;
  const debt = netWorth?.breakdown?.debt_inr ?? 0;
  const income = dashboard?.monthly_income ?? 0;
  const expenses = dashboard?.monthly_expenses ?? 0;
  const savings = dashboard?.savings_rate ?? 0;
  const toAssign = dashboard?.budget?.to_assign ?? 0;
  const budgeted = dashboard?.budget?.total_budgeted ?? 0;
  const spent = dashboard?.budget?.total_spent ?? 0;

  return (
    <div className="p-4 space-y-3">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs gap-1.5 font-semibold">
            <DollarSign className="w-3 h-3" />
            {defaultCurrency}
          </Badge>
          <Badge variant="outline" className="text-xs gap-1.5">
            <CalendarDays className="w-3 h-3" />
            {monthLabel}
          </Badge>
        </div>
      </div>

      {/* ── Row 1: Net Worth hero ─────────────────────────────────────── */}
      <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
            {/* Left: headline */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
                Total Net Worth
              </p>
              {nwLoading ? (
                <Skeleton className="h-9 w-44" />
              ) : (
                <p className="text-3xl font-bold tabular-nums">{fmt(nw)}</p>
              )}
              {/* Breakdown bar */}
              {!nwLoading && accts + invs + pols > 0 && (
                <div className="flex h-1 rounded-full overflow-hidden w-full max-w-56 mt-2 gap-px">
                  {(() => {
                    const total = accts + invs + pols;
                    return (
                      <>
                        <div
                          className="bg-indigo-500 rounded-l-full"
                          style={{ width: `${(accts / total) * 100}%` }}
                        />
                        <div
                          className="bg-positive"
                          style={{ width: `${(invs / total) * 100}%` }}
                        />
                        <div
                          className="bg-amber-500"
                          style={{ width: `${(pols / total) * 100}%` }}
                        />
                        {debt > 0 && (
                          <div
                            className="bg-negative rounded-r-full"
                            style={{ width: `${(debt / total) * 100}%` }}
                          />
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
            {/* Right: breakdown pills */}
            <div className="flex gap-4 flex-wrap md:flex-shrink-0 md:justify-end">
              {[
                {
                  label: "Cash & Accounts",
                  value: accts,
                  dot: "bg-indigo-500",
                },
                { label: "Investments", value: invs, dot: "bg-positive" },
                { label: "Policies / Bonds", value: pols, dot: "bg-amber-500" },
                ...(debt > 0
                  ? [{ label: "Debt", value: -debt, dot: "bg-negative" }]
                  : []),
              ].map((s) => (
                <div key={s.label} className="text-right">
                  <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                    <span
                      className={`w-1.5 h-1.5 rounded-full inline-block ${s.dot}`}
                    />
                    {s.label}
                  </p>
                  {nwLoading ? (
                    <Skeleton className="h-5 w-20 mt-0.5" />
                  ) : (
                    <p
                      className={`text-base font-semibold tabular-nums ${s.value < 0 ? "text-negative" : ""}`}
                    >
                      {s.value < 0 ? "−" : ""}
                      {fmt(Math.abs(s.value))}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Row 2: Wealth breakdown ──────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="Cash & Accounts"
          value={fmt(accts)}
          sub="On-budget balances"
          icon={Building2}
          accent="purple"
          loading={nwLoading}
        />
        <StatCard
          title="Investments"
          value={fmt(invs)}
          sub="Portfolio + linked accounts"
          icon={TrendingUp}
          accent="green"
          loading={nwLoading}
        />
        <StatCard
          title="Policies / Bonds"
          value={fmt(pols)}
          sub="Surrender / maturity value"
          icon={ShieldCheck}
          accent="amber"
          loading={nwLoading}
        />
        <StatCard
          title="Total Debt"
          value={debt > 0 ? `−${fmt(debt)}` : fmt(0)}
          sub="Loans & credit owed"
          icon={BarChart3}
          accent="blue"
          loading={nwLoading}
        />
      </div>

      {/* ── Row 3: Month KPIs ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="Income"
          value={fmt(income)}
          sub={monthLabel}
          icon={TrendingUp}
          accent="green"
          loading={dashLoading}
        />
        <StatCard
          title="Expenses"
          value={fmt(expenses)}
          sub={expenses > 0 ? `${savings.toFixed(1)}% saved` : "No expenses"}
          icon={TrendingDown}
          accent="red"
          loading={dashLoading}
        />
        <StatCard
          title="Savings Rate"
          value={`${savings.toFixed(1)}%`}
          sub={
            savings >= 20
              ? "Above 20% goal ✓"
              : income > 0
                ? "Below 20% goal"
                : "No income this month"
          }
          icon={Wallet}
          accent={income === 0 ? "default" : savings >= 20 ? "green" : "red"}
          loading={dashLoading}
        />
        <StatCard
          title="Ready to Assign"
          value={fmt(Math.abs(toAssign))}
          sub={
            toAssign > 0
              ? "Unassigned income"
              : toAssign < 0
                ? "Over-budgeted"
                : "Fully assigned"
          }
          icon={Target}
          accent={toAssign > 0 ? "green" : toAssign < 0 ? "red" : "default"}
          loading={dashLoading}
        />
      </div>

      {/* ── Row 4: Portfolio + Budget progress + Recent transactions ─── */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        {/* Portfolio Breakdown ── 4 cols */}
        <Card className="md:col-span-4 relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Portfolio Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {donutData.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">
                No investments yet.
              </p>
            ) : (
              <div className="flex items-center gap-4">
                <div className="relative w-[125px] h-[125px] flex-shrink-0 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={donutData}
                        dataKey="value"
                        cx="50%"
                        cy="50%"
                        innerRadius={38}
                        outerRadius={48}
                        paddingAngle={3}
                        cornerRadius={4}
                        onMouseEnter={(_, index) => setActiveDonutIndex(index)}
                        onMouseLeave={() => setActiveDonutIndex(null)}
                      >
                        {donutData.map((_: any, i: number) => {
                          const isHovered = activeDonutIndex === i;
                          return (
                            <Cell
                              key={i}
                              fill={PIE_COLORS[i % PIE_COLORS.length]}
                              stroke="none"
                              strokeWidth={0}
                              style={{
                                outline: "none",
                                filter: isHovered ? "drop-shadow(0 0 4px rgba(99,102,241,0.3))" : "none",
                                transition: "all 0.2s ease-in-out",
                              }}
                            />
                          );
                        })}
                      </Pie>
                      <Tooltip formatter={(v: any) => fmt(Number(v))} content={<></>} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center p-1.5">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-muted-foreground/80 truncate max-w-[72px] leading-none">
                      {activeDonut ? activeDonut.name : "Total"}
                    </span>
                    <span className="text-xs font-extrabold tracking-tight mt-1 tabular-nums text-foreground truncate max-w-[72px]">
                      {fmt(activeDonut ? activeDonut.value : totalDonutValue)}
                    </span>
                  </div>
                </div>
                <div className="space-y-1 flex-1 min-w-0">
                  {donutData.map((d: any, i: number) => (
                    <div
                      key={d.name}
                      className="flex items-center gap-1.5 min-w-0"
                    >
                      <div
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{
                          background: PIE_COLORS[i % PIE_COLORS.length],
                        }}
                      />
                      <span className="text-xs text-muted-foreground capitalize flex-1 truncate">
                        {d.name}
                      </span>
                      <span className="text-xs font-semibold tabular-nums">
                        {d.pct}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Budget progress ── 4 cols */}
        <Card className="md:col-span-4 relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Budget — {monthLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 space-y-2">
            {dashLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-positive/10 rounded-lg p-2 text-center">
                    <p className="text-xs text-muted-foreground">Income</p>
                    <p className="text-sm font-bold text-positive tabular-nums truncate">
                      {fmt(income)}
                    </p>
                  </div>
                  <div className="bg-negative/10 rounded-lg p-2 text-center">
                    <p className="text-xs text-muted-foreground">
                      Expenses
                    </p>
                    <p className="text-sm font-bold text-negative tabular-nums truncate">
                      {fmt(expenses)}
                    </p>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Envelope spend</span>
                    <span className="tabular-nums">
                      {fmt(spent)} / {fmt(budgeted)}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${spent > budgeted ? "bg-negative" : "bg-indigo-500"}`}
                      style={{
                        width: `${Math.min(100, budgeted > 0 ? (spent / budgeted) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                  <p
                    className={`text-xs mt-1 tabular-nums ${toAssign >= 0 ? "text-positive" : "text-negative"}`}
                  >
                    {toAssign >= 0
                      ? `${fmt(toAssign)} ready to assign`
                      : `${fmt(-toAssign)} over-budgeted`}
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Recent Transactions ── 4 cols */}
        <Card className="md:col-span-4 relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Top Transactions — {monthLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {dashLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !dashboard?.recent_transactions?.length ? (
              <p className="text-xs text-muted-foreground text-center py-6">
                No transactions this month.
              </p>
            ) : (
              <div className="space-y-0">
                {dashboard.recent_transactions.slice(0, 6).map((t: any) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between py-1 rounded hover:bg-muted/40 px-1 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{t.payee}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {t.date} · {t.account_name}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-semibold tabular-nums ml-2 flex-shrink-0 ${t.type === "income" ? "text-positive" : t.type === "expense" ? "text-negative" : "text-info"}`}
                    >
                      {t.type === "income"
                        ? "+"
                        : t.type === "expense"
                          ? "−"
                          : "⇄"}
                      {fmt(t.amount_inr ?? t.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Row 5: Spending Trends ────────────────────────────────────── */}
      <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
        <CardHeader className="pt-3 pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Income vs Expenses — Last 6 Months
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          {!trendsData?.trends?.length ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              No transaction data yet.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              {(() => {
                const CustomBarTooltip = ({ active, payload, label }: any) => {
                  if (active && payload && payload.length) {
                    const [y, mo] = label.split("-");
                    const formattedLabel = new Date(+y, +mo - 1).toLocaleString("default", {
                      month: "long",
                      year: "numeric",
                    });
                    return (
                      <div className="backdrop-blur-md bg-background/80 border border-border/50 shadow-xl rounded-xl p-3 text-xs flex flex-col gap-1.5 min-w-[140px] animate-in fade-in-50 duration-200">
                        <p className="font-semibold text-muted-foreground">{formattedLabel}</p>
                        <div className="space-y-1 mt-1">
                          {payload.map((p: any) => (
                            <div key={p.name} className="flex items-center justify-between gap-4">
                              <div className="flex items-center gap-1.5">
                                <div 
                                  className="w-2.5 h-2.5 rounded-full" 
                                  style={{ 
                                    background: p.name === "Income" ? "#8da99a" : "#c97b7b",
                                    boxShadow: p.name === "Income" ? "0 0 6px rgba(141,169,154,0.4)" : "0 0 6px rgba(201,123,123,0.4)"
                                  }}
                                />
                                <span className="text-muted-foreground text-xs">{p.name}</span>
                              </div>
                              <span className="font-bold tabular-nums text-foreground">
                                {fmt(Number(p.value))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  return null;
                };

                return (
                  <BarChart data={trendsData.trends} barSize={16} barGap={4}>
                    <defs>
                      <linearGradient id="barIncomeGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8da99a" />
                        <stop offset="100%" stopColor="#769384" />
                      </linearGradient>
                      <linearGradient id="barExpenseGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#c97b7b" />
                        <stop offset="100%" stopColor="#b86868" />
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
                      tickFormatter={(m) => {
                        const [y, mo] = m.split("-");
                        return new Date(+y, +mo - 1).toLocaleString("default", {
                          month: "short",
                        });
                      }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                      tickFormatter={(v) => fmt(v)}
                      width={55}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<CustomBarTooltip />} cursor={{ fill: "currentColor", opacity: 0.04 }} />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
                    />
                    <Bar
                      dataKey="income"
                      name="Income"
                      fill="url(#barIncomeGrad)"
                      radius={[8, 8, 0, 0]}
                    />
                    <Bar
                      dataKey="expenses"
                      name="Expenses"
                      fill="url(#barExpenseGrad)"
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                );
              })()}
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Row 6: Investment Movers + Upcoming Payouts + Upcoming Premiums ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Investment Movers */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Investment Movers
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            {!topMovers?.movers?.length ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No investments yet.
              </p>
            ) : (
              <div className="space-y-0">
                {topMovers.movers.map((m: any) => {
                  const pos = m.gain_loss_inr >= 0;
                  return (
                    <div
                      key={m.investment.id}
                      className="flex items-center justify-between py-1.5 px-1 rounded hover:bg-muted/40 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">
                          {m.investment.name}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {m.investment.asset_type.replace(/_/g, " ")}
                        </p>
                      </div>
                      <div
                        className={`text-right ml-3 ${pos ? "text-positive" : "text-negative"}`}
                      >
                        <p className="text-xs font-semibold tabular-nums">
                          {pos ? "+" : ""}
                          {fmt(m.gain_loss_inr)}
                        </p>
                        <p className="text-xs">
                          {pos ? "+" : ""}
                          {m.gain_loss_pct.toFixed(2)}%
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Policy Payouts */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Scheduled Policy Receipts — next 90 days
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upcoming maturity/bonus amounts from your insurance &amp; bond
              policies
            </p>
          </CardHeader>
          <CardContent className="pb-3">
            {!dashboard?.upcoming_policy_payouts?.length ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No scheduled receipts in the next 90 days.
              </p>
            ) : (
              <div className="space-y-1.5">
                {dashboard.upcoming_policy_payouts.map((p: any, i: number) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/40"
                  >
                    <div>
                      <p className="text-xs font-medium">{p.policy_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.payout_date} · {p.label}
                      </p>
                    </div>
                    <p className="text-xs font-bold text-positive tabular-nums">
                      {fmt(p.amount)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Premium Payments */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardHeader className="pt-3 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Upcoming Premiums — next 60 days
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Insurance premium payments due soon
            </p>
          </CardHeader>
          <CardContent className="pb-3">
            {!dashboard?.upcoming_premium_payments?.length ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No premiums due in the next 60 days.
              </p>
            ) : (
              <div className="space-y-1.5">
                {dashboard.upcoming_premium_payments.map(
                  (p: any, i: number) => (
                    <div
                      key={i}
                      className="flex items-center justify-between p-2 rounded-lg bg-amber-500/10"
                    >
                      <div>
                        <p className="text-xs font-medium">{p.policy_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.due_date} · {p.provider} · {p.frequency}
                        </p>
                      </div>
                      <p className="text-xs font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                        −{fmt(p.amount)}
                      </p>
                    </div>
                  )
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
