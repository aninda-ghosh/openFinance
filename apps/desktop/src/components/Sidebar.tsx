import {
  ArrowLeftRight,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Landmark,
  LayoutDashboard,
  LineChart,
  MessageSquare,
  Settings,
  Wallet,
  FileText,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";

const NAV_GROUPS = [
  {
    title: "",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/networth", label: "Net Worth", icon: LineChart },
    ],
  },
  {
    title: "Budgeting",
    items: [
      { to: "/reports", label: "Cash Flow", icon: BarChart2 },
      { to: "/budget", label: "Budget", icon: Wallet },
      { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
    ],
  },
  {
    title: "Balance Sheet",
    items: [
      { to: "/accounts", label: "Accounts", icon: Landmark },
      { to: "/documents", label: "Documents", icon: FileText },
    ],
  },
  {
    title: "Utilities",
    items: [
      { to: "/chat", label: "AI Chat", icon: MessageSquare },
      { to: "/faq", label: "Help & FAQ", icon: HelpCircle },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useAppStore();

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col h-full bg-sidebar border-r border-sidebar-border transition-all duration-200",
        sidebarCollapsed ? "w-14" : "w-52"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 py-4 border-b border-sidebar-border">
        <img
          src="/OpenFinance.png"
          alt="openFinance"
          className="w-7 h-7 rounded-md object-contain flex-shrink-0"
        />
        {!sidebarCollapsed && (
          <span className="font-semibold text-sidebar-foreground">openFinance</span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col gap-3 p-2 overflow-y-auto">
        {NAV_GROUPS.map(({ title, items }) => (
          <div key={title} className="flex flex-col gap-0.5">
            {title && !sidebarCollapsed && (
              <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/30 px-2 py-1 select-none">
                {title}
              </span>
            )}
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-2 py-2 rounded-md text-sm font-medium transition-colors",
                    "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    isActive &&
                      "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground"
                  )
                }
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!sidebarCollapsed && <span>{label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="p-2 border-t border-sidebar-border flex flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSidebar}
          className="w-full justify-center text-sidebar-foreground hover:bg-sidebar-accent"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </Button>
      </div>
    </aside>
  );
}
