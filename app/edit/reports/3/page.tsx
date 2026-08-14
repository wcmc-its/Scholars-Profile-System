/**
 * `/edit/reports/3` — "Publications". Per-center publication × Journal
 * Impact Factor report (`lib/edit/cancer-center-publications-report.ts`;
 * `etl/journal-impact-factor` mirrors reciterdb's `journal_impact_alternative`
 * weekly into `JournalImpactFactor`). Same session/authz/center-resolution
 * flow as `/edit/reports` (see that page's doc comment).
 *
 * Read-only, server-rendered — no client component, no interaction beyond
 * following a link, matching `/edit/etl-status`'s table.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  HIGH_IMPACT_THRESHOLD,
  loadCancerCenterPublicationsReport,
  type PublicationsReport,
} from "@/lib/edit/cancer-center-publications-report";
import { loadReportsContext, resolveReportsCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Publications — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function ReportBody({ report }: { report: PublicationsReport }) {
  const { totalPublications, matchedPublications, matchRatePct, highImpactCount, highImpactRatePct, rows } =
    report;

  if (totalPublications === 0) {
    return (
      <p className="text-muted-foreground mt-6" data-testid="pubs-report-empty">
        No publications with a confirmed center-member author were found.
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

      <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="pubs-report-table">
          <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
            <tr className="border-apollo-border border-b">
              <th className={thClass}>Publication</th>
              <th className={thClass}>Journal</th>
              <th className={thClass}>Impact Factor</th>
              <th className={thClass}>5-yr IF</th>
              <th className={thClass}>Quartile</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.pmid}
                className="border-apollo-border border-b align-top"
                data-testid={`pubs-report-row-${r.pmid}`}
              >
                <td className={tdClass}>
                  <a
                    href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.pmid)}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {r.title}
                  </a>
                  {r.year === null ? null : (
                    <span className="text-muted-foreground ml-1">({r.year})</span>
                  )}
                </td>
                <td className={tdClass}>{r.matchedJournalTitle}</td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {r.impactScore1 === null ? "—" : r.impactScore1.toFixed(1)}
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>
                  {r.impactScore2 === null ? "—" : r.impactScore2.toFixed(1)}
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>{r.quartile ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default async function EditReportsPublicationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/3");
  }

  const { center } = (await searchParams) ?? {};
  const code = await resolveReportsCenterCode(db.read, center);
  const ctx = await loadReportsContext(code, session, db.read);
  if (ctx === null) {
    return <ForbiddenEditPage variant="unit" targetEntity={code} />;
  }

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  const report = await loadCancerCenterPublicationsReport(code);

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      <Link
        href={`/edit/reports?center=${encodeURIComponent(code)}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      <h1 className="mb-1 text-xl font-semibold">3. Publications</h1>
      <p className="text-muted-foreground text-sm">
        Every publication with a confirmed {ctx.unit.name} author, joined to Journal Impact Factor
        data where the journal matches.
      </p>
      <ReportBody report={report} />
    </ConsoleShell>
  );
}
