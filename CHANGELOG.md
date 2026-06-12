# Changelog

All notable changes to Finwise are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [4.1.0] — 2026-06-12

### Added

- **Envelope category on every transfer.** The transfer form now always offers the budget envelope picker — required when the transfer crosses the YNAB boundary (On-Budget → Off-Budget), optional otherwise. Previously the picker only appeared for boundary-crossing transfers, and not at all in some views.
- **Cross-currency transfers from Quick Add.** When the source and destination accounts use different currencies, the form now asks for the exact amount received on the destination side instead of assuming a 1:1 amount (previously only possible from the account detail sheet).

### Changed

- **One shared transaction form everywhere.** Expense, income, and transfer entry and editing previously used four divergent UIs — the Quick Add drawer, the mobile Quick Add page, the Transactions-page edit dialog (plain HTML selects), and the account detail sheet's inline forms. All of them now render a single `TransactionForm` component with the full Quick Add experience: segmented type tabs, large amount input, account card chips with balances, searchable envelope selector with budget progress bars, income category pills, predictive payees, and date/notes.
- Off-budget accounts now appear as account choices in Quick Add, making transfers to off-budget accounts (and the boundary-crossing envelope rule) reachable from there.

### Fixed

- **Editing a transfer from the Transactions page silently failed.** The old edit dialog always sent payee/amount/envelope in the update, which the server rejects for transfer legs (HTTP 400). The unified edit form sends only date and notes for transfers and shows the other fields locked with an explanation (transfers must be deleted and recreated to change amounts, accounts, or envelopes).
- Transfers can now be edited (date and notes) from the account detail sheet — the edit button was previously hidden for transfer rows.

## [4.0.1] — 2026-06-11

### Fixed

- **iOS Home-Screen PWA bottom dead strip.** Recent iOS under-reports `100dvh` in standalone mode, leaving a blank band below the app. A `display-mode: standalone` media override now uses exact `100vh` heights for installed web apps while keeping dynamic `dvh` in Safari browser tabs.
- **Favicon runtime regression.** The theme-sync effect was rewriting the icon link back to the raw 2000×2000 logo PNG on every theme change, overriding the proper multi-size favicons.
- **Mobile dialog and sheet ergonomics.** Dialogs now cap at 85dvh and scroll internally (form fields could previously be pushed off-screen behind the iPhone keyboard), and side/bottom sheets pad for the notch and home-indicator safe areas instead of rendering under them.
- **iOS Safari polish.** Removed the grey tap-highlight flash on every touch and stopped Safari from inflating font sizes when rotating to landscape.

## [4.0.0] — 2026-06-11

### Added

- **One-Command Docker Deployment.** New `./scripts/deploy.sh` deploys the whole stack: it verifies Docker is installed (pointing to the installer — and auto-starting Docker Desktop on macOS — if needed), generates `JWT_SECRET` and `POSTGRES_PASSWORD` into `.env` automatically, builds and starts the containers, and waits until the app is healthy. No manual environment configuration required.
- **Single-File Compose Stack.** The full stack — Nginx-served web UI, Hono API server, and PostgreSQL — is defined in one `docker-compose.yml` with inline Dockerfiles and Nginx config. The compose project is named `openfinance`, and PostgreSQL data and uploaded documents persist in named volumes (`openfinance_pgdata`, `openfinance_uploads`).
- **At-Rest Encryption in Server Mode.** Uploaded documents and AI chat memories are now AES-256-GCM encrypted on disk in the Docker deployment, using an `ENCRYPTION_KEY` generated automatically by `deploy.sh` (previously encryption only applied to the desktop build). Existing plaintext documents are encrypted in place automatically at server startup, and chat memories persist in a new `openfinance_chat-memories` volume.
- **Configurable Ollama Server.** The AI assistant's Ollama endpoint and model are now runtime settings managed from the new **Settings → AI Assistant** card (with connection test and installed-model listing), stored in the database. Nothing is hardcoded: point the chat at any reachable Ollama server. Resolution order is in-app setting → `OLLAMA_URL`/`OLLAMA_MODEL` env vars → `http://localhost:11434`.

### Changed

- **PostgreSQL only.** SQLite support has been removed entirely — local development and deployment both use PostgreSQL. The dual-dialect database layer (`table-helper.ts`, the cross-dialect `runTransaction`, the raw-SQL sqlite shim) is gone, the server bundle is now fully self-contained pure JavaScript (no native modules, no compiler toolchain in the Docker build), and `better-sqlite3-multiple-ciphers` was dropped from the dependencies.
- **Transaction integrity pass.** All multi-step writes now run inside database transactions through a single shared insert path (`insertTransactionTx`) that keeps envelope budgets in sync: recurring transactions apply atomically (no more duplicates after a crash, envelope spent now updates), CSV import is all-or-nothing (one bad row no longer poisons the PostgreSQL transaction and loses the batch), transfer legs can no longer be desynced by editing one side (date/notes sync to both legs; amount/account changes are rejected), account creation seeds its starting balance atomically, backup restore and data reset roll back fully on failure, and duplicate imports are detected race-free via the unique index.
- **Proper favicons.** The web portal now ships real favicon assets (multi-size `favicon.ico`, 16/32 px PNGs, 180 px apple-touch-icon, 192/512 px PWA icons) generated from the openFinance logo, so the icon shows in the browser tab and bookmarks instead of a raw 2 MP image.
- The chat page's offline banner now links to the AI Assistant settings instead of trying to start a local Ollama process, and model names shown in chat reflect the configured model instead of a hardcoded default.

### Removed

- **macOS DMG Packaging.** Removed the `build-dmg.sh` pipeline and the universal Node sidecar bundler (`copy-sidecar.mjs`). The project now targets self-hosted Docker deployment with browser access instead of a native macOS desktop build.
- **FIRE Calculator.** Removed the FIRE (Financial Independence, Retire Early) calculator page, its sidebar entry, and its help documentation.

## [3.1.0] — 2026-06-07

### Added

