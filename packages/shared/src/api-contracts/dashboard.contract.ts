export type DashboardResponse = {
  net_worth_inr: number;
  month: string;
  budget: {
    total_budgeted: number; // sum of envelope budgeted_inr
    total_spent: number; // sum of envelope spent (INR)
    total_available: number;
    total_income: number; // monthly income (INR)
    to_assign: number; // income - budgeted (INR)
  };
  cash_total_inr: number; // on-budget account balances (excl. debt)
  investments_total_inr: number; // investments table + linked investment accounts
  policies_total_inr: number;
  debt_total_inr: number; // total amount owed across all debt accounts
  monthly_income: number; // INR
  monthly_expenses: number; // INR
  savings_rate: number; // % (0-100), null if no income
  recent_transactions: {
    id: string;
    payee: string;
    amount: number;
    amount_inr: number;
    currency: string; // account's native currency
    type: "income" | "expense" | "transfer";
    date: string;
    account_name: string;
  }[];
  upcoming_policy_payouts: {
    policy_name: string;
    payout_date: string;
    amount: number;
    label: string;
  }[];
  upcoming_premium_payments: {
    policy_name: string;
    provider: string;
    due_date: string;
    amount: number;
    frequency: string;
  }[];
  top_categories?: {
    name: string;
    amount: number;
  }[];
};
