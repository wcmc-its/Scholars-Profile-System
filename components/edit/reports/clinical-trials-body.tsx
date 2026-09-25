/**
 * Report 5 — "Clinical Trials" body (reports redesign, 2026-09-25; mockup
 * `Clinical Trials Redesign.dc.html`, plan decision D4). The center's trials,
 * one per OnCore protocol number, with the members on each, plus a By member
 * roll-up; search / status / phase filters narrow the tabs, the headline
 * numbers and the `.xlsx` (`/api/edit/reports/clinical-trials`).
 *
 * The query is `loadClinicalTrialsReport`
 * (`lib/center-collaboration/clinical-trials-report.ts`: current members,
 * uncarved, no public-profile flag, withdrawn and suspended trials kept);
 * the grouping, filters and totals are `lib/edit/clinical-trials-report.ts`,
 * shared with the download. The filtering itself runs in the client half
 * (`clinical-trials-results.tsx`), which keeps the URL in step.
 *
 * Unit-gated, center-only (`REPORT_NUMBERS_BY_KIND`); the frame is the
 * dynamic page's (`lib/edit/report-registry.ts`).
 */
import { ClinicalTrialsResults } from "@/components/edit/reports/clinical-trials-results";
import { ReportCard } from "@/components/edit/reports/report-ui";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import { loadClinicalTrialsReport } from "@/lib/center-collaboration/clinical-trials-report";
import { db } from "@/lib/db";
import { groupTrials, parseClinicalTrialsParams } from "@/lib/edit/clinical-trials-report";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

function toSearchParams(sp: UnitReportProps["searchParams"]): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  }
  return out;
}

export async function renderClinicalTrialsReport({
  code,
  searchParams,
  basePath,
}: UnitReportProps): Promise<ReportRender> {
  const sp = toSearchParams(searchParams);
  const params = parseClinicalTrialsParams(sp);
  const trials = groupTrials(await loadClinicalTrialsReport(db.read, code));
  const center = sp.get("center");
  const keepQuery = center ? `center=${encodeURIComponent(center)}` : "";

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        Clinical trials that current center members lead, with phase, sponsor and accrual status.
      </p>
    ),
    main: (
      <div className="mt-7">
        <ReportCard>
          {trials.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="ct-no-data">
              No clinical trials found for this center&rsquo;s current members.
            </p>
          ) : (
            <ClinicalTrialsResults
              trials={trials}
              initial={params}
              basePath={basePath}
              centerCode={code}
              keepQuery={keepQuery}
              cap={SCHOLAR_EXPORT_CAP}
            />
          )}
          <p className="text-muted-foreground mt-6 max-w-[760px] text-[13px]" role="note">
            Trials come from the WCM clinical trials management system, matched to center members by
            CWID. Only each trial&rsquo;s Principal Investigator is listed. Registered trials link
            to ClinicalTrials.gov.
          </p>
        </ReportCard>
      </div>
    ),
  };
}