- **Full Project Rebrand to openFinance.** Renamed the project and updated all user-facing branding names (window titles, sidebar labels, chatbot names, and help dialogs) to use `openFinance`.
- **New Universal Logo Integration.** Updated browser favicons, sidebar, PWA descriptors, and generated platform-specific application icons (macOS `.icns`, Windows `.ico`, Android, and iOS formats) from the new `OpenFinance.png` logo asset.
- **Improved Backup and Restore support.** Exported backup files now default to the new `.ofb` (openFinance backup) extension, while the restore file dialog is updated to accept both `.ofb` and legacy `.fwb` files for seamless backwards compatibility.

## [3.0.5] — 2026-06-07

### Fixed

- **Timezone-Shift Date Formatting Bug.** Resolved the timezone-shift date formatting bug across all account detail, transaction, debt, and investment feeds. The dates now parse component-by-component in the system's local timezone instead of defaulting to UTC, preventing dates from displaying shifted by one day behind in UTC-negative zones.

## [3.0.4] — 2026-06-07

### Added

- **Tauri Single-Instance Window Focusing.** Registered the `tauri-plugin-single-instance` plugin to focus the existing application window and exit immediately when a second copy of the app is opened.
- **Idempotent Developer Sidecar Server.** Programmed a fast TCP probe on port `3001` before spawning the sidecar server, skipping spawning if the dev server is already running concurrently.
- **Unified Cross-Dialect Transaction Runner.** Created a new database transaction helper that automatically routes transaction queries. On PostgreSQL (production/web) it executes using native async transactions, and on SQLite (desktop sidecar) it runs manual SQL commands (`BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`) directly on the connection, resolving the synchronous promise constraints of the `better-sqlite3` driver.

## [3.0.3] — 2026-06-06

### Added

- **Encrypted Backup Export and Import.** Implemented full backup encryption where data is encrypted using AES-256-GCM via a key derived from the user's password, ensuring exported ZIP files are unreadable without the passcode and automatically decrypted on import.

## [3.0.2] — 2026-06-03

### Added

- **Universal macOS Architecture Support.** Added native compilation and runtime packaging for both Apple Silicon (`aarch64`) and Intel (`x86_64`) processors, producing a Universal macOS App that runs natively on older and newer MacBooks alike.
- **Embedded Zero-Dependency Node.js Runtimes.** Replaced launcher script dependency with the actual native Node.js binaries copied directly into the sidecars. The script automatically fetches the required target architecture binary from nodejs.org at build time.
- **Robust Cache & Journal Wipe.** Extended Tauri's Rust data-wipe command to clean up SQLite transaction rollback journals (`.db-journal`) and caches alongside the database, encrypted files, and conversation logs.

### Fixed

- **CommonJS ESM Interop Startup Crash.** Injected a `createRequire` banner at the top of the compiled backend bundle to prevent CommonJS packages (such as `adm-zip`) from throwing a `Dynamic require of "fs" is not supported` runtime error on startup.

## [3.0.1] — 2026-05-31

### Added

- **Asynchronous AI Chat Harness.** Introduced a decoupled server-side `ChatHarness` coordinator that processes local AI streams and tool calling in a background promise. Even if the user navigates away or disconnects, the analysis completes and commits the results to the database automatically.
- **Multi-Device Live Progress Tracker.** Added a premium visual **Active Financial Task** card in the chat UI. Displays a real-time checklist of executed tools (`✓ get_net_worth`, `✓ calculate`) on all connected devices, automatically re-attaching and catching up with active background streams on mount.
- **Secure Math Calculator Tool.** Programmed a custom, highly secure recursive descent arithmetic parser with zero external dependencies and zero `eval`/`Function` execution risks. Registered the `calculate` tool to allow the local model to perform math operations on-demand.
- **Foolproof Tool/API Selection Guide.** Injected a concise **API & Tool Selection Map** directly into the financial advisor system prompt and optimized function metadata, guiding the local model to accurately map user intents to the correct tools.
- **Mobile Transactions Feed.** Enabled the Transactions tab in mobile bottom navigation, complete with a beautiful, chronological date-grouped card list, horizontal swipe filters, and dynamic inline deletion capabilities.
- **iPhone Notch & Safe Area Compliance.** Added global landscape/portrait safe-area fit margins to perfectly slide and render all screens and headers underneath modern phone status bars.
- **Unified Version UI.** Relocated app version badges to the top-right header areas on both desktop (nested elegantly in Sidebar logo block) and mobile (glassmorphic notch-respecting floating badge).
- **API Flow Intent Verification.** Integrated robust Sonner alerts across all 6 main transaction/transfer forms and category categorizers to explicitly notify users if a database entry is unfulfilled on failure.
- **Sankey Unused Funds Label.** Re-labeled the simulated savings surplus node inside the Reports Cash Flow Sankey chart to **Unused** to correctly reflect unassigned monthly funds.

## [3.0.0] — 2026-05-31

### Added

- **Inactivity Auto-Logout Security.** Implemented an industry-grade 5-minute inactivity session lock. Listens for user input events (clicks, scrolls, typing) and combines periodic checks with visibility focus hooks to immediately wipe auth tokens and prompt for passcode verification upon screen unlocks or wakes.
- **Date-Grouped Investment History Feed.** Restructured the value history list of standalone investment instruments (e.g. 401K) into date-grouped feeds with sticky headers, matching check/savings pages.
- **Mobile Mode Layout Pruning.** Optimized the mobile bottom navigation bar to exactly 4 clean, balanced tabs: Dashboard, Cash Flow, Budget, and AI Chat.
- **Mobile Floating Quick Add.** Enabled the premium floating action button (FAB) on mobile, positioned elegantly 20px above the bottom navigation bar to trigger the Quick Add drawer.

## [2.0.3] — 2026-05-31

### Added

- **Running Balance Column.** Added a dynamic, chronological backward-running balance column next to transaction amounts inside both Checking & Savings and Debt/Liabilities drawers, and the main mixed-account paginated Transactions register.
- **Date-Grouped chronological Feed.** Refactored side-drawer transaction lists into highly scannable chronological feeds grouped under sticky section Date Headers, giving payee names full horizontal breathing width and eliminating text wrapping or clipping.

