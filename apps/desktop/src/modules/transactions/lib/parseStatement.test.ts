import { describe, expect, it } from "vitest";
import { parseStatement } from "./parseStatement";

const today = new Date(2026, 10, 15); // 15 Nov 2026
const simple = (text: string) =>
  parseStatement(text, { today }).rows.map(({ date, description, amount }) => ({
    date,
    description,
    amount,
  }));

describe("parseStatement: CSV and spreadsheet copies", () => {
  it("reads a card CSV with a header (Date, Description, Amount)", () => {
    const rows = simple(
      'Date,Description,Amount\n11/12/2026,STARBUCKS STORE 1234,5.40\n11/13/2026,"AUTOPAY PAYMENT - THANK YOU",-200.00'
    );
    expect(rows).toEqual([
      { date: "2026-11-12", description: "STARBUCKS STORE 1234", amount: 5.4 },
      {
        date: "2026-11-13",
        description: "AUTOPAY PAYMENT - THANK YOU",
        amount: -200,
      },
    ]);
  });

  it("prefers the transaction date over the post date", () => {
    const rows = simple(
      "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/10/2026,11/12/2026,BLUE BOTTLE,Food & Drink,Sale,-6.25,"
    );
    expect(rows).toEqual([
      { date: "2026-11-10", description: "BLUE BOTTLE", amount: -6.25 },
    ]);
  });

  it("combines Debit / Credit columns and marks money out as negative", () => {
    const result = parseStatement(
      "Date,Description,Debit,Credit,Balance\n2026-11-01,RENT,1500.00,,3500.00\n2026-11-02,PAYROLL,,4200.00,7700.00",
      { today }
    );
    expect(result.outflowSign).toBe("negative");
    expect(result.rows.map((r) => r.amount)).toEqual([-1500, 4200]);
  });

  it("reads tab-separated rows pasted from a spreadsheet without a header", () => {
    expect(simple("2026-11-12\tCoffee\t-5.40\n2026-11-13\tLunch\t-12")).toEqual(
      [
        { date: "2026-11-12", description: "Coffee", amount: -5.4 },
        { date: "2026-11-13", description: "Lunch", amount: -12 },
      ]
    );
  });

  it("ignores a running balance column after the amount", () => {
    expect(
      simple("11/12/2026,Coffee,-5.40,994.60\n11/13/2026,Lunch,-12.00,982.60")
    ).toEqual([
      { date: "2026-11-12", description: "Coffee", amount: -5.4 },
      { date: "2026-11-13", description: "Lunch", amount: -12 },
    ]);
  });
});

describe("parseStatement: text copied from a website", () => {
  it("reads one transaction per line, inferring a missing year", () => {
    expect(
      simple(
        "Nov 12, 2026 STARBUCKS STORE 12345 SEATTLE WA $5.40\nNov 13 AUTOPAY PAYMENT - THANK YOU -$200.00"
      )
    ).toEqual([
      {
        date: "2026-11-12",
        description: "STARBUCKS STORE 12345 SEATTLE WA",
        amount: 5.4,
      },
      {
        date: "2026-11-13",
        description: "AUTOPAY PAYMENT - THANK YOU",
        amount: -200,
      },
    ]);
  });

  it("reads transactions spread over several lines", () => {
    expect(
      simple(
        "Nov 12\nSTARBUCKS STORE 12345\nSEATTLE WA\n$5.40\nNov 11\nTRADER JOE S #552\n$54.20"
      )
    ).toEqual([
      {
        date: "2026-11-12",
        description: "STARBUCKS STORE 12345 SEATTLE WA",
        amount: 5.4,
      },
      { date: "2026-11-11", description: "TRADER JOE S #552", amount: 54.2 },
    ]);
  });

  it("skips a second (posting) date after the first", () => {
    expect(simple("11/10 11/12 UBER *TRIP $23.10")).toEqual([
      { date: "2026-11-10", description: "UBER *TRIP", amount: 23.1 },
    ]);
  });

  it("does not take a store number for the amount", () => {
    expect(simple("Nov 12 WALGREENS 1234 $5.40")[0]).toEqual({
      date: "2026-11-12",
      description: "WALGREENS 1234",
      amount: 5.4,
    });
  });

  it("reads CR suffixes and brackets as negative", () => {
    expect(
      simple("12 Nov 2026 REFUND 20.00 CR\n13 Nov 2026 RETURN (12.00)").map(
        (r) => r.amount
      )
    ).toEqual([-20, -12]);
  });

  it("puts a year-less date from last December in last year", () => {
    const rows = parseStatement("Dec 28 HOTEL $300.00", {
      today: new Date(2026, 0, 5),
    }).rows;
    expect(rows[0].date).toBe("2025-12-28");
  });
});

