import { localYearMonth } from "@openfinance/shared/utils";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isModKey, NAV_SHORTCUTS } from "@/lib/shortcuts";
import { useAppStore } from "@/stores/app.store";

/** Time allowed between "G" and the page key. */
const SEQUENCE_TIMEOUT = 1200;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return ![
    "checkbox",
    "radio",
    "button",
    "submit",
    "reset",
    "range",
    "color",
    "file",
  ].includes(type);
}

/** A Radix dialog, popover, select or menu is open and owns the keyboard. */
function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="listbox"], [role="menu"]'
  );
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Focus the page's search box, waiting for a lazily loaded page to mount. */
function focusSearch(attempt = 0) {
  const el = document.querySelector<HTMLInputElement>(
    '[data-shortcut="search"]'
  );
  if (el) {
    el.focus();
    el.select();
  } else if (attempt < 20) {
    setTimeout(() => focusSearch(attempt + 1), 50);
  }
}

export function useKeyboardShortcuts({ onLock }: { onLock: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const pendingG = useRef<number | null>(null);

  // Read the latest values inside the single long-lived listener
  const latest = useRef({ navigate, location, onLock });
  latest.current = { navigate, location, onLock };

  useEffect(() => {
    const clearPending = () => {
      if (pendingG.current !== null) clearTimeout(pendingG.current);
      pendingG.current = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;

      const store = useAppStore.getState();
      const { navigate, location, onLock } = latest.current;
      const key = e.key.toLowerCase();
      const mod = isModKey(e);

      // ── Modifier shortcuts: work even while typing in a field ──────────
      if (mod && !e.altKey) {
        if (e.shiftKey && key === "l") {
          e.preventDefault();
          onLock();
          return;
        }
        if (e.shiftKey && key === "n") {
          e.preventDefault();
          store.setQuickAddOpen(false);
          navigate("/bulk-add");
          return;
        }
        if (e.shiftKey) return;

        if (key === "n") {
          e.preventDefault();
          store.setQuickAddOpen(true);
          return;
        }
        if (key === "k" || key === "f") {
          e.preventDefault();
          store.setQuickAddOpen(false);
          if (location.pathname !== "/transactions") navigate("/transactions");
          focusSearch();
          return;
        }
        if (key === "b") {
          e.preventDefault();
          store.toggleSidebar();
          return;
        }
        if (key === ",") {
          e.preventDefault();
          navigate("/settings");
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          const target = NAV_SHORTCUTS.filter((n) => n.to !== "/settings")[
            Number(e.key) - 1
          ];
          if (target) {
            e.preventDefault();
            navigate(target.to);
          }
        }
        return;
      }

      // ── Escape closes the quick-add drawer unless something on top of it
      //    (envelope picker, select, confirm dialog) should get it first ──
      if (e.key === "Escape") {
        if (store.quickAddOpen && !overlayOpen()) {
          e.preventDefault();
          store.setQuickAddOpen(false);
        }
        return;
      }

      // ── Single-key shortcuts: never while typing or inside an overlay ──
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || overlayOpen()) {
        clearPending();
        return;
      }

      if (pendingG.current !== null) {
        clearPending();
        const target = NAV_SHORTCUTS.find((n) => n.key === key);
        if (target) {
          e.preventDefault();
          navigate(target.to);
        }
        return;
      }

      switch (e.key) {
        case "g":
          pendingG.current = window.setTimeout(clearPending, SEQUENCE_TIMEOUT);
          return;
        case "n":
          e.preventDefault();
          store.setQuickAddOpen(true);
          return;
        case "/":
          e.preventDefault();
          if (location.pathname !== "/transactions") navigate("/transactions");
          focusSearch();
          return;
        case "[":
          e.preventDefault();
          store.setSelectedMonth(shiftMonth(store.selectedMonth, -1));
          return;
        case "]":
          e.preventDefault();
          store.setSelectedMonth(shiftMonth(store.selectedMonth, 1));
          return;
        case "m":
          e.preventDefault();
          store.setSelectedMonth(localYearMonth());
          return;
        case "?":
          e.preventDefault();
          store.setShortcutsOpen(true);
          return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      clearPending();
    };
  }, []);
}
