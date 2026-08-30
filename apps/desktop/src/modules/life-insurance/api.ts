import type {
  CreateLifeInsuranceRequest,
  LifeInsuranceListResponse,
  LifeInsuranceResponse,
  UpdateLifeInsuranceRequest,
} from "@openfinance/shared/api-contracts";
import { apiFetch } from "@/lib/api";

const BASE = "/api/life-insurance";

export const lifeInsuranceApi = {
  getPolicies: () => apiFetch<LifeInsuranceListResponse>(`${BASE}`),
  createPolicy: (data: CreateLifeInsuranceRequest) =>
    apiFetch<LifeInsuranceResponse>(`${BASE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updatePolicy: (id: string, data: UpdateLifeInsuranceRequest) =>
    apiFetch<LifeInsuranceResponse>(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deletePolicy: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/${id}`, { method: "DELETE" }),
};
