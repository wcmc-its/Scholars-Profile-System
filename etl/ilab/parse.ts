/**
 * iLab charges export -> `core_charge` rows. Pure (no DB, no S3) so the
 * importer's parsing is unit-testable on synthetic workbooks.
 */
import ExcelJS from "exceljs";

import { isCwid } from "../../lib/cwid";

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
  /// the first row wins rather than counting it twice). `duplicateMismatch` = a
  /// repeated Charge ID whose price or payment differs from the first row's:
  /// still dropped, but counted apart because dollars or a grant link are lost.
  /// `longChargeId` = a Charge ID wider than the `charge_id` column.
  skipped: {
    noChargeId: number;
    longChargeId: number;
    noCoreName: number;
    noErpDate: number;
    badPrice: number;
    duplicate: number;
    duplicateMismatch: number;
  };
};

/** `core_charge` column widths the parser enforces (see the migration). */
const CHARGE_ID_MAX = 32;
const TEXT_MAX = 255;

/**
 * PI email domains whose local part is a WCM CWID. nyp.org is included because
 * WCM faculty with NYP addresses use their CWID there. Any other domain (gmail,
 * partner institutions) has no CWID, and its local part could collide with one.
 */
const CWID_EMAIL_DOMAINS = new Set(["med.cornell.edu", "weill.cornell.edu", "nyp.org"]);

/** The PI's CWID from a WCM email, or null (external domain, or an alias such as first.last). */
export function emailCwid(email: string | null): string | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(email?.trim().toLowerCase() ?? "");
  if (!m || !CWID_EMAIL_DOMAINS.has(m[2])) return null;
  return isCwid(m[1]) ? m[1] : null;
}

/** "Total Price" as a number: numeric cells as-is; text with $, commas or (accounting negatives) parsed. */
function money(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  let t = v.trim().replace(/[$,\s]/g, "");
  const neg = /^\(.*\)$/.test(t);
  if (neg) t = t.slice(1, -1);
  if (t === "") return NaN;
  const n = Number(t);
  return neg ? -n : n;
}

/**
 * "Payment Information" as text. A numeric cell has lost its leading zero, so a
 * 7- or 9-digit integer is re-padded to the 8-digit fund / 10-digit WBS it was.
 */
function payment(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
    const s = String(v);
    return s.length === 7 || s.length === 9 ? s.padStart(s.length + 1, "0") : s;
  }
  return str(v)?.slice(0, TEXT_MAX) ?? null;
}

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
/** Payment accounts whose charges are the subsidy line, for exports without a "Subsidy" column. */
export type ParseOptions = { subsidyAccounts?: ReadonlySet<string> };

export function parseChargeRows(
  rows: Array<Record<string, unknown>>,
  { subsidyAccounts }: ParseOptions = {},
): ParseResult {
  const skipped = {
    noChargeId: 0,
    longChargeId: 0,
    noCoreName: 0,
    noErpDate: 0,
    badPrice: 0,
    duplicate: 0,
    duplicateMismatch: 0,
  };
  const seen = new Map<string, CoreChargeRow>();
  const charges: CoreChargeRow[] = [];
  for (const r of rows) {
    const chargeId = str(r[COL.chargeId]);
    if (!chargeId) {
      skipped.noChargeId++;
      continue;
    }
    if (chargeId.length > CHARGE_ID_MAX) {
      skipped.longChargeId++;
      continue;
    }
    const coreName = str(r[COL.coreName]);
    if (!coreName) {
      skipped.noCoreName++;
      continue;
    }
    const erpDate = day(r[COL.erpDate]);
    if (!erpDate) {
      skipped.noErpDate++;
      continue;
    }
    const price = money(r[COL.totalPrice]);
    if (!Number.isFinite(price)) {
      skipped.badPrice++;
      continue;
    }
    const paymentNumber = payment(r[COL.payment]);
    const charge: CoreChargeRow = {
      chargeId,
      coreName: coreName.slice(0, TEXT_MAX),
      customerLab: str(r[COL.customerLab])?.slice(0, TEXT_MAX) ?? null,
      piCwid: emailCwid(str(r[COL.piEmail])),
      ilabMcc: str(r[COL.mcc])?.toUpperCase() === "Y",
      totalPrice: price.toFixed(2),
      // The hand-built report labels the subsidy line; a raw iLab export does
      // not, but the line is always charged to the center's subsidy account.
      isSubsidy:
        str(r[COL.subsidy]) === "Subsidy" ||
        (paymentNumber !== null && subsidyAccounts?.has(paymentNumber) === true),
      paymentNumber,
      erpDate,
      billingDate: day(r[COL.billingDate]),
      purchaseDate: day(r[COL.purchaseDate]),
    };
    const first = seen.get(chargeId);
    if (first) {
      if (first.totalPrice !== charge.totalPrice || first.paymentNumber !== charge.paymentNumber) {
        skipped.duplicateMismatch++;
      } else {
        skipped.duplicate++;
      }
      continue;
    }
    seen.set(chargeId, charge);
    charges.push(charge);
  }
  return { charges, skipped };
}

/**
 * Read an iLab charges xlsx. The charges sheet is the first worksheet with a
 * "Charge ID" header cell in its first 10 rows (the export also carries pivot
 * and chart sheets, and the sheet name changes per quarter).
 */
export async function readChargesWorkbook(
  buffer: ArrayBuffer | Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
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
      return parseChargeRows(rows, opts);
    }
  }
  throw new Error(`No worksheet has a "${COL.chargeId}" header; is this an iLab charges export?`);
}

/** Inclusive ERP-date range of the parsed charges (logged; the import replaces an explicit window). */
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

/** Longest replace window: one quarter (92 days inclusive covers every calendar quarter). */
export const MAX_WINDOW_DAYS = 92;

/**
 * The import's explicit replace window from `--from` / `--to` (YYYY-MM-DD,
 * inclusive). Required, and capped at one quarter, so a stray old ERP date in
 * the file can never widen the delete.
 */
export function parseErpWindow(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } {
  const parse = (name: string, v: string | undefined): Date => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v))
      throw new Error(`${name} YYYY-MM-DD is required (the quarter to replace).`);
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
      throw new Error(`${name} ${v} is not a date.`);
    return d;
  };
  const w = { from: parse("--from", from), to: parse("--to", to) };
  const days = (w.to.getTime() - w.from.getTime()) / 86_400_000 + 1;
  if (days < 1) throw new Error(`--to ${to} is before --from ${from}.`);
  if (days > MAX_WINDOW_DAYS) {
    throw new Error(
      `Window ${from}..${to} is ${days} days; the import replaces at most one quarter (${MAX_WINDOW_DAYS} days).`,
    );
  }
  return w;
}

/** Split charges into those whose ERP date is inside the window and the count outside it. */
export function chargesInWindow(
  charges: CoreChargeRow[],
  w: { from: Date; to: Date },
): { inside: CoreChargeRow[]; outside: number } {
  const inside = charges.filter((c) => c.erpDate >= w.from && c.erpDate <= w.to);
  return { inside, outside: charges.length - inside.length };
}
