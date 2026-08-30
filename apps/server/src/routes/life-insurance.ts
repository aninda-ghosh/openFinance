import {
  CreateLifeInsuranceSchema,
  UpdateLifeInsuranceSchema,
} from "@openfinance/shared/schemas";
import { Hono } from "hono";
import * as lifeInsuranceService from "../services/life-insurance.service";

export const lifeInsuranceRouter = new Hono();

function handleError(c: any, err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 404) return c.json({ error: e.message ?? "Not found" }, 404);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
}

lifeInsuranceRouter.get("/", async (c) => {
  try {
    const policies = await lifeInsuranceService.listLifeInsurance();
    return c.json({ policies });
  } catch (err) {
    return handleError(c, err);
  }
});

// Declared before "/:id" so "alerts" is not swallowed as an id.
lifeInsuranceRouter.get("/alerts", async (c) => {
  const days = Number(c.req.query("days") ?? 60);
  try {
    const policies = await lifeInsuranceService.getRenewalAlerts(days);
    return c.json({ policies });
  } catch (err) {
    return handleError(c, err);
  }
});

lifeInsuranceRouter.get("/:id", async (c) => {
  try {
    const policy = await lifeInsuranceService.getLifeInsurance(
      c.req.param("id")
    );
    return c.json(policy);
  } catch (err) {
    return handleError(c, err);
  }
});

lifeInsuranceRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateLifeInsuranceSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const policy = await lifeInsuranceService.createLifeInsurance(parsed.data);
    return c.json(policy, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

lifeInsuranceRouter.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateLifeInsuranceSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "Validation failed", details: parsed.error }, 400);
  try {
    const policy = await lifeInsuranceService.updateLifeInsurance(
      c.req.param("id"),
      parsed.data
    );
    return c.json(policy);
  } catch (err) {
    return handleError(c, err);
  }
});

lifeInsuranceRouter.delete("/:id", async (c) => {
  try {
    await lifeInsuranceService.deleteLifeInsurance(c.req.param("id"));
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});
