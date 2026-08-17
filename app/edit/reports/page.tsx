/**
 * `/edit/reports` — the org-unit reports console index.
 *
 * Consolidates what used to be two tabs (`?attr=reports`, `?attr=nci-2a`)
 * buried inside the generic `/edit/center/[code]` unit editor into a
 * top-level, numbered list of reports, each its own route
 * (`/edit/reports/{1..6}`). Modeled on `app/edit/data-quality/page.tsx`:
 * `force-dynamic`, noindex, `getEffectiveEditSession()` gate, `ConsoleShell`.
 *
 * Authorization is the SAME gate `/edit/center/[code]` (or `/edit/department`
 * / `/edit/division`) enforces — superuser, comms_steward (global
 * content-editor parity), or a unit Owner/Curator of this unit — reused
 * wholesale via `loadReportsContext` rather than re-derived, so this console
 * can't drift from the per-unit editor it replaced. The unit itself is
 * resolved server-side (never hardcoded).
 *
 * Reports 1/2/4/5 stay center-only (`CenterProgram`/`CenterMembership`-family
 * data with no department/division equivalent — org-unit publications reports
 * plan, 2026-08-16, "Reports 1 & 2 — considered, dropped"). Reports 3
 * (Publications) and 6 (NIH-funded pubs) are unit-agnostic — `REPORTS_BY_KIND`
 * below is the single source of truth for which cards a unit's kind shows,
 * mirroring `REPORT_NUMBERS_BY_KIND` in `lib/edit/cancer-center-reports.ts`.
 * "Live" per unit varies with real data (`loadReportLiveness`); the catalog
 * per KIND does not.
 *
 * Reports IA redesign (2026-08-14): `?center=` now addresses one of
 * POTENTIALLY SEVERAL reportable units, not just "the second center once one
 * exists." With `?center=` given, behavior is unchanged (today's single-unit
 * list) for a center; an accompanying `?kind=department|division` addresses a
 * department/division instead (2026-08-16). Without `?center=`: 0 reportable
 * units → 404 for a scoped Owner/Curator/comms_steward, but an empty index
 * for a superuser (Gap 5, 2026-08-14 handoff — a superuser isn't scoped to
 * any grants, so an empty roster isn't "this route doesn't exist"); exactly
 * 1 → the same single-unit list, resolved automatically (unchanged end-user
 * behavior); 2+ → the cross-unit index (`ReportsIndex`), scoped to the actor
 * (org-wide for a superuser/comms_steward, else their own `UnitAdmin`
 * grants) — a table with a filter rail for a superuser/comms_steward (`2a`,
 * no unit-count minimum, #2455), otherwise every unit banded inline on one
 * page (`1a`).
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import {
  ReportsIndex,
  SingleUnitReportsTable,
  type ReportsIndexReport,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import type { EditSession } from "@/lib/auth/superuser";
import type { UnitEntityType } from "@/lib/api/manual-layer";
import { db } from "@/lib/db";
import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  loadReportsContext,
  resolveReportsCenterCode,
  REPORT_NUMBERS_BY_KIND,
  type ReportLiveness,
} from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { unitEditHref } from "@/lib/edit/manageable-units";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";
import type { UnitEditContext } from "@/lib/api/unit-edit-context";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reports — Scholars Profile Console",
  robots: { index: false, follow: false },
};

/** One numbered report card on the index — styled off the `REPORTS` list item
 *  in `cancer-center-collab-report-card.tsx` (same classes/structure), just
 *  as a real route link instead of client-side `selectedKey` state. */
type ReportDef = ReportsIndexReport;

/** Every report this console can show. Which of these a given unit's kind
 *  actually gets is `REPORTS_BY_KIND` below — this array is the full catalog,
 *  not a per-kind one. */
const ALL_REPORTS: readonly ReportDef[] = [
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
    description: "This unit's member publications, joined to Journal Impact Factor and paper-level impact-score data.",
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
  {
    n: 6,
    label: "6. NIH-funded pubs",
    description: "This unit's member publications with a matched NIH RePORTER funding link.",
  },
];

/** `REPORTS_BY_KIND[kind]` — the catalog `ReportsIndex`/`SingleUnitReportsTable`
 *  render for a unit of that kind, resolved from `REPORT_NUMBERS_BY_KIND`
 *  (`lib/edit/cancer-center-reports.ts`) so the two lists can never drift.
 *  Department/division show only Publications + NIH-funded pubs — no dead
 *  card that 404s/empty-states when opened. */
const REPORTS_BY_KIND: Record<UnitEntityType, readonly ReportDef[]> = {
  center: ALL_REPORTS.filter((r) => REPORT_NUMBERS_BY_KIND.center.includes(r.n)),
  department: ALL_REPORTS.filter((r) => REPORT_NUMBERS_BY_KIND.department.includes(r.n)),
  division: ALL_REPORTS.filter((r) => REPORT_NUMBERS_BY_KIND.division.includes(r.n)),
};

const REPORTABLE_KINDS: readonly UnitEntityType[] = ["center", "department", "division"];

function parseKind(raw: string | undefined): UnitEntityType {
  return raw === "department" || raw === "division" ? raw : "center";
}

