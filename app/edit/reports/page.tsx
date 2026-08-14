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
 * replaced. The center itself is resolved server-side (never hardcoded).
 *
 * All 5 reports are live (`CancerCenterCollabReportCard`, `Nci2aCard`, and
 * three plain data-table pages) — "live" per unit varies with real data
 * (`loadReportLiveness`), the catalog does not.
 *
 * Reports IA redesign (2026-08-14): `?center=` now addresses one of
 * POTENTIALLY SEVERAL reportable units, not just "the second center once one
 * exists." With `?center=` given, behavior is unchanged (today's single-unit
 * list). Without it: 0 reportable units → 404 (unchanged); exactly 1 → the
 * same single-unit list, resolved automatically (unchanged end-user
 * behavior); 2+ → the new cross-unit index (`ReportsIndex`), scoped to the
 * actor (org-wide for a superuser/comms_steward, else their own `UnitAdmin`
 * grants) — a table with a filter rail once there are enough units to
 * warrant one (`2a`), otherwise every unit banded inline on one page (`1a`).
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import { ReportsIndex, type ReportsIndexUnit } from "@/components/edit/reports-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  loadReportsContext,
  resolveReportsCenterCode,
} from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { unitEditHref } from "@/lib/edit/manageable-units";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";

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
  {
    n: 3,
    label: "3. Publications",
    description: "Center-attributed publications by program, with cancer-relevance tagging.",
  },
  {
    n: 4,
    label: "4. Grants",
    description: "Active grants for the center's members, as of a chosen date.",
  },
  {
    n: 5,
    label: "5. Clinical Trials",
    description: "Active clinical trials involving the center's members, with ClinicalTrials.gov links.",
  },
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

  const pendingSlugRequests =
    session.isSuperuser && isSlugRequestEnabled() ? await countPendingSlugRequests(db.read) : null;
  const pendingHonors = isHonorsQueueTabVisible(session)
    ? await countPendingHonors(db.read)
    : null;
  const shell = { session, pendingSlugRequests, pendingHonors } as const;

  const { center } = (await searchParams) ?? {};
  if (center) {
    // Unchanged: an explicit `?center=` always addresses exactly one unit.
    const code = await resolveReportsCenterCode(db.read, center);
    const ctx = await loadReportsContext(code, session, db.read);
    if (ctx === null) return <ForbiddenEditPage variant="unit" targetEntity={code} />;
    return <SingleUnitReports ctx={ctx} code={code} {...shell} />;
  }

  const reportableUnits = await loadReportableUnitsForActor(session, db.read);
  if (reportableUnits.length === 0) notFound();

  if (reportableUnits.length === 1) {
    const code = reportableUnits[0].code;
    const ctx = await loadReportsContext(code, session, db.read);
    if (ctx === null) return <ForbiddenEditPage variant="unit" targetEntity={code} />;
    return <SingleUnitReports ctx={ctx} code={code} {...shell} />;
  }

  const liveness = await loadReportLiveness(
    reportableUnits.map((u) => u.code),
    db.read,
  );
  const units: ReportsIndexUnit[] = reportableUnits.map((u) => {
    const l = liveness.get(u.code);
    return {
      code: u.code,
      name: u.name,
      centerType: u.centerType,
      editHref: unitEditHref("center", u.code),
      liveCount: l?.liveCount ?? 0,
      totalCount: l?.totalCount ?? REPORTS.length,
      lastRefreshedAt: l?.lastRefreshedAt?.toISOString() ?? null,
      perReport:
        l?.perReport.map((r) => ({ n: r.n, live: r.live, lastRefreshedAt: r.lastRefreshedAt?.toISOString() ?? null })) ??
        REPORTS.map((r) => ({ n: r.n, live: false, lastRefreshedAt: null })),
    };
  });
  // 2a (table + filter rail) once there are enough units for a picker to earn
  // its keep; otherwise 1a (every unit banded inline) — including a
  // superuser/comms_steward with a small org today.
  const mode = (session.isSuperuser || session.isCommsSteward) && units.length > 3 ? "table" : "bands";

  return (
    <ConsoleShell active="reports" reportsTab {...shell}>
      <div className="apollo-card">
        <h1 className="mb-1 text-xl font-semibold">Reports</h1>
        <p className="text-muted-foreground text-sm">
          {mode === "table"
            ? "Advisory only — every report reads precomputed data; nothing here writes to the roster."
            : "Reports for the centers you administer."}
        </p>
        {mode === "bands" && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">Advisory only</span> — every report reads precomputed
            data; nothing here writes to the roster.
          </div>
        )}
        <div className="mt-5">
          <ReportsIndex units={units} reports={REPORTS} mode={mode} />
        </div>
      </div>
    </ConsoleShell>
  );
}

/** Today's existing per-unit report list — unchanged, just extracted so both
 *  the explicit `?center=` path and the single-reportable-unit default reuse
 *  it instead of duplicating the JSX. */
function SingleUnitReports({
  ctx,
  code,
  session,
  pendingSlugRequests,
  pendingHonors,
}: {
  ctx: UnitEditContext;
  code: string;
  session: EditSession;
  pendingSlugRequests: number | null;
  pendingHonors: number | null;
}) {
  return (
    <ConsoleShell
      active="reports"
      session={session}
      pendingSlugRequests={pendingSlugRequests}
      pendingHonors={pendingHonors}
      reportsTab
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
