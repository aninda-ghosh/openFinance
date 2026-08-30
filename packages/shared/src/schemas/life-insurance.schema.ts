import { z } from "zod";
import { CurrencyEnum } from "./currency.schema";

export const LifePremiumFrequencyEnum = z.enum([
  "monthly",
  "quarterly",
  "annual",
]);

export const CreateLifeInsuranceSchema = z.object({
  name: z.string().min(1),
  insured_person: z.string().min(1),
  provider: z.string().min(1),
  policy_number: z.string().optional(),
  currency: CurrencyEnum.default("INR"),
  coverage_amount: z.number().positive(),
  renewal_date: z.string().date("Date must be ISO format YYYY-MM-DD"),
  premium_amount: z.number().positive().nullable().optional(),
  premium_frequency: LifePremiumFrequencyEnum.nullable().optional(),
});

export const UpdateLifeInsuranceSchema = z.object({
  name: z.string().min(1).optional(),
  insured_person: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  policy_number: z.string().optional(),
  currency: CurrencyEnum.optional(),
  coverage_amount: z.number().positive().optional(),
  renewal_date: z
    .string()
    .date("Date must be ISO format YYYY-MM-DD")
    .optional(),
  premium_amount: z.number().positive().nullable().optional(),
  premium_frequency: LifePremiumFrequencyEnum.nullable().optional(),
});
