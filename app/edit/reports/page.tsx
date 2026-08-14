/**
 * `/edit/reports` — the Cancer Center reports console index.
 *
 * Consolidates what used to be two tabs (`?attr=reports`, `?attr=nci-2a`)
 * buried inside the generic `/edit/center/[code]` unit editor into a
 * top-level, numbered list of reports, each its own route
 * (`/edit/reports/{1..5}`). Modeled on `app/edit/data-quality/page.tsx`:
 * `force-dynamic`, noindex, `getEffectiveEditSession()` gate, `ConsoleShell`.
 *
 * Authorization is the SAME gate `/edit/center/[code]` enforces — superuser,
 * comms_steward (global content-editor parity), or a unit Owner/Curator of
 * this center — reused wholesale via `loadReportsContext` rather than
 * re-derived, so this console can't drift from the per-unit editor it
 * replaced. The center itself is resolved server-side (never hardcoded):
 * `?center=` addresses a second center once one exists; absent that, the sole
 * center today is the default (`resolveReportsCenterCode`).
 *
 * Reports 1 and 2 are live (`CancerCenterCollabReportCard`, `Nci2aCard`,
 * unchanged — only how they're hosted moved). 3–5 are placeholder stubs;
 * their real implementations are separate follow-up PRs.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadReportsContext, resolveReportsCenterCode } from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cancer Center Reports — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** One numbered report card on the index — styled off the `REPORTS` list item
 *  in `cancer-center-collab-report-card.tsx` (same classes/structure), just
 *  as a real route link instead of client-side `selectedKey` state. */
type ReportDef = { n: 1 | 2 | 3 | 4 | 5; label: string; description: string };

const REPORTS: readonly ReportDef[] = [
  {
    n: 1,
    label: "1. Optimize membership",
    description:
      "REMOVE / ADD membership recommendations from PubMed co-authorship and MeSH cancer-relevance signals.",
  },
  {
    n: 2,
    label: "2. NCI Table 2a",
    description:
      "NCI CCSG Data Table 2A funding review — program-code allocation and the Cancer-Relevant Percent judgment column.",
  },
  { n: 3, label: "3. Publications", description: "Coming soon." },
  { n: 4, label: "4. Grants", description: "Coming soon." },
  { n: 5, label: "5. Clinical Trials", description: "Coming soon." },
];

export default async function EditReportsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string }>;
}) {
  const session = await getEffectiveEditSession();
  if (!session) {
    redirect("/api/auth/saml/login?return=/edit/reports");
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

  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
    >
      {/* ConsoleShell owns only the chrome — content supplies its own surface
          (R1/the Apollo Surface Language "the page is never white"). Without
          this, the list floats directly on --apollo-page with no card. */}
      <div className="apollo-card">
        <h1 className="mb-1 text-xl font-semibold">{ctx.unit.name} reports</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Advisory only — every report reads precomputed data; nothing here writes to the roster.
        </p>
        <ul className="divide-y divide-border">
          {REPORTS.map((r) => (
            <li key={r.n}>
              <Link
                href={`/edit/reports/${r.n}?center=${encodeURIComponent(code)}`}
                data-testid={`reports-index-${r.n}`}
                className="flex w-full flex-col items-start gap-0.5 py-3 text-left hover:bg-muted/50"
              >
                <span className="text-sm font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </ConsoleShell>
  );
}
