import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/index";
import { createTransfer } from "./budget.service";

vi.mock("../db/index", () => {
  const mockDb = {
    select: vi.fn(),
    transaction: vi.fn(),
  };
  return {
    getDb: () => mockDb,
    runTransaction: (cb: any) => mockDb.transaction(cb),
  };
});

describe("budget.service", () => {
  const db = getDb();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTransfer boundary checks", () => {
    it("throws 400 if transfer crosses On-Budget to Off-Budget boundary without envelope", async () => {
      const limitMock = vi
        .fn()
        .mockResolvedValueOnce([
          { id: "acc-1", off_budget: false, currency: "USD" },
        ])
        .mockResolvedValueOnce([
          { id: "acc-2", off_budget: true, currency: "USD" },
        ]);

      const mockSelect = () => ({
        from: () => ({
          where: () => ({
            limit: limitMock,
          }),
        }),
      });

      (db.select as any).mockImplementation(mockSelect);

      await expect(
        createTransfer({
          from_account_id: "acc-1",
          to_account_id: "acc-2",
          amount: 100,
          to_amount: 100,
          date: "2026-05-21",
        })
      ).rejects.toThrow(
        "On-to-Off Budget transfers require a budget envelope category."
      );
    });

    it("allows transfer if envelope is provided for On-Budget to Off-Budget crossing", async () => {
      const limitMock = vi
        .fn()
        .mockResolvedValueOnce([
          { id: "acc-1", off_budget: false, currency: "USD" },
        ])
        .mockResolvedValueOnce([
          { id: "acc-2", off_budget: true, currency: "USD" },
        ]);

      const mockSelect = () => ({
        from: () => ({
          where: () => ({
            limit: limitMock,
          }),
        }),
      });

      (db.select as any).mockImplementation(mockSelect);
      (db.transaction as any).mockImplementation(async (cb: any) => {
        const mockTx = {
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "txn-1" }]),
            })),
          })),
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockResolvedValue(true),
            })),
          })),
        };
        return cb(mockTx);
      });

      const _res = await createTransfer({
        from_account_id: "acc-1",
        to_account_id: "acc-2",
        amount: 100,
        to_amount: 100,
        date: "2026-05-21",
        envelope_id: "env-123",
      });

      expect(db.transaction).toHaveBeenCalled();
    });
  });
});
