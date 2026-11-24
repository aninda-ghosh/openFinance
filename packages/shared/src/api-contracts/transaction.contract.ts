import type { z } from "zod";
import type {
  BulkCreateSchema,
  BulkPreviewSchema,
  BulkRowSchema,
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
  // "from_savings" marks a Transfer-in leg that funds Ready to assign (not income).
  income_category:
    | "income"
    | "cashback"
    | "starting_balance"
    | "from_savings"
    | null;
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
  /**
   * Imported expense rows that landed with no envelope. CSV import is exempt
   * from the "on-budget expense needs an envelope" rule the API enforces on
   * createTransaction/updateTransaction — a bank export carries no envelope —
   * so they are reported here instead of rejected.
   */
  uncategorised?: number;
  errors: string[];
};

// ─── Bulk add ─────────────────────────────────────────────────────────────────

export type BulkRow = z.infer<typeof BulkRowSchema>;
export type BulkCreateRequest = z.infer<typeof BulkCreateSchema>;
export type BulkPreviewRequest = z.infer<typeof BulkPreviewSchema>;

export type BulkRowError = { index: number; message: string };

export type BulkCreateResponse = {
  /** Rows written (a transfer counts once, though it stores two legs). */
  created: number;
  /** Rows skipped because the same pasted line was already imported. */
  skipped: number;
};

export type BulkPreviewRow = {
  /** This exact pasted line was saved by an earlier bulk add. */
  already_imported: boolean;
  /** Existing rows in the account with the same amount within a few days. */
  possible_duplicates: {
    id: string;
    date: string;
    payee: string;
    amount: number;
    type: "income" | "expense" | "transfer";
  }[];
  /** The category last used for a similar payee, if any. */
  suggested_envelope_id: string | null;
};

export type BulkPreviewResponse = { rows: BulkPreviewRow[] };
