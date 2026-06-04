import {
  CreatePayoutSchema,
  CreatePolicySchema,
  UpdatePayoutSchema,
  UpdatePolicySchema,
} from "@finwise/shared/schemas";
import { Hono } from "hono";
import * as policyService from "../services/policy.service";

export const policiesRouter = new Hono();

function handleError(c: any, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 404) return c.json({ error: e.message ?? "Not found" }, 404);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

policiesRouter.get("/", async (c) => {
  try {
    const policies = await policyService.listPolicies();
    return c.json({ policies });
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreatePolicySchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const policy = await policyService.createPolicy(parsed.data);
    return c.json(policy, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdatePolicySchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const policy = await policyService.updatePolicy(
      c.req.param("id"),
      parsed.data
    );
    return c.json(policy);
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.delete("/:id", async (c) => {
  try {
    await policyService.deletePolicy(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.post("/:id/payouts/generate", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (
    !body?.start_date ||
    !body.end_date ||
    !body.amount ||
    !body.frequency ||
    !body.label
  ) {
    return c.json(
      { error: "start_date, end_date, amount, frequency, label are required" },
      400
    );
  }
  try {
    const count = await policyService.generatePayouts(c.req.param("id"), body);
    return c.json({ created: count });
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.get("/:id/payouts", async (c) => {
  try {
    const payouts = await policyService.getPayouts(c.req.param("id"));
    return c.json({ payouts });
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.post("/:id/payouts", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreatePayoutSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const payout = await policyService.addPayout(
      c.req.param("id"),
      parsed.data
    );
    return c.json(payout, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.patch("/:id/payouts/:payoutId", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdatePayoutSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const payout = await policyService.updatePayout(
      c.req.param("id"),
      c.req.param("payoutId"),
      parsed.data
    );
    return c.json(payout);
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.post("/:id/payouts/:payoutId/mark-received", async (c) => {
  try {
    const payout = await policyService.markPayoutReceived(
      c.req.param("id"),
      c.req.param("payoutId")
    );
    return c.json(payout);
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.get("/timeline", async (c) => {
  const years = Number(c.req.query("years") ?? 5);
  try {
    const events = await policyService.getTimeline(years);
    return c.json({ events });
  } catch (err) {
    return handleError(c, err);
  }
});

policiesRouter.get("/alerts", async (c) => {
  const days = Number(c.req.query("days") ?? 30);
  try {
    const alerts = await policyService.getUpcomingAlerts(days);
    return c.json({ alerts });
  } catch (err) {
    return handleError(c, err);
  }
});
