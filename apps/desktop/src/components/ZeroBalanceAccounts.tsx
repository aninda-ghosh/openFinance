import { Eye, EyeOff } from "lucide-react";
import { useAppStore } from "@/stores/app.store";

/**
 * Zero-balance accounts (a paid-off loan, an emptied card) are hidden from the
 * account lists by default; one remembered toggle brings them back. Only the
 * LISTS are filtered — a zero balance contributes nothing to any total, so
 * every sum and chart is identical either way.
 */

/** Below half a cent in the account's own currency counts as zero. */
export function isZeroBalance(a: { balance?: number | null }): boolean {
  return Math.abs(a.balance ?? 0) < 0.005;
}

export function useZeroBalanceFilter<T extends { balance?: number | null }>(
  accounts: T[]
): { visible: T[]; hiddenCount: number } {
  const show = useAppStore((s) => s.showZeroBalanceAccounts);
  if (show) return { visible: accounts, hiddenCount: 0 };
  const visible = accounts.filter((a) => !isZeroBalance(a));
  return { visible, hiddenCount: accounts.length - visible.length };
}

/** The global switch, shown on the Accounts page tab bar. */
export function ZeroBalanceToggle() {
  const show = useAppStore((s) => s.showZeroBalanceAccounts);
  const setShow = useAppStore((s) => s.setShowZeroBalanceAccounts);
  const Icon = show ? Eye : EyeOff;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={show}
      onClick={() => setShow(!show)}
      title={
        show
          ? "Hide accounts with a zero balance"
          : "Show accounts with a zero balance"
      }
      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap ${
        show
          ? "bg-primary/10 border-primary/30 text-primary"
          : "border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40"
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      Zero-balance accounts: {show ? "shown" : "hidden"}
    </button>
  );
}

/** Inline hint under a list that has hidden rows, with a one-click reveal. */
export function HiddenZeroBalanceNotice({ count }: { count: number }) {
  const setShow = useAppStore((s) => s.setShowZeroBalanceAccounts);
  if (count <= 0) return null;
  return (
    <p className="text-xs text-muted-foreground text-center pt-2">
      {count} account{count === 1 ? "" : "s"} with a zero balance hidden ·{" "}
      <button
        type="button"
        onClick={() => setShow(true)}
        className="font-semibold text-primary hover:underline"
      >
        Show
      </button>
    </p>
  );
}
