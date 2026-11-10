/**
 * iLab charges export -> `core_charge` rows. Pure (no DB, no S3) so the
 * importer's parsing is unit-testable on synthetic workbooks.
 */
import ExcelJS from "exceljs";

export type CoreChargeRow = {
  chargeId: string;
  coreName: string;
  customerLab: string | null;
  piCwid: string | null;
  ilabMcc: boolean;
  /// Cents-rounded decimal string, e.g. "-12.50" for a refund.
  totalPrice: string;
  isSubsidy: boolean;
  paymentNumber: string | null;
  erpDate: Date;
  billingDate: Date | null;
  purchaseDate: Date | null;
};

export type ParseResult = {
  charges: CoreChargeRow[];
  /// Rows dropped, by reason. `duplicate` = a repeated Charge ID (iLab repeats a
  /// charge once per linked service request; the price is the same charge, so
  /// the first row wins rather than counting it twice).
  skipped: { noChargeId: number; noCoreName: number; noErpDate: number; badPrice: number; duplicate: number };
};

/** The header cells the parser reads; the sheet is found by "Charge ID". */
const COL = {
  chargeId: "Charge ID",
  coreName: "Core Name",
  customerLab: "Customer Lab",
  piEmail: "PI Email",
  mcc: "MCC (Y/N)",
  totalPrice: "Total Price",
  subsidy: "Subsidy",
  payment: "Payment Information",
  erpDate: "Date file sent to ERP",
  billingDate: "Billing Date",
  purchaseDate: "Purchase Date",
} as const;

/**
 * The 8-digit InfoEd `proposal.acct` behind an iLab payment number, or null.
 * A 10-digit payment number is a WBS = 8-digit acct + 2-digit suffix; an
 * 8-digit one is a department/MCC fund, which is not a grant.
 */
export function wbsFinAccount(paymentNumber: string | null | undefined): string | null {
  const p = paymentNumber?.trim() ?? "";
  return /^\d{10}$/.test(p) ? p.slice(0, 8) : null;
}

/** Flatten an exceljs cell value (rich text, hyperlink, formula) to a primitive. */
function plain(v: ExcelJS.CellValue): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if ("result" in v) return plain(v.result as ExcelJS.CellValue);
  if ("richText" in v) return v.richText.map((t) => t.text).join("");
  if ("text" in v) return plain(v.text as ExcelJS.CellValue);
  return null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = (v instanceof Date ? v.toISOString() : String(v)).trim();
  return s === "" ? null : s;
}

/** A date cell as a UTC midnight Date (exceljs yields dates as UTC), or null. */
function day(v: unknown): Date | null {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "string" && v.trim() !== "") d = new Date(v.trim());
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Parse header-keyed rows (values already flattened) into `core_charge` rows. */
export function parseChargeRows(rows: Array<Record<string, unknown>>): ParseResult {
  const skipped = { noChargeId: 0, noCoreName: 0, noErpDate: 0, badPrice: 0, duplicate: 0 };
  const seen = new Set<string>();
  const charges: CoreChargeRow[] = [];
  for (const r of rows) {
    const chargeId = str(r[COL.chargeId]);
    if (!chargeId) { skipped.noChargeId++; continue; }
    const coreName = str(r[COL.coreName]);
    if (!coreName) { skipped.noCoreName++; continue; }
    const erpDate = day(r[COL.erpDate]);
    if (!erpDate) { skipped.noErpDate++; continue; }
    const price = Number(r[COL.totalPrice]);
    if (r[COL.totalPrice] === null || r[COL.totalPrice] === undefined || !Number.isFinite(price)) {
      skipped.badPrice++;
      continue;
    }
    if (seen.has(chargeId)) { skipped.duplicate++; continue; }
    seen.add(chargeId);
    const email = str(r[COL.piEmail]);
    charges.push({
      chargeId,
      coreName,
      customerLab: str(r[COL.customerLab]),
      piCwid: email?.includes("@") ? email.split("@")[0].toLowerCase() || null : null,
      ilabMcc: str(r[COL.mcc])?.toUpperCase() === "Y",
      totalPrice: price.toFixed(2),
      isSubsidy: str(r[COL.subsidy]) === "Subsidy",
      paymentNumber: str(r[COL.payment]),
      erpDate,
      billingDate: day(r[COL.billingDate]),
      purchaseDate: day(r[COL.purchaseDate]),
    });
  }
  return { charges, skipped };
}

/**
 * Read an iLab charges xlsx. The charges sheet is the first worksheet with a
 * "Charge ID" header cell in its first 10 rows (the export also carries pivot
 * and chart sheets, and the sheet name changes per quarter).
 */
export async function readChargesWorkbook(buffer: ArrayBuffer | Uint8Array): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  for (const ws of wb.worksheets) {
    for (let h = 1; h <= Math.min(10, ws.rowCount); h++) {
      const header = new Map<number, string>();
      ws.getRow(h).eachCell((cell, col) => {
        const name = str(plain(cell.value));
        if (name) header.set(col, name);
      });
      if (![...header.values()].includes(COL.chargeId)) continue;
      const rows: Array<Record<string, unknown>> = [];
      for (let i = h + 1; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        if (!row.hasValues) continue;
        const rec: Record<string, unknown> = {};
        for (const [col, name] of header) rec[name] = plain(row.getCell(col).value);
        rows.push(rec);
      }
      return parseChargeRows(rows);
    }
  }
  throw new Error(`No worksheet has a "${COL.chargeId}" header; is this an iLab charges export?`);
}

/** Inclusive ERP-date range of the parsed charges; the import replaces this span. */
export function erpRange(charges: CoreChargeRow[]): { from: Date; to: Date } | null {
  if (charges.length === 0) return null;
  let from = charges[0].erpDate;
  let to = from;
  for (const c of charges) {
    if (c.erpDate < from) from = c.erpDate;
    if (c.erpDate > to) to = c.erpDate;
  }
  return { from, to };
}
