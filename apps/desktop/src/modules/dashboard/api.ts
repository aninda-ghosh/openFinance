import { apiFetch } from "@/lib/api";
export const dashboardApi = {
  getDashboard: (month: string) =>
    apiFetch<any>(`/api/dashboard?month=${month}`),
  getNetWorth: () => apiFetch<any>(`/api/dashboard/net-worth`),
  getPortfolioBreakdown: () =>
    apiFetch<any>(`/api/dashboard/portfolio-breakdown`),
  getTopMovers: (limit = 5) =>
    apiFetch<any>(`/api/dashboard/top-movers?limit=${limit}`),
  getSpendingTrends: (months = 6) =>
    apiFetch<{ trends: { month: string; income: number; expenses: number }[] }>(
      `/api/dashboard/spending-trends?months=${months}`
    ),
  getCashFlow: (month: string) =>
    apiFetch<{
      month: string;
      carryover?: number;
      total_income: number;
      total_expenses: number;
      savings: number;
      income_sources: { payee: string; amount: number }[];
      expense_groups: {
        group_name: string;
        total: number;
        envelopes: { name: string; amount: number }[];
      }[];
    }>(`/api/dashboard/cash-flow?month=${month}`),
  getNetWorthHistory: (months = 6) =>
    apiFetch<{
      history: {
        month: string;
        total_inr: number;
        cash_inr: number;
        investments_inr: number;
        debt_inr: number;
      }[];
    }>(`/api/dashboard/net-worth-history?months=${months}`),
};
