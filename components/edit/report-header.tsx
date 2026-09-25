/**
 * The shared header of every `/edit/reports/[report]` page (the reports
 * redesign, 2026-09-24): a "Report N" eyebrow; the report's name from
 * `report_meta` (`lib/edit/report-meta.ts`) as the `<h1>`; beside it the
 * access badge — the default audience plus "+ N others" for hand-added
 * grantees, opening "Who can open this report" (`ReportAccessPopover`; the
 * page hands over its props, since only it knows the gate); the page's own dynamic subtitle (`children`); when the report has a
 * description, a closed-by-default "About this report" disclosure; and, at
 * the right, "Edit details" (`ReportDetailsSheet`, a client island) for a
 * superuser, or "Manage access" for a comms steward who can change a
 * row-granted report's grants.
 *
 * An async SERVER component: the meta read is `cache()`d, so it shares the
 * page's `generateMetadata` read. The request record is read only for a
 * superuser — report editors only, never rendered on the report.
 *
 * The description is stored write-sanitized (`sanitizeOverview`, the route)
 * and re-sanitized here on read (`sanitizeOverviewHtml`) before the raw
 * `dangerouslySetInnerHTML` — the overview precedent (`lib/api/manual-layer.ts`).
 */
import * as React from "react";

import { ReportAccessPopover, type ReportAccessPopoverProps } from "@/components/edit/report-access-popover";
import { ReportDetailsSheet } from "@/components/edit/report-details-sheet";
import type { EditSession } from "@/lib/auth/superuser";
import { loadReportRequestRecord, reportMetaFor, type ReportKey } from "@/lib/edit/report-meta";
import { sanitizeOverviewHtml } from "@/lib/edit/validators";
import { OVERVIEW_HTML_CLASS } from "@/lib/utils";

export type ReportHeaderProps = {
  /** Which report — the `report_meta.report_key`. */
  n: ReportKey;
  /** The effective session; only `isSuperuser` is read (the meta editor's gate). */
  session: Pick<EditSession, "isSuperuser">;
  /** The access badge's props, composed by the page — `mode: "unit"` for a
   *  unit-gated report, `mode: "person"` with the grant rows (and, for report
   *  8, its audience and note) for a row-granted one. Omitted → no badge. */
  access?: ReportAccessPopoverProps;
  /** The page's dynamic subtitle `<p>`, rendered under the heading row. */
  children?: React.ReactNode;
};

export async function ReportHeader({ n, session, access, children }: ReportHeaderProps) {
  const meta = await reportMetaFor(n);
  const canEditMeta = session.isSuperuser;
  const canManageAccess = access?.mode === "person" && access.canManage;
  const request = canEditMeta ? await loadReportRequestRecord(n) : null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-[0.08em] uppercase tabular-nums">
          Report {n}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[26px] font-bold tracking-[-0.01em]">{meta.name}</h1>
          {access && (
            <span className="inline-flex" data-testid="report-header-access">
              <ReportAccessPopover {...access} />
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-2 max-w-[760px] text-[15px]" data-testid="report-header-rendered">
          {children}
          {meta.descriptionHtml !== null && (
            <details className="mt-2 text-sm" data-testid="report-description">
              <summary className="cursor-pointer">About this report</summary>
              <div
                className={OVERVIEW_HTML_CLASS}
                dangerouslySetInnerHTML={{ __html: sanitizeOverviewHtml(meta.descriptionHtml) }}
              />
            </details>
          )}
        </div>
      </div>
      {(canEditMeta || canManageAccess) && access && (
        <ReportDetailsSheet
          n={n}
          meta={{
            slug: meta.slug,
            name: meta.name,
            summary: meta.summary,
            descriptionHtml: meta.descriptionHtml,
          }}
          canEditMeta={canEditMeta}
          request={request}
          access={access}
        />
      )}
    </div>
  );
}