### Fixed

- **Private Document Git Purge.** Successfully rewrote repository Git history and force-pushed to `origin/main`, completely deleting all traces of accidental local statement PDF commits while keeping your local physical files untouched.
- **Uploads Ignored Integration.** Configured root `.gitignore` to completely ignore `apps/server/uploads/` to prevent future bank statement staging or leaks.

## [2.0.2] — 2026-05-31

### Added

- **Automated Live Carryover Integration.** Connected the Cash Flow reports and stat cards directly to the live database carryover balance (`data.carryover`). Spans dynamic "Prior Month Leftover" source nodes for surpluses and "Prior Month Overspent" outflow nodes for deficits automatically.
- **Dynamic 3-Column / 4-Column Balanced Sankey.** Overhauled the Sankey diagram layout to dynamically detect if there are envelope expenses rendered. If none exist, it automatically re-centers columns (`COL0=15`, `COL1=440`, `COL2=865`) as a balanced 3-column flow spanning the entire width of the card.
- **Left-Aligned Gutter Labels.** Shifted final-column text labels to draw on the left side of the nodes (`textAnchor="end"`), preventing any visual horizontal clipping at the card edges.
- **Full-Bleed Visual Polish.** Removed default card padding on the Sankey card, allowing the SVG lines to blend perfectly with card borders, while maintaining standard indentation on headers and skeletons.
- **AI Chat mobile text input auto-grow.** Implemented a robust, cross-browser JavaScript auto-grow effect for the AI Chat text input area (`ChatPage.tsx`) that scales height dynamically based on input content `scrollHeight` (up to `144px`), fully resolving paragraph clipping issues in Safari on mobile iOS.

### Fixed

- **Sankey Node Value Scale Fix.** Fixed a bug where small-height nodes in the Sankey diagram (like simulated prior deficits under `$100` relative to large `$11k` income flows) rendered as `$0.00` by removing the conditional check `gn.h > 10 ? gn.group.total : 0`.
- **Database Envelope Alignment Correction.** Resolved a database mismatch where a single May transaction (`9YpVOOxXHq4H-L0kZdzCy`, `$742.57`) was incorrectly linked to a June envelope ID, causing a phantom `$742.57` uncategorized May expense badge. Realigned it to the correct May Splitwise envelope, balancing the May budget to exactly `$0.00` and clearing the warning badge.

---

## [2.0.1] — 2026-05-30

### Fixed

- **Envelope Budgeting Mismatch Resolution.** Aligned `totalExpenses` and envelope spent calculations in the backend (`getMonthlySummary`) to correctly include boundary-crossing or envelope-assigned transfers, resolving the `$6,829.29` mathematical discrepancy.
- **Global Auto-Refresh Cache Hook.** Integrated a global `MutationCache` in `QueryClient` that automatically invalidates and refetches active dashboard views, cashflows, and net-worths on any successful data mutation.
- **Off-Budget Filter support.** Added `off_budget` filters in list transactions API to cleanly separate on-budget transactions from off-budget net worth valuations on the main budgeting page.

---

## [2.0.0] — 2026-05-29

### Added

- **Ultra-Premium Deep Organic Obsidian Dark Mode.** Upgraded the dark mode styling (`App.css`) from cold bluish-indigo to a highly refined sage-green and emerald accented midnight obsidian theme (`oklch(0.12 0.006 150)` background, `oklch(0.14 0.007 150)` sidebar, `oklch(0.17 0.008 150)` cards) matching the light theme organic design system.
- **Enhanced Legibility Contrast.** Elevated secondary subtext and labels (`--muted-foreground`) to `oklch(0.72 0.008 150)` (72% lightness) for pristine, high-contrast readability.
- **Global Card Border Standardization.** Purged all ad-hoc thin borders (`border-primary/10`, `border-primary/15`, etc.) from all views so they all cleanly inherit standard cards (`border border-border/80 border-b-2 border-b-border/95 shadow-sm`), guaranteeing a 100% consistent tactile look without ad-hoc styling variations.
- **Modernized Calculator-Style Amount Input.** Redesigned the Amount container into a borderless, glassmorphic obsidian card (`bg-card rounded-3xl p-6`). Set currency symbol to a light, sophisticated weight (`text-4xl font-light text-muted-foreground/60`) and amount digits to `text-5xl font-semibold` to mimic high-end hardware interfaces.
- **Sleek Symmetrical Mobile Bottom Navigation.** Re-architected mobile Bottom Navigation (`BottomNav.tsx`) to exactly 4 symmetrical, equal-width tabs: Net Worth (`/networth`), Budget (`/budget`), Quick Add (`/quick-add`, with an accented emerald trigger), and More (`MoreHorizontal` icon).
- **Consolidated More Actions Grid.** Moved all remaining 9 workspace links under a beautiful slide-up bottom drawer sheet with a 4-column actions grid over a soft frosted backdrop.
- **Linear/Vercel-inspired Submit Actions.** Replaced retro all-caps `LOG TRANSACTION` with a beautifully curved `Log Transaction` button with clean letter-spacing and soft shadow drop.
- **Sophisticated Dismiss FAB Style.** Shifted the Quick Add close button state from loud, neon red to a quiet, elegant, low-contrast muted charcoal (`from-muted to-muted/80 text-muted-foreground border-border/40`).

### Fixed

- **Typography Baseline Alignment Glitch.** Fixed vertical centering between the currency symbol and input amount box using flexbox geometric `items-center` and collapsed `leading-none` line-heights, achieving perfect horizontal alignment.
- **Large Numeric Digit Clipping.** Enlarged the dynamic inline width multiplier of the amount input box from `1.25` to `1.65` to prevent text clipping at larger `text-5xl` font sizes.
- **Predictive Tag Spacing and Shape Overhaul.** Softened recent payee pills from heavy solid outlines to lightweight tag pills (`border-border/60 bg-card hover:bg-primary/5 text-xs font-medium text-muted-foreground`).

---

## [1.0.7] — 2026-05-29

### Added

