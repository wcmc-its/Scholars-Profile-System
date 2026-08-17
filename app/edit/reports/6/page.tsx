/**
 * `/edit/reports/6` — "NIH-funded pubs" (org-unit publications reports plan,
 * 2026-08-16). This unit's member publications that carry a `GrantPublication`
 * link to NIH RePORTER (`lib/edit/nih-funded-publications-report.ts` — see
 * that module's doc comment for the row grain and confidence trigger).
 * Center, department, or division — unit-agnostic from day one, same
 * `?center=<code>[&kind=department|division]` routing convention as report 3.
 *
 * Read-only, server-rendered — no client component, no interaction beyond
 * following a link, matching reports 1/2/4/5's tables.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { LowerConfidenceBadge } from "@/components/funding/expanded-grant";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import { loadReportsContext, resolveNumberedReportCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { loadNihFundedPublicationsReport } from "@/lib/edit/nih-funded-publications-report";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "NIH-funded pubs — Scholars Profile Console",
  robots: { index: false, follow: false },
};

const ALLOWED_KINDS: readonly UnitEntityType[] = ["center", "department", "division"];

function parseKind(raw: string | undefined): UnitEntityType | undefined {
  return raw === "department" || raw === "division" ? raw : undefined;
}

const thClass = "px-3 py-2 font-medium";
const tdClass = "px-3 py-2";

export default async function EditReportsNihFundedPublicationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string; kind?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/6");
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

  const report = await loadNihFundedPublicationsReport(kind, code);

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
      <h1 className="mb-1 text-xl font-bold">6. NIH-funded pubs</h1>
      <p className="text-muted-foreground text-sm">
        Every {ctx.unit.name} member publication with a matched NIH RePORTER funding link.
      </p>

      {report.totalPublications === 0 ? (
        <p className="text-muted-foreground mt-6" data-testid="nih-pubs-report-empty">
          No NIH-funded publications were found for a confirmed member author.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm" data-testid="nih-pubs-report-count-line">
            <strong>{report.totalPublications.toLocaleString()}</strong> publication
            {report.totalPublications === 1 ? "" : "s"} with an NIH RePORTER-linked grant.
          </p>
          <div className="border-apollo-border bg-apollo-surface mt-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="nih-pubs-report-table">
              <thead className="bg-apollo-surface-2 text-muted-foreground text-left">
                <tr className="border-apollo-border border-b">
                  <th className={thClass}>Publication</th>
                  <th className={thClass}>Journal</th>
                  <th className={thClass}>Grant</th>
                  <th className={thClass}>Award number</th>
                  <th className={thClass}>Investigators</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr
                    key={`${r.pmid}-${r.grantId}`}
                    className="border-apollo-border border-b align-top"
                    data-testid={`nih-pubs-report-row-${r.pmid}-${r.grantId}`}
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
                      {r.isLowerConfidence ? <LowerConfidenceBadge /> : null}
                    </td>
                    <td className={tdClass}>{r.journal ?? "—"}</td>
                    <td className={tdClass}>{r.grantTitle}</td>
                    <td className={`${tdClass} whitespace-nowrap`}>{r.awardNumber ?? "—"}</td>
                    <td className={tdClass}>
                      {r.investigators.length === 0
                        ? "—"
                        : r.investigators.map((i) => `${i.name} (${i.cwid})`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ConsoleShell>
  );
}
