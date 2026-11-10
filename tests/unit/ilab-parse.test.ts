import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { erpRange, parseChargeRows, readChargesWorkbook, wbsFinAccount } from "@/etl/ilab/parse";

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
        { text: "abc1001@example.edu", hyperlink: "mailto:abc1001@example.edu" },
        "Example Lab A",
        "Y",
        1234567801,
        "Subsidy",
        -25.5,
        d("2026-06-20"),
        d("2026-07-02"),
        d("2026-07-15"),
        "Example Core ",
        900001,
      ],
      ["XYZ2002@Example.edu", "Example Lab B", "#N/A", 87654321, "Paid by Researcher", 100, null, null, d("2026-10-20"), "Other Core", 900002],
    ]);
    const { charges, skipped } = await readChargesWorkbook(buf);
    expect(skipped).toEqual({ noChargeId: 0, noCoreName: 0, noErpDate: 0, badPrice: 0, duplicate: 0 });
    expect(charges).toEqual([
      {
        chargeId: "900001",
        coreName: "Example Core",
        customerLab: "Example Lab A",
        piCwid: "abc1001",
        ilabMcc: true,
        totalPrice: "-25.50",
        isSubsidy: true,
        paymentNumber: "1234567801",
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

  it("keeps rows from any date; the import replaces their ERP-date range", () => {
    const { charges } = parseChargeRows([
      { ...base, "Charge ID": 1, "Date file sent to ERP": d("2026-07-01") },
      { ...base, "Charge ID": 2, "Date file sent to ERP": d("2026-10-31") },
      { ...base, "Charge ID": 3, "Date file sent to ERP": d("2026-09-15") },
    ]);
    expect(charges).toHaveLength(3);
    expect(erpRange(charges)).toEqual({ from: d("2026-07-01"), to: d("2026-10-31") });
    expect(erpRange([])).toBeNull();
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
    expect(skipped).toEqual({ noChargeId: 1, noCoreName: 1, noErpDate: 1, badPrice: 1, duplicate: 1 });
    expect(charges.map((c) => [c.chargeId, c.piCwid])).toEqual([
      ["1", null],
      ["6", null],
    ]);
  });
});
