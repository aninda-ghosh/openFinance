import { z } from "zod";

export const TransactionTypeEnum = z.enum(["income", "expense", "transfer"]);
export const IncomeCategoryEnum = z.enum([
  "income",
  "cashback",
  "starting_balance",
]);

export const CreateTransactionSchema = z.object({
  account_id: z.string().min(1),
  envelope_id: z.string().min(1).optional(),
  payee: z.string().min(1),
  amount: z.number(),
  type: TransactionTypeEnum,
  date: z.string().date("Date must be ISO format YYYY-MM-DD"),
  notes: z.string().optional(),
  import_hash: z.string().optional(),
  income_category: IncomeCategoryEnum.optional(),
});

export const UpdateTransactionSchema = z.object({
  envelope_id: z.string().min(1).nullable().optional(),
  notes: z.string().optional(),
  payee: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  date: z.string().date().optional(),
  type: z.enum(["income", "expense"]).optional(), // transfers must be managed via the transfer endpoint
  income_category: IncomeCategoryEnum.nullable().optional(),
});

export const CreateTransferSchema = z.object({
  from_account_id: z.string().min(1),
  to_account_id: z.string().min(1),
  amount: z.coerce.number().positive(),
  // Destination-side amount for cross-currency transfers; defaults to `amount`
  to_amount: z.coerce.number().positive().optional(),
  date: z.string().date("Date must be ISO format YYYY-MM-DD"),
  notes: z.string().optional(),
  import_hash: z.string().optional(),
  envelope_id: z.string().min(1).optional(),
  to_envelope_id: z.string().min(1).optional(),
});

export const TransactionFiltersSchema = z.object({
  account_id: z.string().optional(),
  envelope_id: z.string().optional(),
  type: TransactionTypeEnum.optional(),
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  off_budget: z.union([z.boolean(), z.string()]).optional(),
});
