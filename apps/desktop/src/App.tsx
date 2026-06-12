import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { LoginGate } from "@/components/LoginGate";
import QuickAddTransactionDrawer from "@/components/QuickAddTransactionDrawer";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/ui/sonner";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { getToken, clearToken } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { useAppStore } from "@/stores/app.store";
import { Plus } from "lucide-react";
import { PasswordGate } from "@/components/PasswordGate";
import { cn, isTauri } from "@/lib/utils";
import { toast } from "sonner";
import "./App.css";

const DashboardPage = lazy(
  () => import("@/modules/dashboard/pages/DashboardPage")
);
const ReportsPage = lazy(() => import("@/modules/reports/pages/ReportsPage"));
const NetWorthPage = lazy(
  () => import("@/modules/networth/pages/NetWorthPage")
);
const BudgetPage = lazy(() => import("@/modules/budget/pages/BudgetPage"));
const TransactionsPage = lazy(
  () => import("@/modules/transactions/pages/TransactionsPage")
);
const AccountsPage = lazy(
  () => import("@/modules/accounts/pages/AccountsPage")
);
const DocumentsPage = lazy(
  () => import("@/modules/documents/pages/DocumentsPage")
);
const ChatPage = lazy(() => import("@/modules/chat/pages/ChatPage"));
const SettingsPage = lazy(
  () => import("@/modules/settings/pages/SettingsPage")
);
const FAQPage = lazy(() => import("@/modules/faq/pages/FAQPage"));
const QuickAddPage = lazy(
  () => import("@/modules/transactions/pages/QuickAddPage")
);

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="animate-pulse text-muted-foreground text-sm">
        Loading…
      </div>
    </div>
  );
}

function ThemeSync() {
  const resolved = useResolvedTheme();

  useEffect(() => {
    const isDark = resolved === "dark";
    document.documentElement.classList.toggle("dark", isDark);

    // Dynamic meta theme-color to blend status bar & safe areas on mobile devices
    let metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.getElementsByTagName('head')[0].appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', isDark ? "#090C11" : "#FAF8F5");
  }, [resolved]);

  return null;
}

function AppContent() {
  const { quickAddOpen, setQuickAddOpen } = useAppStore();

  return (
    <div
      className="app-shell flex bg-background text-foreground overflow-hidden relative"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <Sidebar />
      <main className="flex-1 overflow-y-auto no-scrollbar pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route
              path="/"
              element={<Navigate to="/dashboard" replace />}
            />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/networth" element={<NetWorthPage />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/investments" element={<Navigate to="/accounts?tab=investments" replace />} />
            <Route path="/debt" element={<Navigate to="/accounts?tab=debt" replace />} />
            <Route path="/policies" element={<Navigate to="/accounts?tab=policies" replace />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/faq" element={<FAQPage />} />
            <Route path="/quick-add" element={<QuickAddPage />} />
          </Routes>
        </Suspense>
      </main>
      <BottomNav />

      {/* Floating Action Button (FAB) for Quick Add - Desktop, Tablet, & Mobile */}
      <button
        onClick={() => setQuickAddOpen(!quickAddOpen)}
        className={cn(
          "fixed bottom-[calc(76px+env(safe-area-inset-bottom))] md:bottom-6 right-6 z-40 flex items-center justify-center h-12 w-12 rounded-full bg-gradient-to-tr from-primary to-primary/85 text-primary-foreground shadow-[0_4px_20px_rgba(20,184,166,0.35)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] active:scale-95 hover:scale-105 transition-all duration-300 border border-primary/20",
          quickAddOpen && "rotate-45 from-muted to-muted/80 text-muted-foreground border-border/40 shadow-md dark:shadow-none"
        )}
        aria-label="Quick Add Transaction"
        title="Quick Add Transaction"
      >
        <Plus className="w-5.5 h-5.5 stroke-[2.5]" />
      </button>

      <QuickAddTransactionDrawer />
    </div>
  );
}

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export default function App() {
  const [unlocked, setUnlocked] = useState(() => {
    if (isTauri()) return false;
    return !!getToken();
  });

  useEffect(() => {
    if (!unlocked) return;

    // Track last activity time
    let lastActivity = Date.now();
    localStorage.setItem("openfinance_last_activity", String(lastActivity));

    const handleActivity = () => {
      lastActivity = Date.now();
      localStorage.setItem("openfinance_last_activity", String(lastActivity));
    };

    const checkTimeout = () => {
      const stored = localStorage.getItem("openfinance_last_activity");
      const last = stored ? parseInt(stored, 10) : lastActivity;
      if (Date.now() - last > INACTIVITY_TIMEOUT) {
        clearToken();
        setUnlocked(false);
        toast.info("Logged out due to inactivity", {
          description: "For session security, you have been logged out after 5 minutes of idle time.",
        });
      }
    };

    // Add activity listeners
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((evt) => document.addEventListener(evt, handleActivity));

    // Periodic check (every 5 seconds) to catch tab sleep / lock screen wakes
    const interval = setInterval(checkTimeout, 5000);

    // Visibility change listener (runs check when user returns to tab)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        checkTimeout();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      events.forEach((evt) => document.removeEventListener(evt, handleActivity));
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [unlocked]);

  if (!unlocked) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeSync />
        {isTauri() ? (
          <PasswordGate onUnlocked={() => setUnlocked(true)} />
        ) : (
          <LoginGate onUnlocked={() => setUnlocked(true)} />
        )}
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
