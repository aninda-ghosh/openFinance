import { convertFromINR, formatCurrency } from "@openfinance/shared/utils";
import { ChevronLeft, ChevronRight, GitMerge, Layers, ChevronDown, ChevronUp, TrendingUp, Info } from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useExchangeRates } from "@/modules/budget/hooks/useBudget";
import { useCashFlow } from "@/modules/dashboard/hooks/useDashboard";
import { useAppStore } from "@/stores/app.store";
import { dashboardApi } from "@/modules/dashboard/api";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  Legend,
} from "recharts";

const GROUP_COLORS = [
  "var(--chart-2)",  // Muted Savings Green (uses Sage green var)
  "var(--chart-1)",  // Indigo
  "var(--chart-7)",  // Amber/Sand
  "var(--chart-4)",  // Coral/Red/Lime
  "var(--chart-8)",  // Violet
  "var(--chart-3)",  // Cyan
  "var(--chart-9)",  // Orange/Grey
  "var(--chart-10)", // Mint
  "var(--chart-6)",  // Pale Sage
  "var(--chart-5)",  // Forest Sage
];

interface CustomTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string;
  isPercentage?: boolean;
  defaultCurrency?: string;
}

function CustomChartTooltip({
  active,
  payload,
  label,
  isPercentage = false,
  defaultCurrency = "USD",
}: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-popover/90 backdrop-blur-md border border-border/80 rounded-2xl p-4 shadow-xl space-y-2 text-xs min-w-[180px] select-none">
      <p className="font-extrabold text-muted-foreground uppercase tracking-widest text-[9px]">{label}</p>
      <div className="space-y-2">
        {payload.map((entry: any, i: number) => {
          const val = Number(entry.value);
          const valueStr = isPercentage
            ? `${val.toFixed(1)}%`
            : formatCurrency(val, defaultCurrency as any);
          return (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color || entry.fill }} />
                <span className="text-muted-foreground font-semibold">{entry.name === "income" ? "Income" : entry.name === "expenses" ? "Expenses" : entry.name}</span>
              </div>
              <span className="font-extrabold text-foreground tabular-nums">{valueStr}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sankeyPath(
  x1: number,
  y1: number,
  h1: number,
  x2: number,
  y2: number,
  h2: number
) {
  const mx = (x1 + x2) / 2;
  return [
    `M ${x1} ${y1}`,
    `C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`,
    `L ${x2} ${y2 + h2}`,
    `C ${mx} ${y2 + h2} ${mx} ${y1 + h1} ${x1} ${y1 + h1}`,
    `Z`,
  ].join(" ");
}

interface IncomeSource {
  payee: string;
  amount: number;
}

interface Envelope {
  name: string;
  amount: number;
}

interface ExpenseGroup {
  group_name: string;
  total: number;
  envelopes: Envelope[];
}

interface CashFlowData {
  month: string;
  carryover?: number;
  total_income: number;
  total_expenses: number;
  savings: number;
  income_sources: IncomeSource[];
  expense_groups: ExpenseGroup[];
}

interface SrcNode {
  id: string;
  y: number;
  h: number;
  amount: number;
}

interface GroupNode {
  id: string;
  y: number;
  h: number;
  group: ExpenseGroup;
  colorIdx: number;
}

interface EnvNode {
  name: string;
  y: number;
  h: number;
  colorIdx: number;
}

interface Slice {
  y: number;
  h: number;
}

function CashFlowSankey({
  data,
  fmt,
}: {
  data: CashFlowData & { simValInr?: number };
  fmt: (n: number) => string;
}) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    setIsMobile(media.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  const W = 900;
  const H = isMobile ? 580 : 460;
  const nodeW = 20;
  const TOP = 24,
    BOTTOM = 24;
  const usableH = H - TOP - BOTTOM;
  const nodePad = 6;

  const simValInr = data.simValInr ?? 0;

  // Simulated total income available
  const simIncome = data.total_income + (simValInr > 0 ? simValInr : 0);

  // Simulated total expenses / sinks
  const simExpenses = data.total_expenses + (simValInr < 0 ? Math.abs(simValInr) : 0);

  // Simulated net savings remaining
  const simSavings = Math.max(0, simIncome - simExpenses);

  if (!data || (data.total_income === 0 && simValInr === 0)) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
        No income recorded for this month.
      </div>
    );
  }

  // Scaling denominator is the larger of total available flow vs total expense sinks
  const totalFlow = Math.max(simIncome, simExpenses);

  // If expenses exceed income, calculate the deficit and add it as a virtual
  // "Past Savings / Deficit" source node on the left to perfectly balance the Income node.
  const deficit = simExpenses > simIncome
    ? simExpenses - simIncome
    : 0;

  const incomeSources = [
    ...data.income_sources,
    ...(simValInr > 0 ? [{ payee: "Prior Month Leftover", amount: simValInr }] : []),
    ...(deficit > 0 ? [{ payee: "Past Savings / Deficit", amount: deficit }] : [])
  ];

  const expenseGroups = [
    ...data.expense_groups,
    ...(simValInr < 0 ? [{ group_name: "Prior Month Overspent", total: Math.abs(simValInr), envelopes: [] }] : [])
  ];

  const totalEnvelopes = expenseGroups.reduce(
    (sum, g) => sum + (g.envelopes?.length ?? 0),
    0
  );
  const hasEnvelopes = totalEnvelopes > 0;

  // Column x positions (left edge of node rect)
  const COL0 = 15;  // income sources
  const COL1 = hasEnvelopes ? (isMobile ? 220 : 300) : 440; // income total node
  const COL2 = hasEnvelopes ? (isMobile ? 470 : 585) : 865; // savings + expense groups
  const COL3 = 865; // envelopes

  // Standard scale for single full-height nodes (contiguous)
  const scale = (v: number) => (v / totalFlow) * usableH;

  // Calculate dynamic scaling for Column 0 (income sources) to fit precisely
  const numSrcNodes = incomeSources.length;
  const totalSrcPad = Math.max(0, numSrcNodes - 1) * nodePad;
  const usableSrcH = Math.max(100, usableH - totalSrcPad);
  const scaleSrc = (v: number) => (v / totalFlow) * usableSrcH;

  // Calculate dynamic scaling for Column 2 (savings + groups) to fit precisely
  const numNodes2 = (simSavings > 0 ? 1 : 0) + expenseGroups.length;
  const totalPad2 = Math.max(0, numNodes2 - 1) * nodePad;
  const usableH2 = Math.max(100, usableH - totalPad2);
  const scale2 = (v: number) => (v / totalFlow) * usableH2;

  // ── Column 0: income sources ──────────────────────────────────────────────
  let cursor0 = TOP;
  const srcNodes: SrcNode[] = incomeSources.map((s) => {
    const h = Math.max(2, scaleSrc(s.amount));
    const node: SrcNode = { id: s.payee, y: cursor0, h, amount: s.amount };
    cursor0 += h + nodePad;
    return node;
  });

  // ── Column 1: single income node ─────────────────────────────────────────
  const incNode = { y: TOP, h: usableH };

  // Left side of income node: slices per income source (contiguous, no gap)
  let incLeftCursor = TOP;
  const incLeftSlices: Slice[] = incomeSources.map((s) => {
    const h = Math.max(2, scale(s.amount));
    const slice: Slice = { y: incLeftCursor, h };
    incLeftCursor += h;
    return slice;
  });

  // Right side of income node: savings on top, then groups (contiguous)
  let incRightCursor = TOP;
  const savingsH = scale(simSavings);
  const incRightSavings: Slice = { y: incRightCursor, h: savingsH };
  incRightCursor += savingsH;
  const incRightGroups: Slice[] = expenseGroups.map((g) => {
    const h = Math.max(2, scale(g.total));
    const slice: Slice = { y: incRightCursor, h };
    incRightCursor += h;
    return slice;
  });

  // ── Column 2: savings + expense groups ───────────────────────────────────
  let cursor2 = TOP;
  const savingsNode: Slice | null =
    simSavings > 0
      ? (() => {
          const h = Math.max(2, scale2(simSavings));
          const n: Slice = { y: cursor2, h };
          cursor2 += h + nodePad;
          return n;
        })()
      : null;

  const groupNodes: GroupNode[] = expenseGroups.map((g, i) => {
    const h = Math.max(2, scale2(g.total));
    const node: GroupNode = {
      id: g.group_name,
      y: cursor2,
      h,
      group: g,
      colorIdx: i + 1,
    };
    cursor2 += h + nodePad;
    return node;
  });

  // ── Column 3: envelopes ───────────────────────────────────────────────────
  // For each group, stack its envelopes perfectly within the group's height range
  const envelopeNodesByGroup: EnvNode[][] = groupNodes.map((gn) => {
    const numEnvs = gn.group.envelopes.length;
    const totalEnvPad = Math.max(0, numEnvs - 1) * 2;
    const usableEnvH = Math.max(2 * numEnvs, gn.h - totalEnvPad);
    let envCursor = gn.y;
    
    return gn.group.envelopes.map((e, idx) => {
      const h = (e.amount / gn.group.total) * usableEnvH;
      const en: EnvNode = {
        name: e.name,
        y: envCursor,
        h,
        colorIdx: gn.colorIdx,
      };
      envCursor += h + (idx === numEnvs - 1 ? 0 : 2); // only add padding between envelopes to avoid overflow
      return en;
    });
  });

  // Label helpers
  const pct = (v: number) =>
    simIncome > 0
      ? `(${((v / simIncome) * 100).toFixed(1)}%)`
      : "";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
    >
      {/* ── Paths: income sources → income node ── */}
      {srcNodes.map((src, i) => (
        <path
          key={`src-link-${i}`}
          d={sankeyPath(
            COL0 + nodeW,
            src.y,
            src.h,
            COL1,
            incLeftSlices[i].y,
            incLeftSlices[i].h
          )}
          fill={src.id === "Past Savings / Deficit" ? "#cc747d" : src.id === "Prior Month Leftover" ? "var(--chart-2)" : "#709ec6"}
          opacity={src.id === "Past Savings / Deficit" ? 0.22 : 0.18}
        >
          <title>{`${src.id} → Income: ${fmt(src.amount)} ${pct(src.amount)}`}</title>
        </path>
      ))}

      {/* ── Path: income node → savings ── */}
      {savingsNode && (
        <path
          d={sankeyPath(
            COL1 + nodeW,
            incRightSavings.y,
            incRightSavings.h,
            COL2,
            savingsNode.y,
            savingsNode.h
          )}
          fill={GROUP_COLORS[0]}
          opacity={0.2}
        >
          <title>{`Income → Unused: ${fmt(simSavings)} ${pct(simSavings)}`}</title>
        </path>
      )}

      {/* ── Paths: income node → expense groups ── */}
      {groupNodes.map((gn, i) => (
        <path
          key={`grp-link-${i}`}
          d={sankeyPath(
            COL1 + nodeW,
            incRightGroups[i].y,
            incRightGroups[i].h,
            COL2,
            gn.y,
            gn.h
          )}
          fill={gn.id === "Prior Month Overspent" ? "var(--destructive)" : GROUP_COLORS[gn.colorIdx % GROUP_COLORS.length]}
          opacity={gn.id === "Prior Month Overspent" ? 0.25 : 0.18}
        >
          <title>{`Income → ${gn.id}: ${fmt(gn.group.total)} ${pct(gn.group.total)}`}</title>
        </path>
      ))}

      {/* ── Paths: expense groups → envelopes ── */}
      {groupNodes.map((gn, gi) => {
        let envRightCursor = gn.y;
        return envelopeNodesByGroup[gi].map((en, ei) => {
          const srcH = (gn.group.envelopes[ei].amount / gn.group.total) * gn.h;
          const path = sankeyPath(
            COL2 + nodeW,
            envRightCursor,
            srcH,
            COL3,
            en.y,
            en.h
          );
          envRightCursor += srcH; // Contiguous start, spreads out to padded envelopes
          return (
            <path
              key={`env-link-${gi}-${ei}`}
              d={path}
              fill={GROUP_COLORS[gn.colorIdx % GROUP_COLORS.length]}
              opacity={0.15}
            >
              <title>{`${gn.id} → ${en.name}: ${fmt(gn.group.envelopes[ei].amount)} ${pct(gn.group.envelopes[ei].amount)}`}</title>
            </path>
          );
        });
      })}

      {/* ── Column 0 nodes: income sources ── */}
      {srcNodes.map((src, i) => (
        <g key={`src-node-${i}`}>
          <title>{`${src.id}: ${fmt(src.amount)} ${pct(src.amount)}`}</title>
          <rect
            x={COL0}
            y={src.y}
            width={nodeW}
            height={src.h}
            rx={3}
            fill={src.id === "Past Savings / Deficit" ? "#cc747d" : src.id === "Prior Month Leftover" ? "var(--chart-2)" : "#709ec6"}
          />
          {src.h > (isMobile ? 14 : 12) ? (
            <>
              <text
                x={COL0 + nodeW + 6}
                y={src.y + src.h / 2 - 3}
                dominantBaseline="middle"
                fontSize={isMobile ? 13 : 11}
                fontWeight={isMobile ? 600 : 500}
                fill="currentColor"
                className="fill-foreground font-semibold"
              >
                {src.id}
              </text>
              <text
                x={COL0 + nodeW + 6}
                y={src.y + src.h / 2 + 9}
                fontSize={isMobile ? 11 : 10}
                fill="#6b7280"
              >
                {fmt(src.amount)}
              </text>
            </>
          ) : src.h > 6 ? (
            <text
              x={COL0 + nodeW + 6}
              y={src.y + src.h / 2}
              dominantBaseline="middle"
              fontSize={isMobile ? 11 : 10}
              fontWeight={isMobile ? 600 : 500}
              fill="currentColor"
              className="fill-foreground font-semibold"
            >
              {src.id} ({fmt(src.amount)})
            </text>
          ) : null}
        </g>
      ))}

      {/* ── Column 1 node: income total ── */}
      <g>
        <title>{`Total Income Available: ${fmt(simIncome)} (100.0%)`}</title>
        <rect
          x={COL1}
          y={incNode.y}
          width={nodeW}
          height={incNode.h}
          rx={3}
          fill="#709ec6"
        />
        <text
          x={COL1 + nodeW + 6}
          y={incNode.y + incNode.h / 2 - 6}
          dominantBaseline="middle"
          fontSize={isMobile ? 13 : 11}
          fontWeight={isMobile ? 600 : 500}
          fill="currentColor"
          className="fill-foreground font-semibold"
        >
          Income
        </text>
        <text
          x={COL1 + nodeW + 6}
          y={incNode.y + incNode.h / 2 + 8}
          fontSize={isMobile ? 11 : 10}
          fill="#6b7280"
        >
          {fmt(simIncome)}
        </text>
      </g>

      {/* ── Column 2: savings node ── */}
      {savingsNode && (
        <g>
          <title>{`Unused: ${fmt(simSavings)} ${pct(simSavings)}`}</title>
          <rect
            x={COL2}
            y={savingsNode.y}
            width={nodeW}
            height={savingsNode.h}
            rx={3}
            fill={GROUP_COLORS[0]}
          />
          <text
            x={hasEnvelopes ? COL2 + nodeW + 6 : COL2 - 6}
            y={savingsNode.y + savingsNode.h / 2 - 6}
            dominantBaseline="middle"
            textAnchor={hasEnvelopes ? undefined : "end"}
            fontSize={isMobile ? 13 : 11}
            fontWeight={isMobile ? 600 : 500}
            fill="currentColor"
            className="fill-foreground font-semibold"
          >
            Unused
          </text>
          <text
            x={hasEnvelopes ? COL2 + nodeW + 6 : COL2 - 6}
            y={savingsNode.y + savingsNode.h / 2 + 8}
            textAnchor={hasEnvelopes ? undefined : "end"}
            fontSize={isMobile ? 11 : 10}
            fill="#6b7280"
          >
            {fmt(simSavings)} {pct(simSavings)}
          </text>
        </g>
      )}

      {/* ── Column 2: expense group nodes ── */}
      {groupNodes.map((gn, i) => (
        <g key={`grp-node-${i}`}>
          <title>{`${gn.id}: ${fmt(gn.group.total)} ${pct(gn.group.total)}`}</title>
          <rect
            x={COL2}
            y={gn.y}
            width={nodeW}
            height={gn.h}
            rx={3}
            fill={gn.id === "Prior Month Overspent" ? "var(--destructive)" : GROUP_COLORS[gn.colorIdx % GROUP_COLORS.length]}
          />
          <text
            x={hasEnvelopes ? COL2 + nodeW + 6 : COL2 - 6}
            y={gn.y + gn.h / 2 - 6}
            dominantBaseline="middle"
            textAnchor={hasEnvelopes ? undefined : "end"}
            fontSize={isMobile ? 13 : 11}
            fontWeight={isMobile ? 600 : 500}
            fill="currentColor"
            className="fill-foreground font-semibold"
          >
            {gn.id}
          </text>
          <text
            x={hasEnvelopes ? COL2 + nodeW + 6 : COL2 - 6}
            y={gn.y + gn.h / 2 + 8}
            textAnchor={hasEnvelopes ? undefined : "end"}
            fontSize={isMobile ? 11 : 10}
            fill="#6b7280"
          >
            {fmt(gn.group.total)}{" "}
            {gn.h > 10 ? pct(gn.group.total) : ""}
          </text>
        </g>
      ))}

      {/* ── Column 3: envelope nodes ── */}
      {envelopeNodesByGroup.map((envs, gi) =>
        envs.map((en, ei) => {
          const amt = expenseGroups[gi].envelopes[ei].amount;
          return (
            <g key={`env-node-${gi}-${ei}`}>
              <title>{`${en.name}: ${fmt(amt)} ${pct(amt)}`}</title>
              <rect
                x={COL3}
                y={en.y}
                width={nodeW}
                height={en.h}
                rx={2}
                fill={GROUP_COLORS[en.colorIdx % GROUP_COLORS.length]}
              />
              {en.h > (isMobile ? 14 : 12) && (
                <text
                  x={COL3 - 6}
                  y={en.y + en.h / 2}
                  dominantBaseline="middle"
                  textAnchor="end"
                  fontSize={isMobile ? 11 : 10}
                  fontWeight={isMobile ? 600 : 500}
                  fill="currentColor"
                  className="fill-foreground font-semibold"
                >
                  {en.name}
                </text>
              )}
            </g>
          );
        })
      )}
    </svg>
  );
}

