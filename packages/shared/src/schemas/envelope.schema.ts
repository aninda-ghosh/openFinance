import { z } from "zod";
import { CurrencyEnum } from "./currency.schema";

export const RolloverTypeEnum = z.enum(["none", "amount", "leftover"]);

// Month format: "YYYY-MM"
const YearMonthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

export const CreateEnvelopeGroupSchema = z.object({
  name: z.string().min(1),
  sort_order: z.number().int().default(0),
});

export const CreateEnvelopeSchema = z.object({
  group_id: z.string().min(1),
  name: z.string().min(1),
  budgeted: z.number().min(0).default(0),
  budget_currency: CurrencyEnum.default("INR"),
  month: z.string().regex(YearMonthRegex, "Month must be in YYYY-MM format"),
  rollover_type: RolloverTypeEnum.default("none"),
  rollover_amount: z.number().min(0).default(0),
});

export const UpdateEnvelopeSchema = z.object({
  name: z.string().min(1).optional(),
  budgeted: z.number().min(0).optional(),
  budget_currency: CurrencyEnum.optional(),
  group_id: z.string().min(1).optional(),
  rollover_type: RolloverTypeEnum.optional(),
  rollover_amount: z.number().min(0).optional(),
});
