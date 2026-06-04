import { useState, useMemo, useEffect } from "react";
import {
  Award,
  Calendar,
  Coins,
  Flame,
  Globe,
  Info,
  Percent,
  Sparkles,
  TrendingUp,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccounts, useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useNetWorth } from "@/modules/dashboard/hooks/useDashboard";
import { useAppStore } from "@/stores/app.store";
import { convertFromINR, formatCurrency } from "@finwise/shared/utils";

interface Destination {
  code: string;
  name: string;
  flag: string;
  singleComfort: number;
  singleLean: number;
  coupleComfort: number;
  coupleLean: number;
  family3Comfort: number;
  family3Lean: number;
  family4Comfort: number;
  family4Lean: number;
  description: string;
}

const DESTINATIONS: Destination[] = [
  {
    code: "custom",
    name: "Custom Scenario",
    flag: "⚙️",
    singleComfort: 0,
    singleLean: 0,
    coupleComfort: 0,
    coupleLean: 0,
    family3Comfort: 0,
    family3Lean: 0,
    family4Comfort: 0,
    family4Lean: 0,
    description: "Adjust expenses manually using the slider below."
  },
  {
    code: "in",
    name: "India",
    flag: "🇮🇳",
    singleComfort: 1100,
    singleLean: 700,
    coupleComfort: 1600,
    coupleLean: 1100,
    family3Comfort: 2000,
    family3Lean: 1350,
    family4Comfort: 2400,
    family4Lean: 1600,
    description: "India offers exceptional tier-1/2 comforts (including Kolkata, Goa, Pune, Bangalore), rich cultural diversity, premium healthcare, and highly affordable organic living."
  },
  {
    code: "th",
    name: "Thailand",
    flag: "🇹🇭",
    singleComfort: 1500,
    singleLean: 1000,
    coupleComfort: 2100,
    coupleLean: 1450,
    family3Comfort: 2700,
    family3Lean: 1800,
    family4Comfort: 3200,
    family4Lean: 2100,
    description: "Thailand features elite expat beach/mountain communities, low-cost premium healthcare, and beautiful tropical climates."
  },
  {
    code: "id",
    name: "Indonesia",
    flag: "🇮🇩",
    singleComfort: 1400,
    singleLean: 900,
    coupleComfort: 2000,
    coupleLean: 1300,
    family3Comfort: 2500,
    family3Lean: 1650,
    family4Comfort: 3000,
    family4Lean: 2000,
    description: "Indonesia (specifically Bali) offers unmatched creative cafe culture, low living expenses, and world-class surfing resorts."
  },
  {
    code: "vn",
    name: "Vietnam",
    flag: "🇻🇳",
    singleComfort: 1200,
    singleLean: 800,
    coupleComfort: 1700,
    coupleLean: 1150,
    family3Comfort: 2150,
    family3Lean: 1450,
    family4Comfort: 2600,
    family4Lean: 1700,
    description: "Vietnam provides some of the lowest costs of living globally, rich local traditions, fast internet, and rich coastal foods."
  },
  {
    code: "my",
    name: "Malaysia",
    flag: "🇲🇾",
    singleComfort: 1600,
    singleLean: 1100,
    coupleComfort: 2200,
    coupleLean: 1550,
    family3Comfort: 2800,
    family3Lean: 1950,
    family4Comfort: 3400,
    family4Lean: 2300,
    description: "Malaysia features modern Western-grade infrastructure, high English fluency, safety, and excellent retirement visa pathways."
  },
  {
    code: "ph",
    name: "Philippines",
    flag: "🇵🇭",
    singleComfort: 1300,
    singleLean: 850,
    coupleComfort: 1800,
    coupleLean: 1200,
    family3Comfort: 2300,
    family3Lean: 1500,
    family4Comfort: 2800,
    family4Lean: 1800,
    description: "Philippines offers beautiful island living, high English fluency, low-cost helpers, and extremely friendly hospitality."
  },
  {
    code: "sg",
    name: "Singapore",
    flag: "🇸🇬",
    singleComfort: 4000,
    singleLean: 2800,
    coupleComfort: 5500,
    coupleLean: 4000,
    family3Comfort: 7000,
    family3Lean: 5000,
    family4Comfort: 8500,
    family4Lean: 6000,
    description: "Singapore represents top-tier global safety, high-tech efficiency, and elite comforts but resides in the highest cost tier."
  },
];