function CashFlowCompact({
  data,
  fmt,
}: {
  data: CashFlowData & { simValInr?: number };
  fmt: (n: number) => string;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const simValInr = data.simValInr ?? 0;
  const simIncome = data.total_income + (simValInr > 0 ? simValInr : 0);
  const simExpenses = data.total_expenses + (simValInr < 0 ? Math.abs(simValInr) : 0);
  const simSavings = Math.max(0, simIncome - simExpenses);
  const deficit = simExpenses > simIncome ? simExpenses - simIncome : 0;

  const incomeSources = [
    ...data.income_sources,
    ...(simValInr > 0 ? [{ payee: "Prior Month Leftover", amount: simValInr }] : []),
    ...(deficit > 0 ? [{ payee: "Past Savings / Deficit", amount: deficit }] : [])
  ];

  const expenseGroups = [
    ...data.expense_groups,
    ...(simValInr < 0 ? [{ group_name: "Prior Month Overspent", total: Math.abs(simValInr), envelopes: [] }] : [])
  ];

  const pct = (v: number) =>
    simIncome > 0 ? ((v / simIncome) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-4 px-5 py-3">
      {/* 1. Inflow Segmented Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-wider select-none px-1">
          <span>Inflow Sources</span>
          <span className="text-foreground tabular-nums font-extrabold">{fmt(simIncome)}</span>
        </div>
        <div className="w-full h-5 rounded-xl bg-muted/65 overflow-hidden flex shadow-inner border border-border/40 select-none">
          {incomeSources.map((src, i) => {
            const widthPct = parseFloat(pct(src.amount));
            if (widthPct <= 0) return null;
            // Harmonious custom shades of blue/indigo
            const colors = [
              "bg-[#3b82f6]/95",
              "bg-[#60a5fa]/95",
              "bg-[#93c5fd]/95",
              "bg-[#bfdbfe]/95"
            ];
            const colorClass = colors[i % colors.length];
            return (
              <div
                key={`inflow-seg-${i}`}
                className={`${colorClass} h-full transition-all duration-300 relative group cursor-pointer border-r border-background/20 last:border-r-0`}
                style={{ width: `${widthPct}%` }}
              >
                <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                <title>{`${src.payee}: ${fmt(src.amount)} (${widthPct.toFixed(1)}%)`}</title>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Central Transition Flow Arrow */}
      <div className="flex justify-center select-none py-0.5">
        <ChevronDown className="w-4 h-4 text-muted-foreground/60 animate-pulse" />
      </div>

      {/* 3. Outflow & Unused Segmented Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-wider select-none px-1">
          <span>Outflow Allocations</span>
          <span className="text-foreground tabular-nums font-extrabold">{fmt(simIncome)}</span>
        </div>
        <div className="w-full h-5 rounded-xl bg-muted/65 overflow-hidden flex shadow-inner border border-border/40 select-none">
          {/* Unused Funds (Savings leftover) */}
          {simSavings > 0 && (
            <div
              onClick={() => setExpandedGroup(expandedGroup === "unused" ? null : "unused")}
              className="bg-emerald-500/90 h-full transition-all duration-300 relative group cursor-pointer border-r border-background/20 last:border-r-0"
              style={{ width: `${pct(simSavings)}%` }}
            >
              <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <title>{`Unused Funds: ${fmt(simSavings)} (${pct(simSavings)}%)`}</title>
            </div>
          )}

          {/* Expense Groups */}
          {expenseGroups.map((g, i) => {
            const groupPct = parseFloat(pct(g.total));
            if (groupPct <= 0) return null;
            const groupColor = g.group_name === "Prior Month Overspent"
              ? "var(--destructive)"
              : GROUP_COLORS[(i + 1) % GROUP_COLORS.length];

            return (
              <div
                key={`outflow-seg-${i}`}
                onClick={() => setExpandedGroup(expandedGroup === g.group_name ? null : g.group_name)}
                className="h-full transition-all duration-300 relative group cursor-pointer border-r border-background/20 last:border-r-0"
                style={{
                  width: `${groupPct}%`,
                  backgroundColor: groupColor.startsWith("var") ? undefined : groupColor,
                }}
              >
                {groupColor.startsWith("var") && (
                  <div className="absolute inset-0" style={{ backgroundColor: groupColor }} />
                )}
                <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                <title>{`${g.group_name}: ${fmt(g.total)} (${groupPct.toFixed(1)}%)`}</title>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Highly Compact Interactive Accordion Legend */}
      <div className="mt-5 space-y-2 border-t border-border/30 pt-4">
        <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground/80 select-none px-1">
          Allocation Breakdown (Select to view sub-envelopes)
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* Unused Funds */}
          {simSavings > 0 && (
            <div className="bg-card/45 border border-border/40 rounded-xl overflow-hidden transition-all duration-350 hover:border-emerald-500/20">
              <button
                onClick={() => setExpandedGroup(expandedGroup === "unused" ? null : "unused")}
                className="w-full flex items-center justify-between p-2.5 text-xs font-bold hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2 truncate">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span className="text-foreground font-semibold">Unused Funds</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="tabular-nums text-foreground font-bold">{fmt(simSavings)}</span>
                  <span className="text-[10px] text-muted-foreground font-normal">({pct(simSavings)}%)</span>
                  {expandedGroup === "unused" ? (
                    <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/80" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/80" />
                  )}
                </div>
              </button>
              {expandedGroup === "unused" && (
                <div className="px-3 pb-3 pt-1 text-[11px] text-muted-foreground font-semibold leading-relaxed bg-muted/10">
                  Unallocated surplus reserves kept inside cash or generic bank accounts.
                </div>
              )}
            </div>
          )}

          {/* Expense groups */}
          {expenseGroups.map((g, i) => {
            const groupPct = parseFloat(pct(g.total));
            if (groupPct <= 0) return null;
            const isExpanded = expandedGroup === g.group_name;
            const groupColor = g.group_name === "Prior Month Overspent"
              ? "var(--destructive)"
              : GROUP_COLORS[(i + 1) % GROUP_COLORS.length];

            return (
              <div
                key={`legend-grp-${i}`}
                className="bg-card/45 border border-border/40 rounded-xl overflow-hidden transition-all duration-350 hover:border-primary/20"
              >
                <button
                  onClick={() => setExpandedGroup(isExpanded ? null : g.group_name)}
                  className="w-full flex items-center justify-between p-2.5 text-xs font-bold hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: groupColor.startsWith("var") ? undefined : groupColor }}
                    >
                      {groupColor.startsWith("var") && (
                        <span className="w-full h-full rounded-full block" style={{ backgroundColor: groupColor }} />
                      )}
                    </span>
                    <span className="text-foreground font-semibold truncate">{g.group_name}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="tabular-nums text-foreground font-bold">{fmt(g.total)}</span>
                    <span className="text-[10px] text-muted-foreground font-normal">({groupPct.toFixed(1)}%)</span>
                    {isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/80" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/80" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 pt-2 border-t border-border/5 space-y-2.5 bg-muted/10">
                    {g.envelopes && g.envelopes.length > 0 ? (
                      g.envelopes.map((e) => {
                        const envPct = parseFloat(pct(e.amount));
                        return (
                          <div key={e.name} className="flex flex-col gap-1">
                            <div className="flex justify-between items-center text-[10px] font-bold text-muted-foreground">
                              <span className="truncate max-w-[150px]">{e.name}</span>
                              <span className="tabular-nums text-foreground font-extrabold">
                                {fmt(e.amount)} ({envPct.toFixed(1)}%)
                              </span>
                            </div>
                            <div className="w-full bg-muted/70 rounded-full h-1 overflow-hidden">
                              <div
                                className="h-full rounded-full opacity-80"
                                style={{
                                  backgroundColor: groupColor.startsWith("var") ? undefined : groupColor,
                                  width: `${Math.min(100, (e.amount / g.total) * 100)}%`,
                                }}
                              >
                                {groupColor.startsWith("var") && (
                                  <div className="w-full h-full" style={{ backgroundColor: groupColor }} />
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-[10px] text-muted-foreground font-bold italic">No sub-envelopes</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [year, mon] = value.split("-").map(Number);
  const label = new Date(year, mon - 1).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });
  const prev = () => {
    const d = new Date(year, mon - 2);
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const next = () => {
    const d = new Date(year, mon);
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  return (
    <div className="flex items-center gap-2">
      <button onClick={prev} className="p-1 rounded hover:bg-muted">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-sm font-medium w-36 text-center">{label}</span>
      <button onClick={next} className="p-1 rounded hover:bg-muted">
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function ReportsPage() {
  const { selectedMonth } = useAppStore();
  const [month, setMonth] = useState(selectedMonth);
  const { data: rates = {} } = useExchangeRates();
  const { defaultCurrency } = useAppStore();

  const [viewMode, setViewMode] = useState<"sankey" | "cascade">("cascade");

  const { data, isLoading } = useCashFlow(month);

  const fmt = (inr: number) =>
    formatCurrency(
      convertFromINR(inr, defaultCurrency as any, rates),
      defaultCurrency as any
    );

  const fmtShort = (val: number) => {
    if (Math.abs(val) >= 1000) {
      const kVal = val / 1000;
      const formattedNum = kVal % 1 === 0 ? kVal.toFixed(0) : kVal.toFixed(1);
      return formatCurrency(parseFloat(formattedNum), defaultCurrency as any) + "k";
    }
    return formatCurrency(Math.round(val), defaultCurrency as any);
  };

  const carryoverInr = data?.carryover ?? 0;

  const savingsGroup = data?.expense_groups.find(
    (g) => g.group_name.toLowerCase() === "savings"
  );
  const savingsGroupTotal = savingsGroup ? savingsGroup.total : 0;
  const livingExpenses = data ? data.total_expenses - savingsGroupTotal : 0;
  
  // Actual savings this month (net surplus + savings envelopes)
  const actualSavings = data ? data.total_income - livingExpenses : 0;
  const displaySavingsRate =
    data && data.total_income > 0
      ? ((actualSavings / data.total_income) * 100).toFixed(1)
      : "0.0";

  // Base Net Surplus before carryover
  const netSurplus = data ? data.total_income - livingExpenses : 0;

  // Adjusted values for live carryover
  const displayIncome = data ? data.total_income + (carryoverInr > 0 ? carryoverInr : 0) : 0;
  const displayExpenses = data ? livingExpenses + (carryoverInr < 0 ? Math.abs(carryoverInr) : 0) : 0;
  const displayNet = netSurplus + carryoverInr;

  const [year, mon] = month.split("-").map(Number);

  // Hook to fetch cash flow history YTD
  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ["cash-flow-history", year, mon],
    queryFn: async () => {
      const promises = [];
      for (let m = 1; m <= mon; m++) {
        const monthStr = `${year}-${String(m).padStart(2, "0")}`;
        promises.push(
          dashboardApi.getCashFlow(monthStr).catch(() => ({
            month: monthStr,
            total_income: 0,
            total_expenses: 0,
            savings: 0,
            income_sources: [],
            expense_groups: [],
          }))
        );
      }
      return Promise.all(promises);
    },
    staleTime: 2 * 60 * 1000,
  });

  const trendData = useMemo(() => {
    if (!historyData) return [];
    return historyData.map((d: any) => {
      const sGroup = d.expense_groups.find(
        (g: any) => g.group_name.toLowerCase() === "savings"
      );
      const sGroupTotal = sGroup ? sGroup.total : 0;
      const livExp = d.total_expenses - sGroupTotal;
      const actSav = d.total_income - livExp;
      const rate = d.total_income > 0 ? (actSav / d.total_income) * 100 : 0;

      // Extract month name (e.g. "2026-01" -> "Jan")
      const dateParts = d.month.split("-").map(Number);
      const monthName = new Date(dateParts[0], dateParts[1] - 1).toLocaleDateString("en-US", { month: "short" });

      const convertedIncome = convertFromINR(d.total_income, defaultCurrency as any, rates);
      const convertedExpenses = convertFromINR(d.total_expenses, defaultCurrency as any, rates);
      const convertedSavings = convertFromINR(actSav, defaultCurrency as any, rates);

      return {
        month: monthName,
        rawMonth: d.month,
        income: parseFloat(convertedIncome.toFixed(2)),
        expenses: parseFloat(convertedExpenses.toFixed(2)),
        savings: parseFloat(convertedSavings.toFixed(2)),
        savingsRate: parseFloat(rate.toFixed(1)),
      };
    });
  }, [historyData, defaultCurrency, rates]);

  const categoryTrendData = useMemo(() => {
    if (!historyData) return { data: [], categories: [] };

    // 1. Gather all unique group names across all months
    const groupNamesSet = new Set<string>();
    for (const d of historyData) {
      for (const g of d.expense_groups) {
        groupNamesSet.add(g.group_name);
      }
    }
    const categories = Array.from(groupNamesSet);

    // 2. Map month data
    const data = historyData.map((d: any) => {
      const dateParts = d.month.split("-").map(Number);
      const monthName = new Date(dateParts[0], dateParts[1] - 1).toLocaleDateString("en-US", { month: "short" });

      const row: any = {
        month: monthName,
        rawMonth: d.month,
      };

      // Initialize all categories to 0
      for (const cat of categories) {
        row[cat] = 0;
      }

      // Populate from expense groups
      for (const g of d.expense_groups) {
        const val = convertFromINR(g.total, defaultCurrency as any, rates);
        row[g.group_name] = parseFloat(val.toFixed(2));
      }

      return row;
    });

    return { data, categories };
  }, [historyData, defaultCurrency, rates]);

  const ytdMetrics = useMemo(() => {
    if (!trendData || trendData.length === 0) return { avgRate: "0.0", totalIncome: 0, totalSavings: 0 };
    let totalIncome = 0;
    let totalSavings = 0;
    for (const d of trendData) {
      totalIncome += d.income;
      totalSavings += d.savings;
    }
    const avgRate = totalIncome > 0 ? ((totalSavings / totalIncome) * 100).toFixed(1) : "0.0";
    return { avgRate, totalIncome, totalSavings };
  }, [trendData]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cash Flow</h1>
        <MonthPicker value={month} onChange={setMonth} />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: carryoverInr > 0 ? "Total Income + Carryover" : "Total Income",
            value: data ? fmt(displayIncome) : "—",
            color: "text-positive",
          },
          {
            label: carryoverInr < 0 ? "Expenses + Prior Deficit" : "Total Expenses",
            value: data ? fmt(displayExpenses) : "—",
            color: "text-negative",
          },
          {
            label: carryoverInr !== 0 ? "Adjusted Net" : "Net Surplus",
            value: data ? fmt(displayNet) : "—",
            color: displayNet < 0 ? "text-negative" : displayNet > 0 ? "text-positive" : "text-foreground",
          },
          {
            label: "Savings Rate",
            value: `${displaySavingsRate}%`,
            color: "text-foreground",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card p-5 border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30 space-y-1"
          >
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {card.label}
            </p>
            <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* Trend & YTD Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Income & Expenses Trend (YTD) - Full Width */}
        <div className="md:col-span-2 relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm p-6 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 select-none">
                <TrendingUp className="w-3.5 h-3.5 text-primary" />
                Income & Expenses Trend (YTD)
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Month-by-month comparison of total income and expenses
              </p>
            </div>
            <div className="flex items-center gap-4 bg-muted/30 px-4 py-2.5 rounded-2xl border border-border/40 select-none">
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-bold block">
                  YTD Savings Rate
                </span>
                <span className="text-xl font-bold text-positive">
                  {ytdMetrics.avgRate}%
                </span>
              </div>
              <div className="w-px h-8 bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-bold flex items-center gap-0.5 select-none">
                  Total YTD Saved
                  <span title="Includes total net surplus and savings group envelope allocations since January.">
                    <Info className="w-3 h-3 text-muted-foreground/60" />
                  </span>
                </span>
                <span className="text-xl font-bold text-foreground">
                  {fmt(ytdMetrics.totalSavings)}
                </span>
              </div>
            </div>
          </div>

          {historyLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trendData}
                  margin={{ top: 15, right: 15, left: 15, bottom: 10 }}
                >
                  <defs>
                    <linearGradient id="colorIncome" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.08} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorExpenses" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-4)" stopOpacity={0.08} />
                      <stop offset="95%" stopColor="var(--chart-4)" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.15} />
                  <XAxis
                    dataKey="month"
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => fmtShort(v)}
                  />
                  <RechartsTooltip
                    content={
                      <CustomChartTooltip
                        isPercentage={false}
                        defaultCurrency={defaultCurrency}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="income"
                    name="income"
                    stroke="var(--chart-1)"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorIncome)"
                  />
                  <Area
                    type="monotone"
                    dataKey="expenses"
                    name="expenses"
                    stroke="var(--chart-4)"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorExpenses)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Card 2: Savings Rate Trend (YTD) */}
        <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 select-none">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              Savings Rate Trend (YTD)
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Month-by-month cash savings rate vs. YTD target
            </p>
          </div>

          {historyLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trendData}
                  margin={{ top: 15, right: 15, left: 15, bottom: 10 }}
                >
                  <defs>
                    <linearGradient id="colorSavings" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.15} />
                  <XAxis
                    dataKey="month"
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <RechartsTooltip
                    content={
                      <CustomChartTooltip
                        isPercentage={true}
                        defaultCurrency={defaultCurrency}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="savingsRate"
                    name="Savings Rate"
                    stroke="var(--chart-2)"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorSavings)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Card 3: Spending by Category (YTD) */}
        <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm p-6 space-y-4">
          <div>
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 select-none">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              Spending by Category (YTD)
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Month-by-month spending breakdown across all budget categories
            </p>
          </div>

          {historyLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={categoryTrendData.data}
                  margin={{ top: 15, right: 15, left: 15, bottom: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.15} />
                  <XAxis
                    dataKey="month"
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => fmtShort(v)}
                  />
                  <RechartsTooltip
                    cursor={false}
                    content={
                      <CustomChartTooltip
                        isPercentage={false}
                        defaultCurrency={defaultCurrency}
                      />
                    }
                  />
                  <Legend
                    verticalAlign="top"
                    height={36}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{
                      fontSize: "11px",
                      fontWeight: 600,
                      paddingBottom: "15px",
                    }}
                  />
                  {categoryTrendData.categories.map((cat, i) => (
                    <Bar
                      key={cat}
                      dataKey={cat}
                      name={cat}
                      stackId="a"
                      maxBarSize={28}
                      fill={GROUP_COLORS[(i + 1) % GROUP_COLORS.length]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Sankey */}
      <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <p className="text-xs font-extrabold uppercase tracking-wider text-muted-foreground select-none">
            Cash Flow Allocation
          </p>
          <div className="flex bg-muted/65 p-0.5 rounded-xl border border-border/40 backdrop-blur-sm select-none">
            <button
              onClick={() => setViewMode("sankey")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all duration-300 ${
                viewMode === "sankey"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <GitMerge className="w-3.5 h-3.5" />
              <span>Diagram</span>
            </button>
            <button
              onClick={() => setViewMode("cascade")}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all duration-300 ${
                viewMode === "cascade"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Compact</span>
            </button>
          </div>
        </div>
        {isLoading ? (
          <div className="px-6 pb-5">
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <div className="w-full pb-2">
            {viewMode === "cascade" ? (
              <CashFlowCompact data={{ ...data!, simValInr: carryoverInr }} fmt={fmt} />
            ) : (
              <CashFlowSankey data={{ ...data!, simValInr: carryoverInr }} fmt={fmt} />
            )}
          </div>
        )}
      </div>

      {/* Expense breakdown table */}
      {data && data.expense_groups.length > 0 && (
        <div className="relative overflow-hidden bg-gradient-to-br from-primary/5 via-transparent to-transparent rounded-3xl bg-card border border-border/80 border-b-2 border-b-border/95 shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:shadow-md hover:border-primary/30 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Category
                </th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Amount
                </th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  % of Income
                </th>
                <th className="px-4 py-2.5 w-48" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.expense_groups.map((g, gi) => (
                <>
                  <tr key={g.group_name} className="bg-muted/20 font-medium">
                    <td className="px-4 py-2 flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0 inline-block"
                        style={{
                          background:
                            GROUP_COLORS[(gi + 1) % GROUP_COLORS.length],
                        }}
                      />
                      {g.group_name}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmt(g.total)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {((g.total / data.total_income) * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2">
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                           className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (g.total / data.total_income) * 100)}%`,
                            background:
                              GROUP_COLORS[(gi + 1) % GROUP_COLORS.length],
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                  {g.envelopes.map((e) => (
                    <tr
                      key={`${g.group_name}-${e.name}`}
                      className="hover:bg-muted/10"
                    >
                      <td className="px-4 py-1.5 pl-10 text-muted-foreground">
                        {e.name}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums">
                        {fmt(e.amount)}
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground text-xs">
                        {((e.amount / data.total_income) * 100).toFixed(1)}%
                      </td>
                      <td className="px-4 py-1.5">
                        <div className="h-1 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full opacity-60"
                            style={{
                              width: `${Math.min(100, (e.amount / data.total_income) * 100)}%`,
                              background:
                                GROUP_COLORS[(gi + 1) % GROUP_COLORS.length],
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
