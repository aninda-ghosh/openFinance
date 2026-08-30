import { apiFetch } from "@/lib/api";

const BASE = "/api/documents";

export interface DocumentResponse {
  id: string;
  investment_id: string | null;
  account_id: string | null;
  life_insurance_id: string | null;
  name: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Investment details if joined
  investment_name?: string;
  investment_asset_type?: string;
  investment_currency?: string;
  investment_current_value?: number;
  investment_units?: number;
  // Account details if joined
  account_name?: string;
  account_type?: string;
  account_currency?: string;
  account_balance?: number;
  account_institution?: string;
  // Life-insurance details if joined
  life_insurance_name?: string;
  life_insurance_insured_person?: string;
  life_insurance_provider?: string;
  life_insurance_currency?: string;
  life_insurance_coverage_amount?: number;
  life_insurance_renewal_date?: string;
}

export const documentsApi = {
  getDocuments: (filters?: {
    investmentId?: string;
    accountId?: string;
    lifeInsuranceId?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.investmentId) params.set("investment_id", filters.investmentId);
    if (filters?.accountId) params.set("account_id", filters.accountId);
    if (filters?.lifeInsuranceId)
      params.set("life_insurance_id", filters.lifeInsuranceId);
    return apiFetch<{ documents: DocumentResponse[] }>(`${BASE}?${params}`);
  },
  uploadDocument: (
    parentId: {
      investmentId?: string | null;
      accountId?: string | null;
      lifeInsuranceId?: string | null;
    },
    name: string,
    file: File,
    notes?: string
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("name", name);
    if (parentId.investmentId) {
      formData.append("investment_id", parentId.investmentId);
    }
    if (parentId.accountId) {
      formData.append("account_id", parentId.accountId);
    }
    if (parentId.lifeInsuranceId) {
      formData.append("life_insurance_id", parentId.lifeInsuranceId);
    }
    if (notes) {
      formData.append("notes", notes);
    }

    return apiFetch<DocumentResponse>(`${BASE}`, {
      method: "POST",
      body: formData,
    });
  },
  deleteDocument: (docId: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/${docId}`, { method: "DELETE" }),
};
