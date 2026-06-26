import { useState } from "react";
import {
  ArrowLeftRight,
  BarChart2,
  HelpCircle,
  Landmark,
  LayoutDashboard,
  LineChart,
  MessageSquare,
  Settings,
  Wallet,
  FileText,
  Menu,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const TABS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/budget", label: "Budget", icon: Wallet },
  { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/reports", label: "Cash Flow", icon: BarChart2 },
];

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

export function BottomNav() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const mainRoutes = ["/dashboard", "/budget", "/transactions", "/reports"];
  const isMoreActive = !mainRoutes.includes(location.pathname);

  return (
    <>
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

          {/* More menu button */}
          <button
            onClick={() => setMenuOpen(true)}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-all duration-200 select-none",
              isMoreActive ? "text-primary scale-105" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Menu className="w-5 h-5 flex-shrink-0" />
            <span className="text-[10px] font-semibold leading-tight">
              More
            </span>
          </button>
        </div>
      </nav>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="right" className="w-72 p-0 flex flex-col gap-0 border-l border-border bg-sidebar">
          <SheetHeader className="px-5 py-4 border-b border-sidebar-border bg-sidebar flex-shrink-0 flex flex-row items-center gap-2">
            <img
              src="/OpenFinance.png"
              alt="openFinance"
              className="w-7 h-7 rounded-md object-contain flex-shrink-0"
            />
            <SheetTitle className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              openFinance
            </SheetTitle>
          </SheetHeader>

          <nav className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {NAV_GROUPS.map(({ title, items }) => (
              <div key={title} className="flex flex-col gap-1">
                {title && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-sidebar-foreground/30 px-2.5 py-1 select-none">
                    {title}
                  </span>
                )}
                {items.map(({ to, label, icon: Icon }) => {
                  const isActive = location.pathname === to;
                  return (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={() => setMenuOpen(false)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors select-none",
                        isActive
                          ? "bg-sidebar-primary text-sidebar-primary-foreground font-semibold shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span>{label}</span>
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
