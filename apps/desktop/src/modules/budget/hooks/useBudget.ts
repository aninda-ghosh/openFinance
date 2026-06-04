import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAppStore } from "@/stores/app.store";
import { budgetApi } from "../api";

export function useExchangeRates() {
  const defaultCurrency = useAppStore((s) => s.defaultCurrency);
  return useQuery({
    queryKey: ["exchange-rates", defaultCurrency],
    queryFn: () =>
      apiFetch<{ rates: { from_currency: string; rate_to_base: number }[] }>(
        "/api/exchange-rates"
      ).then((d) => {
        const map: Record<string, number> = {};
        for (const r of d.rates) map[r.from_currency] = r.rate_to_base;
        return map;
      }),
    staleTime: 5 * 60 * 1000, // 5 min
  });
}

export function useAccounts() {
  return useQuery({ queryKey: ["accounts"], queryFn: budgetApi.getAccounts });
}

export function useEnvelopes(month: string) {
  return useQuery({
    queryKey: ["envelopes", month],
    queryFn: () => budgetApi.getEnvelopes(month),
  });
}

export function useTransactions(
  filters: Record<string, string | number | undefined>
) {
  return useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => budgetApi.getTransactions(filters),
  });
}

export function useMonthlySummary(month: string) {
  return useQuery({
    queryKey: ["monthly-summary", month],
    queryFn: () => budgetApi.getMonthlySummary(month),
  });
}

export function useEnvelopeGroups() {
  return useQuery({
    queryKey: ["envelope-groups"],
    queryFn: budgetApi.getEnvelopeGroups,
  });
}

export function useCreateEnvelopeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createEnvelopeGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelope-groups"] }),
  });
}

export function useUpdateEnvelopeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      budgetApi.updateEnvelopeGroup(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelope-groups"] }),
  });
}

export function useDeleteEnvelopeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.deleteEnvelopeGroup,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envelope-groups"] });
      qc.invalidateQueries({ queryKey: ["envelopes"] });
    },
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      budgetApi.updateAccount(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.deleteAccount,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useCreateEnvelope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createEnvelope,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

export function useUpdateEnvelope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      budgetApi.updateEnvelope(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

export function useDeleteEnvelope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.deleteEnvelope,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

export function useReclaimEnvelope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.reclaimEnvelope,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
    },
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createTransaction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      budgetApi.updateTransaction(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.deleteTransaction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createTransfer,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRecurring() {
  return useQuery({
    queryKey: ["recurring"],
    queryFn: budgetApi.listRecurring,
  });
}
export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.createRecurring,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring"] }),
  });
}
export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      budgetApi.updateRecurring(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring"] }),
  });
}
export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.deleteRecurring,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring"] }),
  });
}
export function useApplyDueRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.applyDueRecurring,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["recurring"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useImportCSV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, accountId }: { file: File; accountId: string }) =>
      budgetApi.importCSV(file, accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
      qc.invalidateQueries({ queryKey: ["spending-trends"] });
      qc.invalidateQueries({ queryKey: ["net-worth-history"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useCopyPreviousMonthBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.copyPreviousMonthBudget,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
    },
  });
}

export function useClearMonthBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: budgetApi.clearMonthBudget,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envelopes"] });
      qc.invalidateQueries({ queryKey: ["monthly-summary"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["net-worth"] });
      qc.invalidateQueries({ queryKey: ["cash-flow"] });
    },
  });
}
