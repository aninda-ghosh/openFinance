import type { z } from "zod";
import type {
  CreateLifeInsuranceSchema,
  UpdateLifeInsuranceSchema,
} from "../schemas/life-insurance.schema";

export type CreateLifeInsuranceRequest = z.infer<
  typeof CreateLifeInsuranceSchema
>;
export type UpdateLifeInsuranceRequest = z.infer<
  typeof UpdateLifeInsuranceSchema
>;

export type LifeInsuranceResponse = {
  id: string;
  name: string;
  insured_person: string;
  provider: string;
  policy_number: string | null;
  currency: "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD";
  coverage_amount: number;
  /**
   * Coverage converted to the app's base unit, for display alongside the rest
   * of the app. It is NOT summed into net worth or the portfolio donut — a
   * death benefit is a contingent payout, not an asset you hold.
   */
  coverage_amount_inr: number;
  renewal_date: string;
  /** Whole days from today to renewal_date; negative once the date has passed. */
  days_to_renewal: number;
  premium_amount: number | null;
  premium_amount_inr: number | null;
  premium_frequency: "monthly" | "quarterly" | "annual" | null;
  /** Premium normalised to a yearly figure; null when no premium is recorded. */
  annual_premium_inr: number | null;
  document_count: number;
  created_at: string;
  updated_at: string;
};

export type LifeInsuranceListResponse = { policies: LifeInsuranceResponse[] };
