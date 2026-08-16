/**
 * `/edit/reports/3` — "Publications". Per-unit publication × Journal Impact
 * Factor report (`lib/edit/cancer-center-publications-report.ts`;
 * `etl/journal-impact-factor` mirrors reciterdb's `journal_impact_alternative`
 * weekly into `JournalImpactFactor`). Genericized off center-only by the
 * org-unit publications reports plan (2026-08-16) — same session/authz/
 * unit-resolution flow as `/edit/reports` (see that page's doc comment), now
 * kind-aware: `?center=<code>` still resolves a center exactly as it always
 * has (implied `kind=center`); `&kind=department|division` alongside it
 * addresses the other two kinds.
 *
 * Server-rendered summary + table shell; the table body itself
 * (`PublicationsReportTable`) is a client island for the Person-type filter
 * rail — no fetch, filters the already-loaded rows in memory.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { PublicationsReportTable } from "@/components/edit/publications-report-table";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import {
  HIGH_IMPACT_THRESHOLD,
  loadUnitPublicationsReport,
  type PublicationsReport,
} from "@/lib/edit/cancer-center-publications-report";
import { loadReportsContext, resolveNumberedReportCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Publications — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const ALLOWED_KINDS: readonly UnitEntityType[] = ["center", "department", "division"];

function parseKind(raw: string | undefined): UnitEntityType | undefined {
  return raw === "department" || raw === "division" ? raw : undefined;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function ReportSummary({ report }: { report: PublicationsReport }) {
  const { totalPublications, matchedPublications, matchRatePct, highImpactCount, highImpactRatePct } = report;

  if (totalPublications === 0) {
    return (
      <p className="text-muted-foreground mt-6" data-testid="pubs-report-empty">
        No publications with a confirmed member author were found.
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

export default async function EditReportsPublicationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string; kind?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/3");
  }

  const { center, kind: kindParam } = (await searchParams) ?? {};
  const { code, kind } = await resolveNumberedReportCenterCode(session, db.read, center, {
    allowedKinds: ALLOWED_KINDS,
    requestedKind: parseKind(kindParam),
  });
  const ctx = await loadReportsContext(code, session, db.read, kind);
  if (ctx === null) {
    return (
      <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
        <ForbiddenEditPage variant="unit" targetEntity={code} />
      </ConsoleShell>
    );
  }

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;

  const report = await loadUnitPublicationsReport(kind, code);

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
    >
      <Link
        href={kind === "center" ? `/edit/reports?center=${encodeURIComponent(code)}` : `/edit/reports?center=${encodeURIComponent(code)}&kind=${kind}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      <h1 className="mb-1 text-xl font-bold">3. Publications</h1>
      <p className="text-muted-foreground text-sm">
        Every publication with a confirmed {ctx.unit.name} author, joined to Journal Impact Factor
        data where the journal matches.
      </p>
      <ReportSummary report={report} />
      {report.totalPublications > 0 ? <PublicationsReportTable rows={report.rows} /> : null}
    </ConsoleShell>
  );
}
