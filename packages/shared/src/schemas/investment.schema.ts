import { z } from "zod";
import { CurrencyEnum } from "./currency.schema";

export const AssetTypeEnum = z.enum([
  "mutual_fund",
  "stock",
  "etf",
  "fd",
  "savings",
  "bond",
  "real_estate",
  "cash",
  "structured",
  "other",
]);

export const SetContributionSchema = z.object({
  contribution: z.number(),
});

export const BulkContributionSchema = z.object({
  /**
   * match_delta: treat every recorded change as new money (the starting point
   * for a holding whose history is all deposits). clear: back to all-market.
   */
  mode: z.enum(["match_delta", "clear"]),
});

export const CreateInvestmentSchema = z.object({
  name: z.string().min(1),
  asset_type: AssetTypeEnum,
  currency: CurrencyEnum.default("INR"),
  purchase_value: z.number().positive(),
  units: z.number().positive().optional(),
  purchase_date: z.string().date("Date must be ISO format YYYY-MM-DD"),
  current_value: z.number().min(0),
  current_value_source: z.string().optional(),
  current_value_at: z.string().date().optional(),
  notes: z.string().optional(),
  account_id: z.string().nullable().optional(),
  maturity_date: z
    .string()
    .date("Date must be ISO format YYYY-MM-DD")
    .nullable()
    .optional(),
});

export const UpdateInvestmentSchema = z.object({
  /**
   * How much of this value change is new money rather than market movement.
   * Recorded on the resulting history row and folded into the cost basis, so
   * a contribution moves value and basis together and leaves gain alone.
   */
  contribution: z.number().optional(),
  name: z.string().min(1).optional(),
  asset_type: AssetTypeEnum.optional(),
  currency: CurrencyEnum.optional(),
  purchase_value: z.number().positive().optional(),
  purchase_date: z
    .string()
    .date("Date must be ISO format YYYY-MM-DD")
    .optional(),
  current_value: z.number().min(0).optional(),
  current_value_source: z.string().optional(),
  current_value_at: z.string().date().optional(),
  units: z.number().positive().optional(),
  notes: z.string().optional(),
  account_id: z.string().nullable().optional(),
  maturity_date: z
    .string()
    .date("Date must be ISO format YYYY-MM-DD")
    .nullable()
    .optional(),
});
