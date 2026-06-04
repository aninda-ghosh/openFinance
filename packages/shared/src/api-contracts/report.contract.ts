export type MonthlySummaryResponse = {
  month: string;
  total_income: number;
  total_expenses: number;
  net: number;
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
