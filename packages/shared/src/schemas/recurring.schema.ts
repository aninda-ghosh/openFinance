import { z } from "zod";

export const RecurringFrequencyEnum = z.enum([
  "weekly",
  "monthly",
  "quarterly",
  "annual",
]);

/**
 * Recurring rules are a write path like any other — they generate real
 * transactions — so they get the same validation every other write route has.
 * `transfer` is excluded deliberately: a recurring rule generates a single
 * row, and a transfer needs a matched pair.
 */
export const CreateRecurringSchema = z.object({
  payee: z.string().min(1),
  amount: z.number().positive(),
  type: z.enum(["income", "expense"]),
  account_id: z.string().min(1),
  envelope_id: z.string().min(1).nullable().optional(),
  frequency: RecurringFrequencyEnum,
  next_date: z.string().date("Date must be ISO format YYYY-MM-DD"),
  end_date: z.string().date().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const UpdateRecurringSchema = CreateRecurringSchema.partial().extend({
  is_active: z.boolean().optional(),
});
