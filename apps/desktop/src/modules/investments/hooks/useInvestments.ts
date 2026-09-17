import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { investmentsApi } from "../api";

export function useInvestments(filters?: { asset_type?: string }) {
  return useQuery({
    queryKey: ["investments", filters],
    queryFn: () => investmentsApi.getInvestments(filters),
  });
}

export function usePortfolioSummary() {
  return useQuery({
    queryKey: ["portfolio-summary"],
    queryFn: investmentsApi.getPortfolioSummary,
  });
}

export function useCreateInvestment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: investmentsApi.createInvestment,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio-summary"] });
    },
  });
}

export function useRefreshPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: investmentsApi.refreshPrice,
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["value-history", id] });
    },
  });
}

export function useUpdateInvestment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      investmentsApi.updateInvestment(id, data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio-summary"] });
      qc.invalidateQueries({ queryKey: ["value-history", id] });
    },
  });
}

export function useDeleteInvestment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: investmentsApi.deleteInvestment,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["investments"] }),
  });
}

export function useValueHistory(id: string | null) {
  return useQuery({
    queryKey: ["value-history", id],
    queryFn: () => investmentsApi.getValueHistory(id!),
    enabled: !!id,
  });
}

/** Invalidate everything a changed cost basis feeds. */
function invalidateBasis(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["investments"] });
  qc.invalidateQueries({ queryKey: ["portfolio-summary"] });
  qc.invalidateQueries({ queryKey: ["value-history", id] });
  qc.invalidateQueries({ queryKey: ["net-worth"] });
}

export function useSetEntryContribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      entryId,
      contribution,
    }: {
      id: string;
      entryId: string;
      contribution: number;
    }) => investmentsApi.setEntryContribution(id, entryId, contribution),
    onSuccess: (_, { id }) => invalidateBasis(qc, id),
  });
}

export function useBulkContributions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      mode,
    }: {
      id: string;
      mode: "match_delta" | "clear";
    }) => investmentsApi.bulkContributions(id, mode),
    onSuccess: (_, { id }) => invalidateBasis(qc, id),
  });
}

export function useDocuments(investmentId: string | null) {
  return useQuery({
    queryKey: ["documents", investmentId],
    queryFn: () => investmentsApi.getDocuments(investmentId!),
    enabled: !!investmentId,
  });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      investmentId,
      name,
      file,
      notes,
    }: {
      investmentId: string;
      name: string;
      file: File;
      notes?: string;
    }) => investmentsApi.uploadDocument(investmentId, name, file, notes),
    onSuccess: (_, { investmentId }) => {
      qc.invalidateQueries({ queryKey: ["documents", investmentId] });
    },
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docId }: { docId: string; investmentId: string }) =>
      investmentsApi.deleteDocument(docId),
    onSuccess: (_, { investmentId }) => {
      qc.invalidateQueries({ queryKey: ["documents", investmentId] });
    },
  });
}
