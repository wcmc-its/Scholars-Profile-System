/**
 * Report 3 — "Publications". Per-unit publication × Journal Impact Factor
 * report (`lib/edit/cancer-center-publications-report.ts`;
 * `etl/journal-impact-factor` mirrors reciterdb's `journal_impact_alternative`
 * weekly into `JournalImpactFactor`). Genericized off center-only by the
 * org-unit publications reports plan (2026-08-16), kind-aware: `?center=<code>`
 * still resolves a center exactly as it always has (implied `kind=center`);
 * `&kind=department|division|core` alongside it addresses the other three
 * kinds. For `kind=core` the `<code>` is the core id and BOTH the authz gate
 * and the publication set change — a core's owner or curator passes
 * (`loadReportsContext`), and the rows come from the core's confirmed
 * `publication_core` usages rather than from members
 * (`loadUnitPublicationsReport`), since a core has no membership table. The
 * kind resolution itself is the dynamic page's (`unitKindsFor("3")` →
 * `resolveNumberedReportCenterCode`); this body receives the resolved
 * `code` / `kind` / `ctx`.
 *
 * Server-rendered summary + table shell; the table body itself
 * (`PublicationsReportTable`) is a client island for the Person-type filter
 * rail — no fetch, filters the already-loaded rows in memory.
 *
 * The body of what was `app/edit/reports/3/page.tsx`, moved verbatim into the
 * registry shape (`lib/edit/report-registry.ts`): the session / gate / shell /
 * header frame is the dynamic page's; this owns only the report. The kind-
 * aware subtitle `<p>` is returned as `subtitle` (the header's children).
 */
import { PublicationsReportTable } from "@/components/edit/publications-report-table";
import {
  HIGH_IMPACT_THRESHOLD,
  loadUnitPublicationsReport,
  type PublicationsReport,
} from "@/lib/edit/cancer-center-publications-report";
import type { ReportableUnitKind } from "@/lib/edit/cancer-center-reports";
import type { ReportRender, UnitReportProps } from "@/lib/edit/report-registry";

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function ReportSummary({ report, kind }: { report: PublicationsReport; kind: ReportableUnitKind }) {
  const { totalPublications, matchedPublications, matchRatePct, highImpactCount, highImpactRatePct } = report;

  if (totalPublications === 0) {
    return (
      // Kind-aware copy: a core has no members, so the member phrasing would
      // be actively misleading about WHY the report is empty (the real reason
      // is no confirmed core usage yet — 6 of 14 staging cores have zero
      // confirmed usages, so this is a state real cores hit, not a hypothetical).
      <p className="text-muted-foreground mt-6" data-testid="pubs-report-empty">
        {kind === "core"
          ? "No publications with a confirmed use of this core were found."
          : "No publications with a confirmed member author were found."}
      </p>
    );
  }

  return (
    <>
      <p className="mt-2 text-sm" data-testid="pubs-report-match-line">
        <strong>{matchedPublications.toLocaleString()}</strong> of{" "}
        <strong>{totalPublications.toLocaleString()}</strong> publications matched a known journal (
        {pct(matchRatePct)}).
      </p>
      <p className="text-muted-foreground mt-1 text-sm" data-testid="pubs-report-high-impact-line">
        Of those, <strong>{highImpactCount.toLocaleString()}</strong> ({pct(highImpactRatePct)}) are in a
        journal with a current Impact Factor of {HIGH_IMPACT_THRESHOLD} or higher.
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Unmatched publications are omitted from the table below — their journal isn&rsquo;t in the
        Impact Factor source, or its abbreviation didn&rsquo;t match exactly.
      </p>
    </>
  );
}

/** Report 3's body: the unit's publications joined to Journal Impact Factor
 *  data — summary lines plus the filterable table island. */
export async function renderPublicationsReport({
  code,
  kind,
  ctx,
}: UnitReportProps): Promise<ReportRender> {
  const report = await loadUnitPublicationsReport(kind, code);

  return {
    subtitle: (
      <p className="text-muted-foreground text-sm">
        {kind === "core" ? (
          <>
            Every publication with a confirmed use of {ctx.unit.name}, joined to Journal Impact
            Factor data where the journal matches.
          </>
        ) : (
          <>
            Every publication with a confirmed {ctx.unit.name} author, joined to Journal Impact
            Factor data where the journal matches.
          </>
        )}
      </p>
    ),
    main: (
      <>
        <ReportSummary report={report} kind={kind} />
        {report.totalPublications > 0 ? <PublicationsReportTable rows={report.rows} /> : null}
      </>
    ),
  };
}
