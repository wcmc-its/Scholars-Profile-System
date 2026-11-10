import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  chargesInWindow,
  emailCwid,
  erpRange,
  parseChargeRows,
  parseErpWindow,
  readChargesWorkbook,
  wbsFinAccount,
} from "@/etl/ilab/parse";

// Synthetic fixtures only: invented labs, CWIDs, accounts and amounts.
const HEADER = [
  "PI Email",
  "Customer Lab",
  "MCC (Y/N)",
  "Payment Information",
  "Subsidy",
  "Total Price",
  "Purchase Date",
  "Billing Date",
  "Date file sent to ERP",
  "Core Name",
  "Charge ID",
];

const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function workbook(rows: unknown[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Pivot").addRow(["Date file sent to ERP", "(Multiple Items)"]);
  const ws = wb.addWorksheet("charges_report");
  ws.addRow(HEADER);
  for (const r of rows) ws.addRow(r);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("wbsFinAccount", () => {
  it("takes the first 8 digits of a 10-digit WBS", () => {
    expect(wbsFinAccount("1234567801")).toBe("12345678");
    expect(wbsFinAccount(" 1234567801 ")).toBe("12345678");
  });

  it("returns null for an 8-digit fund and anything else", () => {
    expect(wbsFinAccount("87654321")).toBeNull();
    expect(wbsFinAccount("123456789")).toBeNull();
    expect(wbsFinAccount("12345678AB")).toBeNull();
    expect(wbsFinAccount(null)).toBeNull();
    expect(wbsFinAccount(undefined)).toBeNull();
  });
});

describe("readChargesWorkbook", () => {
  it("finds the charges sheet and maps every kept column", async () => {
    const buf = await workbook([
      [
        { text: "abc1001@med.cornell.edu", hyperlink: "mailto:abc1001@med.cornell.edu" },
        "Example Lab A",
        "Y",
        123456701,
        "Subsidy",
        -25.5,
        d("2026-06-20"),
        d("2026-07-02"),
        d("2026-07-15"),
        "Example Core ",
        900001,
      ],
      [
        "XYZ2002@Med.Cornell.edu",
        "Example Lab B",
        "#N/A",
        87654321,
        "Paid by Researcher",
        100,
        null,
        null,
        d("2026-10-20"),
        "Other Core",
        900002,
      ],
    ]);
    const { charges, skipped } = await readChargesWorkbook(buf);
    expect(skipped).toEqual({
      noChargeId: 0,
      longChargeId: 0,
      noCoreName: 0,
      noErpDate: 0,
      badPrice: 0,
      duplicate: 0,
      duplicateMismatch: 0,
    });
    expect(charges).toEqual([
      {
        chargeId: "900001",
        coreName: "Example Core",
        customerLab: "Example Lab A",
        piCwid: "abc1001",
        ilabMcc: true,
        totalPrice: "-25.50",
        isSubsidy: true,
        paymentNumber: "0123456701",
        erpDate: d("2026-07-15"),
        billingDate: d("2026-07-02"),
        purchaseDate: d("2026-06-20"),
      },
      {
        chargeId: "900002",
        coreName: "Other Core",
        customerLab: "Example Lab B",
        piCwid: "xyz2002",
        ilabMcc: false,
        totalPrice: "100.00",
        isSubsidy: false,
        paymentNumber: "87654321",
        erpDate: d("2026-10-20"),
        billingDate: null,
        purchaseDate: null,
      },
    ]);
  });

  it("throws when no sheet has a Charge ID header", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("x").addRow(["a", "b"]);
    await expect(readChargesWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer)).rejects.toThrow(
      /Charge ID/,
    );
  });
});

