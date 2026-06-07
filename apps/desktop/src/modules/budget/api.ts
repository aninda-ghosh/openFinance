import type {
  AccountListResponse,
  AccountResponse,
  CreateAccountRequest,
  CreateEnvelopeRequest,
  CreateTransactionRequest,
  EnvelopeListResponse,
  EnvelopeWithGroupResponse,
  ImportResult,
  MonthlySummaryResponse,
  PaginatedTransactionsResponse,
  TransactionFilters,
  UpdateAccountRequest,
  UpdateEnvelopeRequest,
  UpdateTransactionRequest,
} from "@openfinance/shared/api-contracts";
import { apiFetch } from "@/lib/api";

const BASE = "/api/budget";

export const budgetApi = {
  getAccounts: () => apiFetch<AccountListResponse>(`${BASE}/accounts`),

  createAccount: (data: CreateAccountRequest) =>
    apiFetch<AccountResponse>(`${BASE}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  updateAccount: (id: string, data: UpdateAccountRequest) =>
    apiFetch<AccountResponse>(`${BASE}/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  deleteAccount: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/accounts/${id}`, {
      method: "DELETE",
    }),

  getEnvelopes: (month: string) =>
    apiFetch<{ envelopes: EnvelopeWithGroupResponse[] }>(
      `${BASE}/envelopes?month=${month}`
    ),

  createEnvelope: (data: CreateEnvelopeRequest) =>
    apiFetch<EnvelopeListResponse>(`${BASE}/envelopes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  updateEnvelope: (id: string, data: UpdateEnvelopeRequest) =>
    apiFetch<EnvelopeListResponse>(`${BASE}/envelopes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  deleteEnvelope: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/envelopes/${id}`, {
      method: "DELETE",
    }),

  reclaimEnvelope: (id: string) =>
    apiFetch<{ reclaimed_inr: number }>(`${BASE}/envelopes/${id}/reclaim`, {
      method: "POST",
    }),

  getEnvelopeGroups: () =>
    apiFetch<{ groups: { id: string; name: string; sort_order: number }[] }>(
      `${BASE}/envelope-groups`
    ),

  createEnvelopeGroup: (name: string) =>
    apiFetch<{ id: string; name: string; sort_order: number }>(
      `${BASE}/envelope-groups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }
    ),

  updateEnvelopeGroup: (id: string, name: string) =>
    apiFetch<{ id: string; name: string }>(`${BASE}/envelope-groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  deleteEnvelopeGroup: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/envelope-groups/${id}`, {
      method: "DELETE",
    }),

  getTransactions: (filters: Partial<TransactionFilters>) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(
      ([k, v]) => v != null && params.set(k, String(v))
    );
    return apiFetch<PaginatedTransactionsResponse>(
      `${BASE}/transactions?${params}`
    );
  },

  createTransaction: (data: CreateTransactionRequest) =>
    apiFetch<PaginatedTransactionsResponse>(`${BASE}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  updateTransaction: (id: string, data: UpdateTransactionRequest) =>
    apiFetch<PaginatedTransactionsResponse>(`${BASE}/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  deleteTransaction: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/transactions/${id}`, {
      method: "DELETE",
    }),

  createTransfer: (data: {
    from_account_id: string;
    to_account_id: string;
    amount: number;
    to_amount?: number;
    date: string;
    notes?: string;
    envelope_id?: string;
    to_envelope_id?: string;
  }) =>
    apiFetch<any>(`${BASE}/transactions/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  importCSV: (file: File, accountId: string) => {
    const body = new FormData();
    body.append("file", file);
    return apiFetch<ImportResult>(`${BASE}/import?account_id=${accountId}`, {
      method: "POST",
      body: file,
    });
  },

  getMonthlySummary: (month: string) =>
    apiFetch<MonthlySummaryResponse>(`${BASE}/reports/summary?month=${month}`),

  listRecurring: () => apiFetch<{ recurring: any[] }>(`${BASE}/recurring`),
  createRecurring: (data: any) =>
    apiFetch<any>(`${BASE}/recurring`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updateRecurring: (id: string, data: any) =>
    apiFetch<any>(`${BASE}/recurring/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteRecurring: (id: string) =>
    apiFetch<{ success: boolean }>(`${BASE}/recurring/${id}`, {
      method: "DELETE",
    }),
  applyDueRecurring: () =>
    apiFetch<{ applied: number }>(`${BASE}/recurring/apply-due`, {
      method: "POST",
    }),

  copyPreviousMonthBudget: (month: string) =>
    apiFetch<{ count: number }>(`${BASE}/envelopes/copy-previous`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    }),

  clearMonthBudget: (month: string) =>
    apiFetch<{ count: number }>(`${BASE}/envelopes/clear-budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    }),
};
