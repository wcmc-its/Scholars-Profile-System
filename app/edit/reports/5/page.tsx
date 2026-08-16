/**
 * `/edit/reports/5` — "Clinical Trials". Lists every current Cancer Center
 * member's clinical-trial links (Principal Investigator or Investigator), one
 * row per (person, trial) pair. Same session/authz/center-resolution flow as
 * `/edit/reports/1`/`/2` (see `app/edit/reports/page.tsx`'s doc comment) —
 * duplicated per page rather than a shared server component, matching every
 * other `/edit/*` console page's convention. The query itself lives in
 * `lib/center-collaboration/clinical-trials-report.ts` — see that file's doc
 * comment for the membership-resolution and data-scope decisions (uncarved
 * membership, no CLINICAL_TRIALS_SECTION gate, withdrawn trials kept).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { loadClinicalTrialsReport } from "@/lib/center-collaboration/clinical-trials-report";
import { db } from "@/lib/db";
import { loadReportsContext, resolveNumberedReportCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Clinical Trials — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** ClinicalTrials.gov study page for an NCT id — same URL form as the public
 *  profile's `ctgovUrl` (`components/profile/clinical-trials-section.tsx`);
 *  that helper isn't exported, so this mirrors it rather than importing it. */
function ctgovUrl(nct: string): string {
  return `https://clinicaltrials.gov/study/${encodeURIComponent(nct)}`;
}

export default async function EditReportsClinicalTrialsPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports/5");
  }

  const { center } = (await searchParams) ?? {};
  const { code } = await resolveNumberedReportCenterCode(session, db.read, center);
  const ctx = await loadReportsContext(code, session, db.read);
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

  const rows = await loadClinicalTrialsReport(db.read, code);

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
    >
      <Link
        href={`/edit/reports?center=${encodeURIComponent(code)}`}
        className="text-apollo-slate mb-4 inline-block text-sm hover:underline"
      >
        &larr; All reports
      </Link>
      <h1 className="mb-1 text-xl font-bold">5. Clinical Trials</h1>
      <p className="text-muted-foreground mb-4 text-sm">
        {rows.length === 0
          ? "Current members' clinical-trial links (Principal Investigator or Investigator)."
          : `${rows.length} clinical-trial link${rows.length === 1 ? "" : "s"} across the center's current members.`}
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No clinical trial links found for this center&rsquo;s current members.
        </p>
      ) : (
        <div className="border-apollo-border bg-apollo-surface overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="clinical-trials-report-table">
            <thead>
              <tr className="text-muted-foreground border-apollo-border bg-apollo-surface-2 border-b text-left">
                <th className="px-4 py-2.5 font-medium">Person</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Trial</th>
                <th className="px-4 py-2.5 font-medium">Phase</th>
                <th className="px-4 py-2.5 font-medium">Sponsor</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">NCT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.cwid}-${row.protocolNumber}`}
                  className="border-apollo-border border-b align-top last:border-b-0"
                >
                  <td className="px-4 py-3 whitespace-nowrap">{row.personName}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.role}</td>
                  <td className="px-4 py-3">{row.title}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.phase ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {row.principalSponsor ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.status ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.nctNumber ? (
                      <a
                        href={ctgovUrl(row.nctNumber)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="View on ClinicalTrials.gov"
                        className="text-apollo-slate font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {row.nctNumber}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleShell>
  );
}
