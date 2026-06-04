import {
  BarChart2,
  LayoutDashboard,
  MessageSquare,
  Wallet,
  ArrowLeftRight,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/reports", label: "Cash Flow", icon: BarChart2 },
  { to: "/budget", label: "Budget", icon: Wallet },
  { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/chat", label: "AI Chat", icon: MessageSquare },
];

export function BottomNav() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 md:hidden bg-background/95 backdrop-blur-md border-t border-border/60"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center h-14 justify-around px-2">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-all duration-200 select-none",
                isActive ? "text-primary scale-105" : "text-muted-foreground hover:text-foreground"
              )
            }
          >
            <Icon className="w-5 h-5 flex-shrink-0" />
            <span className="text-[10px] font-semibold leading-tight">
              {label}
            </span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
