import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  KeyRound,
  Lock,
  RefreshCw,
  ScrollText,
  Server,
  Upload,
  XCircle,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, BASE_URL, getToken } from "@/lib/api";
import { chatApi } from "@/modules/chat/api";
import { useAppStore } from "@/stores/app.store";

const CHANGELOG: {
  version: string;
  date: string;
  sections: { label: string; items: string[] }[];
}[] = [
  {
    version: "3.0.1",
    date: "2026-05-31",
    sections: [
      {
        label: "Added",
        items: [
          "Mobile Transactions Feed — enabled the Transactions tab in mobile bottom navigation, complete with a beautiful, chronological date-grouped card list, horizontal swipe filters, and dynamic inline deletion capabilities.",
          "iPhone Notch & Safe Area Compliance — added global landscape/portrait safe-area fit margins to perfectly slide and render all screens and headers underneath modern phone status bars.",
          "Unified Version UI — relocated app version badges to the top-right header areas on both desktop (nested elegantly in Sidebar logo block) and mobile (glassmorphic notch-respecting floating badge).",
          "API Flow Intent Verification — integrated robust Sonner alerts across all 6 main transaction/transfer forms and category categorizers to explicitly notify users if a database entry is unfulfilled on failure."
        ],
      },
    ],
  },
  {
    version: "3.0.0",
    date: "2026-05-31",
    sections: [
      {
        label: "Added",
        items: [
          "Inactivity Auto-Logout Security — implemented an industry-grade 5-minute inactivity session lock. Listens for user input events (clicks, scrolls, typing) and combines periodic checks with visibility focus hooks to immediately wipe auth tokens and prompt for passcode verification upon screen unlocks or wakes.",
          "Date-Grouped Investment History Feed — restructured the value history list of standalone investment instruments (e.g. 401K) into date-grouped feeds with sticky headers, matching check/savings pages.",
          "Mobile Mode Layout Pruning — optimized the mobile bottom navigation bar to exactly 4 clean, balanced tabs: Dashboard, Cash Flow, Budget, and AI Chat.",
          "Mobile Floating Quick Add — enabled the premium floating action button (FAB) on mobile, positioned elegantly 20px above the bottom navigation bar to trigger the Quick Add drawer."
        ],
      },
    ],
  },
  {
    version: "2.0.3",
    date: "2026-05-31",
    sections: [
      {
        label: "Added",
        items: [
          "Running Balance Column — added a dynamic, chronological backward-running balance column next to transaction amounts inside the Checking & Savings details drawer, Debt details drawer, and the main mixed-account paginated Transactions register.",
          "Date-Grouped Chronological Feed — refactored side-drawer transaction lists into highly scannable chronological feeds grouped under sticky section Date Headers, giving payee names full horizontal breathing width and eliminating text wrapping or clipping."
        ],
      },
      {
        label: "Fixed",
        items: [
          "Private Document History Purge — successfully rewrote repository Git history and force-pushed to origin/main, completely deleting all traces of accidental local statement PDF commits while keeping your local physical files untouched.",
          "Uploads Ignored Integration — configured root .gitignore to completely ignore apps/server/uploads/ to prevent future statement staging or leaks."
        ],
      },
    ],
  },
  {
    version: "2.0.2",
    date: "2026-05-31",
    sections: [
      {
        label: "Added",
        items: [
          "Automated Live Carryover Integration — connected Cash Flow reports and stat cards directly to live database carryover balance (data.carryover), spawning dynamic prior leftover source nodes or overspent outflow nodes automatically.",
          "Dynamic Balanced Sankey Layout — automatically shifts from 4-column to a perfectly centered 3-column layout (COL0=15, COL1=440, COL2=865) if there are no envelope expenses, maximizing card width usage.",
          "Left-Aligned Gutter Labels — shifted final column text labels to the left of the nodes (textAnchor='end'), preventing any text boundary clipping or overlapping at the right card edge.",
          "Full-Bleed Visual Polish — removed card padding on the Sankey container to let SVG paths flow beautifully edge-to-edge with the card borders.",
          "AI Chat Mobile Text Input Auto-Grow — implemented a robust JavaScript auto-resize listener that scales the input box height based on scrollHeight (up to 144px), resolving mobile Safari paragraph clipping."
        ],
      },
      {
        label: "Fixed",
        items: [
          "Sankey Node Value Scale — resolved a bug where small-height nodes formatted as $0.00 by removing the conditional h > 10 threshold check from the amount formatter.",
          "Database Envelope Alignment — corrected a cross-month database mismatch where a May transaction ($742.57) was incorrectly linked to a June envelope, balancing May's budget to exactly $0.00 and clearing the header badge."
        ],
      },
    ],
  },
  {
    version: "2.0.1",
    date: "2026-05-30",
    sections: [
      {
        label: "Fixed",
        items: [
          "Envelope Budgeting Mismatch — aligned totalExpenses and envelope spent logic in the Hono backend to correctly capture envelope-assigned transfers, resolving the $6.8k budget discrepancy.",
          "Global Auto-Refresh Mutations — integrated a global React Query MutationCache that automatically refetches active dashboard, cashflow, and net-worth queries on any successful data change.",
          "Off-Budget Transaction Separator — added off_budget filter support to cleanly separate on-budget transfers from off-budget net worth holding valuations."
        ],
      },
    ],
  },
  {
    version: "2.0.0",
    date: "2026-05-29",
    sections: [
      {
        label: "Added",
        items: [
          "Deep Organic Obsidian Dark Mode — completely redesigned dark mode using warm sage-green and emerald-accented charcoal obsidian shades, delivering rich layered depth, gorgeous pop contrast, and unified brand aesthetics.",
          "Enhanced Legibility Contrast — boosted muted foreground subtexts to 72% lightness for pristine, comfortable readability of labels and details.",
          "Global Card Border Standardization — purged all custom thin primary borders globally, enabling all cards to cleanly and consistently inherit standard tactile card boundaries.",
          "Modernized Amount Input screen — designed a sleek borderless card block, scaled up numeric input to 5xl, and softened the currency symbol for a clean, premium calculator-like feel.",
          "Symmetrical Mobile Bottom Navigation — simplified the mobile view nav bar to 4 equal-width, balanced tabs: Net Worth, Budget, Quick Add, and More.",
          "Consolidated More Actions grid — moved all 9 remaining workspace links into a slide-up More drawer bottom sheet in a grid over a frosted blur backdrop.",
          "Linear/Vercel-inspired Submit button — upgraded log transaction triggers to clean, curved, title-cased buttons with soft drop shadows.",
          "Subtle close FAB style — changed the Quick Add close button background state from neon red to a quiet, elegant muted charcoal."
        ],
      },
      {
        label: "Fixed",
        items: [
          "Horizontal Baseline Alignment — resolved the vertical baseline offset between the currency symbol and input amount using items-center and leading-none.",
          "Large Numeric Input text-clipping — enlarged the dynamic width multiplier to 1.65 to guarantee digits are never cut off at larger font sizes.",
          "Clipped Dashboard Donut chart — scaled the Portfolio Breakdown donut chart container to 125px and inner radius to 38 (76px diameter) so long texts are perfectly enclosed."
        ],
      },
    ],
  },
  {
    version: "2.0.0",
    date: "2026-05-29",
    sections: [
      {
        label: "Fixed",
        items: [
          "iOS 26 PWA Black Bar / Chin Gap — resolved a Safari viewport shift caused by combining black-translucent status bar style with viewport-fit=cover on iOS 26 Liquid Glass. Switched to the default status bar style and moved to explicit env(safe-area-inset-top) CSS padding, eliminating the phantom black bar at the bottom of the screen.",
          "PWA Manifest Theme Color — updated background_color and theme_color in manifest.json to match the actual app light-mode background so iOS fills safe area zones with the correct warm off-white instead of black.",
        ],
      },
    ],
  },
  {
    version: "1.0.7",
    date: "2026-05-29",
    sections: [
      {
        label: "Improved",
        items: [
          "Global translucent border design — replaced all opaque grey borders with subtly translucent oklch borders (4% black in light mode, 6% white in dark mode) for a deeply blended, premium card feel.",
          "Adaptive organic shadow system — introduced light and dark-adaptive CSS shadow tokens (--card-shadow-sm/md/lg) for soft, natural depth without harsh outlines.",
          "Quick-Add floating button — redesigned the center tab-bar button with a gradient indigo-to-violet pill, thick background-colored border ring, and glow shadow for a premium floating effect.",
          "Scrolling removed from Quick-Add sheet — modal no longer scrolls; layout is compact and center-aligned for a snappy one-tap experience.",
        ],
      },
    ],
  },
  {

    version: "1.0.5",
    date: "2026-05-29",
    sections: [
      {
        label: "Added",
        items: [
          "Universal Secure Document Storage — extended the secure local storage filesystem to support all standard budget and balance sheet accounts.",
          "Account Drawer Tab Integration — added sliding tabs to AccountDetailSheet allowing seamless navigation between transactions and document dropzones.",
          "Dedicated Unified Documents Page — built a gorgeous centralized Documents dashboard page showcasing storage KPIs, search, format filters, and parent group pills.",
        ],
      },
    ],
  },
  {
    version: "1.0.4",
    date: "2026-05-29",
    sections: [
      {
        label: "Added",
        items: [
          "Secure Document Storage for Investments — built full-stack secure file uploads to a local folder (uploads/documents/) with metadata in PostgreSQL.",
          "Premium Drag-and-Drop Document Interface — added drag-and-drop secure file dropzone with size & type formatters and inline PDF rendering.",
          "Compressed ZIP Backup & Restore — re-engineered backup & restore using adm-zip to bundle SQL JSON data alongside all physical folders into a single compressed .zip file.",
        ],
      },
    ],
  },
  {
    version: "1.0.3",
    date: "2026-05-28",
    sections: [
      {
        label: "Added",
        items: [
          "New Screenshots & Detailed Monorepo Tree — updated the documentation with 13 beautiful screenshots and a complete monorepo project tree.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Database Reset Foreign-Key Crash — fixed the database reset functionality by clearing recurring transactions first, avoiding constraint violations.",
          "JSON Backup Policy & Investment History Constraints — updated the sample seeder backup data to strictly conform to all table not-null constraints.",
        ],
      },
    ],
  },
  {
    version: "1.0.2",
    date: "2026-05-28",
    sections: [
      {
        label: "Added",
        items: [
          "Copy Last Month's Budget manually — added a header action to manually copy envelopes, budgeted amounts, and custom currencies from the previous month.",
          "Clear Budget amounts — added a 'Clear Budget' button next to copy actions to instantly reset all budgeted values to 0.00 for the current month.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Strict compiler flags for unused imports — cleaned up unused imports and variables in budget and settings modules to ensure a flawless Vite HMR and build process.",
        ],
      },
    ],
  },
  {
    version: "1.0.1",
    date: "2026-05-28",
    sections: [
      {
        label: "Added",
        items: [
          "Envelope copy-seeder for budgeted amounts — auto-seeding template function dynamically copies the previous month's budgeted amounts and currencies to the new month.",
          "Standalone investment badges — added clean and neutral Standalone tag next to investment holdings that do not link to any parent cash/savings account.",
          "UI Error Toast Notifications — added standard error callback handlers to investment creation mutations to instantly trigger a visible toast error on validation failures.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Envelope duplicate seeding race conditions — introduced an in-memory active promise map alongside a database transaction check to prevent concurrent double-inserts of envelopes when a new month is opened concurrently.",
          "Standalone investment backend validation error — made the account_id field explicitly nullable in CreateInvestmentSchema to cleanly allow standalone investment creations to pass Hono API validations.",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-05-27",
    sections: [
      {
        label: "Added",
        items: [
          "Transfer warning on transaction deletion — added safety confirmation messages warning about cascade deletion across all transaction detail views and logs.",
          "Foreign-key safe database reset — reordered table resets to prevent constraint violation errors.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Multi-currency conversion in Debt view — dynamic base currency checking hides redundant USD-to-USD conversion and correctly displays USD equivalent for rupee accounts.",
          "Clean signed bookkeeping mathematics — removed all absolute value overrides across Hono API services, Net Worth, and Debt views to align with strict double-entry conventions.",
          "Investments editing Standalone clearing bug — standalone investments can now cleanly clear parent account relationships.",
          "Zod validator max limit — reduced pre-deletion transaction scans from 1000 to 200 to avoid Zod limits causing 400 Bad Request errors.",
        ],
      },
    ],
  },
  {
    version: "0.9.0-beta",
    date: "2026-05-16",
    sections: [
      {
        label: "Added",
        items: [
          "Envelope transaction drill-down — click any envelope name or spent amount in the Budget table to inspect its current month transactions sheet.",
          "Transfer In credits envelopes — modified envelope balances to properly factor in transfers received to reduce net spent.",
          "Debit / Credit envelope picker on transfers — dynamic envelope picker dropdown on the transfer form that adapts to direction.",
          "Portfolio breakdown percentages — Investments Portfolio Legend now shows actual asset allocation percentages.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Envelope incorrectly charged by 'Deposit into' transfers — incoming transfers now properly credit instead of debiting.",
        ],
      },
    ],
  },
  {
    version: "0.8.0-beta",
    date: "2026-05-09",
    sections: [
      {
        label: "Fixed",
        items: [
          "Transfer deletion envelope reversal — deleting a transfer pair now correctly reverses envelope charges for both legs.",
          "Account deletion envelope reversal — reversing all category spent counters before account deletion.",
        ],
      },
      {
        label: "Added",
        items: [
          "Category dropdown in Debt page Make Payment dialog — tag debt payments directly to specific envelopes.",
          "Category dropdown in Investments page Linked Account transfers.",
          "Bi-directional transfer toggle in Budget account sheets.",
        ],
      },
    ],
  },
  {
    version: "0.7.8-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Fixed",
        items: [
          "AI chat streaming words space truncation — fixed regex data parser trimming spaces causing words to run together.",
        ],
      },
    ],
  },
  {
    version: "0.7.7-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Changed",
        items: [
          "Currency support trimmed to 7 — INR, USD, SGD, GBP, EUR, JPY, NTD.",
          "Locale support per currency — configured individual number formatting per currency locale dynamically.",
        ],
      },
    ],
  },
  {
    version: "0.7.6-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Fixed",
        items: [
          "AI tool output formatting — all amounts are converted and formatted on the server-side to prevent models from generating incorrect currency symbols.",
        ],
      },
    ],
  },
  {
    version: "0.7.5-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Changed",
        items: [
          "AI model tool calling — switched model from static data dump to dynamic on-demand tool calls.",
          "Ollama context window raised to 16,384 tokens to avoid prompt truncation.",
        ],
      },
    ],
  },
  {
    version: "0.7.4-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Changed",
        items: [
          "AI model default switched to faster speed gemma4:e2b.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "AI reporting wrong budget totals — pre-computed summaries are sent directly in model context.",
          "Mobile/Safari layout adjustments — dynamic viewports (100dvh) and viewport fit adjustments.",
        ],
      },
    ],
  },
  {
    version: "0.7.3-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Added",
        items: [
          "AI chat auto-clears when display currency is changed in Settings — prevents old responses in the previous currency from confusing the model.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "AI chat currency accuracy — transaction amounts now show with currency symbol, envelope budgeted value was using wrong currency field, and the system prompt no longer hardcodes ₹ regardless of your display currency setting.",
          "AI currency directive is now the first line the model reads, making it impossible to ignore on small models.",
          "PWA top overlap (Dynamic Island) — replaced Tailwind arbitrary env() value with an inline style that iOS Safari actually applies.",
          "PWA input zoom — inputs now have font-size: max(16px, 1em) so iOS never auto-zooms the viewport when tapping a field.",
        ],
      },
    ],
  },
  {
    version: "0.7.2-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Added",
        items: [
          "PWA support — install from Safari via 'Add to Home Screen'. Runs in standalone mode; all navigation stays inside the app shell instead of breaking out to Safari.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "JWT token not persisting across page refreshes — login screen no longer appears after a refresh when a valid token is already stored.",
          "Expired token now cleanly logs you out instead of leaving the app in a broken state.",
          "Smaller UI on mobile — root font size reduced to 14 px on small screens so all text and spacing scales down proportionally.",
          "PWA top overlap fixed — app content now starts below the Dynamic Island / status bar using env(safe-area-inset-top).",
          "PWA zoom prevented — maximum-scale=1.0 stops iOS from scaling up content in standalone mode.",
        ],
      },
    ],
  },
  {
    version: "0.7.1-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Added",
        items: [
          "Auto-heal sidecar — willfarrell/autoheal monitors all containers every 30 s and restarts any that become unhealthy, covering cases that restart: unless-stopped misses.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "AI Chat SSE stream cut off (ERR_INCOMPLETE_CHUNKED_ENCODING) — Nginx now forwards tokens to the browser immediately with proxy_buffering off on the /api/ai/chat route.",
          "Ollama healthcheck now uses 'ollama list' instead of a raw HTTP check, with a longer start period to handle slow first-start initialization.",
        ],
      },
    ],
  },
  {
    version: "0.7.0-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Added",
        items: [
          "Ollama runs as a Docker service — no host installation required. Models persist in a named volume.",
          "deploy.sh — validates required env vars, builds, starts all services, and prints access URLs.",
        ],
      },
      {
        label: "Changed",
        items: [
          "OLLAMA_URL now defaults to http://ollama:11434 (Docker internal DNS) instead of host.docker.internal.",
        ],
      },
    ],
  },
  {
    version: "0.6.0-beta",
    date: "2026-05-08",
    sections: [
      {
        label: "Added",
        items: [
          "Mobile bottom navigation bar — Dashboard, Budget, Transactions, AI Chat, and a More sheet for the rest. Respects iOS safe-area insets.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "iOS Safari viewport cutoff — switched root layout to dynamic viewport height (100dvh) so content is no longer clipped by the browser chrome.",
          "Sidebar hidden on mobile — full viewport width given to content on small screens.",
          "Responsive grids on Dashboard — all stat rows and content grids now collapse to 1–2 columns on mobile.",
          "Horizontally scrollable tables on mobile — Budget, Transactions, Debt, Investments, and Policies tables no longer overflow the screen.",
          "Full-width sheets on mobile — account and transaction sheets now fill the screen instead of overflowing.",
          "Chat and Transactions pages clear the bottom nav — input bar and pagination are no longer hidden behind the navigation bar.",
          "Server crash when clicking 'Start Ollama' in Docker — unhandled ENOENT spawn error no longer kills the server process.",
        ],
      },
    ],
  },
  {
    version: "0.5.0-beta",
    date: "2026-05-07",
    sections: [
      {
        label: "Added",
        items: [
          "App screenshots — ten screenshots covering all major modules added to the repository and README.",
        ],
      },
      {
        label: "Changed",
        items: [
          "README fully rewritten — prerequisites section, inline .env values in Quick Start, split Mac/Linux Ollama instructions, updated project structure.",
        ],
      },
      {
        label: "Infrastructure",
        items: [
          "Public release — repository open-sourced on GitHub with a clean git history.",
          "Project cleaned up — extras/, docs/, .github/, and scripts/ removed from the tree.",
        ],
      },
    ],
  },
  {
    version: "0.4.1-beta",
    date: "2026-05-06",
    sections: [
      {
        label: "Changed",
        items: [
          "Frontend port changed from 8080 to 3002 — updated across all compose files, .env.example, README, and docs. Backend stays on 3001.",
        ],
      },
      {
        label: "Infrastructure",
        items: [
          "Repository open-sourced — migration exports and personal data excluded, fresh git history.",
          ".env.example updated to reflect current environment variables.",
        ],
      },
    ],
  },
  {
    version: "0.4.0-beta",
    date: "2026-05-05",
    sections: [
      {
        label: "Added",
        items: [
          "Backup & Restore in Settings — export all financial data as a JSON file and restore from it with a single click.",
          "Production Docker Compose (docker-compose.prod.yml) for self-hosted deployment.",
          "GitHub Actions CI — Biome lint check runs on every push and pull request.",
          "Theme-aware logo — sidebar switches between dark and light logo variants based on the active theme.",
        ],
      },
      {
        label: "Security",
        items: [
          "JWT_SECRET is now required at startup — the server refuses to start if the variable is not set.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "AI Chat 401 errors — replaced EventSource (no custom headers) with a fetch-based SSE reader that sends the Authorization token.",
          "Editing an account's type or currency was silently ignored — both fields are now included in the update schema.",
          "Portfolio summary and net worth now correctly include both investment holdings and linked off-budget account balances.",
        ],
      },
    ],
  },
  {
    version: "0.3.0-beta",
    date: "2026-05-02",
    sections: [
      {
        label: "Added",
        items: [
          "Investment account linking from Investments page — create a real off-budget account directly from the Linked Accounts section.",
          "Transfer tab in Linked Account sheet — move money to/from investment accounts without switching to Budget.",
          "Investment Accounts strip on Budget page — off-budget savings and investment accounts appear as clickable cards below the regular account strip.",
          "Debt module — track credit cards and loans; debt is subtracted from net worth on the Dashboard.",
          "Changelog viewer in Settings.",
        ],
      },
      {
        label: "Changed",
        items: [
          "Help & FAQ page fully rewritten to match the actual state of the app (PostgreSQL storage, correct currency lists, accurate settings paths, Debt and Active Month sections added).",
          "Settings version badge now reads from package.json — sidebar and Settings always show the same version.",
        ],
      },
      {
        label: "Fixed",
        items: [
          "Investment holdings (Add Investment) and transferable linked accounts are now clearly distinct, with an empty-state explanation in the Linked Accounts section.",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-05-02",
    sections: [
      {
        label: "Changed — Architecture",
        items: [
          "Switched database from SQLite/SQLCipher to PostgreSQL 16.",
          "Removed Tauri desktop app — now a pure web app served by Nginx + Docker Compose.",
          "Replaced password-as-DB-key auth with JWT auth (PBKDF2-SHA512 + HMAC-SHA256, 30-day tokens).",
          "Schema migrations run automatically on server startup.",
        ],
      },
      {
        label: "Added",
        items: [
          "JWT_SECRET environment variable for signing tokens.",
          "Currency enum expanded to full 11-currency set (INR, USD, SGD, GBP, EUR, AUD, JPY, TWD, HKD, CAD, NTD).",
        ],
      },
      {
        label: "Removed",
        items: [
          "better-sqlite3-multiple-ciphers and related dependencies.",
          "OPENFINANCE_DB_KEY and DB_PATH environment variables.",
          "db/key-manager.ts — DB key derivation from macOS Keychain.",
        ],
      },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-04-01",
    sections: [
      {
        label: "Added — Initial release",
        items: [
          "Envelope budgeting with monthly rollover.",
          "Multi-currency accounts with live exchange rates via open.er-api.com.",
          "CSV transaction import with SHA-256 deduplication.",
          "Recurring transactions (weekly / monthly / quarterly / annual).",
          "Investment portfolio tracking (mutual funds, stocks, ETFs, FDs, bonds, real estate, cash, structured, savings).",
          "Insurance policy manager with premium schedule and payout timeline.",
          "AI Chat powered by local Ollama with conversation history.",
          "Dark / light / system theme toggle.",
          "Debt page.",
          "FAQ page.",
          "Dockerized deployment (server + Nginx frontend).",
        ],
      },
    ],
  },
];

const LABEL_COLORS: Record<string, string> = {
  Added: "text-green-600 dark:text-green-400",
  "Added — Initial release": "text-green-600 dark:text-green-400",
  Changed: "text-blue-600 dark:text-blue-400",
  "Changed — Architecture": "text-blue-600 dark:text-blue-400",
  Fixed: "text-yellow-600 dark:text-yellow-400",
  Removed: "text-red-500",
  Security: "text-orange-600 dark:text-orange-400",
  Infrastructure: "text-purple-600 dark:text-purple-400",
};

function ChangelogDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <ScrollText className="w-3.5 h-3.5" />
          View Changelog
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Changelog</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto space-y-6 pr-1">
          {CHANGELOG.map((release) => (
            <div key={release.version}>
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="outline" className="font-mono text-xs">
                  {release.version}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {release.date}
                </span>
              </div>
              <div className="space-y-3">
                {release.sections.map((section) => (
                  <div key={section.label}>
                    <p
                      className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${LABEL_COLORS[section.label] ?? "text-muted-foreground"}`}
                    >
                      {section.label}
                    </p>
                    <ul className="space-y-1">
                      {section.items.map((item, i) => (
                        <li
                          key={i}
                          className="text-sm text-muted-foreground flex gap-2"
                        >
                          <span className="mt-1.5 w-1 h-1 rounded-full bg-muted-foreground/50 flex-shrink-0" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function buildMonthOptions() {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let offset = -11; offset <= 1; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    options.push({
      value: `${year}-${month}`,
      label: d.toLocaleString("en-IN", { month: "long", year: "numeric" }),
    });
  }
  return options.reverse();
}

function ServerStatus() {
  const [status, setStatus] = useState<"checking" | "online" | "offline">(
    "checking"
  );

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => setStatus(r.ok ? "online" : "offline"))
      .catch(() => setStatus("offline"));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Server className="w-4 h-4" /> API Server
        </CardTitle>
        <CardDescription>Hono API — PostgreSQL backend</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          {status === "checking" && (
            <span className="text-xs text-muted-foreground animate-pulse">
              Checking…
            </span>
          )}
          {status === "online" && (
            <>
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                Online
              </span>
            </>
          )}
          {status === "offline" && (
            <>
              <XCircle className="w-4 h-4 text-red-500" />
              <span className="text-sm text-red-600 dark:text-red-400 font-medium">
                Offline
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExchangeRatesCard() {
  const queryClient = useQueryClient();
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRates, setLastRates] = useState<
    { from_currency: string; rate_to_base: number }[]
  >([]);

  useEffect(() => {
    apiFetch<any>("/api/exchange-rates")
      .then((d) => setLastRates(d.rates ?? []))
      .catch(() => {});
  }, [defaultCurrency]);

  const formatRate = (rate: number) => {
    const localeMap: Record<string, string> = {
      INR: "en-IN",
      USD: "en-US",
      SGD: "en-SG",
      GBP: "en-GB",
      EUR: "en-IE",
      JPY: "ja-JP",
      NTD: "zh-TW",
    };
    const currencyMap: Record<string, string> = {
      INR: "INR",
      USD: "USD",
      SGD: "SGD",
      GBP: "GBP",
      EUR: "EUR",
      JPY: "JPY",
      NTD: "TWD",
    };
    const locale = localeMap[defaultCurrency] || "en-US";
    const currency = currencyMap[defaultCurrency] || "USD";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(rate);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch<any>("/api/exchange-rates/refresh", {
        method: "POST",
      });
      setLastRates(res.updated ?? []);
      await queryClient.invalidateQueries();
      toast.success(
        `Refreshed ${res.count} exchange rate${res.count !== 1 ? "s" : ""}`
      );
    } catch {
      toast.error("Exchange rate refresh failed — check network");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exchange Rates</CardTitle>
        <CardDescription>
          Live rates from open.er-api.com — used to convert foreign investments
          to {defaultCurrency}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {lastRates.length > 0 && (
          <div className="text-sm space-y-1">
            {lastRates.map((r) => (
              <div key={r.from_currency} className="flex justify-between">
                <span className="text-muted-foreground">
                  1 {r.from_currency}
                </span>
                <span className="font-medium">{formatRate(r.rate_to_base)}</span>
              </div>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={refreshing}
          className="gap-2"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
          {refreshing ? "Refreshing…" : "Refresh rates"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DataBackupCard() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [pendingBackupFile, setPendingBackupFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  // Password fallback — only shown when importing a backup from a different user/instance
  const [decryptionRequired, setDecryptionRequired] = useState(false);
  const [fallbackPassword, setFallbackPassword] = useState("");
  const [fallbackUsername, setFallbackUsername] = useState("");
  const [fallbackError, setFallbackError] = useState("");

  const exportBackup = async () => {
    setExporting(true);
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/api/backup/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `openfinance-backup-${date}.ofb`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Encrypted backup downloaded", {
        description: "Your backup is secured with your account password.",
      });
    } catch {
      toast.error("Export failed — check the server logs");
    } finally {
      setExporting(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingBackupFile(file);
    setDecryptionRequired(false);
    setFallbackPassword("");
    setFallbackUsername("");
    setFallbackError("");
    e.target.value = "";
  };

  const doImport = async (password?: string, username?: string) => {
    if (!pendingBackupFile) return;
    setImporting(true);
    try {
      const token = getToken();
      const arrayBuffer = await pendingBackupFile.arrayBuffer();
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(password ? { "x-backup-password": password } : {}),
        ...(username ? { "x-backup-username": username } : {}),
      };
      const res = await fetch(`${BASE_URL}/api/backup/import`, {
        method: "POST",
        headers,
        body: arrayBuffer,
      });

      if (res.status === 400) {
        const body = await res.json().catch(() => ({}));
        if (body?.error === "DECRYPTION_REQUIRED") {
          // Backup was made by a different user — ask for their password
          setDecryptionRequired(true);
          setFallbackError(password ? "Incorrect password — please try again." : "");
          return;
        }
        throw new Error(body?.error ?? "Import failed");
      }

      if (!res.ok) throw new Error("Import failed");

      queryClient.invalidateQueries();
      toast.success("Backup restored — all data replaced");
      setPendingBackupFile(null);
      setDecryptionRequired(false);
      setFallbackPassword("");
      setFallbackUsername("");
    } catch {
      toast.error("Import failed — check the server logs");
    } finally {
      setImporting(false);
    }
  };

  const importBackup = () => doImport();
  const importWithPassword = () => {
    if (!fallbackPassword.trim() || !fallbackUsername.trim()) return;
    doImport(fallbackPassword, fallbackUsername);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Lock className="w-4 h-4 text-positive" />
          Backup &amp; Restore
        </CardTitle>
        <CardDescription>
          Exports are automatically encrypted with your account password. Import replaces all existing data.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={exportBackup}
          disabled={exporting}
          className="gap-2"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? "Exporting…" : "Export Backup"}
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".ofb,.fwb,.zip"
          className="hidden"
          onChange={onFileChange}
        />

        {/* ── Confirm restore dialog ─────────────────────────────────── */}
        <Dialog
          open={!!pendingBackupFile && !decryptionRequired}
          onOpenChange={(o) => {
            if (!o) setPendingBackupFile(null);
          }}
        >
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5" />
              Import Backup
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5" /> Restore from backup?
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground text-left leading-relaxed">
                This will <strong>replace all existing data</strong> (including accounts, transactions, envelopes, and secure documents) with the contents of the backup file. This cannot be undone.
              </p>
              {pendingBackupFile && (
                <div className="rounded-xl border border-border/60 bg-muted/20 p-3.5 text-xs font-semibold text-muted-foreground flex items-center justify-between shadow-sm">
                  <span>Selected file:</span>
                  <span className="text-foreground font-bold font-mono">{pendingBackupFile.name}</span>
                </div>
              )}
              <Button
                className="w-full"
                disabled={importing}
                onClick={importBackup}
              >
                {importing ? "Restoring…" : "Restore Backup"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* ── Decryption fallback dialog ─────────────────────────────── */}
        <Dialog
          open={decryptionRequired}
          onOpenChange={(o) => {
            if (!o) {
              setDecryptionRequired(false);
              setPendingBackupFile(null);
              setFallbackPassword("");
              setFallbackUsername("");
              setFallbackError("");
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-amber-500" />
                Backup Password Required
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground leading-relaxed">
                This backup was encrypted with a <strong>different account</strong>. Enter the credentials that were used when this backup was created.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="backup-fallback-user" className="text-sm">Username</Label>
                <Input
                  id="backup-fallback-user"
                  type="text"
                  placeholder="Enter backup username"
                  value={fallbackUsername}
                  onChange={(e) => {
                    setFallbackUsername(e.target.value);
                    setFallbackError("");
                  }}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="backup-fallback-pw" className="text-sm">Password</Label>
                <Input
                  id="backup-fallback-pw"
                  type="password"
                  placeholder="Enter backup password"
                  value={fallbackPassword}
                  onChange={(e) => {
                    setFallbackPassword(e.target.value);
                    setFallbackError("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && importWithPassword()}
                />
                {fallbackError && (
                  <p className="text-xs text-destructive">{fallbackError}</p>
                )}
              </div>
              <Button
                className="w-full"
                disabled={importing || !fallbackPassword.trim() || !fallbackUsername.trim()}
                onClick={importWithPassword}
              >
                {importing ? "Decrypting & Restoring…" : "Unlock & Restore"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function DataResetCard() {
  const queryClient = useQueryClient();

  // ── Clear transactions only ───────────────────────────────────────────────
  const [txOpen, setTxOpen] = useState(false);
  const [txResetting, setTxResetting] = useState(false);

  const clearTransactions = async () => {
    setTxResetting(true);
    try {
      await apiFetch("/api/reset/transactions", { method: "POST" });
      queryClient.invalidateQueries();
      toast.success(
        "Transactions cleared — accounts and envelopes are intact."
      );
      setTxOpen(false);
    } catch {
      toast.error("Clear failed — check the server logs.");
    } finally {
      setTxResetting(false);
    }
  };

  // ── Reset everything ──────────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const PHRASE = "delete all my data";

  const reset = async () => {
    if (confirm !== PHRASE) return;
    setResetting(true);
    try {
      await apiFetch("/api/reset", { method: "POST" });
      queryClient.invalidateQueries();
      toast.success("All data deleted — the app is now fresh.");
      setOpen(false);
      setConfirm("");
    } catch {
      toast.error("Reset failed — check the server logs.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <Card className="border-red-200 dark:border-red-900">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4" /> Danger Zone
        </CardTitle>
        <CardDescription>
          Permanently delete all your data — accounts, transactions,
          investments, policies, AI conversations, and everything else.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        {/* Level 1 — clear transactions only */}
        <Dialog open={txOpen} onOpenChange={setTxOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              Clear Transactions
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="text-red-600 dark:text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> Clear all transactions?
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                This will delete all transactions and reset envelope budgets to{" "}
                <strong>$0</strong>. Your accounts, envelope groups, and
                envelope names will be kept intact.
              </p>
              <Button
                variant="destructive"
                className="w-full"
                disabled={txResetting}
                onClick={clearTransactions}
              >
                {txResetting ? "Clearing…" : "Clear Transactions"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Level 2 — nuke everything */}
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setConfirm("");
          }}
        >
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">
              Reset All Data
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="text-red-600 dark:text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> Are you absolutely sure?
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                This will permanently delete <strong>everything</strong> — all
                accounts, transactions, envelopes, investments, policies, and AI
                chat history. This cannot be undone.
              </p>
              <div>
                <Label className="text-sm">
                  Type{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {PHRASE}
                  </span>{" "}
                  to confirm
                </Label>
                <Input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={PHRASE}
                  className="mt-2"
                />
              </div>
              <Button
                variant="destructive"
                className="w-full"
                disabled={confirm !== PHRASE || resetting}
                onClick={reset}
              >
                {resetting ? "Deleting…" : "Delete Everything"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

const SUPPORTED_CURRENCIES = [
  "INR",
  "USD",
  "SGD",
  "GBP",
  "EUR",
  "JPY",
  "NTD",
] as const;

export default function SettingsPage() {
  const {
    selectedMonth,
    setSelectedMonth,
    theme,
    setTheme,
    defaultCurrency,
    setDefaultCurrency,
  } = useAppStore();
  const monthOptions = buildMonthOptions();
  const queryClient = useQueryClient();
  const [updatingCurrency, setUpdatingCurrency] = useState(false);

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Active Month */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Month</CardTitle>
          <CardDescription>
            Budget and transaction views are filtered by this month.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="month-select">Selected Month</Label>
            <select
              id="month-select"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm bg-background"
            >
              {monthOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Currently viewing:{" "}
              <span className="font-medium text-foreground">
                {selectedMonth}
              </span>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Theme */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>Choose your preferred color theme.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {(["light", "dark", "system"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`flex-1 py-2 rounded-md border text-sm font-medium capitalize transition-colors ${theme === t ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300" : "border-border hover:bg-muted"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Default Currency */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Default Currency</CardTitle>
          <CardDescription>
            Base currency for the entire app — all budget amounts, balances, and
            totals are displayed in this currency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_CURRENCIES.map((c) => (
              <button
                key={c}
                disabled={updatingCurrency}
                onClick={async () => {
                  if (c === defaultCurrency) return;
                  try {
                    setUpdatingCurrency(true);
                    await apiFetch("/api/exchange-rates/base-currency", {
                      method: "POST",
                      body: JSON.stringify({ base_currency: c }),
                      headers: {
                        "Content-Type": "application/json",
                      },
                    });
                    setDefaultCurrency(c);
                    chatApi.clearChat().catch(() => {});
                    await queryClient.invalidateQueries();
                    toast.success(
                      `Currency changed to ${c} globally. Exchange rates refreshed & AI chat history cleared.`
                    );
                  } catch (err: any) {
                    console.error("Failed to change base currency:", err);
                    toast.error(
                      err?.message || "Failed to update system base currency."
                    );
                  } finally {
                    setUpdatingCurrency(false);
                  }
                }}
                className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${defaultCurrency === c ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300" : "border-border hover:bg-muted"} ${updatingCurrency ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {c}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Current default:{" "}
            <span className="font-medium text-foreground">
              {defaultCurrency}
            </span>
          </p>
        </CardContent>
      </Card>

      {/* Exchange rates */}
      <ExchangeRatesCard />

      {/* Server status */}
      <ServerStatus />

      {/* Backup & restore */}
      <DataBackupCard />

      {/* Session Security */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-positive" /> Session Security
          </CardTitle>
          <CardDescription>
            Configure authentication and device safety options.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/40">
            <div className="space-y-0.5 pr-4">
              <p className="text-xs font-bold text-foreground">Auto-Logout on Inactivity</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                Automatically lock session and require passcode authentication after 5 minutes of total user inactivity on this device.
              </p>
            </div>
            <Badge variant="default" className="bg-positive text-positive-foreground font-bold text-[10px] select-none hover:bg-positive px-2.5 py-0.5 shrink-0">
              Active (5m)
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Data reset */}
      <DataResetCard />

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">About openFinance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>Version</span>
              <Badge variant="outline">{__APP_VERSION__}</Badge>
            </div>
            <ChangelogDialog />
          </div>
          <p>
            Personal finance manager. Your data is stored in PostgreSQL and
            stays within your own infrastructure.
          </p>
          <p>
            AI powered by{" "}
            <span className="font-medium text-foreground">
              Ollama gemma4:e2b
            </span>{" "}
            running locally.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
