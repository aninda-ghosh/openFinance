import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface FAQItem {
  q: string;
  a: React.ReactNode;
}

interface FAQSection {
  title: string;
  icon: string;
  items: FAQItem[];
}

const FAQ_SECTIONS: FAQSection[] = [
  {
    title: "Getting Started",
    icon: "🚀",
    items: [
      {
        q: "What is openFinance and what does it do?",
        a: "openFinance is a self-hosted personal finance app. It helps you track your budget using envelopes, manage investments across multiple currencies, monitor insurance policies, track debt, and get AI-powered financial advice — all running within your own infrastructure.",
      },
      {
        q: "Where is my data stored?",
        a: "All data is stored in a PostgreSQL database that runs as part of your local openFinance setup. Nothing is sent to any external cloud service — your data stays entirely within your own infrastructure.",
      },
      {
        q: "What currencies are supported?",
        a: (
          <span>
            Accounts, investments, and envelopes all support the same 7
            currencies: <strong>INR, USD, SGD, GBP, EUR, JPY, and NTD</strong>.
            Debt accounts are currently limited to INR, USD, SGD, and NTD.
            Exchange rates are fetched automatically every 15 minutes from
            open.er-api.com and everything is converted to your chosen default
            display currency.
          </span>
        ),
      },
      {
        q: "How do I set my default display currency?",
        a: "Go to Settings → Default Currency. All monetary values across the Dashboard, Budget, Investments, Debt, and Policies will be displayed in your chosen currency. The underlying data is always stored in the account's native currency — the conversion happens at display time.",
      },
    ],
  },
  {
    title: "Budget & Accounts",
    icon: "💳",
    items: [
      {
        q: "What is the envelope budgeting method?",
        a: (
          <span>
            Envelope budgeting means you allocate every pound/dollar of income
            to a named "envelope" (category) before you spend it. When you add
            income, it becomes available to assign. You then budget amounts into
            envelopes like Groceries, Rent, or Savings. Transactions are tagged
            to envelopes, reducing their balance. This gives you a real-time
            view of what you have left in each category — not just your bank
            balance.
          </span>
        ),
      },
      {
        q: "How do I move money between accounts?",
        a: (
          <span>
            Use <strong>Budget → Add Transaction → Transfer</strong>. Select a
            From and To account and enter the amount. If the accounts are in
            different currencies, enter both the sent and received amounts. This
            creates two linked transactions and updates both account balances.
          </span>
        ),
      },
      {
        q: "How do I invest money from my checking account without double-counting net worth?",
        a: (
          <span>
            <ol className="list-decimal ml-4 space-y-1">
              <li>
                Add an <strong>Investment-type account</strong> (e.g.
                "Brokerage") via Add Account.
              </li>
              <li>
                <strong>Transfer</strong> money from Checkings → Brokerage
                account. This moves the cash correctly.
              </li>
              <li>
                Add the holding in <strong>Investments</strong> with the
                purchase value.
              </li>
            </ol>
            <p className="mt-2">
              Investment-type accounts are automatically excluded from the "Cash
              &amp; Accounts" net worth total, since that value is already
              captured in the Investments module. No double-counting.
            </p>
          </span>
        ),
      },
      {
        q: "What does 'Ready to Assign' mean on the Dashboard?",
        a: "It's your total income for the month minus the total amount you've budgeted into envelopes. A positive number means you have unallocated income — go budget it into an envelope. Zero means every penny is assigned. A negative number means you've over-budgeted (budgeted more than you earned).",
      },
      {
        q: "How do I import bank transactions?",
        a: (
          <span>
            <p>
              CSV import is available via the API at{" "}
              <code className="bg-muted px-1 rounded text-xs">
                POST /api/budget/import?account_id=…
              </code>
              .
            </p>
            <p className="mt-2">
              The CSV must have these exact column headers:
            </p>
            <code className="block bg-muted px-2 py-1 rounded text-xs mt-1">
              date, payee, amount, type, notes
            </code>
            <ul className="list-disc ml-4 mt-2 space-y-1">
              <li>
                <strong>date</strong> — ISO format (YYYY-MM-DD)
              </li>
              <li>
                <strong>type</strong> — one of{" "}
                <code className="bg-muted px-1 rounded text-xs">income</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">expense</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">transfer</code>
              </li>
              <li>
                <strong>notes</strong> — optional
              </li>
            </ul>
            <p className="mt-2">
              Duplicate rows are automatically skipped using a SHA-256 hash of
              each row, so re-importing the same file is safe. Note: most banks
              export CSVs with different column names — you will need to rename
              the columns to match the format above before importing.
            </p>
          </span>
        ),
      },
    ],
  },
  {
    title: "Investments",
    icon: "📈",
    items: [
      {
        q: "What asset types can I track?",
        a: "Mutual Fund, Stock, ETF, FD, Savings Account, Bond, Real Estate, Cash, Structured, and Other.",
      },
      {
        q: "How is gain/loss calculated?",
        a: (
          <span>
            <code className="bg-muted px-1 rounded text-xs">
              Gain/Loss = current_value − purchase_value
            </code>{" "}
            (both converted to INR using stored exchange rates for
            cross-currency comparison). The percentage is{" "}
            <code className="bg-muted px-1 rounded text-xs">
              (gain_loss_inr / purchase_value_inr) × 100
            </code>
            .
          </span>
        ),
      },
      {
        q: "What does the Refresh Price button do?",
        a: "It records the current stored value as price history and updates the 'last updated' timestamp. There is no live market price fetching — prices are always what you manually enter.",
      },
      {
        q: "How do investments appear in net worth?",
        a: "The Investments module total is summed separately from account balances. Investment-type accounts are excluded from the account balance total so there's no double-counting when you hold cash in a brokerage account AND have logged investments.",
      },
      {
        q: "How can I group investments by category or type?",
        a: "By default, the holdings table is structured into collapsible groups based on investment types (e.g., Stocks, Mutual Funds, Fixed Deposits). You can toggle between this 'Group by Type' layout and a traditional 'Flat List' using the view selector toggle above the table.",
      },
      {
        q: "How are the totals calculated in the Group headers?",
        a: "Group headers display real-time calculated aggregate summaries (Total Purchase, Total Current, and Overall Gain/Loss) for all holdings in that asset class. Native values are converted to INR first using active exchange rates to ensure correct multi-currency summation, and then formatted into your default display currency.",
      },
    ],
  },
  {
    title: "Debt",
    icon: "💳",
    items: [
      {
        q: "What is the Debt module?",
        a: "The Debt module lets you track money you owe — credit cards and loans. Each debt entry records the outstanding balance, institution, and currency, and feeds into your net worth as a liability.",
      },
      {
        q: "What types of debt can I track?",
        a: "Credit cards and loans. You can record the current amount owed, the lending institution, and the currency. To record a repayment, use the transfer flow to move money from a budget account to the debt account, which reduces the outstanding balance.",
      },
      {
        q: "How does debt appear in net worth?",
        a: "Debt balances are stored as negative values and subtracted from your net worth total on the Dashboard. Net worth = Cash & Accounts + Investments + Policies − Debt.",
      },
      {
        q: "What currencies are supported for debt?",
        a: "Debt accounts currently support INR, USD, SGD, and NTD.",
      },
    ],
  },
  {
    title: "Policies",
    icon: "🛡️",
    items: [
      {
        q: "What kind of policies can I track?",
        a: "Any insurance or savings policy with a premium schedule and a maturity/surrender value — term life, whole life, endowment, bonds, annuities, etc.",
      },
      {
        q: "How does openFinance know when a premium is due?",
        a: "It calculates due dates from the policy's start date and frequency (monthly / quarterly / annual). The Policies page shows an alert banner for any premium due within 30 days, and the Dashboard shows upcoming scheduled receipts (policy payouts) within 90 days.",
      },
      {
        q: "What is the difference between Sum Assured and Maturity Value?",
        a: "Sum Assured is the death benefit — what is paid out if the policy is claimed. Maturity Value is what you receive if you hold the policy to term. Net worth uses Surrender Value if set, otherwise Maturity Value, as the current estimated worth of the policy.",
      },
      {
        q: "All policy amounts are in INR — can I change that?",
        a: "Currently policies are stored in INR only. The display respects your default currency and converts at display time. Multi-currency policy storage is not yet supported.",
      },
      {
        q: "How is 'Total Invested' calculated for an ongoing policy?",
        a: "The system dynamically computes your total invested amount by calculating all premium payments due between the policy's Start Date and the current date, based on the premium frequency (monthly, quarterly, semi-annual, or annual). This paid-to-date calculation is also used to synchronize your checking/savings policy account balances.",
      },
      {
        q: "What detailed policy parameters can I track?",
        a: "You can track 14 parameters including Policy Number, Provider, Start Date, Premium Frequency, Premium Term, Policy Term, Maturity Date, Sum Assured, Maturity Value, Surrender Value, and linked budget accounts.",
      },
    ],
  },
  {
    title: "AI Chat",
    icon: "🤖",
    items: [
      {
        q: "What AI model does the chat use?",
        a: "openFinance uses Ollama to run a language model on infrastructure you control. Point the app at any reachable Ollama server (your own machine, a home server, …) under Settings → AI Assistant — it defaults to http://localhost:11434. The default model is gemma4:e2b, but you can use any model installed on that server.",
      },
      {
        q: "What can the AI advisor help with?",
        a: "The AI has read access to all your financial data — accounts, transactions, envelopes, investments, policies, and debt. You can ask it things like 'Am I on track to save 20% this month?', 'Which investment is performing best?', or 'When is my next insurance premium due?'.",
      },
      {
        q: "Does the AI remember previous conversations?",
        a: "Yes. Each conversation accumulates a memory file that is injected into every new message in that conversation, giving the AI full context of what was discussed. Deleting a conversation also deletes its memory.",
      },
      {
        q: "The AI says it can't connect — what do I do?",
        a: (
          <span>
            Check the Ollama server URL under{" "}
            <strong>Settings → AI Assistant</strong> and use{" "}
            <strong>Save &amp; Test</strong> to verify the connection. Make
            sure Ollama is running on that machine (
            <code className="bg-muted px-1 rounded text-xs">ollama.com</code>)
            and that you have pulled at least one model (e.g.{" "}
            <code className="bg-muted px-1 rounded text-xs">
              ollama pull gemma4:e2b
            </code>
            ). You can also verify the backend is running under{" "}
            <strong>Settings → API Server</strong>.
          </span>
        ),
      },
    ],
  },
  {
    title: "Settings & Data",
    icon: "⚙️",
    items: [
      {
        q: "How do I update exchange rates manually?",
        a: "Go to Settings → Exchange Rates → Refresh Rates. Rates are also auto-refreshed every 15 minutes while the app is running, and once on startup.",
      },
      {
        q: "Can I reset all my data?",
        a: (
          <span>
            Settings → Danger Zone has two options:
            <ul className="list-disc ml-4 mt-1 space-y-1">
              <li>
                <strong>Clear Transactions</strong> — deletes all transactions
                and resets envelope budgets to zero, but keeps your accounts,
                envelope groups, and envelope names intact.
              </li>
              <li>
                <strong>Reset All Data</strong> — permanently deletes
                everything: accounts, transactions, envelopes, investments,
                policies, debt, and AI chat history. Requires typing a
                confirmation phrase. This action is irreversible.
              </li>
            </ul>
          </span>
        ),
      },
      {
        q: "How do I change the app theme?",
        a: "Settings → Appearance. You can choose Light, Dark, or System (follows your OS setting).",
      },
      {
        q: "How do I switch the active month for budgeting?",
        a: "Settings → Active Month. The budget and transaction views are filtered by the selected month. You can navigate up to 11 months back and one month forward.",
      },
    ],
  },
];

