import {
  addDaysIso,
  addMonthsIso,
  isIsoDate,
  localIsoDate,
} from "@openfinance/shared/utils";
import { describe, expect, it, vi } from "vitest";
import { premiumDueDates } from "./policy.service";
import { advanceDate } from "./recurring.service";

vi.mock("../db/index", () => ({ getDb: () => ({}), runTransaction: vi.fn() }));

describe("calendar-date arithmetic", () => {
  it("clamps to month end and returns to the anchor day", () => {
    expect(addMonthsIso("2026-01-31", 1, 31)).toBe("2026-02-28");
    expect(addMonthsIso("2026-02-28", 1, 31)).toBe("2026-03-31");
    expect(addMonthsIso("2024-02-29", 12, 29)).toBe("2025-02-28");
    expect(addMonthsIso("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("adds days across a year end", () => {
    expect(addDaysIso("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("recognises only real YYYY-MM-DD dates", () => {
    expect(isIsoDate("2026-09-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("09/28/2026")).toBe(false);
  });

  it("uses the local calendar day, not UTC", () => {
    // 11pm on Sep 30 local is already Oct 1 in UTC for anyone west of UTC.
    expect(localIsoDate(new Date(2026, 8, 30, 23, 0))).toBe("2026-09-30");
  });
});

describe("recurring rules", () => {
  it("keeps a rule on the 1st on the 1st (it used to drift to the 28th west of UTC)", () => {
    let d = "2026-03-01";
    const seen = [d];
    for (let i = 0; i < 3; i++) seen.push((d = advanceDate(d, "monthly", 1)));
    expect(seen).toEqual(["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
  });

  it("does not skip February for a rule on the 31st", () => {
    let d = "2026-01-31";
    const seen = [d];
    for (let i = 0; i < 3; i++) seen.push((d = advanceDate(d, "monthly", 31)));
    expect(seen).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("steps weekly, quarterly and annually", () => {
    expect(advanceDate("2026-09-28", "weekly")).toBe("2026-10-05");
    expect(advanceDate("2026-11-30", "quarterly", 30)).toBe("2027-02-28");
    expect(advanceDate("2028-02-29", "annual", 29)).toBe("2029-02-28");
  });
});

describe("policy premium schedule", () => {
  it("lists each premium once, on its day, within the premium term", () => {
    const dates = premiumDueDates({
      start_date: "2026-01-31",
      premium_frequency: "monthly",
      premium_term_years: 1,
    });
    expect(dates).toHaveLength(12);
    expect(dates.slice(0, 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(dates[11]).toBe("2026-12-31");
  });
});