export default async function EditReportsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ center?: string; kind?: string }>;
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

  const { center, kind: kindParam } = (await searchParams) ?? {};
  const kind = parseKind(kindParam);
  if (center) {
    // Unchanged for a center: an explicit `?center=` always addresses exactly
    // one unit, validated against the CenterProgram taxonomy gate. A
    // department/division `?center=` has no equivalent taxonomy to validate
    // against — `loadReportsContext` below is the real existence/authz gate.
    const code = kind === "center" ? await resolveReportsCenterCode(db.read, center) : center;
    const ctx = await loadReportsContext(code, session, db.read, kind);
    if (ctx === null)
      return (
        <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage variant="unit" targetEntity={code} />
        </ConsoleShell>
      );
    return (
      <SingleUnitReports
        ctx={ctx}
        code={code}
        kind={kind}
        perReport={await loadSingleUnitPerReport(code, kind)}
        {...shell}
      />
    );
  }

  const reportableUnits = await loadReportableUnitsForActor(session, db.read, REPORTABLE_KINDS);
  // Gap 5 (2026-08-14 handoff): a superuser isn't scoped to any particular
  // unit's grants, so zero reportable units for them isn't "this route doesn't
  // exist" the way it is for a scoped Owner/Curator/comms_steward with no
  // grants at all — it's an empty roster. Fall through to the bands view below,
  // which renders gracefully on an empty `units` array; everyone else still 404s.
  if (reportableUnits.length === 0 && !session.isSuperuser) notFound();

  if (reportableUnits.length === 1) {
    const unit = reportableUnits[0];
    const ctx = await loadReportsContext(unit.code, session, db.read, unit.kind);
    if (ctx === null)
      return (
        <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage variant="unit" targetEntity={unit.code} />
        </ConsoleShell>
      );
    return (
      <SingleUnitReports
        ctx={ctx}
        code={unit.code}
        kind={unit.kind}
        perReport={await loadSingleUnitPerReport(unit.code, unit.kind)}
        {...shell}
      />
    );
  }

  const liveness = await loadReportLiveness(
    reportableUnits.map((u) => ({ code: u.code, kind: u.kind })),
    db.read,
  );
  const units: ReportsIndexUnit[] = reportableUnits.map((u) => {
    const l = liveness.get(u.code);
    const reports = REPORTS_BY_KIND[u.kind];
    return {
      code: u.code,
      kind: u.kind,
      name: u.name,
      centerType: u.kind === "center" ? u.centerType : null,
      editHref: unitEditHref(u.kind, u.code),
      liveCount: l?.liveCount ?? 0,
      totalCount: l?.totalCount ?? reports.length,
      lastRefreshedAt: l?.lastRefreshedAt?.toISOString() ?? null,
      reports,
      perReport: serializePerReport(l, reports),
    };
  });
  // 2a (table + filter rail) for a superuser/comms_steward at any unit count
  // ≥2 — no size threshold; 1a (every unit banded inline) for everyone else.
  const mode = session.isSuperuser || session.isCommsSteward ? "table" : "bands";

  return (
    <ConsoleShell active="reports" reportsTab {...shell}>
      <h1 className="mb-1 text-xl font-bold">Reports</h1>
      <p className="text-muted-foreground text-sm">
        Advisory only: every report reads precomputed data; nothing here writes to the roster.
      </p>
      {/* ConsoleShell owns only the chrome — content supplies its own surface
          (R1/the Apollo Surface Language "the page is never white"). Without
          this, the list floats directly on --apollo-page with no card. */}
      <div className="apollo-card mt-5">
        <ReportsIndex units={units} mode={mode} />
      </div>
    </ConsoleShell>
  );
}

type SerializedPerReport = ReadonlyArray<{
  n: 1 | 2 | 3 | 4 | 5 | 6;
  live: boolean;
  lastRefreshedAt: string | null;
}>;

/** ISO-string serialization shared by the multi-unit index and the
 *  single-unit table below — a unit/code with no liveness row at all (the
 *  Map lookup missed) degrades to "nothing live," not a missing entry.
 *  `reports` is the unit's OWN catalog (varies by kind) — the fallback when
 *  liveness is missing pads exactly that list, never a fixed six. */
function serializePerReport(
  liveness: ReportLiveness | undefined,
  reports: readonly ReportDef[],
): SerializedPerReport {
  return (
    liveness?.perReport.map((r) => ({
      n: r.n,
      live: r.live,
      lastRefreshedAt: r.lastRefreshedAt?.toISOString() ?? null,
    })) ?? reports.map((r) => ({ n: r.n, live: false, lastRefreshedAt: null }))
  );
}

/** `3a` — an actor with exactly one reportable unit (the common case today).
 *  Per-report liveness for one unit, plain-serialized for the client table. */
async function loadSingleUnitPerReport(code: string, kind: UnitEntityType): Promise<SerializedPerReport> {
  const liveness = (await loadReportLiveness([{ code, kind }], db.read)).get(code);
  return serializePerReport(liveness, REPORTS_BY_KIND[kind]);
}

/** `3a` — same `Report | Focus | Last refreshed` table `1a`'s bands use per
 *  unit, just without the band header (this page's own `<h1>` already names
 *  the unit) — matches the actual mockup (`Reports IA.dc.html`), which was
 *  never a plain list. Shared between the explicit `?center=` path and the
 *  single-reportable-unit default so neither duplicates the JSX. */
function SingleUnitReports({
  ctx,
  code,
  kind,
  perReport,
  session,
  pendingSlugRequests,
  pendingHonors,
}: {
  ctx: UnitEditContext;
  code: string;
  kind: UnitEntityType;
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
        Advisory only: every report reads precomputed data; nothing here writes to the roster.
      </p>
      {/* ConsoleShell owns only the chrome — content supplies its own surface
          (R1/the Apollo Surface Language "the page is never white"). Without
          this, the table floats directly on --apollo-page with no card. */}
      <div className="apollo-card">
        <SingleUnitReportsTable
          unitCode={code}
          unitKind={kind}
          perReport={perReport}
          reports={REPORTS_BY_KIND[kind]}
        />
      </div>
    </ConsoleShell>
  );
}