describe("parseStatement: dates and keys", () => {
  it("detects day/month order from an unambiguous date", () => {
    const result = parseStatement(
      "12/11/2026\tSWIGGY\t₹450.00\n15/11/2026\tZOMATO\t₹320.00",
      { today }
    );
    expect(result.dateOrder).toBe("dmy");
    expect(result.dateOrderAmbiguous).toBe(false);
    expect(result.rows.map((r) => r.date)).toEqual([
      "2026-11-12",
      "2026-11-15",
    ]);
  });

  it("flags day/month order as ambiguous when nothing settles it", () => {
    const result = parseStatement(
      "03/04/2026,Coffee,5.00\n04/05/2026,Tea,3.00",
      { today }
    );
    expect(result.dateOrderAmbiguous).toBe(true);
    expect(result.rows[0].date).toBe("2026-03-04");
    expect(
      parseStatement("03/04/2026,Coffee,5.00\n04/05/2026,Tea,3.00", {
        today,
        dateOrder: "dmy",
      }).rows[0].date
    ).toBe("2026-04-03");
  });

  it("does not read amounts like 42.10 as day/month dates", () => {
    // Before: "42.10" counted as day 42 of month 10, switching to dmy and
    // silently reading 03/04 as 3 April.
    const result = parseStatement(
      "03/04/2026\tCoffee\t42.10\n04/05/2026\tTea\t13.05",
      { today }
    );
    expect(result.dateOrderAmbiguous).toBe(true);
    expect(result.rows[0].date).toBe("2026-03-04");
  });

  it("still reads dotted dates that carry a year", () => {
    const result = parseStatement("31.10.2026\tREWE\t12.40", { today });
    expect(result.dateOrder).toBe("dmy");
    expect(result.rows[0].date).toBe("2026-10-31");
  });

  it("reads the openfinance-bulk-add skill's format without warnings", () => {
    const result = parseStatement(
      [
        "Date\tDescription\tDebit\tCredit",
        "2026-10-03\tWHOLEFDS MKT 10234 SAN FRANCISCO CA\t84.17\t",
        "2026-10-09\tAMAZON MKTPLACE PMTS AMZN.COM/BILL WA\t\t23.99",
        "2026-10-15\tAUTOPAY PAYMENT - THANK YOU\t\t1250.00",
      ].join("\n"),
      { today }
    );
    expect(result.dateOrderAmbiguous).toBe(false);
    expect(result.outflowSign).toBe("negative");
    expect(
      result.rows.map(({ date, description, amount }) => ({
        date,
        description,
        amount,
      }))
    ).toEqual([
      {
        date: "2026-10-03",
        description: "WHOLEFDS MKT 10234 SAN FRANCISCO CA",
        amount: -84.17,
      },
      {
        date: "2026-10-09",
        description: "AMAZON MKTPLACE PMTS AMZN.COM/BILL WA",
        amount: 23.99,
      },
      {
        date: "2026-10-15",
        description: "AUTOPAY PAYMENT - THANK YOU",
        amount: 1250,
      },
    ]);
  });

  it("gives identical lines different source keys, stable across pastes", () => {
    const text = "Nov 12 COFFEE $5.00\nNov 12 COFFEE $5.00";
    const a = parseStatement(text, { today }).rows.map((r) => r.sourceKey);
    const b = parseStatement(text, { today }).rows.map((r) => r.sourceKey);
    expect(a[0]).not.toBe(a[1]);
    expect(a).toEqual(b);
  });

  it("returns nothing for text with no dates", () => {
    expect(parseStatement("hello\nworld", { today }).rows).toEqual([]);
  });
});