function FAQEntry({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 py-3.5 px-4 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="text-sm font-medium leading-snug">{item.q}</span>
        {open ? (
          <ChevronDown className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
          {item.a}
        </div>
      )}
    </div>
  );
}

export default function FAQPage() {
  const [activeSection, setActiveSection] = useState<string | null>(null);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Help & FAQ</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everything you need to know about using openFinance.
        </p>
      </div>

      {/* Section pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setActiveSection(null)}
          className={cn(
            "text-xs px-3 py-1.5 rounded-full border font-medium transition-colors",
            activeSection === null
              ? "bg-foreground text-background border-foreground"
              : "hover:bg-muted text-muted-foreground"
          )}
        >
          All
        </button>
        {FAQ_SECTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() =>
              setActiveSection(activeSection === s.title ? null : s.title)
            }
            className={cn(
              "text-xs px-3 py-1.5 rounded-full border font-medium transition-colors",
              activeSection === s.title
                ? "bg-foreground text-background border-foreground"
                : "hover:bg-muted text-muted-foreground"
            )}
          >
            {s.icon} {s.title}
          </button>
        ))}
      </div>

      {/* Sections */}
      {FAQ_SECTIONS.filter(
        (s) => activeSection === null || s.title === activeSection
      ).map((section) => (
        <div key={section.title} className="rounded-lg border overflow-hidden">
          <div className="px-4 py-3 bg-muted/50 border-b">
            <h2 className="text-sm font-semibold">
              {section.icon} {section.title}
            </h2>
          </div>
          <div>
            {section.items.map((item, i) => (
              <FAQEntry key={i} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
