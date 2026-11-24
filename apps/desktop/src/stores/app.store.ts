import { localYearMonth } from "@openfinance/shared/utils";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  selectedMonth: string;
  sidebarCollapsed: boolean;
  theme: "light" | "dark" | "system";
  defaultCurrency: string;
  aiModel: string;
  quickAddOpen: boolean;
  /** Keyboard shortcut cheat sheet ("?"). */
  shortcutsOpen: boolean;
  /** Accounts pages: also list accounts whose balance is exactly zero. */
  showZeroBalanceAccounts: boolean;
  setShowZeroBalanceAccounts: (show: boolean) => void;
  setSelectedMonth: (month: string) => void;
  toggleSidebar: () => void;
  setTheme: (theme: AppState["theme"]) => void;
  setDefaultCurrency: (currency: string) => void;
  setAiModel: (model: string) => void;
  setQuickAddOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
}

const currentMonth = () => localYearMonth();

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      selectedMonth: currentMonth(),
      sidebarCollapsed: false,
      theme: "system",
      defaultCurrency: "USD",
      // Empty = use the server-configured default model (Settings → AI Assistant)
      aiModel: "",
      quickAddOpen: false,
      shortcutsOpen: false,
      showZeroBalanceAccounts: false,
      setShowZeroBalanceAccounts: (show) =>
        set({ showZeroBalanceAccounts: show }),
      setSelectedMonth: (month) => set({ selectedMonth: month }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setDefaultCurrency: (currency) => set({ defaultCurrency: currency }),
      setAiModel: (model) => set({ aiModel: model }),
      setQuickAddOpen: (open) => set({ quickAddOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
    }),
    {
      name: "openfinance-app",
      partialize: (state) => {
        const { quickAddOpen, shortcutsOpen, ...rest } = state;
        return rest;
      },
    }
  )
);
