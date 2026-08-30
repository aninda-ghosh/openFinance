import { useSearchParams } from "react-router-dom";
import {
  Coins,
  Landmark,
  Shield,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useNetWorth } from "@/modules/dashboard/hooks/useDashboard";
import { useAppStore } from "@/stores/app.store";
import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";

// Sub-pages in embed mode
import SavingsCheckingPage from "./SavingsCheckingPage";
import InvestmentsPage from "@/modules/investments/pages/InvestmentsPage";
import PoliciesPage from "@/modules/policies/pages/PoliciesPage";
import DebtPage from "@/modules/debt/pages/DebtPage";

const TABS = [
  { id: "cash", label: "Cash & Checking", icon: Landmark },
  { id: "investments", label: "Investments", icon: TrendingUp },
  { id: "policies", label: "Policies", icon: Shield },
  { id: "debt", label: "Liabilities & Debt", icon: Coins },
] as const;

export default function AccountsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") as typeof TABS[number]["id"]) || "cash";

  const { data: nwData, isLoading: nwLoading } = useNetWorth();
  const { data: rates = {} } = useExchangeRates();
  const { defaultCurrency } = useAppStore();

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  // ── Balance-sheet tiles ─────────────────────────────────────────────────────
  //
  // These read the server's net-worth breakdown verbatim. This page used to
  // re-derive its own assets total from `useAccounts()` — on-budget
  // checking/savings/cash only — which made it a THIRD net-worth formula
  // alongside `getNetWorth` and `getNetWorthHistory`. It disagreed with the
  // dashboard's headline number in two ways: it dropped off-budget savings
  // accounts from assets entirely (the server counts them, minus their linked
  // holdings, inside `investments_inr`), and it double-counted the cash sleeve
  // of any on-budget account with linked holdings, because `balance_inr` folds
  // those holdings in while `investments_inr` counts them again.
  const cashInr = nwData?.breakdown.cash_inr ?? 0;
  const investmentsTotalInr = nwData?.breakdown.investments_inr ?? 0;
  const policiesTotalInr = nwData?.breakdown.policies_inr ?? 0;
  // SIGNED, and negative: liabilities are stored with a negative balance and
  // the server sums them as-is so that total = cash + investments + policies +
  // debt. Keep this signed in all arithmetic.
  const debtInr = nwData?.breakdown.debt_inr ?? 0;

  const totalAssetsInr = cashInr + investmentsTotalInr + policiesTotalInr;

  // Presentation only: the Liabilities tile shows the amount owed as a positive
  // magnitude because the label already says "Liabilities". This Math.abs must
  // NOT leak into the Net Position arithmetic below, which uses the signed
  // `debtInr`.
  const totalLiabilitiesInr = Math.abs(debtInr);

  // Identical to the server's `total_inr`, by construction.
  const netPositionInr = totalAssetsInr + debtInr;

  const handleTabChange = (tabId: typeof TABS[number]["id"]) => {
    setSearchParams({ tab: tabId });
  };

  const isLoading = nwLoading;

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 w-full max-w-7xl mx-auto">
      {/* Page Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Accounts & Balance Sheet</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          A consolidated view of all your checking, savings, investments, policies, and debts.
        </p>
      </div>

      {/* Aggregate Stats Dashboard Grid */}
      <div className="grid grid-cols-3 gap-2 md:gap-4">
        {/* Total Assets */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm border border-border/80">
          <CardContent className="p-2.5 md:p-4 flex flex-col justify-between h-full min-h-[64px] md:min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] md:text-xs font-bold uppercase tracking-wider text-muted-foreground truncate">
                Assets
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary hidden md:block">
                <Landmark className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-5 w-16 md:h-7 md:w-28 mt-2" />
            ) : (
              <p className="text-sm md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary truncate">
                {fmt(totalAssetsInr)}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground mt-0.5 hidden md:block">
              Cash + Investments + Policies
            </p>
          </CardContent>
        </Card>

        {/* Total Liabilities */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm border border-border/80">
          <CardContent className="p-2.5 md:p-4 flex flex-col justify-between h-full min-h-[64px] md:min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] md:text-xs font-bold uppercase tracking-wider text-muted-foreground truncate">
                Liabilities
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary hidden md:block">
                <Coins className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-5 w-16 md:h-7 md:w-28 mt-2" />
            ) : (
              <p className="text-sm md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary truncate">
                {fmt(totalLiabilitiesInr)}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground mt-0.5 hidden md:block">
              Credit Cards + Active Loans & Debts
            </p>
          </CardContent>
        </Card>

        {/* Net Position */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm border border-border/80">
          <CardContent className="p-2.5 md:p-4 flex flex-col justify-between h-full min-h-[64px] md:min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] md:text-xs font-bold uppercase tracking-wider text-muted-foreground truncate">
                Net Position
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary hidden md:block">
                <Wallet className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-5 w-16 md:h-7 md:w-28 mt-2" />
            ) : (
              <p className="text-sm md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary truncate">
                {fmt(netPositionInr)}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground mt-0.5 hidden md:block">
              Total assets minus total liabilities
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tab Switcher */}
      <div className="border-b border-border/40 pb-px">
        <div className="flex space-x-1 p-0.5 bg-muted/40 rounded-lg w-full max-w-2xl overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => handleTabChange(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all whitespace-nowrap ${
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/20"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Tab Subpage Component */}
      <div className="pt-2">
        {activeTab === "cash" && <SavingsCheckingPage embed />}
        {activeTab === "investments" && <InvestmentsPage embed />}
        {activeTab === "policies" && <PoliciesPage embed />}
        {activeTab === "debt" && <DebtPage embed />}
      </div>
    </div>
  );
}