- **iOS Dynamic Safe Area and Notch Color-Bleed System.** Added support for dynamic safe area color matching to eliminate ugly solid black bar gaps on the top (notch/status bar) and bottom (home indicator) of modern iPhone and mobile devices:
  - Configured `html`, `body`, and `#root` elements to utilize `100dvh` (Dynamic Viewport Height) to expand the webview boundary behind safe areas completely.
  - Implemented dynamic DOM syncing of the `<meta name="theme-color">` header inside the `ThemeSync` component. The safe area background seamlessly matches the active theme color (`#FAF8F5` Ivory in light mode, and `#090C11` Obsidian in dark mode) dynamically as the user toggles settings, providing a 100% native mobile app feel.

---

## [1.0.6] — 2026-05-29

### Added

- **Mobile Navigation Bar Quick Add Button Cutout.** Scaled up the mobile Bottom Navigation bar's central Quick Add button to a bold `h-14 w-14` profile and centered it perfectly (`-mt-7`) to form a stunning floating crescent edge on the top border. Integrated a thick `border-4 border-background` ring to mimic a fluid, high-end cutout layout and wrapped it in a brand-indigo shadow glow.
- **Global Translucent Blended Borders.** Transitioned global `--border` and `--input` tokens from static opaque greys to modern alpha-translucent custom properties (`oklch(0 0 0 / 0.04)` in light mode, and `oklch(1 0 0 / 0.06)` in dark mode). Boundaries now mathematically blend into any background (ivory, obsidian, cards, badges) dynamically.
- **Adaptive Depth Shadows.** Mapped global shadows (`--shadow-sm`, `--shadow-md`, `--shadow-lg`) to light/dark adaptive CSS custom variables, delivering feather-light shadows in light mode and rich, deep obsidian shadows in dark mode.
- **Selector Dropdown Menu Overhaul.** Upgraded `SelectContent` dropdown popover inside `select.tsx` from sharp `ring-1 ring-foreground/10` and narrow `rounded-lg` corners to a gorgeous `rounded-2xl border border-border shadow-lg` popup, matching the card visual language.

### Fixed

- **Layout Scroll-Free Mobile Logger.** Tightened vertical padding, segmented tab margins, card chip dimensions, and button spacings on the Quick Add transaction page, saving over 110px of vertical space to ensure it fits perfectly within standard viewports with **no scrolling**. Added a global `.no-scrollbar` styling block to hide scrollbars completely.
- **TypeScript Import Compiler Validation.** Cleaned up an unused `ArrowLeft` import in `QuickAddPage.tsx` to maintain 100% strict compiler builds.

---

## [1.0.5] — 2026-05-29

### Added

- **Universal Secure Document Storage.** Expanded the secure local file storage system to support all accounts on the balance sheet (Checking, Savings, Credit Cards, and Loans). Documents can now be attached to any holding or account dynamically.
- **Account Drawer Tab Integration.** Integrated the secure drag-and-drop document dropzone inside the budgeting module's `AccountDetailSheet` drawer, giving users a seamless choices between transaction logs and monthly statements.
- **Dedicated Unified Documents Page.** Developed a gorgeous centralised Documents dashboard (`/documents`) displaying a master directory of files across all investments and accounts. Highlights include space consumption charts, type-aware filtering (PDF, Sheet, Image, other), full-text search, and direct-upload dialogues.

---

## [1.0.4] — 2026-05-29

### Added

- **Secure Document Storage for Investments.** Built a premium full-stack secure file storage system allowing users to attach brokerage contract notes, mutual fund statements, and PDFs to specific investments. Files are written securely to a local disk folder (`uploads/documents/`) with metadata stored in PostgreSQL.
- **Premium Drag-and-Drop Document Interface.** Integrated a drag-and-drop file upload dropzone with file size formatting, file type icons (PDF, Spreadsheet, Image, generic), metadata badges (investment name, asset class, currency, and value), and native browser-inline PDF viewing.
- **Compressed ZIP Backup and Restore.** Upgraded the Backup & Restore endpoints to package JSON database dumps alongside physical local disk uploads (`uploads/documents/`) into a single compressed `.zip` archive, securing full offline data portability.

---

## [1.0.3] — 2026-05-28

### Added

- **New Screenshots & Detailed Monorepo Tree.** Updated `README.md` to reference 13 new high-quality UI screenshots and a comprehensive monorepo project tree.

### Fixed

- **Database Reset Foreign-Key Crash.** Fixed the `/api/reset` endpoint by importing and deleting `recurring_transactions` in the correct child-first order before deleting accounts, preventing PostgreSQL foreign-key constraint violations.
- **JSON Backup Policy & Investment History Schema Constraints.** Updated `sample-data.json` to strictly include required not-null schema properties for value histories and policies (`premium_term_years`, `policy_term_years`, `maturity_date`, `sum_assured`, `maturity_value`), preventing 500 PostgresErrors during backup import.

---

## [1.0.2] — 2026-05-28

### Added

- **Copy Last Month's Budget manually.** Exposed a highly reliable "Copy Last Month's Budget" button on the frontend to manually copy budgeted amounts and custom budget currencies from the most recent previous month that has configured budgets.
- **Clear Budget amounts.** Added a "Clear Budget" button next to copy actions to instantly reset all budgeted values to `0.00` for the current month while keeping existing envelopes and currency configurations.

### Fixed

- **Strict compiler flags for unused imports.** Resolved compilation failures by cleaning unused imports and types in the budget and settings modules to ensure a flawless Vite HMR and build process.

---

## [1.0.1] — 2026-05-28

### Added

- **Envelope copy-seeder for budgeted amounts.** Modified the auto-seeding template function to dynamically copy the previous month's actual budgeted amounts and custom budget currencies to the new month, replacing the hardcoded `0` budgeted amount and `"INR"` fallback.
- **Standalone investment badges.** Added a clean and neutral Standalone tag next to investment holdings that do not link to any parent checking, savings, or investment cash account.
- **UI Error Toast Notifications.** Added standard `onError` callback handlers to investment creation mutations to instantly trigger a visible toast error if validation or backend issues occur.

### Fixed

