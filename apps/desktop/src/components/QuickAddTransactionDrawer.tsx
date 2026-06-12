import { Coins, X } from "lucide-react";
import TransactionForm from "@/components/TransactionForm";
import { useAppStore } from "@/stores/app.store";

export default function QuickAddTransactionDrawer() {
  const { quickAddOpen, setQuickAddOpen } = useAppStore();

  if (!quickAddOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:items-center sm:justify-center md:inset-auto md:bottom-20 md:right-6 md:w-[500px] md:h-auto md:max-h-[85vh]">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-background/85 backdrop-blur-sm md:bg-transparent md:backdrop-blur-none transition-opacity"
        onClick={() => setQuickAddOpen(false)}
      />

      {/* Drawer Body */}
      <div className="relative w-full max-w-lg md:max-w-[500px] bg-card border border-border shadow-2xl rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden max-h-[92dvh] md:max-h-[83vh] transition-all duration-300 ease-out">
        {/* Drawer Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-muted/20 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Coins className="w-4 h-4 text-primary animate-pulse" />
            <h2 className="text-sm font-semibold tracking-tight">
              Quick Add Transaction
            </h2>
          </div>
          <button
            onClick={() => setQuickAddOpen(false)}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <TransactionForm
          mode="create"
          onSuccess={() => setQuickAddOpen(false)}
          className="flex-1 min-h-0"
        />
      </div>
    </div>
  );
}
