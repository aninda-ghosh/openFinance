import type { z } from "zod";
import type {
  CreateAccountSchema,
  UpdateAccountSchema,
} from "../schemas/account.schema";

export type CreateAccountRequest = z.infer<typeof CreateAccountSchema>;
export type UpdateAccountRequest = z.infer<typeof UpdateAccountSchema>;

export type AccountResponse = {
  id: string;
  name: string;
  type:
    | "checking"
    | "savings"
    | "cash"
    | "investment"
    | "policy"
    | "credit"
    | "loan"
    | "debt";
  currency: "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD";
  balance: number;
  balance_inr: number;
  institution: string | null;
  is_active: boolean;
  off_budget: boolean;
  created_at: string;
  updated_at: string;
};

export type AccountListResponse = { accounts: AccountResponse[] };

export type ExchangeRateResponse = {
  from_currency: "USD" | "SGD" | "NTD";
  rate_to_base: number;
  source: string;
  fetched_at: string;
};

export type ExchangeRatesResponse = { rates: ExchangeRateResponse[] };
