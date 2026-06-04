import type { z } from "zod";
import type {
  CreatePayoutSchema,
  CreatePolicySchema,
  UpdatePayoutSchema,
  UpdatePolicySchema,
} from "../schemas/policy.schema";

export type CreatePolicyRequest = z.infer<typeof CreatePolicySchema>;
export type UpdatePolicyRequest = z.infer<typeof UpdatePolicySchema>;
export type CreatePayoutRequest = z.infer<typeof CreatePayoutSchema>;
export type UpdatePayoutRequest = z.infer<typeof UpdatePayoutSchema>;

export type PayoutResponse = {
  id: string;
  policy_id: string;
  payout_date: string;
  amount: number;
  label: string;
  is_received: boolean;
};

export type PolicyResponse = {
  id: string;
  name: string;
  provider: string;
  policy_number: string | null;
  start_date: string;
  currency: "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD";
  premium_amount: number;
  premium_amount_inr: number;
  premium_frequency: "monthly" | "quarterly" | "annual";
  premium_term_years: number;
  policy_term_years: number;
  maturity_date: string;
  sum_assured: number;
  sum_assured_inr: number;
  maturity_value: number;
  maturity_value_inr: number;
  surrender_value: number | null;
  surrender_value_inr: number | null;
  total_invested: number;
  total_invested_inr: number;
  notes: string | null;
  account_id: string | null;
  payouts: PayoutResponse[];
  created_at: string;
  updated_at: string;
};

export type PolicyListResponse = { policies: PolicyResponse[] };
