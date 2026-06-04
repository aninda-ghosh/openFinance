import { z } from "zod";
import { CurrencyEnum } from "./currency.schema";

export const AccountTypeEnum = z.enum([
  "checking",
  "savings",
  "cash",
  "investment",
  "policy",
  "credit",
  "loan",
  "debt",
]);

export const CreateAccountSchema = z.object({
  name: z.string().min(1),
  type: AccountTypeEnum,
  currency: CurrencyEnum.default("INR"),
  institution: z.string().optional(),
  balance: z.number().default(0),
  off_budget: z.boolean().default(false),
});

export const UpdateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  type: AccountTypeEnum.optional(),
  currency: CurrencyEnum.optional(),
  institution: z.string().optional(),
  balance: z.number().optional(),
  is_active: z.boolean().optional(),
  off_budget: z.boolean().optional(),
});
