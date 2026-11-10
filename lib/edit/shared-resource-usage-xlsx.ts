/**
 * Report 20's download: the subsidy-by-lab table (narrowed to one core when
 * the page is) and a Criteria sheet. Lab names, no people or emails, so no
 * SCHOLAR_EXPORT_CAP applies.
 */
import ExcelJS from "exceljs";

import type { FiscalQuarter, LabRow, SharedResourceParams } from "@/lib/edit/shared-resource-usage";
import { addCriteriaSheet, boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export async function buildSharedResourceWorkbook(
  centerName: string,
  quarter: FiscalQuarter | null,
  labs: readonly LabRow[],
  p: SharedResourceParams,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Subsidy by lab");
  ws.addRow(["Core", "Customer lab", "Program", "Charges", "Total ($)", "Subsidy ($)"]);
  boldRow(ws, 1);
  for (const r of labs)
    ws.addRow([r.coreName, r.customerLab, r.group, r.charges, r.total, r.subsidy]);
  for (const [i, w] of [40, 40, 16, 10, 14, 14].entries()) ws.getColumn(i + 1).width = w;
  for (const c of [5, 6]) ws.getColumn(c).numFmt = "#,##0.00";
  addCriteriaSheet(wb, [
    ["Center", centerName],
    [
      "Quarter (by date sent to ERP)",
      quarter ? `${quarter.label}, ${quarter.start} to before ${quarter.end}` : "None",
    ],
    ["Core", p.core ?? "All"],
    ["Program", "The PI's program on the charge's ERP date (research members); Non-MCC otherwise"],
    ["Dollars", "iLab Total Price, researcher and subsidy lines together; refunds are negative"],
  ]);
  return workbookBuffer(wb);
}
