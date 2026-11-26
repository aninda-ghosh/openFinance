import type { AccountResponse } from "@openfinance/shared/api-contracts";
import { describe, expect, it } from "vitest";
import {
  applyPreview,
  draftFromParsed,
  payeeKey,
  rowProblem,
  toBulkRow,
} from "./bulkRows";

const acct = (over: Partial<AccountResponse>): AccountResponse => ({
  id: "x",
  name: "X",
  type: "checking",
  currency: "USD",
  balance: 0,
  balance_inr: 0,
  institution: null,
  is_active: true,
  off_budget: false,
  created_at: "",
  updated_at: "",
  ...over,
});

const gold = acct({
  id: "gold",
  name: "Gold Card",
  type: "credit",
  institution: "American Express",
});
const checking = acct({
  id: "chk",
  name: "Everyday Checking",
  type: "checking",
  institution: "Chase",
});
const brokerage = acct({
  id: "brk",
  name: "Brokerage",
  type: "investment",
  off_budget: true,
});
const accounts = [gold, checking, brokerage];
const byId = new Map(accounts.map((a) => [a.id, a]));
const line = (description: string, amount: number | null) => ({
  date: "2026-11-12",
  description,
  amount,
  sourceKey: `k-${description}`,
});

describe("draftFromParsed", () => {
  it("card statement: charges are expenses, credits are refunds", () => {
    expect(
      draftFromParsed(line("STARBUCKS", 5.4), gold, accounts, "positive").kind
    ).toBe("expense");
    expect(
      draftFromParsed(line("AMAZON MKTPLACE", -20), gold, accounts, "positive")
        .kind
    ).toBe("refund");
  });

  it("card statement: a payment is a transfer in from the checking account", () => {
    const row = draftFromParsed(
      line("AUTOPAY PAYMENT - THANK YOU", -200),
      gold,
      accounts,
      "positive"
    );
    expect(row.kind).toBe("transfer_in");
    expect(row.counterpartId).toBe("chk");
    expect(row.amount).toBe("200.00");
  });

  it("checking statement: paying the card is a transfer out to it", () => {
    const row = draftFromParsed(
      line("AMEX EPAYMENT ACH PMT", -200),
      checking,
      accounts,
      "negative"
    );
    expect(row.kind).toBe("transfer_out");
    expect(row.counterpartId).toBe("gold");
  });

  it("checking statement: a utility payment stays an expense", () => {
    expect(
      draftFromParsed(line("PG&E PAYMENT", -80), checking, accounts, "negative")
        .kind
    ).toBe("expense");
  });

  it("checking statement: deposits are income", () => {
    expect(
      draftFromParsed(
        line("PAYROLL ACME", 4200),
        checking,
        accounts,
        "negative"
      ).kind
    ).toBe("income");
  });
});

describe("applyPreview", () => {
  it("fills suggested categories and leaves out rows already saved", () => {
    const rows = [
      draftFromParsed(line("STARBUCKS", 5.4), gold, accounts, "positive"),
      draftFromParsed(line("TRADER JOES", 50), gold, accounts, "positive"),
    ];
    const out = applyPreview(rows, [
      {
        already_imported: false,
        possible_duplicates: [],
        suggested_envelope_id: "env-dining",
      },
      {
        already_imported: true,
        possible_duplicates: [],
        suggested_envelope_id: null,
      },
    ]);
    expect(out[0].envelopeId).toBe("env-dining");
    expect(out[0].include).toBe(true);
    expect(out[1].include).toBe(false);
  });

  it("leaves out a transfer the other account already recorded", () => {
    const rows = [
      draftFromParsed(
        line("AMEX EPAYMENT", -200),
        checking,
        accounts,
        "negative"
      ),
    ];
    const out = applyPreview(rows, [
      {
        already_imported: false,
        possible_duplicates: [
          {
            id: "t",
            date: "2026-11-13",
            payee: "Transfer out",
            amount: 200,
            type: "transfer",
          },
        ],
        suggested_envelope_id: null,
      },
    ]);
    expect(out[0].transferAlreadyRecorded).toBe(true);
    expect(out[0].include).toBe(false);
  });
});

describe("rowProblem and toBulkRow", () => {
  it("asks for a category on on-budget spending", () => {
    const row = draftFromParsed(
      line("STARBUCKS", 5.4),
      gold,
      accounts,
      "positive"
    );
    expect(rowProblem(row, gold, byId)).toBe("Pick a category");
    expect(rowProblem({ ...row, envelopeId: "e1" }, gold, byId)).toBeNull();
  });

  it("asks for a category when money leaves the budget", () => {
    const row = {
      ...draftFromParsed(
        line("TRANSFER TO BROKERAGE", -500),
        checking,
        accounts,
        "negative"
      ),
      counterpartId: "brk",
    };
    expect(row.kind).toBe("transfer_out");
    expect(rowProblem(row, checking, byId)).toMatch(/leaving the budget/);
    expect(
      toBulkRow({ ...row, envelopeId: "e9" }, checking, byId)
    ).toMatchObject({
      type: "transfer",
      direction: "out",
      counterpart_account_id: "brk",
      envelope_id: "e9",
    });
  });

  it("converts a refund to cashback income", () => {
    const row = draftFromParsed(
      line("AMAZON", -20),
      gold,
      accounts,
      "positive"
    );
    expect(toBulkRow(row, gold, byId)).toMatchObject({
      type: "income",
      income_category: "cashback",
      amount: 20,
    });
  });

  it("flags rows the paste could not read", () => {
    const row = draftFromParsed(
      { date: null, description: "???", amount: null, sourceKey: "z" },
      gold,
      accounts,
      "positive"
    );
    expect(rowProblem(row, gold, byId)).toBe("Enter a date");
  });
});

describe("payeeKey", () => {
  it("groups bank variations of the same merchant", () => {
    expect(payeeKey("SQ *BLUE BOTTLE #123 OAKLAND")).toBe("blue bottle");
    expect(payeeKey("Blue Bottle Coffee")).toBe("blue bottle");
  });
});