- **Envelope duplicate seeding race conditions.** Added an in-memory active promise map (`activeSeeds`) alongside a database transaction check to prevent concurrent double-inserts of envelopes when a new month is opened concurrently by frontend components.
- **Standalone investment backend validation error.** Made the `account_id` field explicitly `nullable()` in the `CreateInvestmentSchema` to cleanly allow standalone investment creations to pass Hono API validations.

---

## [1.0.0] — 2026-05-27

### Added

- **Transfer warning on transaction deletion.** Added descriptive confirmation messages warning about automatically cascading deletes when deleting a transaction that is part of a transfer pair, implemented across Checking/Savings details, Debt details, Investments list, and the global Transactions log.
- **Foreign-key safe database reset.** Reordered the truncation/reset sequence of database tables to safely handle foreign-key constraints.

### Fixed

- **Multi-currency conversion in Debt view.** Replaced static is-not-INR checks with dynamic default currency checks. Rupee accounts now correctly display their converted USD (or user default base currency) equivalents, while base currency (USD) accounts hide redundant conversion figures.
- **Signed bookkeeping mathematics.** Eliminated arbitrary `Math.abs` operations in financial calculations across the backend and the Net Worth/Debt pages, ensuring assets and liabilities sum correctly using standard sign conventions.
- **Investments editing Standalone clearing bug.** Allowed nullable Zod schemas and passed explicit `null` when standalone investment option is selected.
- **Zod validation max limit.** Reduced pre-deletion queries from `1000` to `200` to avoid Zod max limits which triggered `400 Bad Request` errors.

---

## [0.9.0-beta] — 2026-05-16

### Added

- **Envelope transaction drill-down.** Clicking an envelope name or its spent amount in the Budget table opens a side sheet listing every transaction that affected that envelope for the current month. Each row shows the payee (with transfer notes substituted for the generic "Transfer in/out" label), type badge, date, account name, and amount — green for credits, red for debits.
- **Transfer In credits envelopes.** The envelope balance formula is now `budgeted + transfer_ins − expenses − transfer_outs`. Transfers received into an account can now be assigned a "Credit envelope", which reduces net spent and improves the available balance. All sync points (create, update, delete, account delete, monthly summary) updated with the correct sign logic.
- **"Debit / Credit envelope" picker on transfers.** The category dropdown on the transfer form now adapts to direction: "Send from" shows **Debit envelope** (charges the envelope), "Deposit into" shows **Credit envelope** (reduces net spent). The picker resets when switching direction. Previously the envelope picker appeared for both directions but always debited, causing accidental charges on incoming transfers.
- **Portfolio breakdown percentages.** Each row in the Investments → Portfolio Breakdown legend now shows the allocation percentage alongside the dollar amount (e.g. `$50,475  29.9%`).

### Fixed

- **Envelope incorrectly charged by "Deposit into" transfers.** When recording a deposit into an account and selecting an envelope, the charge landed on the outgoing leg of the source account — making the envelope look overspent even though no money left the budget. The envelope picker for the "Deposit into" direction now correctly credits instead of debits.

---

## [0.8.0-beta] — 2026-05-09

### Fixed

- **Transfer deletion left envelopes over-charged.** When deleting either leg of a transfer pair, the envelope reversal only checked the single transaction clicked — not both legs. Deleting the "Transfer in" side skipped the reversal entirely because only the "Transfer out" side carries `envelope_id`. Both legs are now fetched before the delete and any envelope charges are reversed regardless of which side triggered the deletion.
- **Deleting an account left envelopes over-charged.** `deleteAccount` bulk-deleted all transactions for the account without reversing their envelope contributions first. Expense and outgoing-transfer transactions with a category assigned would leave the envelope `spent` counter permanently inflated. The delete now fetches and reverses all such charges before removing the transactions.

### Added

- **Category dropdown in Debt page — Make Payment dialog.** Debt payments can now be tagged with a budget category so the payment is tracked against the correct envelope (e.g. "Car Loan EMI", "Credit Card Payment").
- **Category dropdown in Investments page — Linked Account transfer tab.** Transfers to/from investment and savings accounts can now be assigned a budget category, charged against the outgoing (budget-account) side of the transfer.
- **Bi-directional transfer toggle in Budget account sheets.** Every account's transaction sheet now has a "Send from / Deposit into" direction toggle on the Transfer tab, matching what the Investments sheet already had. This lets you record an incoming payment directly from a debt account's own sheet instead of having to navigate to the source account.

---

## [0.7.8-beta] — 2026-05-08

### Fixed

- **AI chat streaming: words concatenated with no spaces.** The SSE data parser used `.trim()` on the `data:` field value. The SSE spec says to strip exactly one leading space (the separator after `data:`), not all whitespace. When a token is a single space character, `.trim()` collapsed it to an empty string and it was dropped — causing every word to run together in the streamed output. Fixed by using `raw.startsWith(" ") ? raw.slice(1) : raw` instead.

---

## [0.7.7-beta] — 2026-05-08

### Changed

- **Currency support trimmed to 7.** Removed AUD, CAD, HKD, and TWD. Supported currencies are now: **INR, USD, SGD, GBP, EUR, JPY, NTD**. Updated across the Zod schema, DB type annotations, all UI currency selectors (Settings, Budget, Investments), the AI prompt, and FAQ text.
- **Correct locale per currency.** Each currency now uses its proper `Intl.NumberFormat` locale: `en-IN` (INR), `en-US` (USD), `en-SG` (SGD), `en-GB` (GBP), `en-IE` (EUR — western comma grouping), `ja-JP` (JPY), `zh-TW` (NTD). Applied consistently in the AI tool formatter, context builder, and the shared `currency.ts` utility.

---

## [0.7.6-beta] — 2026-05-08

### Fixed

- **AI mixing currency symbols and labels** (e.g. "$26,028,884 (in INR)"). Tool results were returned as raw JSON objects full of bare INR numbers; the model was left to format and convert them itself, which it did incorrectly. Tool outputs are now formatted server-side — every monetary amount is converted to the user's display currency and formatted with the correct locale before being sent to the model. The model receives plain text like `Net Worth: $26,028` and has nothing to reinterpret.

