import type { z } from "zod";
import type {
  CreateEnvelopeGroupSchema,
  CreateEnvelopeSchema,
  UpdateEnvelopeSchema,
} from "../schemas/envelope.schema";

export type CreateEnvelopeGroupRequest = z.infer<
  typeof CreateEnvelopeGroupSchema
>;
export type CreateEnvelopeRequest = z.infer<typeof CreateEnvelopeSchema>;
export type UpdateEnvelopeRequest = z.infer<typeof UpdateEnvelopeSchema>;

export type EnvelopeGroupResponse = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
};

export type EnvelopeResponse = {
  id: string;
  group_id: string;
  name: string;
  budgeted: number; // in budget_currency
  budget_currency: string;
  budgeted_inr: number; // budgeted converted to INR
  spent: number; // always in INR
  available: number; // budgeted_inr - spent
  month: string;
  rollover_type: "none" | "amount" | "leftover";
  rollover_amount: number;
  created_at: string;
};

export type EnvelopeWithGroupResponse = EnvelopeResponse & {
  group_name: string;
};

export type EnvelopeListResponse = {
  groups: (EnvelopeGroupResponse & { envelopes: EnvelopeResponse[] })[];
};
