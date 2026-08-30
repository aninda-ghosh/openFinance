import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateLifeInsuranceRequest } from "@openfinance/shared/api-contracts";
import { lifeInsuranceApi } from "../api";

export function useLifeInsurance() {
  return useQuery({
    queryKey: ["life-insurance"],
    queryFn: lifeInsuranceApi.getPolicies,
  });
}

export function useCreateLifeInsurance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: lifeInsuranceApi.createPolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["life-insurance"] }),
  });
}

export function useUpdateLifeInsurance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateLifeInsuranceRequest;
    }) => lifeInsuranceApi.updatePolicy(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["life-insurance"] }),
  });
}

export function useDeleteLifeInsurance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: lifeInsuranceApi.deletePolicy,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["life-insurance"] });
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}