---

## [0.7.5-beta] — 2026-05-08

### Changed

- **AI chat now uses tool calling instead of pre-loaded context.** The model no longer receives a static dump of all financial data in the system prompt. Instead it is given tools it can call on demand — `get_net_worth`, `get_envelope_summary`, `get_monthly_summary`, `get_transactions`, `get_investment_summary`, `get_policy_timeline`, `get_exchange_rates`, `refresh_investment_price`, `refresh_exchange_rates`. For each message the model decides which tools it needs, fetches only that data, and then generates its answer. General knowledge questions (investment principles, tax strategy, etc.) are answered from the model's own training without any tool call.
- **Ollama context window raised to 16 384 tokens** (`num_ctx`) on all chat and tool-calling requests. The previous default of 2 048 tokens caused the system prompt and financial snapshot to be silently truncated, which is why the model was saying amounts were "not explicitly stated."

---

## [0.7.4-beta] — 2026-05-08

### Changed

- **AI model switched to `gemma4:e2b`.** Default Ollama model changed from `gemma4:e4b` to `gemma4:e2b` across the server config, client store, and all UI references. The e2b variant is smaller and faster while maintaining the same instruction-following quality for financial queries.

### Fixed

- **AI reporting garbage budget totals.** The model was receiving individual envelope amounts with no pre-computed total and attempting to add them itself, producing a stream of raw arithmetic instead of a summary. The financial context now includes a `SUMMARY` line with pre-computed total budgeted, total spent, and total remaining before the per-envelope detail rows — the model reads the answer directly instead of calculating it.
- **AI formatting non-INR amounts with Indian number grouping.** `Intl.NumberFormat` was using the `en-IN` locale for all currencies, formatting `$275,867` as `$2,75,867`. The formatter now selects `en-IN` for INR and `en-US` for all other currencies so commas appear in the correct positions.
- **Chat streaming text rendering glitches.** Incomplete markdown syntax during token streaming (e.g. a half-written `**bold**` or fenced code block) caused the rendered output to flicker and reformat unpredictably as tokens arrived. Streaming text now renders as plain `whitespace-pre-wrap` text; ReactMarkdown is only applied to completed messages already saved to the database.
- **Chat auto-scrolling interrupting reading.** The message list was scrolling to the bottom on every streaming token, jumping the user away from content they were reading above. Scroll-on-token now only fires when the user is already within 80 px of the bottom. Scrolling to the bottom on a newly completed message is unconditional (the user just sent something).

---

## [0.7.3-beta] — 2026-05-08

### Added

- **AI chat auto-clears on currency change.** Switching the display currency in Settings now immediately clears the AI conversation history. Old responses formatted in the previous currency would have confused the model context — clearing ensures every reply after a currency switch is consistent.

### Fixed

- **AI chat reporting wrong currency.** Three bugs in the financial context passed to the model:
  - Transaction amounts were raw numbers with no currency label (e.g. `5000` instead of `₹5,000`) — the model could not tell which currency an amount was in.
  - Envelope `budgeted` value was taken from the raw budget_currency field rather than the INR-normalised `budgeted_inr`, causing mismatched units when `spent` and `available` (both in INR) were compared alongside it.
  - The system prompt hardcoded "Use ₹ for INR amounts" regardless of the user's display currency setting, conflicting with USD/SGD/etc. context data.
- **AI currency directive now prominent.** The model's display currency is now stated as the very first line of the system prompt (`IMPORTANT: The user's display currency is …`) and repeated at the top of the financial data snapshot. Small models previously ignored the currency setting buried deep in context.
- **PWA top overlap (Dynamic Island).** Replaced `pt-[env(safe-area-inset-top)]` Tailwind arbitrary value — which iOS Safari does not reliably resolve — with an inline `style={{ paddingTop: "env(safe-area-inset-top)" }}` that is guaranteed to apply at runtime.
- **PWA input zoom.** iOS Safari auto-zooms whenever a focused input has `font-size < 16 px`. With the 14 px mobile root, all inputs were at ~12 px, triggering a viewport zoom and horizontal shift on every login field tap. Added `font-size: max(16px, 1em)` globally so inputs are never below the zoom threshold.

---

## [0.7.2-beta] — 2026-05-08

### Added

- **PWA support.** Added `manifest.json` and iOS-specific meta tags (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`). The app can now be installed from Safari via "Add to Home Screen" and runs in standalone mode — all navigation stays inside the app shell instead of breaking out to Safari.

### Fixed

- **JWT token not persisting across page refreshes.** The `unlocked` state was initialized to `false` on every load, showing the login screen even when a valid token was already in `localStorage`. It now reads the token on startup and skips the login screen if one is present.
- **Expired token leaves app in broken state.** Any 401 response from the API now clears the stored token and reloads the page, sending the user back to the login screen cleanly.
- **Smaller UI on mobile.** Root font size reduced to 14 px on viewports below 768 px (up from 16 px). All `rem`-based sizes — text, padding, spacing — scale down proportionally on mobile without touching individual components.
- **PWA top overlap fixed.** Added `env(safe-area-inset-top)` padding to the root layout so app content starts below the Dynamic Island / status bar instead of rendering underneath it.
- **PWA zoom prevented.** Added `maximum-scale=1.0` to the viewport meta tag so iOS no longer scales up content in standalone mode.
- **Sidebar height corrected.** Sidebar now uses `h-full` instead of `h-[100dvh]` so it respects the top safe-area padding applied to its parent, preventing overflow.

---

## [0.7.1-beta] — 2026-05-08

### Added

