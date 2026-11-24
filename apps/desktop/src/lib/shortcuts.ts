import type * as React from "react";

/**
 * Keyboard shortcut catalogue. The global handler (useKeyboardShortcuts) and
 * the "?" cheat sheet (ShortcutsDialog) both read from here so they can never
 * drift apart.
 */

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** ⌘ on macOS, Ctrl elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl";

export function isModKey(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Pages reachable with "G then <key>" and Mod+<digit>. Order matches the
 * sidebar so Mod+1…9 lines up with what the user sees.
 */
export const NAV_SHORTCUTS = [
  { to: "/dashboard", label: "Dashboard", key: "d" },
  { to: "/networth", label: "Net Worth", key: "w" },
  { to: "/reports", label: "Cash Flow", key: "f" },
  { to: "/budget", label: "Budget", key: "b" },
  { to: "/transactions", label: "Transactions", key: "t" },
  { to: "/accounts", label: "Accounts", key: "a" },
  { to: "/documents", label: "Documents", key: "o" },
  { to: "/chat", label: "AI Chat", key: "c" },
  { to: "/faq", label: "Help & FAQ", key: "h" },
  { to: "/settings", label: "Settings", key: "s" },
] as const;

export function navShortcutHint(to: string): string | undefined {
  const i = NAV_SHORTCUTS.findIndex((n) => n.to === to);
  if (i < 0) return undefined;
  const n = NAV_SHORTCUTS[i];
  const digit =
    n.to === "/settings" ? `${MOD},` : i < 9 ? `${MOD}${i + 1}` : "";
  return [`G ${n.key.toUpperCase()}`, digit].filter(Boolean).join(" · ");
}

export interface ShortcutGroup {
  title: string;
  items: { keys: string[][]; label: string }[];
}

/** Each entry in `keys` is one alternative; each alternative is a key sequence. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Transactions",
    items: [
      { keys: [["N"], [MOD, "N"]], label: "Quick add transaction" },
      { keys: [[MOD, "Shift", "N"]], label: "Bulk add (paste a statement)" },
      { keys: [[MOD, "Enter"]], label: "Save transaction (in the form)" },
      { keys: [["Esc"]], label: "Close quick add" },
      { keys: [["/"], [MOD, "K"]], label: "Search transactions" },
    ],
  },
  {
    title: "Months",
    items: [
      { keys: [["["]], label: "Previous month" },
      { keys: [["]"]], label: "Next month" },
      { keys: [["M"]], label: "Jump to this month" },
    ],
  },
  {
    title: "Navigation",
    items: [
      ...NAV_SHORTCUTS.map((n, i) => ({
        label: n.label,
        keys: [
          ["G", n.key.toUpperCase()],
          ...(n.to === "/settings"
            ? [[MOD, ","]]
            : i < 9
              ? [[MOD, String(i + 1)]]
              : []),
        ],
      })),
    ],
  },
  {
    title: "App",
    items: [
      { keys: [[MOD, "B"]], label: "Toggle sidebar" },
      { keys: [[MOD, "Shift", "L"]], label: "Lock openFinance now" },
      { keys: [["?"]], label: "Show keyboard shortcuts" },
    ],
  },
];
