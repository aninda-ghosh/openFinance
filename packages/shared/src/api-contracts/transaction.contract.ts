import type { z } from "zod";
import type {
  CreateTransactionSchema,
  TransactionFiltersSchema,
  UpdateTransactionSchema,
} from "../schemas/transaction.schema";

export type CreateTransactionRequest = z.infer<typeof CreateTransactionSchema>;
export type UpdateTransactionRequest = z.infer<typeof UpdateTransactionSchema>;
export type TransactionFilters = z.infer<typeof TransactionFiltersSchema>;

export type TransactionResponse = {
  id: string;
  account_id: string;
  envelope_id: string | null;
  payee: string;
  amount: number;
  currency: string;
  type: "income" | "expense" | "transfer";
  date: string;
  notes: string | null;
  income_category: "income" | "cashback" | "starting_balance" | null;
  created_at: string;
};

export type PaginatedTransactionsResponse = {
  transactions: TransactionResponse[];
  total: number;
  page: number;
  limit: number;
};

export type ImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
};