- **PWA support.** Added `manifest.json` and iOS-specific meta tags (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`). The app can now be installed from Safari via "Add to Home Screen" and runs in standalone mode — all navigation stays inside the app shell instead of breaking out to Safari.
- **Auto-heal sidecar.** Added `willfarrell/autoheal` as a Docker Compose service. It monitors all containers with health checks every 30 s and automatically restarts any that enter the `unhealthy` state — covering scenarios that `restart: unless-stopped` misses (a stuck-but-running container that never exits).

### Fixed

- **AI Chat SSE stream cut off (`ERR_INCOMPLETE_CHUNKED_ENCODING`).** Nginx was buffering the `/api/ai/chat` SSE response, causing the browser to receive an incomplete chunked stream. Added a dedicated `location /api/ai/chat` block with `proxy_buffering off` and `proxy_cache off` so tokens are forwarded to the browser immediately as they arrive from the server. Proxy timeouts also increased to 300 s to accommodate long model responses.
- **Ollama container healthcheck.** Replaced `curl http://localhost:11434` with `ollama list` — the former only checked that the HTTP port was open, not that the model runtime was ready. The new check also uses a longer `start_period` (30 s) and more retries (15) to handle slow first-start model initialization.

---

## [0.7.0-beta] — 2026-05-08

### Added

- **Ollama runs as a Docker service.** Ollama is now a first-class service in `docker_compose.yml` using the official `ollama/ollama` image. Models are persisted in an `ollama-data` named volume. The server waits for Ollama to be healthy before starting. No host installation of Ollama is required.
- **`deploy.sh` script.** Single command to validate the environment, build, and start all services. Checks for required variables (`POSTGRES_PASSWORD`, `JWT_SECRET`), prints defaults for optional ones, streams Docker health-check progress, and prints the local and network URLs when done.

### Changed

- **`OLLAMA_URL` default changed** from `http://host.docker.internal:11434` to `http://ollama:11434` — resolved via Docker's internal DNS instead of a host network bridge.

### Removed

- **`extra_hosts: host.docker.internal:host-gateway`** removed from the server service — no longer needed now that Ollama is a container on the same Docker network.

---

## [0.6.0-beta] — 2026-05-08

### Added

- **Mobile bottom navigation.** A fixed bottom tab bar (Dashboard, Budget, Transactions, AI Chat, More) appears on mobile viewports. The "More" sheet surfaces Investments, Debt, Policies, Help & FAQ, and Settings. Fully respects iOS safe-area insets (home indicator / Dynamic Island).

### Fixed

- **iOS Safari viewport cutoff.** Root layout switched from `h-screen` (`100vh`) to `h-[100dvh]` (dynamic viewport height), which excludes the Safari address bar and bottom chrome. Content no longer gets clipped at the bottom on iPhone.
- **Sidebar hidden on mobile.** The sidebar now uses `hidden md:flex` — on small screens it is completely removed from layout, giving the full width to the main content area.
- **Responsive grids on Dashboard.** All hardcoded desktop-only grids fixed: stat rows (`grid-cols-4` → `grid-cols-2 md:grid-cols-4`), the main content row (`grid-cols-12` → `grid-cols-1 md:grid-cols-12`), and the bottom row (`grid-cols-3` → `grid-cols-1 md:grid-cols-3`). Net worth card now stacks vertically on mobile. Fixed-width (`w-56`) breakdown bar replaced with `w-full max-w-56`.
- **Horizontally scrollable tables on mobile.** Budget envelope table, Transactions table, Debt table, Investments portfolio and linked-accounts tables, and Policies table all get `overflow-x-auto` with a `min-width` guard — columns no longer collapse or overflow the screen.
- **Full-width sheets on mobile.** Account transaction sheets (Budget, Investments) and the Debt transaction history sheet now use `w-full` on small screens instead of a fixed pixel width that exceeded the viewport.
- **Budget page header wraps on mobile.** Month selector and action buttons (`Add Account`, `Add Transaction`) now use `flex-wrap` so they stack instead of overflowing.
- **Chat and Transactions pages clear the bottom nav.** Both pages use a fixed-height (`h-full`) flex layout; added `pb-14 md:pb-0` so the chat input bar and transaction pagination are not hidden behind the bottom navigation bar.
- **Server crash on "Start Ollama" in Docker.** The `/api/ai/start-ollama` endpoint spawned `ollama serve` without attaching an `error` listener to the child process. When `ollama` is not installed (e.g. in a Docker container), Node.js emits an unhandled `error` event that killed the server. An error listener is now attached before `child.unref()`.
- **`viewport-fit=cover` added to HTML meta tag** so iOS respects safe-area environment variables for the notch and home indicator.

---

## [0.5.0-beta] — 2026-05-07

### Added

- **App screenshots.** Ten screenshots covering all major modules — Dashboard, Budget, Transactions, Investments, Debt, Policies, AI Chat, Help & FAQ, and Settings — added to the repository and embedded in the README.

### Changed

- **README fully rewritten.** New structure includes a Prerequisites section, inline `.env` values in Quick Start, a Default column in the environment variable table, split Mac/Windows vs Linux Ollama instructions, and an updated project structure tree reflecting the current codebase.

### Infrastructure

- **Public release.** Repository open-sourced on GitHub with a clean git history. Internal migration scripts, personal data exports, and dev-only docs removed from the tree.
- **Project structure cleaned up.** Removed `extras/`, `docs/`, `.github/`, and `scripts/` directories — repository now contains only the application source.

---

## [0.4.1-beta] — 2026-05-06

### Changed

- **Frontend port changed from 8080 to 3002.** All compose files, `.env.example`, README, and ARCHITECTURE docs updated consistently. Backend remains on 3001.

### Infrastructure

- **Open-sourced.** Repository made public — migration exports and personal data excluded via `.gitignore`, fresh git history with no sensitive data in any commit.
- **`.env.example` updated** to reflect current environment variables (`JWT_SECRET`, `POSTGRES_PASSWORD`, `OLLAMA_URL`, `APP_PORT`).

---

## [0.4.0-beta] — 2026-05-05

### Added

- **Backup & Restore.** Settings now includes a Backup & Restore card. Export exports all financial data (accounts, transactions, envelopes, investments, policies, recurring transactions, AI conversations, and exchange rates) as a single JSON file. Import replaces all existing data from a previously exported file, with a confirmation dialog showing row counts before committing.
- **Production Docker Compose** (`docker-compose.prod.yml`). A separate compose file for deployment — uses build-from-source, only exposes the frontend port, and requires `JWT_SECRET` and `POSTGRES_PASSWORD` to be set via environment variables.
- **GitHub Actions CI.** Lint check (Biome) runs automatically on push and pull requests to `main`.
- **Theme-aware logo.** Sidebar and browser favicon now switch automatically between the dark and light logo variants (`Finwise-Dark.png` / `Finwise-Light.png`) based on the active theme, including when "System" mode follows the OS preference.

### Security

- `JWT_SECRET` is now required at server startup — the server throws immediately if the variable is not set rather than falling back to a weak hardcoded default.

### Fixed

- **AI Chat 401 Unauthorized errors.** The chat stream was sent via the browser's native `EventSource` API, which cannot attach custom headers — so the JWT token was never transmitted. Replaced with a `fetch`-based SSE reader that attaches `Authorization: Bearer <token>`, matching how every other API call in the app authenticates.
- Updating an account's type or currency via the edit sheet was silently ignored — `UpdateAccountSchema` was missing those two fields, so Zod stripped them before they reached the database. Both fields are now included as optional in the schema.
- Portfolio summary and net worth on the Dashboard now correctly count both investment holdings (from the `investments` table) and linked off-budget account balances, rather than only one source.

## [0.3.0-beta] — 2026-05-03

### Added

- **Investment account linking from Investments page.** The Linked Accounts section now shows permanently (even when empty) with an "Add Account" button that creates a real off-budget savings/investment account directly from the Investments page — no need to go to Budget first.
- **Transfer tab in Linked Account sheet.** Clicking a linked account on the Investments page now opens a sheet with income / expense / transfer tabs, so you can move money to/from investment accounts without switching to Budget.
- **Investment Accounts strip on Budget page.** Off-budget savings and investment accounts now appear as clickable cards below the regular account strip on the Budget page, with the full transfer-capable sheet.
- **Debt module.** Track credit cards and loans with outstanding balances, institution names, and payment recording via transfers. Debt is subtracted from net worth on the Dashboard.
- **Changelog viewer in Settings.** The About section now includes a "View Changelog" button showing the full release history in-app.

### Changed

- **Help & FAQ page fully rewritten** to match the actual state of the app: corrected data storage (PostgreSQL, not SQLite), accurate currency support (11 currencies everywhere; debt limited to INR/USD/SGD/NTD), fixed AI connection troubleshooting path (Settings → API Server), updated Danger Zone documentation (two levels: Clear Transactions and Reset All Data), added Savings Account to investment asset types, removed the unimplemented rollover configuration section, added new Debt and Active Month sections.
- **Version display unified.** Settings "About" badge now reads `__APP_VERSION__` from `package.json` instead of being hardcoded, so sidebar and Settings always show the same version.

### Fixed

- Investment holdings created via "Add Investment" are now clearly distinct from transferable linked accounts. The Linked Accounts section explains the difference with an empty-state message.

---

## [0.2.0] — 2026-05-02

### Changed — Architecture

- **Switched database from SQLite/SQLCipher to PostgreSQL 16.** All Drizzle schema types migrated from `drizzle-orm/sqlite-core` (`sqliteTable`, `real`, `integer({mode:"boolean"})`) to `drizzle-orm/pg-core` (`pgTable`, `doublePrecision`, `boolean`).
- **Removed Tauri desktop app.** Finwise is now a pure web application served by Nginx + Docker Compose. No Rust/Tauri dependency.
- **Added Docker Compose deployment.** Three services: `postgres` (data), `server` (Hono API), `frontend` (Nginx + React). Run with `docker compose up --build`.
- **Replaced password-as-DB-key auth (Tauri Keychain) with JWT auth.** Username + password stored in `users` table (PBKDF2-SHA512 + HMAC-SHA256 JWT). Tokens valid for 30 days.
- **Schema migrations now run automatically on server startup** via `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` DDL in `src/index.ts`. No separate migration CLI step needed.
- **All database transactions converted from synchronous SQLite to async PostgreSQL.** Five sync `db.transaction()` blocks in `budget.service.ts` rewritten as `async (tx) => {}`.

### Added

- `JWT_SECRET` environment variable for signing tokens (previously reused the DB encryption key).
- `./utils/hash` subpath export in `@finwise/shared` package so server can import `hashRow` without bundling Node.js crypto into the frontend.
- Currency enum for accounts and investments expanded to the full 11-currency set (INR, USD, SGD, GBP, EUR, AUD, JPY, TWD, HKD, CAD, NTD) to match envelope budget currency support.

### Removed

- `better-sqlite3-multiple-ciphers` and `@types/better-sqlite3` dependencies.
- `FINWISE_DB_KEY` environment variable (no longer needed).
- `DB_PATH` environment variable (no longer needed).
- `db/key-manager.ts` — DB key derivation from macOS Keychain / env var.
- Tauri-specific Vite config (strict port 1420, TAURI_DEV_HOST, HMR over websocket).
- `PasswordGate` component is now dead code (kept in tree, not rendered).

---

## [0.1.0] — 2026-04-01

### Added — Initial release

- Envelope budgeting with monthly rollover (none / amount / leftover).
- Multi-currency accounts (INR, USD, SGD, NTD) with live exchange rates via open.er-api.com.
- CSV transaction import with SHA-256 deduplication.
- Recurring transactions (weekly / monthly / quarterly / annual) applied on server startup.
- Investment portfolio tracking (mutual funds, stocks, ETFs, FDs, bonds, real estate, cash, structured, savings, other).
- Insurance policy manager with premium schedule and payout timeline.
- AI Chat powered by local Ollama (Drizzle-backed conversation history, tool calls logged).
- Three income sub-categories: Income, Cashback, Starting Balances — rendered as collapsible groups in the budget income section.
- Auto-created starting balance income transaction when an on-budget account is added with a positive balance.
- Dark / light / system theme toggle.
- Default display currency selector (converts all INR amounts to the chosen currency).
- Budget alerts (over-budget, approaching threshold).
- Debt page.
- FAQ page.
- Dockerized deployment (server + Nginx frontend) with `docker compose up`.
