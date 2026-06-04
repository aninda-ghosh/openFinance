import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { policiesApi } from "../api";
export function usePolicies() {
  return useQuery({ queryKey: ["policies"], queryFn: policiesApi.getPolicies });
}
export function usePolicyTimeline(years = 5) {
  return useQuery({
    queryKey: ["policy-timeline", years],
    queryFn: () => policiesApi.getTimeline(years),
  });
}
export function usePolicyAlerts(days = 30) {
  return useQuery({
    queryKey: ["policy-alerts", days],
    queryFn: () => policiesApi.getAlerts(days),
  });
}
export function useCreatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: policiesApi.createPolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
  });
}
export function useUpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof policiesApi.updatePolicy>[1];
    }) => policiesApi.updatePolicy(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
  });
}
export function useGeneratePayouts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        start_date: string;
        end_date: string;
        amount: number;
        frequency: string;
        label: string;
      };
    }) => policiesApi.generatePayouts(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
  });
}
export function useDeletePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => policiesApi.deletePolicy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
  });
}
export function useMarkPayoutReceived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      policyId,
      payoutId,
    }: {
      policyId: string;
      payoutId: string;
    }) => policiesApi.markPayoutReceived(policyId, payoutId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
  });
}
