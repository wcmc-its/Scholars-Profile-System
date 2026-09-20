/**
 * Report 1 — "Optimize membership" (formerly the `?attr=reports` tab inside
 * `/edit/center/[code]`; Cancer Center collaboration-recommendations v2,
 * `2026-08-10-cancer-center-collaboration-recommendations-v2-cancer-
 * relevance-plan.md`). Hosts `CancerCenterCollabReportCard`, passing
 * `ctx.unit.name` for its subtitle line (`Reports View Fix` mockup review,
 * 2026-08-16). The body of what was `app/edit/reports/1/page.tsx`, moved
 * verbatim into the registry shape (`lib/edit/report-registry.ts`): the
 * session / gate / shell / header frame is the dynamic page's; this owns only
 * the report. Unit-gated, center-only (`REPORT_NUMBERS_BY_KIND`). No subtitle.
 */
import { CancerCenterCollabReportCard } from "@/components/edit/cancer-center-collab-report-card";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

/** Report 1's body: the collaboration-recommendations card for `code`. */
export async function renderOptimizeMembershipReport({
  code,
  ctx,
}: UnitReportProps): Promise<ReportRender> {
  return {
    main: (
      // ConsoleShell owns only the chrome — see app/edit/reports/page.tsx.
      <div className="apollo-card">
        <CancerCenterCollabReportCard centerCode={code} centerName={ctx.unit.name} />
      </div>
    ),
  };
}
