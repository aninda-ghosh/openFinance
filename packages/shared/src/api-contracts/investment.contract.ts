import type { z } from "zod";
import type {
  CreateInvestmentSchema,
  UpdateInvestmentSchema,
} from "../schemas/investment.schema";

export type CreateInvestmentRequest = z.infer<typeof CreateInvestmentSchema>;
export type UpdateInvestmentRequest = z.infer<typeof UpdateInvestmentSchema>;

export type InvestmentResponse = {
  id: string;
  name: string;
  asset_type:
    | "mutual_fund"
    | "fd"
    | "savings"
    | "bond"
    | "real_estate"
    | "cash"
    | "structured"
    | "other";
  currency: "INR" | "USD" | "SGD" | "GBP" | "EUR" | "JPY" | "NTD";
  /** The original outlay, unchanged by later top-ups. */
  purchase_value: number;
  purchase_value_inr: number;
  /** Sum of the new money recorded across this holding's value history. */
  total_contributions: number;
  total_contributions_inr: number;
  /**
   * purchase_value + total_contributions — every rupee/dollar actually put in.
   * Gain is measured against THIS, not purchase_value, so paying into a 401k
   * raises value and basis together and leaves the gain untouched.
   */
  cost_basis: number;
  cost_basis_inr: number;
  units: number | null;
  purchase_date: string;
  current_value: number;
  current_value_inr: number;
  /** current_value_inr − cost_basis_inr: market movement only. */
  gain_loss_inr: number;
  /** gain_loss_inr / cost_basis_inr × 100. */
  gain_loss_pct: number;
  current_value_source: string | null;
  current_value_at: string | null;
  notes: string | null;
  account_id: string | null;
  maturity_date: string | null;
  created_at: string;
  updated_at: string;
};

export type InvestmentListResponse = { investments: InvestmentResponse[] };

export type PriceHistoryEntry = {
  id: string;
  price: number;
  source_url: string | null;
  fetched_at: string;
};

export type PriceHistoryResponse = { history: PriceHistoryEntry[] };

export type ValueHistoryEntry = {
  id: string;
  previous_value: number | null;
  new_value: number;
  source: "manual" | "price_refresh";
  notes: string | null;
  /** New money inside this change; the rest of the delta is market movement. */
  contribution: number;
  changed_at: string;
};

export type ValueHistoryResponse = { history: ValueHistoryEntry[] };
