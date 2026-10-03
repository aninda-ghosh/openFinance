export type MonthlySummaryResponse = {
  month: string;
  total_income: number;
  total_expenses: number;
  net: number;
  /**
   * Off-Budget → On-Budget transfers tagged FROM_SAVINGS this month. Adds to
   * Ready to assign; deliberately excluded from total_income and net.
   */
  total_from_savings: number;
  carryover_from_previous: number;
  envelope_summaries: {
    envelope_id: string;
    envelope_name: string;
    budgeted: number;
    spent: number;
    available: number;
  }[];
};

export type TrendResponse = {
  month: string;
  budgeted: number;
  spent: number;
};
