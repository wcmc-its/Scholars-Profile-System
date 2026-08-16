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
 * list). Without it: 0 reportable units → 404 for a scoped Owner/Curator/
 * comms_steward, but an empty index for a superuser (Gap 5, 2026-08-14
 * handoff — a superuser isn't scoped to any grants, so an empty roster isn't
 * "this route doesn't exist"); exactly 1 → the
 * same single-unit list, resolved automatically (unchanged end-user
 * behavior); 2+ → the new cross-unit index (`ReportsIndex`), scoped to the
 * actor (org-wide for a superuser/comms_steward, else their own `UnitAdmin`
 * grants) — a table with a filter rail for a superuser/comms_steward (`2a`,
 * no unit-count minimum), otherwise every unit banded inline on one page
 * (`1a`).
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  ReportsIndex,
  SingleUnitReportsTable,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  loadReportsContext,
  resolveReportsCenterCode,
  type ReportLiveness,
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
    if (ctx === null)
      return (
        <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage variant="unit" targetEntity={code} />
        </ConsoleShell>
      );
    return <SingleUnitReports ctx={ctx} code={code} perReport={await loadSingleUnitPerReport(code)} {...shell} />;
  }

  const reportableUnits = await loadReportableUnitsForActor(session, db.read);
  // Gap 5 (2026-08-14 handoff): a superuser isn't scoped to any particular
  // unit's grants, so zero reportable units for them isn't "this route doesn't
  // exist" the way it is for a scoped Owner/Curator/comms_steward with no
  // grants at all — it's an empty roster. Fall through to the bands view below,
  // which renders gracefully on an empty `units` array; everyone else still 404s.
  if (reportableUnits.length === 0 && !session.isSuperuser) notFound();

  if (reportableUnits.length === 1) {
    const code = reportableUnits[0].code;
    const ctx = await loadReportsContext(code, session, db.read);
    if (ctx === null)
      return (
        <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage variant="unit" targetEntity={code} />
        </ConsoleShell>
      );
    return <SingleUnitReports ctx={ctx} code={code} perReport={await loadSingleUnitPerReport(code)} {...shell} />;
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
      perReport: serializePerReport(l),
    };
  });
  // 2a (table + filter rail) for a superuser/comms_steward at any unit count
  // ≥2 — no size threshold; 1a (every unit banded inline) for everyone else.
  const mode = session.isSuperuser || session.isCommsSteward ? "table" : "bands";

  return (
    <ConsoleShell active="reports" reportsTab {...shell}>
      <h1 className="mb-1 text-xl font-bold">Reports</h1>
      <p className="text-muted-foreground text-sm">
        Advisory only — every report reads precomputed data; nothing here writes to the roster.
      </p>
      {/* ConsoleShell owns only the chrome — content supplies its own surface
          (R1/the Apollo Surface Language "the page is never white"). Without
          this, the list floats directly on --apollo-page with no card. */}
      <div className="apollo-card mt-5">
        <ReportsIndex units={units} reports={REPORTS} mode={mode} />
      </div>
    </ConsoleShell>
  );
}

type SerializedPerReport = ReadonlyArray<{
  n: 1 | 2 | 3 | 4 | 5;
  live: boolean;
  lastRefreshedAt: string | null;
}>;

/** ISO-string serialization shared by the multi-unit index and the
 *  single-unit table below — a unit/code with no liveness row at all (the
 *  Map lookup missed) degrades to "nothing live," not a missing entry. */
function serializePerReport(liveness: ReportLiveness | undefined): SerializedPerReport {
  return (
    liveness?.perReport.map((r) => ({
      n: r.n,
      live: r.live,
      lastRefreshedAt: r.lastRefreshedAt?.toISOString() ?? null,
    })) ?? REPORTS.map((r) => ({ n: r.n, live: false, lastRefreshedAt: null }))
  );
}

/** `3a` — an actor with exactly one reportable unit (the common case today).
 *  Per-report liveness for one center, plain-serialized for the client table. */
async function loadSingleUnitPerReport(code: string): Promise<SerializedPerReport> {
  const liveness = (await loadReportLiveness([code], db.read)).get(code);
  return serializePerReport(liveness);
}

/** `3a` — same `Report | Focus | Last refreshed` table `1a`'s bands use per
 *  unit, just without the band header (this page's own `<h1>` already names
 *  the unit) — matches the actual mockup (`Reports IA.dc.html`), which was
 *  never a plain list. Shared between the explicit `?center=` path and the
 *  single-reportable-unit default so neither duplicates the JSX. */
function SingleUnitReports({
  ctx,
  code,
  perReport,
  session,
  pendingSlugRequests,
  pendingHonors,
}: {
  ctx: UnitEditContext;
  code: string;
  perReport: SerializedPerReport;
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
      <h1 className="mb-1 text-xl font-bold">{ctx.unit.name} reports</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Advisory only — every report reads precomputed data; nothing here writes to the roster.
      </p>
      {/* ConsoleShell owns only the chrome — content supplies its own surface
          (R1/the Apollo Surface Language "the page is never white"). Without
          this, the table floats directly on --apollo-page with no card. */}
      <div className="apollo-card">
        <SingleUnitReportsTable centerCode={code} perReport={perReport} reports={REPORTS} />
      </div>
    </ConsoleShell>
  );
}
