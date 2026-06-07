import type {
  CreateInvestmentRequest,
  InvestmentListResponse,
  InvestmentResponse,
  PriceHistoryResponse,
  UpdateInvestmentRequest,
} from "@openfinance/shared/api-contracts";
import { apiFetch } from "@/lib/api";

const BASE = "/api/investments";

export const investmentsApi = {
  getInvestments: (filters?: { asset_type?: string; sort?: string }) => {
    const params = new URLSearchParams();
    if (filters?.asset_type) params.set("asset_type", filters.asset_type);
    if (filters?.sort) params.set("sort", filters.sort);
    return apiFetch<InvestmentListResponse>(`${BASE}?${params}`);
  },
  createInvestment: (data: CreateInvestmentRequest) =>
    apiFetch<InvestmentResponse>(`${BASE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updateInvestment: (id: string, data: UpdateInvestmentRequest) =>
    apiFetch<InvestmentResponse>(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteInvestment: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/${id}`, { method: "DELETE" }),
  refreshPrice: (id: string) =>
    apiFetch<{ price: number; source_url: string; fetched_at: string }>(
      `${BASE}/${id}/refresh-price`,
      { method: "POST" }
    ),
  getPriceHistory: (id: string) =>
    apiFetch<PriceHistoryResponse>(`${BASE}/${id}/price-history`),
  getValueHistory: (id: string) =>
    apiFetch<{
      history: {
        id: string;
        previous_value: number | null;
        new_value: number;
        source: "manual" | "price_refresh";
        notes: string | null;
        changed_at: string;
      }[];
    }>(`${BASE}/${id}/value-history`),
  getPortfolioSummary: () =>
    apiFetch<{ total_inr: number; by_asset_type: Record<string, number> }>(
      `${BASE}/portfolio-summary`
    ),
  getDocuments: (investmentId: string) =>
    apiFetch<{ documents: any[] }>(`${BASE}/${investmentId}/documents`),
  uploadDocument: (investmentId: string, name: string, file: File, notes?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("name", name);
    if (notes) formData.append("notes", notes);
    return apiFetch<any>(`${BASE}/${investmentId}/documents`, {
      method: "POST",
      body: formData,
    });
  },
  deleteDocument: (docId: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/documents/${docId}`, {
      method: "DELETE",
    }),
};