describe("parseChargeRows", () => {
  const base = {
    "Charge ID": 1,
    "Core Name": "Example Core",
    "Total Price": 10,
    "Date file sent to ERP": d("2026-07-01"),
  };

  it("keeps rows from any date; the import loads only those in its explicit window", () => {
    const { charges } = parseChargeRows([
      { ...base, "Charge ID": 1, "Date file sent to ERP": d("2026-07-01") },
      { ...base, "Charge ID": 2, "Date file sent to ERP": d("2026-10-31") },
      { ...base, "Charge ID": 3, "Date file sent to ERP": d("2026-09-30") },
      { ...base, "Charge ID": 4, "Date file sent to ERP": d("2026-01-05") },
    ]);
    expect(charges).toHaveLength(4);
    expect(erpRange(charges)).toEqual({ from: d("2026-01-05"), to: d("2026-10-31") });
    expect(erpRange([])).toBeNull();
    const { inside, outside } = chargesInWindow(
      charges,
      parseErpWindow("2026-07-01", "2026-09-30"),
    );
    expect(inside.map((c) => c.chargeId)).toEqual(["1", "3"]);
    expect(outside).toBe(2);
  });

  it("parses currency text prices and re-pads numeric payment cells", () => {
    const { charges, skipped } = parseChargeRows([
      { ...base, "Charge ID": 1, "Total Price": "$1,234.50", "Payment Information": 1234567 },
      { ...base, "Charge ID": 2, "Total Price": "(25.00)", "Payment Information": 12345678 },
      { ...base, "Charge ID": 3, "Total Price": " -3 ", "Payment Information": "0123456701" },
    ]);
    expect(skipped.badPrice).toBe(0);
    expect(charges.map((c) => [c.totalPrice, c.paymentNumber])).toEqual([
      ["1234.50", "01234567"],
      ["-25.00", "12345678"],
      ["-3.00", "0123456701"],
    ]);
  });

  it("truncates overlong text and skips an overlong charge id", () => {
    const { charges, skipped } = parseChargeRows([
      {
        ...base,
        "Charge ID": 1,
        "Payment Information": `PO ${"x".repeat(300)}`,
        "Customer Lab": "L".repeat(300),
      },
      { ...base, "Charge ID": "9".repeat(33) },
    ]);
    expect(skipped.longChargeId).toBe(1);
    expect(charges).toHaveLength(1);
    expect(charges[0].paymentNumber).toHaveLength(255);
    expect(charges[0].customerLab).toHaveLength(255);
    expect(wbsFinAccount(charges[0].paymentNumber)).toBeNull();
  });

  it("counts a repeated charge id with a different price or payment apart from a plain repeat", () => {
    const { charges, skipped } = parseChargeRows([
      { ...base, "Charge ID": 1, "Total Price": 10, "Payment Information": "1111222201" },
      { ...base, "Charge ID": 1, "Total Price": 10, "Payment Information": "1111222201" },
      { ...base, "Charge ID": 1, "Total Price": 12, "Payment Information": "1111222201" },
      { ...base, "Charge ID": 1, "Total Price": 10, "Payment Information": "3333444401" },
    ]);
    expect(charges.map((c) => c.totalPrice)).toEqual(["10.00"]);
    expect(skipped.duplicate).toBe(1);
    expect(skipped.duplicateMismatch).toBe(2);
  });

  it("skips unusable rows and keeps the first of a repeated charge id", () => {
    const { charges, skipped } = parseChargeRows([
      { ...base, "Charge ID": 1, "Total Price": 10 },
      { ...base, "Charge ID": 1, "Total Price": 10 },
      { ...base, "Charge ID": null },
      { ...base, "Charge ID": 3, "Core Name": "  " },
      { ...base, "Charge ID": 4, "Date file sent to ERP": null },
      { ...base, "Charge ID": 5, "Total Price": "n/a" },
      { ...base, "Charge ID": 6, "PI Email": "no-at-sign" },
    ]);
    expect(skipped).toEqual({
      noChargeId: 1,
      longChargeId: 0,
      noCoreName: 1,
      noErpDate: 1,
      badPrice: 1,
      duplicate: 1,
      duplicateMismatch: 0,
    });
    expect(charges.map((c) => [c.chargeId, c.piCwid])).toEqual([
      ["1", null],
      ["6", null],
    ]);
  });
});

describe("emailCwid", () => {
  it("takes a CWID-shaped local part from a WCM domain", () => {
    expect(emailCwid("Abc1001@Med.Cornell.edu")).toBe("abc1001");
    expect(emailCwid("abc1001@weill.cornell.edu")).toBe("abc1001");
    expect(emailCwid("abc1001@nyp.org")).toBe("abc1001");
    // Name-derived vanity CWIDs have no digits.
    expect(emailCwid("exvanity@med.cornell.edu")).toBe("exvanity");
  });

  it("returns null for an external domain or a non-CWID alias", () => {
    expect(emailCwid("abc1001@gmail.com")).toBeNull();
    expect(emailCwid("abc1001@partner.example.org")).toBeNull();
    expect(emailCwid("first.last@med.cornell.edu")).toBeNull();
    expect(emailCwid("no-at-sign")).toBeNull();
    expect(emailCwid(null)).toBeNull();
  });
});

describe("parseErpWindow", () => {
  it("accepts an inclusive window up to one quarter", () => {
    expect(parseErpWindow("2026-07-01", "2026-09-30")).toEqual({
      from: d("2026-07-01"),
      to: d("2026-09-30"),
    });
    expect(parseErpWindow("2026-10-01", "2026-12-31")).toEqual({
      from: d("2026-10-01"),
      to: d("2026-12-31"),
    });
  });

  it("refuses a missing, malformed, reversed or wider-than-a-quarter window", () => {
    expect(() => parseErpWindow(undefined, "2026-09-30")).toThrow(/--from/);
    expect(() => parseErpWindow("2026-07-01", undefined)).toThrow(/--to/);
    expect(() => parseErpWindow("2026-02-30", "2026-03-31")).toThrow(/not a date/);
    expect(() => parseErpWindow("2026-09-30", "2026-07-01")).toThrow(/before/);
    expect(() => parseErpWindow("2026-01-01", "2026-09-30")).toThrow(/at most one quarter/);
  });
});