export default function FirePage() {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const { data: rates = {} } = useExchangeRates();
  const { data: nwData, isLoading: nwLoading } = useNetWorth();
  const { isLoading: accountsLoading } = useAccounts();

  // ─── Live Data Integration ──────────────────────────────────────────────────
  const liveNetWorthBase = useMemo(() => {
    if (!nwData) return 0;
    const inrVal = nwData.total_inr ?? 0;
    return convertFromINR(inrVal, defaultCurrency as any, rates);
  }, [nwData, defaultCurrency, rates]);

  // Sliders States
  const [currentAge, setCurrentAge] = useState<number>(30);
  const [targetRetireAge, setTargetRetireAge] = useState<number>(55);
  const [lifeExpectancy] = useState<number>(85);
  
  // Custom states that default to calculations based on the user's base currency
  const [startingBalance, setStartingBalance] = useState<number>(100000);
  const [monthlySavings, setMonthlySavings] = useState<number>(2000);
  const [retirementExpenses, setRetirementExpenses] = useState<number>(3000);
  
  // Percentage return sliders
  const [preReturn, setPrePreReturn] = useState<number>(8.0);
  const [postReturn, setPostReturn] = useState<number>(5.5);
  const [inflation, setInflation] = useState<number>(3.0);
  const [swr, setSwr] = useState<number>(4.0);

  // Geoarbitrage Country & Mode Selection
  const [selectedDestCode, setSelectedDestCode] = useState<string>("custom");
  const [comfortMode, setComfortMode] = useState<"comfort" | "lean">("comfort");
  const [householdSize, setHouseholdSize] = useState<"single" | "couple" | "family">("single");
  const [numKids, setNumKids] = useState<number>(1);
  const [childAges, setChildAges] = useState<number[]>([3]);
  const [activeViewTab, setActiveViewTab] = useState<"simulator" | "guide">("simulator");

  // Sync starting balance with dynamic Net Worth when loaded
  useEffect(() => {
    if (liveNetWorthBase > 0) {
      setStartingBalance(Math.round(liveNetWorthBase));
      const multiplier = defaultCurrency === "INR" ? 83 : 1;
      setMonthlySavings(Math.round(2000 * multiplier));
      setRetirementExpenses(Math.round(3000 * multiplier));
    } else {
      const multiplier = defaultCurrency === "INR" ? 83 : 1;
      setStartingBalance(Math.round(100000 * multiplier));
      setMonthlySavings(Math.round(1500 * multiplier));
      setRetirementExpenses(Math.round(2500 * multiplier));
    }
  }, [liveNetWorthBase, defaultCurrency]);

  // Adjust Target Retirement Age if Current Age increases
  useEffect(() => {
    if (currentAge >= targetRetireAge) {
      setTargetRetireAge(Math.min(currentAge + 1, lifeExpectancy - 1));
    }
  }, [currentAge]);

  // ─── Dynamic Cost Conversion for Selected Country ──────────────────────────
  useEffect(() => {
    if (selectedDestCode !== "custom") {
      const dest = DESTINATIONS.find((d) => d.code === selectedDestCode);
      if (dest) {
        let costUsd = 0;
        if (householdSize === "family" || numKids > 0) {
          // Family cost basis
          const f3 = comfortMode === "comfort" ? dest.family3Comfort : dest.family3Lean;
          const f4 = comfortMode === "comfort" ? dest.family4Comfort : dest.family4Lean;
          if (numKids <= 1) {
            costUsd = f3;
          } else if (numKids === 2) {
            costUsd = f4;
          } else {
            const childPremium = f4 - f3;
            costUsd = f4 + (numKids - 2) * childPremium;
          }
        } else if (householdSize === "couple") {
          costUsd = comfortMode === "comfort" ? dest.coupleComfort : dest.coupleLean;
        } else {
          costUsd = comfortMode === "comfort" ? dest.singleComfort : dest.singleLean;
        }
        // Rates stored in app store are relative to base currency (e.g. if base is INR, rates["USD"] is ~83.5)
        const usdRate = rates["USD"] ?? (defaultCurrency === "INR" ? 83.5 : 1.0);
        setRetirementExpenses(Math.round(costUsd * usdRate));
      }
    }
  }, [selectedDestCode, comfortMode, householdSize, numKids, rates, defaultCurrency]);

  // ─── Mathematical FIRE Calculations ────────────────────────────────────────
  const coupleExpenses = useMemo(() => {
    if (selectedDestCode === "custom") return retirementExpenses; // no step-down for custom
    const dest = DESTINATIONS.find((d) => d.code === selectedDestCode);
    if (!dest) return retirementExpenses;
    const costUsd = comfortMode === "comfort" ? dest.coupleComfort : dest.coupleLean;
    const usdRate = rates["USD"] ?? (defaultCurrency === "INR" ? 83.5 : 1.0);
    return Math.round(costUsd * usdRate);
  }, [selectedDestCode, comfortMode, rates, defaultCurrency, retirementExpenses]);

  const annualExpenses = useMemo(() => retirementExpenses * 12, [retirementExpenses]);
  const fireNumber = useMemo(() => {
    const rate = swr / 100;
    return rate > 0 ? annualExpenses / rate : 0;
  }, [annualExpenses, swr]);

  const leanFireNumber = useMemo(() => fireNumber * 0.75, [fireNumber]);
  const fatFireNumber = useMemo(() => fireNumber * 1.50, [fireNumber]);

  // Coast FIRE: starting amount today that grows to FIRE target at retire age without savings
  const coastFireNumber = useMemo(() => {
    const realPreReturn = (preReturn - inflation) / 100;
    const yearsToRetire = targetRetireAge - currentAge;
    if (yearsToRetire <= 0) return fireNumber;
    return fireNumber / Math.pow(1 + realPreReturn, yearsToRetire);
  }, [fireNumber, preReturn, inflation, targetRetireAge, currentAge]);

  // ─── Yearly Simulation Engine ──────────────────────────────────────────────
  const { chartData, fireAchievedAge, runsOutAge, isSustainable } = useMemo(() => {
    const data = [];
    let portfolio = startingBalance;
    const annualSavings = monthlySavings * 12;
    let achievedAge: number | null = null;
    let runOut: number | null = null;

    for (let age = currentAge; age <= lifeExpectancy; age++) {
      const yearIndex = age - currentAge;

      // Count active dependent kids (who will be < 21 at this year index)
      const activeKidsCount = (householdSize === "family" || numKids > 0) && selectedDestCode !== "custom"
        ? childAges.filter((initialAge) => (initialAge + yearIndex) < 21).length
        : 0;

      // Calculate active monthly expenses for this specific year index
      let activeMonthlyExpenses = retirementExpenses;
      if ((householdSize === "family" || numKids > 0) && selectedDestCode !== "custom") {
        const childPremium = numKids > 0 ? (retirementExpenses - coupleExpenses) / numKids : 0;
        activeMonthlyExpenses = coupleExpenses + activeKidsCount * childPremium;
      }

      const activeAnnualExpenses = activeMonthlyExpenses * 12;
      const baseTarget = activeAnnualExpenses / (swr / 100);
      
      // Target FIRE Number adjusts upwards with inflation
      const inflatedFireTarget = baseTarget * Math.pow(1 + inflation / 100, yearIndex);

      // Save yearly stats
      data.push({
        age,
        portfolio: Math.round(portfolio),
        fireTarget: Math.round(inflatedFireTarget),
        isRetired: age >= targetRetireAge,
      });

      // Calculate intersection age (where portfolio exceeds target FIRE number)
      if (achievedAge === null && portfolio >= inflatedFireTarget) {
        achievedAge = age;
      }

      // Check run out condition
      if (runOut === null && portfolio <= 0 && age > targetRetireAge) {
        runOut = age;
      }

      // Compound for next year
      if (age < targetRetireAge) {
        // Pre-Retirement Accumulation: preReturn compounding + savings
        portfolio = portfolio * (1 + preReturn / 100) + annualSavings;
      } else {
        // Post-Retirement Decumulation: postReturn compounding - inflated expenses
        const nominalExpenses = activeAnnualExpenses * Math.pow(1 + inflation / 100, yearIndex);
        portfolio = portfolio * (1 + postReturn / 100) - nominalExpenses;
      }

      if (portfolio < 0) {
        portfolio = 0; // prevent graphing negative infinity
      }
    }

    return {
      chartData: data,
      fireAchievedAge: achievedAge,
      runsOutAge: runOut,
      isSustainable: runOut === null && data[data.length - 1].portfolio > 0,
    };
  }, [
    currentAge,
    lifeExpectancy,
    targetRetireAge,
    startingBalance,
    monthlySavings,
    preReturn,
    postReturn,
    inflation,
    swr,
    retirementExpenses,
    coupleExpenses,
    householdSize,
    selectedDestCode,
    numKids,
    childAges,
  ]);

  // ─── Geoarbitrage Timeline Savings Analysis ──────────────────────────────────
  // Compare selected country vs. high-tier Custom baseline to calculate exact years saved
  const geoarbitrageSavings = useMemo(() => {
    if (selectedDestCode === "custom") return null;
    const dest = DESTINATIONS.find((d) => d.code === selectedDestCode);
    if (!dest) return null;

    // Standard high-tier domestic baseline expenses
    const usdRate = rates["USD"] ?? (defaultCurrency === "INR" ? 83.5 : 1.0);
    const domesticCoupleExpenses = Math.round(5000 * usdRate);

    let domesticStartExpenses = Math.round(3500 * usdRate);
    if (householdSize === "couple") {
      domesticStartExpenses = domesticCoupleExpenses;
    } else if (householdSize === "family" || numKids > 0) {
      const f3 = Math.round(6200 * usdRate);
      const f4 = Math.round(7500 * usdRate);
      if (numKids <= 1) {
        domesticStartExpenses = f3;
      } else if (numKids === 2) {
        domesticStartExpenses = f4;
      } else {
        const domesticChildPremium = f4 - f3;
        domesticStartExpenses = f4 + (numKids - 2) * domesticChildPremium;
      }
    }

    const domesticStartingFireTarget = (domesticStartExpenses * 12) / (swr / 100);

    // Run parallel simulation for domestic baseline
    let domesticPortfolio = startingBalance;
    const annualSavings = monthlySavings * 12;
    let domesticAchievedAge: number | null = null;

    for (let age = currentAge; age <= lifeExpectancy; age++) {
      const yearIndex = age - currentAge;

      const activeKidsCount = (householdSize === "family" || numKids > 0)
        ? childAges.filter((initialAge) => (initialAge + yearIndex) < 21).length
        : 0;

      let activeDomesticExpenses = domesticStartExpenses;
      if (householdSize === "family" || numKids > 0) {
        const domesticChildPremium = numKids > 0 ? (domesticStartExpenses - domesticCoupleExpenses) / numKids : 0;
        activeDomesticExpenses = domesticCoupleExpenses + activeKidsCount * domesticChildPremium;
      }

      const activeAnnualExpenses = activeDomesticExpenses * 12;
      const baseTarget = activeAnnualExpenses / (swr / 100);
      const inflatedTarget = baseTarget * Math.pow(1 + inflation / 100, yearIndex);

      if (domesticAchievedAge === null && domesticPortfolio >= inflatedTarget) {
        domesticAchievedAge = age;
        break;
      }

      if (age < targetRetireAge) {
        domesticPortfolio = domesticPortfolio * (1 + preReturn / 100) + annualSavings;
      } else {
        break;
      }
    }

    const ageDifference = domesticAchievedAge !== null && fireAchievedAge !== null
      ? Math.max(0, domesticAchievedAge - fireAchievedAge)
      : null;

    return {
      domesticExpenses: domesticStartExpenses,
      domesticFireTarget: domesticStartingFireTarget,
      savingsCap: Math.max(0, domesticStartingFireTarget - fireNumber),
      yearsSaved: ageDifference,
    };
  }, [selectedDestCode, rates, defaultCurrency, fireNumber, fireAchievedAge, startingBalance, monthlySavings, preReturn, swr, targetRetireAge, currentAge, lifeExpectancy, inflation, householdSize, numKids, childAges]);

  // ─── Comparative Geoarbitrage Simulation across All Countries ──────────────────
  const destinationComparisons = useMemo(() => {
    const usdRate = rates["USD"] ?? (defaultCurrency === "INR" ? 83.5 : 1.0);
    const domesticCoupleExpenses = Math.round(5000 * usdRate);

    let domesticStartExpenses = Math.round(3500 * usdRate);
    if (householdSize === "couple") {
      domesticStartExpenses = domesticCoupleExpenses;
    } else if (householdSize === "family") {
      const f3 = Math.round(6200 * usdRate);
      const f4 = Math.round(7500 * usdRate);
      if (numKids === 1) {
        domesticStartExpenses = f3;
      } else if (numKids === 2) {
        domesticStartExpenses = f4;
      } else {
        const domesticChildPremium = f4 - f3;
        domesticStartExpenses = f4 + (numKids - 2) * domesticChildPremium;
      }
    }

    // Standard baseline domestic projection
    let domesticPortfolio = startingBalance;
    const annualSavings = monthlySavings * 12;
    let domesticAchievedAge: number | null = null;

    for (let age = currentAge; age <= lifeExpectancy; age++) {
      const yearIndex = age - currentAge;

      const activeKidsCount = (householdSize === "family" || numKids > 0)
        ? childAges.filter((initialAge) => (initialAge + yearIndex) < 21).length
        : 0;

      let activeDomesticExpenses = domesticStartExpenses;
      if (householdSize === "family" || numKids > 0) {
        const domesticChildPremium = numKids > 0 ? (domesticStartExpenses - domesticCoupleExpenses) / numKids : 0;
        activeDomesticExpenses = domesticCoupleExpenses + activeKidsCount * domesticChildPremium;
      }

      const activeAnnualExpenses = activeDomesticExpenses * 12;
      const baseTarget = activeAnnualExpenses / (swr / 100);
      const inflatedTarget = baseTarget * Math.pow(1 + inflation / 100, yearIndex);

      if (domesticAchievedAge === null && domesticPortfolio >= inflatedTarget) {
        domesticAchievedAge = age;
        break;
      }

      if (age < targetRetireAge) {
        domesticPortfolio = domesticPortfolio * (1 + preReturn / 100) + annualSavings;
      } else {
        break;
      }
    }

    return DESTINATIONS.filter((d) => d.code !== "custom").map((dest) => {
      // Calculate costs for Single, Couple
      const singleComfort = Math.round(dest.singleComfort * usdRate);
      const singleLean = Math.round(dest.singleLean * usdRate);
      const coupleComfort = Math.round(dest.coupleComfort * usdRate);
      const coupleLean = Math.round(dest.coupleLean * usdRate);

      const f3Comfort = Math.round(dest.family3Comfort * usdRate);
      const f3Lean = Math.round(dest.family3Lean * usdRate);
      const f4Comfort = Math.round(dest.family4Comfort * usdRate);
      const f4Lean = Math.round(dest.family4Lean * usdRate);

      // Starting and step-down costs for the specific destination
      let comfortCost = singleComfort;
      let leanCost = singleLean;
      let stepDownCost = singleComfort;

      if (householdSize === "couple") {
        comfortCost = coupleComfort;
        leanCost = coupleLean;
        stepDownCost = coupleComfort;
      } else if (householdSize === "family" || numKids > 0) {
        stepDownCost = comfortMode === "comfort" ? coupleComfort : coupleLean;
        if (numKids <= 1) {
          comfortCost = f3Comfort;
          leanCost = f3Lean;
        } else if (numKids === 2) {
          comfortCost = f4Comfort;
          leanCost = f4Lean;
        } else {
          const comfortChildPremium = f4Comfort - f3Comfort;
          const leanChildPremium = f4Lean - f3Lean;
          comfortCost = f4Comfort + (numKids - 2) * comfortChildPremium;
          leanCost = f4Lean + (numKids - 2) * leanChildPremium;
        }
      }

      const activeCost = comfortMode === "comfort" ? comfortCost : leanCost;
      const coupleActiveCost = stepDownCost;

      // Simulate timeline for this specific country
      let portfolio = startingBalance;
      let achievedAge: number | null = null;

      for (let age = currentAge; age <= lifeExpectancy; age++) {
        const yearIndex = age - currentAge;

        const activeKidsCount = (householdSize === "family" || numKids > 0)
          ? childAges.filter((initialAge) => (initialAge + yearIndex) < 21).length
          : 0;

        let activeMonthlyExpenses = activeCost;
        if (householdSize === "family" || numKids > 0) {
          const childPremium = numKids > 0 ? (activeCost - coupleActiveCost) / numKids : 0;
          activeMonthlyExpenses = coupleActiveCost + activeKidsCount * childPremium;
        }

        const activeAnnualExpenses = activeMonthlyExpenses * 12;
        const baseTarget = activeAnnualExpenses / (swr / 100);
        const inflatedTarget = baseTarget * Math.pow(1 + inflation / 100, yearIndex);

        if (achievedAge === null && portfolio >= inflatedTarget) {
          achievedAge = age;
          break;
        }

        if (age < targetRetireAge) {
          portfolio = portfolio * (1 + preReturn / 100) + annualSavings;
        } else {
          break;
        }
      }

      const yearsSaved = domesticAchievedAge !== null && achievedAge !== null
        ? Math.max(0, domesticAchievedAge - achievedAge)
        : null;

      return {
        ...dest,
        comfortCost,
        leanCost,
        activeCost,
        targetNestEgg: (activeCost * 12) / (swr / 100),
        achievedAge,
        yearsSaved,
      };
    });
  }, [
    rates,
    defaultCurrency,
    startingBalance,
    monthlySavings,
    currentAge,
    lifeExpectancy,
    targetRetireAge,
    preReturn,
    inflation,
    swr,
    comfortMode,
    householdSize,
    numKids,
    childAges,
  ]);

  const activeDest = useMemo(() => DESTINATIONS.find((d) => d.code === selectedDestCode), [selectedDestCode]);
  const fmt = (val: number) => formatCurrency(val, defaultCurrency as any);
  const isLoading = nwLoading || accountsLoading;

  return (
    <div className="p-4 md:p-6 space-y-6 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Flame className="w-6 h-6 text-caution fill-caution/20 animate-pulse" />
            Financial Independence Planner (FIRE)
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Model pre/post retirement scenarios, analyze Coast/Lean/Fat milestones, and optimize expat Geoarbitrage.
          </p>
        </div>
        {liveNetWorthBase > 0 && (
          <div className="flex items-center gap-2 bg-info/10 border border-info/20 rounded-lg px-3 py-1.5 text-xs text-info font-semibold max-w-fit">
            <Sparkles className="w-3.5 h-3.5" />
            Connected to live Net Worth: {fmt(liveNetWorthBase)}
          </div>
        )}
      </div>

      {/* View Tabs Switcher */}
      <div className="flex items-center gap-2 border-b border-border/20 pb-1">
        <button
          onClick={() => setActiveViewTab("simulator")}
          className={`pb-2 px-4 text-xs font-bold transition-all relative ${
            activeViewTab === "simulator"
              ? "text-primary border-b-2 border-primary font-extrabold"
              : "text-muted-foreground hover:text-foreground font-semibold"
          }`}
        >
          📊 Projection Simulator
        </button>
        <button
          onClick={() => setActiveViewTab("guide")}
          className={`pb-2 px-4 text-xs font-bold transition-all relative ${
            activeViewTab === "guide"
              ? "text-primary border-b-2 border-primary font-extrabold"
              : "text-muted-foreground hover:text-foreground font-semibold"
          }`}
        >
          📖 Guide & Investment Strategy
        </button>
      </div>

      {activeViewTab === "simulator" ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Sliders Panel (Left 5 Cols) */}
        <div className="lg:col-span-5 space-y-4">
          {/* Geoarbitrage Destination Selector */}
          <Card className="border-border/60 bg-card/40 backdrop-blur-md">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Globe className="w-4 h-4 text-info" />
                Expat Destination (Geoarbitrage)
              </CardTitle>
              <CardDescription className="text-xs">
                Retire in highly popular expat countries to leverage local purchasing power.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">Select Country</label>
                <select
                  value={selectedDestCode}
                  onChange={(e) => setSelectedDestCode(e.target.value)}
                  className="w-full bg-muted border border-border/40 rounded px-2.5 py-1.5 text-xs font-semibold"
                >
                  {DESTINATIONS.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.flag} {d.name}
                    </option>
                  ))}
                </select>
              </div>

              {true && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">Household Size</label>
                    <select
                      value={householdSize}
                      onChange={(e) => setHouseholdSize(e.target.value as any)}
                      className="w-full bg-muted border border-border/40 rounded px-2.5 py-1.5 text-xs font-semibold"
                    >
                      <option value="single">👤 Single / Individual</option>
                      <option value="couple">👥 Couple (2 Adults)</option>
                      <option value="family">👪 Family (2 Adults + Kids)</option>
                    </select>
                  </div>

                  {true && (
                    <div className="space-y-3.5 p-3 rounded-lg bg-info/5 border border-info/10">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                          <span>Number of Children</span>
                        </label>
                        <select
                          value={numKids}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setNumKids(val);
                            setChildAges((prev) => {
                              const next = [...prev];
                              if (val > next.length) {
                                while (next.length < val) next.push(3);
                              } else if (val < next.length) {
                                next.length = val;
                              }
                              return next;
                            });
                          }}
                          className="w-full bg-muted border border-border/40 rounded px-2.5 py-1.5 text-xs font-semibold"
                        >
                          <option value={1}>1 Child</option>
                          <option value={2}>2 Children</option>
                          <option value={3}>3 Children</option>
                          <option value={4}>4 Children</option>
                        </select>
                      </div>

                      <div className="space-y-3 pt-1">
                        {childAges.map((age, idx) => (
                          <div key={idx} className="space-y-1.5">
                            <div className="flex justify-between text-xs font-semibold">
                              <span className="flex items-center gap-1">
                                {idx === 0 ? "👶" : idx === 1 ? "👦" : idx === 2 ? "👧" : "🧒"} Child {idx + 1} Current Age
                              </span>
                              <span className="text-info font-bold">{age} yrs</span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="20"
                              value={age}
                              onChange={(e) => {
                                const newAge = parseInt(e.target.value);
                                setChildAges((prev) => {
                                  const next = [...prev];
                                  next[idx] = newAge;
                                  return next;
                                });
                              }}
                              className="w-full h-1.5 accent-primary bg-muted rounded-lg appearance-none cursor-pointer"
                            />
                            <p className="text-xs font-semibold text-muted-foreground/80 leading-none">
                              {age >= 21 ? (
                                <span className="text-info">Independent</span>
                              ) : (
                                <span>Independent at Age 21 (in {21 - age} years)</span>
                              )}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">Lifestyle Tier</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setComfortMode("comfort")}
                        className={`px-2 py-1 text-xs font-semibold rounded border transition-colors ${comfortMode === "comfort" ? "bg-primary/10 border-primary text-primary" : "bg-muted border-border hover:bg-muted/60"}`}
                      >
                        Comfort Expat
                      </button>
                      <button
                        onClick={() => setComfortMode("lean")}
                        className={`px-2 py-1 text-xs font-semibold rounded border transition-colors ${comfortMode === "lean" ? "bg-primary/10 border-primary text-primary" : "bg-muted border-border hover:bg-muted/60"}`}
                      >
                        Lean Expat
                      </button>
                    </div>
                  </div>

                </>
              )}
            </CardContent>
          </Card>

          {/* Scenario Controls Sliders */}
          <Card className="border-border/60 bg-card/40 backdrop-blur-md">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info className="w-4 h-4 text-info" />
                Scenario Controls
              </CardTitle>
              <CardDescription className="text-xs">
                Adjust timeline and return sliders to customize compounding indexes.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-5">
              {/* Age Parameters */}
              <div className="space-y-4 border-b border-border/40 pb-4">
                <p className="text-xs font-bold uppercase tracking-wider text-info">Timeline Params</p>
                
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Current Age</span>
                    <span className="text-info">{currentAge} yrs</span>
                  </div>
                  <input
                    type="range"
                    min="18"
                    max="75"
                    value={currentAge}
                    onChange={(e) => setCurrentAge(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Retirement Target Age</span>
                    <span className="text-info">{targetRetireAge} yrs</span>
                  </div>
                  <input
                    type="range"
                    min={currentAge + 1}
                    max={lifeExpectancy - 1}
                    value={targetRetireAge}
                    onChange={(e) => setTargetRetireAge(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>
              </div>

              {/* Capital Parameters */}
              <div className="space-y-4 border-b border-border/40 pb-4">
                <p className="text-xs font-bold uppercase tracking-wider text-positive">Wealth Params</p>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Starting Wealth</span>
                    <span className="text-positive">{fmt(startingBalance)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={defaultCurrency === "INR" ? "5000000" : "500000"}
                    step={defaultCurrency === "INR" ? "50000" : "5000"}
                    value={startingBalance}
                    onChange={(e) => setStartingBalance(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Monthly Savings</span>
                    <span className="text-positive">{fmt(monthlySavings)} / mo</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={defaultCurrency === "INR" ? "200000" : "15000"}
                    step={defaultCurrency === "INR" ? "2000" : "100"}
                    value={monthlySavings}
                    onChange={(e) => setMonthlySavings(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Retirement Expenses</span>
                    <span className="text-positive">{fmt(retirementExpenses)} / mo</span>
                  </div>
                  <input
                    type="range"
                    min={defaultCurrency === "INR" ? "10000" : "500"}
                    max={defaultCurrency === "INR" ? "300000" : "20000"}
                    step={defaultCurrency === "INR" ? "2000" : "100"}
                    value={retirementExpenses}
                    onChange={(e) => setRetirementExpenses(parseInt(e.target.value))}
                    disabled={selectedDestCode !== "custom"}
                    className={`w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary ${selectedDestCode !== "custom" ? "opacity-50 cursor-not-allowed" : ""}`}
                  />
                </div>
              </div>

              {/* Compounding rates */}
              <div className="space-y-4">
                <p className="text-xs font-bold uppercase tracking-wider text-caution">Market Return Rates</p>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground font-semibold flex items-center gap-1">
                      <Percent className="w-3 h-3" /> Pre-Retire Return
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      max="20"
                      value={preReturn}
                      onChange={(e) => setPrePreReturn(parseFloat(e.target.value) || 0)}
                      className="w-full bg-muted border border-border/40 rounded px-2.5 py-1 text-xs font-semibold tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground font-semibold flex items-center gap-1">
                      <Percent className="w-3 h-3" /> Post-Retire Return
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      max="20"
                      value={postReturn}
                      onChange={(e) => setPostReturn(parseFloat(e.target.value) || 0)}
                      className="w-full bg-muted border border-border/40 rounded px-2.5 py-1 text-xs font-semibold tabular-nums"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground font-semibold flex items-center gap-1">
                      <Percent className="w-3 h-3" /> Inflation Rate
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="15"
                      value={inflation}
                      onChange={(e) => setInflation(parseFloat(e.target.value) || 0)}
                      className="w-full bg-muted border border-border/40 rounded px-2.5 py-1 text-xs font-semibold tabular-nums"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground font-semibold flex items-center gap-1">
                      <Percent className="w-3 h-3" /> Safe Withdraw Rate
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      max="10"
                      value={swr}
                      onChange={(e) => setSwr(parseFloat(e.target.value) || 0)}
                      className="w-full bg-muted border border-border/40 rounded px-2.5 py-1 text-xs font-semibold tabular-nums"
                    />
                  </div>
                </div>
              </div>

            </CardContent>
          </Card>
        </div>

        {/* Dynamic Charts & Milestones (Right 7 Cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Main Visual Compounding Chart */}
          <Card className="border-0 bg-card/40 backdrop-blur-md shadow-sm">
            <CardHeader className="py-4 px-5 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-positive" />
                  Portfolio Wealth Projections
                </CardTitle>
                <CardDescription className="text-xs">
                  Visualizing nominal portfolio growth curve (filled) vs. inflation-adjusted target FIRE thresholds (dashed).
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-5">
              {isLoading ? (
                <Skeleton className="h-60 w-full" />
              ) : (
                <div className="relative">
                  {(() => {
                    const CustomTooltip = ({ active, payload, label }: any) => {
                      if (active && payload && payload.length) {
                        const portfolioVal = payload.find((p: any) => p.name === "portfolio")?.value;
                        const targetVal = payload.find((p: any) => p.name === "fireTarget")?.value;
                        
                        return (
                          <div className="backdrop-blur-md bg-background/80 border border-border/50 shadow-xl rounded-xl p-3 text-xs flex flex-col gap-1.5 min-w-[160px] animate-in fade-in-50 duration-200">
                            <p className="font-semibold text-muted-foreground">Age {label}</p>
                            <div className="space-y-1 mt-1">
                              {portfolioVal !== undefined && (
                                <div className="flex items-center justify-between gap-4">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-2 h-2 rounded-full bg-[#6c7a9c] shadow-[0_0_6px_rgba(108,122,156,0.4)]" />
                                    <span className="text-muted-foreground text-xs">Portfolio</span>
                                  </div>
                                  <span className="font-bold tabular-nums text-foreground">
                                    {fmt(Number(portfolioVal))}
                                  </span>
                                </div>
                              )}
                              {targetVal !== undefined && (
                                <div className="flex items-center justify-between gap-4">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-2 h-2 rounded-full bg-caution shadow-[0_0_6px_rgba(184,160,124,0.4)]" />
                                    <span className="text-muted-foreground text-xs">FIRE Target</span>
                                  </div>
                                  <span className="font-bold tabular-nums text-caution">
                                    {fmt(Number(targetVal))}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    };

                    return (
                      <ResponsiveContainer width="100%" height={260}>
                        <AreaChart
                          data={chartData}
                          margin={{ top: 12, right: 12, left: 10, bottom: 0 }}
                        >
                          <defs>
                            <linearGradient id="fireGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#8da99a" stopOpacity={0.25} />
                              <stop offset="50%" stopColor="#7aa892" stopOpacity={0.10} />
                              <stop offset="100%" stopColor="#7aa892" stopOpacity={0.0} />
                            </linearGradient>
                            <linearGradient id="fireStrokeGrad" x1="0" y1="0" x2="1" y2="0">
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
                            dataKey="age"
                            tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                            tickLine={false}
                            axisLine={false}
                            dy={6}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: "currentColor", opacity: 0.6 }}
                            tickLine={false}
                            axisLine={false}
                            tickFormatter={(v) => {
                              if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                              if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
                              return v;
                            }}
                            width={45}
                          />
                          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "currentColor", strokeOpacity: 0.08, strokeWidth: 1.5 }} />
                          <Area
                            type="natural"
                            dataKey="portfolio"
                            stroke="url(#fireStrokeGrad)"
                            strokeWidth={2.5}
                            fill="url(#fireGrad)"
                            name="portfolio"
                            activeDot={{
                              r: 5,
                              stroke: "#8da99a",
                              strokeWidth: 2,
                              fill: "#ffffff",
                            }}
                          />
                          <Area
                            type="natural"
                            dataKey="fireTarget"
                            stroke="#6c7a9c"
                            strokeWidth={1.5}
                            strokeDasharray="4 4"
                            fill="none"
                            name="fireTarget"
                            dot={false}
                            activeDot={false}
                          />
                          {fireAchievedAge && (
                            <ReferenceLine
                              x={fireAchievedAge}
                              stroke="#8da99a"
                              strokeWidth={1.5}
                              strokeDasharray="3 3"
                              label={{
                                value: `FIRE Age: ${fireAchievedAge}`,
                                fill: "#5e7a6d",
                                fontSize: 10,
                                position: "top",
                                fontWeight: "bold",
                              }}
                            />
                          )}
                          <ReferenceLine
                            x={targetRetireAge}
                            stroke="#6c7a9c"
                            strokeWidth={1.5}
                            label={{
                              value: `Retired: ${targetRetireAge}`,
                              fill: "#4b5b75",
                              fontSize: 10,
                              position: "insideTopLeft",
                              fontWeight: "bold",
                            }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>

          {/* FIRE Milestones Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* 1. Standard FIRE */}
            <Card className="bg-gradient-to-br from-primary/5 via-transparent to-transparent">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Flame className="w-3 h-3 text-primary fill-primary/25" /> FIRE Number
                  </span>
                </div>
                <p className="text-lg font-extrabold tracking-tight mt-1">
                  {fmt(fireNumber)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  100% of target budget cap
                </p>
              </CardContent>
            </Card>

            {/* 2. Coast FIRE */}
            <Card className="bg-gradient-to-br from-primary/5 via-transparent to-transparent">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Coins className="w-3 h-3 text-primary" /> Coast FIRE
                  </span>
                </div>
                <p className="text-lg font-extrabold tracking-tight mt-1 text-primary">
                  {fmt(coastFireNumber)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Invested today, no more savings
                </p>
              </CardContent>
            </Card>

            {/* 3. Lean FIRE */}
            <Card className="bg-gradient-to-br from-primary/5 via-transparent to-transparent">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Wallet className="w-3 h-3 text-primary" /> Lean FIRE
                  </span>
                </div>
                <p className="text-lg font-extrabold tracking-tight mt-1 text-primary">
                  {fmt(leanFireNumber)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Frugal target at 75% expenses
                </p>
              </CardContent>
            </Card>

            {/* 4. Fat FIRE */}
            <Card className="bg-gradient-to-br from-primary/5 via-transparent to-transparent">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Award className="w-3 h-3 text-primary" /> Fat FIRE
                  </span>
                </div>
                <p className="text-lg font-extrabold tracking-tight mt-1 text-primary">
                  {fmt(fatFireNumber)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Affluent target at 150% expenses
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Scenario Analysis Insights Panel */}
          <Card className="bg-gradient-to-br from-primary/5 via-transparent to-transparent">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 font-bold text-xs text-primary">
                <Sparkles className="w-4 h-4" />
                Wealth Sustainability Insights
              </div>

              <div className="text-xs space-y-2 leading-relaxed text-muted-foreground">
                {fireAchievedAge ? (
                  <p>
                    🎉 Excellent! Under your current projection, you will cross your Financial Independence threshold at **Age {fireAchievedAge}** (accumulating an portfolio of **{fmt(chartData[fireAchievedAge - currentAge].portfolio)}**). 
                  </p>
                ) : (
                  <p>
                    ⚠️ Under your current timeline, you will not fully cross your target FIRE threshold before retirement. Consider increasing monthly savings or raising your target retirement age.
                  </p>
                )}

                {/* Geoarbitrage Advantage Highlight */}
                {geoarbitrageSavings && activeDest && (
                  <div className="bg-primary/10 rounded-lg p-3 border border-primary/20 text-primary font-semibold space-y-1 mt-2 mb-2">
                    <p className="flex items-center gap-1.5 text-xs text-primary/80">
                      <Globe className="w-4 h-4 text-primary" />
                      Geoarbitrage Advantage (Retire in {activeDest.name})
                    </p>
                    <p className="text-sm leading-relaxed text-muted-foreground font-medium">
                      By retiring in **{activeDest.name}** instead of a premium domestic benchmark ({fmt(geoarbitrageSavings.domesticExpenses)}/mo), you reduce your target nest egg requirement by **{fmt(geoarbitrageSavings.savingsCap)}**! 
                      {geoarbitrageSavings.yearsSaved !== null && geoarbitrageSavings.yearsSaved > 0 && (
                        <span> This allows you to retire **{geoarbitrageSavings.yearsSaved} years earlier**!</span>
                      )}
                    </p>
                  </div>
                )}

                {isSustainable ? (
                  <p className="text-primary font-semibold flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4" />
                    Sustainable Plan: Your wealth continues to compound and fully support retirement through Age {lifeExpectancy} (ending with {fmt(chartData[chartData.length - 1].portfolio)}).
                  </p>
                ) : runsOutAge ? (
                  <p className="text-primary font-semibold flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4" />
                    Caution: Your wealth will run out at **Age {runsOutAge}**. You may need to scale down retirement expenses or increase post-retirement investments.
                  </p>
                ) : (
                  <p className="text-primary font-semibold flex items-center gap-1.5">
                    <Calendar className="w-4 h-4" />
                    Caution: Under these return parameters, your portfolio compounding is not quite self-sustaining. Try adjusting pre/post return values or inflation.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Expat Geoarbitrage Comparison Panel */}
          <Card className="border-border/60 bg-card/40 backdrop-blur-md shadow-sm">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Globe className="w-4 h-4 text-info" />
                Expat Geoarbitrage Comparison at a Glance
              </CardTitle>
              <CardDescription className="text-xs">
                Compare the early retirement timelines achieved under each country's cost of living. Click a country to load its detailed scenario.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 flex flex-col items-center">
              {(() => {
                const CustomComparisonTooltip = ({ active, payload }: any) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    return (
                      <div className="backdrop-blur-md bg-background/95 border border-border/60 shadow-xl rounded-xl p-3.5 space-y-2 text-xs">
                        <p className="font-bold flex items-center gap-1.5 text-foreground">
                          <span className="text-base">{data.flag}</span> {data.name}
                        </p>
                        <div className="space-y-1 text-muted-foreground">
                          <div className="flex justify-between gap-6">
                            <span>Retire Age:</span>
                            <span className="font-bold text-foreground">
                              {data.achievedAge ? `Age ${data.achievedAge}` : "Compounding (Not Achieved)"}
                            </span>
                          </div>
                          <div className="flex justify-between gap-6">
                            <span>Monthly Budget:</span>
                            <span className="font-semibold text-foreground">
                              {fmt(data.activeCost)}/mo
                            </span>
                          </div>
                          <div className="flex justify-between gap-6">
                            <span>Target Nest Egg:</span>
                            <span className="font-semibold text-foreground">
                              {fmt(data.targetNestEgg)}
                            </span>
                          </div>
                          {data.yearsSaved !== null && data.yearsSaved > 0 && (
                            <div className="flex justify-between gap-6 text-positive border-t border-border/40 pt-1 mt-1 font-semibold">
                              <span>Years Saved:</span>
                              <span>+{data.yearsSaved} Years earlier</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return null;
                };

                return (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={destinationComparisons}
                      layout="vertical"
                      margin={{ top: 10, right: 20, left: 30, bottom: 10 }}
                      onClick={(data: any) => {
                        if (data && data.activePayload && data.activePayload.length) {
                          const clicked = data.activePayload[0].payload;
                          setSelectedDestCode(clicked.code);
                        }
                      }}
                    >
                      <XAxis
                        type="number"
                        domain={[18, 'auto']}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: 'currentColor', fontSize: 10, opacity: 0.6 }}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tickLine={false}
                        axisLine={false}
                        tick={(props) => {
                          const { x, y, payload } = props;
                          const dest = destinationComparisons.find((d) => d.name === payload.value);
                          const isSelected = selectedDestCode === dest?.code;
                          return (
                            <g
                              onClick={() => dest && setSelectedDestCode(dest.code)}
                              className="cursor-pointer"
                            >
                              <text
                                x={x}
                                y={y}
                                dy={4}
                                textAnchor="end"
                                className={`text-xs font-medium transition-colors ${
                                  isSelected ? 'fill-primary font-bold' : 'fill-muted-foreground hover:fill-foreground'
                                }`}
                              >
                                {dest ? `${dest.flag} ${dest.name}` : payload.value}
                              </text>
                            </g>
                          );
                        }}
                      />
                      <Tooltip content={<CustomComparisonTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
                      <Bar
                        dataKey="achievedAge"
                        radius={[0, 4, 4, 0]}
                        barSize={12}
                      >
                        {destinationComparisons.map((entry, index) => {
                          const isSelected = selectedDestCode === entry.code;
                          return (
                            <Cell
                              key={`cell-${index}`}
                              fill={isSelected ? 'var(--primary)' : 'var(--muted-foreground)'}
                              opacity={isSelected ? 1.0 : 0.4}
                              className="cursor-pointer transition-all hover:opacity-85"
                              onClick={() => setSelectedDestCode(entry.code)}
                            />
                          );
                        })}
                      </Bar>
                      <ReferenceLine
                        x={targetRetireAge}
                        stroke="var(--negative)"
                        strokeWidth={1.5}
                        strokeDasharray="3 3"
                        label={{
                          value: `Target: Age ${targetRetireAge}`,
                          position: 'top',
                          fill: 'var(--negative)',
                          fontSize: 9,
                          fontWeight: 'bold',
                        }}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </CardContent>
          </Card>

        </div>
      </div>
    ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* How to Read the Data */}
          <Card className="border-border/60 bg-card/40 backdrop-blur-md">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Info className="w-4 h-4 text-info" />
                How to Read the Visualizations & Comparison Graph
              </CardTitle>
              <CardDescription className="text-xs">
                Learn how to interpret your projection graphs, milestones, and expat comparison graph correctly.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-5">
              
              {/* The Compounding Area Chart */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-info flex items-center gap-1">
                  <TrendingUp className="w-3.5 h-3.5" /> 1. Portfolio Wealth Projections Graph
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The projection graph models your nominal wealth accumulation from today through your life expectancy (Age 85).
                </p>
                <ul className="text-sm space-y-1.5 list-disc pl-4 text-muted-foreground">
                  <li>
                    <strong className="text-info font-bold">Filled Sage Area (Portfolio Value):</strong> Represents your estimated portfolio balance at each age. During pre-retirement (before the target retirement age), this grows via your pre-retirement returns (e.g. 8%) and annual savings. Post-retirement, it compounds via post-retirement returns (e.g. 5.5%) minus your annual inflation-adjusted expenses.
                  </li>
                  <li>
                    <strong className="text-caution font-bold">Dashed Gold Line (FIRE Target):</strong> Your target financial independence nest egg adjusted for annual inflation. Because expenses rise with inflation (e.g. 3%), your target nest egg also slopes upward over time.
                  </li>
                  <li>
                    <strong className="text-positive font-bold">Muted Green Vertical Line (FIRE Age):</strong> The exact age at which your portfolio line crosses your rising FIRE target. This is the moment you achieve financial independence.
                  </li>
                  <li>
                    <strong className="text-negative font-bold">Muted Red Vertical Line (Retirement Target):</strong> Your plan's target retirement age, where you stop adding savings and begin drawing down.
                  </li>
                </ul>
              </div>

              <hr className="border-border/20" />

              {/* The Comparison Table */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-info flex items-center gap-1">
                  <Globe className="w-3.5 h-3.5" /> 2. Expat Geoarbitrage Comparison Graph
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  The comparison graph computes parallel timeline projections across all 7 supported expat destinations simultaneously using live currency rates:
                </p>
                <ul className="text-sm space-y-1.5 list-disc pl-4 text-muted-foreground">
                  <li>
                    <strong className="text-info font-semibold">Comfort vs. Lean Budgets:</strong> Comfort includes premium tier-1 rentals, helpers, and international services. Lean represents a comfortable, frugal local lifestyle.
                  </li>
                  <li>
                    <strong className="text-caution font-semibold">Nest Egg Target:</strong> Calculated as <code className="bg-muted px-1 py-0.5 rounded text-xs">Annual Expenses / SWR</code>. This is the absolute capital pool you need to retire. Lower monthly costs lead to a dramatically smaller target nest egg.
                  </li>
                  <li>
                    <strong className="text-positive font-semibold">Years Saved:</strong> The number of years earlier you can retire by targetting that country's cost of living instead of a premium domestic benchmark (e.g., $3,500/mo for individual, $7,500/mo for family).
                  </li>
                </ul>
              </div>

              <hr className="border-border/20" />

              {/* Milestones Card */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-info flex items-center gap-1">
                  <Award className="w-3.5 h-3.5" /> 3. Coast, Lean, and Fat FIRE Milestones
                </h3>
                <ul className="text-sm space-y-1.5 list-disc pl-4 text-muted-foreground">
                  <li>
                    <strong className="text-caution font-semibold">Coast FIRE:</strong> The portfolio size you need today so that even if you never save another penny, it will compound on its own to hit your full FIRE number at your target retirement age.
                  </li>
                  <li>
                    <strong className="text-positive font-semibold">Lean FIRE:</strong> Achieving independence at a highly frugal 75% lifestyle budget.
                  </li>
                  <li>
                    <strong className="text-negative font-semibold">Fat FIRE:</strong> Achieving independence at a highly affluent 150% lifestyle budget, providing a luxury cushion.
                  </li>
                </ul>
              </div>

            </CardContent>
          </Card>

          {/* Future Investing & Wealth Playbook */}
          <Card className="border-border/60 bg-card/40 backdrop-blur-md">
            <CardHeader className="py-4 px-5 border-b border-border/40">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Flame className="w-4 h-4 text-caution" />
                Retirement Playbook & Future Investing Strategy
              </CardTitle>
              <CardDescription className="text-xs">
                Leverage your planner calculations to craft a highly optimized long-term investment strategy.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-5">
              
              {/* 1. Coast FIRE Strategy */}
              <div className="space-y-1.5 bg-muted/20 p-3 rounded border border-border/20">
                <h4 className="text-xs font-bold text-caution flex items-center gap-1.5">
                  <Coins className="w-3.5 h-3.5" />
                  Strategy A: Front-Load & "Coast"
                </h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Once your portfolio crosses your **Coast FIRE** milestone (e.g. ₹50 Lakhs or $60,000 invested early), you have achieved extreme career freedom. You can transition to low-stress or passion-driven work that merely covers your monthly living costs, knowing that your nest egg is compounding independently in the background to fully fund your eventual retirement.
                </p>
              </div>

              {/* 2. Geoarbitrage Strategy */}
              <div className="space-y-1.5 bg-muted/20 p-3 rounded border border-border/20">
                <h4 className="text-xs font-bold text-info flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Strategy B: Geoarbitrage as a Safety Hedge
                </h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Planning your retirement destination (such as India or Southeast Asia) acts as a **downside risk hedge**. If high inflation or a market crash hits during your decumulation years, you can choose to spend a few years in a high-amenity, low-cost region (like Goa, Pune, Bali, or Chiang Mai) to dramatically lower your portfolio withdrawal rate, giving your market assets a chance to recover.
                </p>
              </div>

              {/* 3. Pre/Post Market Compounding */}
              <div className="space-y-1.5 bg-muted/20 p-3 rounded border border-border/20">
                <h4 className="text-xs font-bold text-positive flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5" />
                  Strategy C: Pre- vs. Post-Retirement Asset Allocation
                </h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  During pre-retirement, keep a growth-oriented asset allocation (e.g., broad market index funds, equity mutual funds, and FDs) to compound at a high nominal rate (7% - 9%). Post-retirement, transition to a conservative allocation (e.g. dividend-paying equities, corporate bonds, government gilts, and fixed deposits) targeting a lower, stable nominal return (e.g. 5.5%) with high liquidity.
                </p>
              </div>

              {/* 4. The 4% Rule & Safe Withdrawal Rate (SWR) */}
              <div className="space-y-1.5 bg-muted/20 p-3 rounded border border-border/20">
                <h4 className="text-xs font-bold text-negative flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5" />
                  Strategy D: Optimizing Your Safe Withdrawal Rate (SWR)
                </h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  The **SWR (Safe Withdrawal Rate)** is the percentage of your portfolio you withdraw in Year 1 of retirement, adjusting that nominal amount for inflation annually. While the historical Trinity Study standard is **4%**, setting a conservative **3.25% - 3.5%** SWR virtually guarantees portfolio sustainability forever, even during prolonged bear markets.
                </p>
              </div>

            </CardContent>
          </Card>
        </div>
      )}

    </div>
  );
}
