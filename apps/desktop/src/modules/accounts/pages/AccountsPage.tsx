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
import { useAccounts, useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useNetWorth } from "@/modules/dashboard/hooks/useDashboard";
import { useAppStore } from "@/stores/app.store";
import { convertFromINR, formatCurrency } from "@finwise/shared/utils";

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

  const { data: accountsData, isLoading: accountsLoading } = useAccounts();
  const { data: nwData, isLoading: nwLoading } = useNetWorth();
  const { data: rates = {} } = useExchangeRates();
  const { defaultCurrency } = useAppStore();

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const allAccounts = accountsData?.accounts ?? [];

  // Liquid assets (Checking, Savings, Cash) - on budget only
  const liquidAccounts = allAccounts.filter(
    (a) => ["checking", "savings", "cash"].includes(a.type) && !a.off_budget && a.is_active
  );
  const liquidTotalInr = liquidAccounts.reduce(
    (sum, a) => sum + (a.balance_inr ?? 0),
    0
  );

  // Investments (holdings + off-budget investment/savings accounts)
  const investmentsTotalInr = nwData?.breakdown.investments_inr ?? 0;

  // Insurance Policies (total premium invested)
  const policiesTotalInr = nwData?.breakdown.policies_inr ?? 0;

  // Total Assets
  const totalAssetsInr = liquidTotalInr + investmentsTotalInr + policiesTotalInr;

  // Liabilities (Credit Cards, Loans)
  const debtAccounts = allAccounts.filter(
    (a) => ["credit", "loan", "debt"].includes(a.type) && a.is_active
  );
  const totalLiabilitiesInr = debtAccounts.reduce(
    (sum, a) => sum + Math.abs(a.balance_inr ?? 0),
    0
  );

  // Net position
  const netPositionInr = totalAssetsInr - totalLiabilitiesInr;

  const handleTabChange = (tabId: typeof TABS[number]["id"]) => {
    setSearchParams({ tab: tabId });
  };

  const isLoading = accountsLoading || nwLoading;

  return (
    <div className="p-4 md:p-6 space-y-6 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Page Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Accounts & Balance Sheet</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          A consolidated view of all your checking, savings, investments, policies, and debts.
        </p>
      </div>

      {/* Aggregate Stats Dashboard Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Total Assets */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Total Assets
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary">
                <Landmark className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-28 mt-2" />
            ) : (
              <p className="text-lg md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary">
                {fmt(totalAssetsInr)}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Liquid Cash + Investments + Policies
            </p>
          </CardContent>
        </Card>

        {/* Total Liabilities */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Total Liabilities
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary">
                <Coins className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-28 mt-2" />
            ) : (
              <p className="text-lg md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary">
                {fmt(totalLiabilitiesInr)}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              Credit Cards + Active Loans & Debts
            </p>
          </CardContent>
        </Card>

        {/* Net Position */}
        <Card className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Net Position
              </span>
              <div className="p-1 rounded bg-primary/10 text-primary">
                <Wallet className="w-3.5 h-3.5" />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="h-7 w-28 mt-2" />
            ) : (
              <p className="text-lg md:text-xl font-extrabold tabular-nums tracking-tight mt-1 text-primary">
                {fmt(netPositionInr)}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
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
