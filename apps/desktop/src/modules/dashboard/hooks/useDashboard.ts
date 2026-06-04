import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api";
export function useDashboard(month: string) {
  return useQuery({
    queryKey: ["dashboard", month],
    queryFn: () => dashboardApi.getDashboard(month),
  });
}
export function useNetWorth() {
  return useQuery({
    queryKey: ["net-worth"],
    queryFn: dashboardApi.getNetWorth,
  });
}
export function usePortfolioBreakdown() {
  return useQuery({
    queryKey: ["portfolio-breakdown"],
    queryFn: dashboardApi.getPortfolioBreakdown,
  });
}
export function useTopMovers() {
  return useQuery({
    queryKey: ["top-movers"],
    queryFn: () => dashboardApi.getTopMovers(),
  });
}
export function useSpendingTrends(months = 6) {
  return useQuery({
    queryKey: ["spending-trends", months],
    queryFn: () => dashboardApi.getSpendingTrends(months),
    staleTime: 5 * 60 * 1000,
  });
}
export function useCashFlow(month: string) {
  return useQuery({
    queryKey: ["cash-flow", month],
    queryFn: () => dashboardApi.getCashFlow(month),
    staleTime: 2 * 60 * 1000,
  });
}
export function useNetWorthHistory(months = 6) {
  return useQuery({
    queryKey: ["net-worth-history", months],
    queryFn: () => dashboardApi.getNetWorthHistory(months),
    staleTime: 5 * 60 * 1000,
  });
}
