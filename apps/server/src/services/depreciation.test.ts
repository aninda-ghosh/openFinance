import { depreciatedValue } from "@openfinance/shared/utils";
import { describe, expect, it } from "vitest";

describe("depreciatedValue", () => {
  it("returns the quote unchanged on the quote date", () => {
    expect(depreciatedValue(20000, 15, "2026-01-01", "2026-01-01")).toBe(20000);
  });

  it("compounds the yearly rate", () => {
    // Two years at 15%: 20000 × 0.85² = 14450 (±leap-day rounding).
    expect(depreciatedValue(20000, 15, "2024-01-01", "2026-01-01")).toBeCloseTo(14450, -1);
  });

  it("drifts continuously within a year", () => {
    const half = depreciatedValue(20000, 15, "2026-01-01", "2026-07-02");
    expect(half).toBeLessThan(20000);
    expect(half).toBeGreaterThan(17000);
  });

  it("is flat without a rate or a quote date", () => {
    expect(depreciatedValue(20000, null, "2020-01-01", "2026-01-01")).toBe(20000);
    expect(depreciatedValue(20000, 0, "2020-01-01", "2026-01-01")).toBe(20000);
    expect(depreciatedValue(20000, 15, null, "2026-01-01")).toBe(20000);
  });

  it("estimates a higher value before the quote date", () => {
    expect(depreciatedValue(20000, 15, "2026-01-01", "2025-01-01")).toBeGreaterThan(20000);
  });
});
