/**
 * Report 1 — "Optimize membership" body (reports redesign, 2026-09-25;
 * mockup `Optimize Membership Redesign.dc.html`, plan D1/D6). People to
 * consider adding to or removing from a cancer center's roster, from the
 * weekly `CenterCollabCandidate` precompute.
 *
 * The server half: loads every candidate row once
 * (`loadCollabReportRows`, shared with the `.xlsx` routes), parses the URL's
 * thresholds and filters (`parseOptimizeParams`), and hands both to the
 * client half (`CancerCenterCollabReportCard`), which does the thresholding,
 * tabs, sort, paging and selection and keeps the URL in step. The "Last
 * refreshed" stamp goes in the header's subtitle slot.
 *
 * Unit-gated, center-only (`REPORT_NUMBERS_BY_KIND`); the frame is the
 * dynamic page's (`lib/edit/report-registry.ts`).
 */
import { CancerCenterCollabReportCard } from "@/components/edit/cancer-center-collab-report-card";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { loadCollabReportRows } from "@/lib/center-collaboration/collab-report-rows";
import { db } from "@/lib/db";
import { formatRefreshed, parseOptimizeParams } from "@/lib/edit/optimize-membership-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

function toSearchParams(sp: UnitReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

export async function renderOptimizeMembershipReport({
  code,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = toSearchParams(searchParams);
  const { rows, lastRefreshedAt } = await loadCollabReportRows(db.read, code);
  const center = sp.get("center");

  return {
    subtitle: lastRefreshedAt ? (
      <p className="text-muted-foreground text-[13px]" data-testid="om-refreshed">
        Last refreshed {formatRefreshed(lastRefreshedAt)}
      </p>
    ) : undefined,
    main: (
      <div className="mt-7">
        <CancerCenterCollabReportCard
          centerCode={code}
          rows={rows}
          initial={parseOptimizeParams(sp)}
          basePath={basePath}
          keepQuery={center ? `center=${encodeURIComponent(center)}` : ""}
          cap={SCHOLAR_EXPORT_CAP}
        />
      </div>
    ),
  };
}
