import type {
  CreatePayoutRequest,
  CreatePolicyRequest,
  PolicyListResponse,
  PolicyResponse,
  UpdatePolicyRequest,
} from "@openfinance/shared/api-contracts";
import { apiFetch } from "@/lib/api";

const BASE = "/api/policies";
export const policiesApi = {
  getPolicies: () => apiFetch<PolicyListResponse>(`${BASE}`),
  createPolicy: (data: CreatePolicyRequest) =>
    apiFetch<PolicyResponse>(`${BASE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updatePolicy: (id: string, data: UpdatePolicyRequest) =>
    apiFetch<PolicyResponse>(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deletePolicy: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/${id}`, { method: "DELETE" }),
  addPayout: (id: string, data: CreatePayoutRequest) =>
    apiFetch<any>(`${BASE}/${id}/payouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  generatePayouts: (
    id: string,
    data: {
      start_date: string;
      end_date: string;
      amount: number;
      frequency: string;
      label: string;
    }
  ) =>
    apiFetch<{ created: number }>(`${BASE}/${id}/payouts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  markPayoutReceived: (policyId: string, payoutId: string) =>
    apiFetch<any>(`${BASE}/${policyId}/payouts/${payoutId}/mark-received`, {
      method: "POST",
    }),
  getTimeline: (years: number) =>
    apiFetch<{ events: any[] }>(`${BASE}/timeline?years=${years}`),
  getAlerts: (days: number) =>
    apiFetch<{ alerts: any[] }>(`${BASE}/alerts?days=${days}`),
};
