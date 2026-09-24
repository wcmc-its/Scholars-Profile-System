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
 * can't drift from the per-unit editor it replaced. A `core` resolves through
 * the same one function to its own gate (`/edit/core/[coreId]/review`'s
 * `getCoreOwnerRole` + `authorizeCoreClaim`). The unit itself is resolved
 * server-side (never hardcoded).
 *
 * Reports 1/2/4/5 stay center-only (`CenterProgram`/`CenterMembership`-family
 * data with no department/division/core equivalent — org-unit publications
 * reports plan, 2026-08-16, "Reports 1 & 2 — considered, dropped"). Reports 3
 * (Publications) and 6 (NIH-funded pubs) are unit-agnostic — `buildCatalog`
 * below (`byKind`) is the single source of truth for which cards a unit's kind
 * shows, mirroring `REPORT_NUMBERS_BY_KIND` in `lib/edit/cancer-center-reports.ts`.
 * "Live" per unit varies with real data (`loadReportLiveness`); the catalog
 * per KIND does not. Each card's name and blurb come from `report_meta`
 * (`lib/edit/report-meta.ts`, superuser-editable), read once per request.
 *
 * Reports IA redesign (2026-08-14): `?center=` now addresses one of
 * POTENTIALLY SEVERAL reportable units, not just "the second center once one
 * exists." With `?center=` given, behavior is unchanged (today's single-unit
 * list) for a center; an accompanying `?kind=department|division` addresses a
 * department/division instead (2026-08-16), and `?kind=core` a core facility
 * by its core id (2026-09-06). Without `?center=`: 0 reportable
 * units → 404 for a scoped Owner/Curator/comms_steward, but an empty index
 * for a superuser (Gap 5, 2026-08-14 handoff — a superuser isn't scoped to
 * any grants, so an empty roster isn't "this route doesn't exist"); exactly
 * 1 → the same single-unit list, resolved automatically (unchanged end-user
 * behavior); 2+ → the cross-unit index (`ReportsIndex`), scoped to the actor
 * (org-wide for a superuser/comms_steward, else their own `UnitAdmin`
 * grants) — a table with a filter rail for a superuser/comms_steward (`2a`,
 * no unit-count minimum, #2455), otherwise every unit banded inline on one
 * page (`1a`).
 *
 * Program reports (`/edit/reports/7`, Mentored publications) are NOT
 * unit-scoped — their gate is a `report_access` row (`getReportScopes`,
 * `lib/edit/report-access.ts`). A holder gets one extra "Program reports"
 * card under whichever unit view above they'd otherwise see (superuser /
 * comms_steward always; a plain holder with zero reportable units gets the
 * card alone instead of the 404). The unit-scoped rendering is untouched.
 *
 * Every report row also carries "Who can run this report"
 * (`ReportAccessPopover`, rendered by `ReportsIndex`): this page builds each
 * report's popover PROPS (`ReportsIndexReport.access`) — the static unit rule
 * for reports 1–6; for report 7 the grant rows (`listReportAccess`, read once
 * per request and only when the program row is shown), the shared scope
 * options and `canManageReportAccess` — exactly what `/edit/reports/7` hands
 * its own header, so the two never disagree.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import type { ReportAccessPopoverPersonProps } from "@/components/edit/report-access-popover";
import {
  ReportsIndex,
  SingleUnitReportsTable,
  type ReportsIndexReport,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { canViewArticleCountReport } from "@/lib/edit/article-count-report";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  loadReportsContext,
  resolveReportsCenterCode,
  REPORT_NUMBERS_BY_KIND,
  type ReportLiveness,
  type ReportNumber,
  type ReportableUnitKind,
  type ReportsContext,
} from "@/lib/edit/cancer-center-reports";
import { countPendingHonors, isHonorsQueueTabVisible } from "@/lib/edit/honor-queue";
import { unitEditHref } from "@/lib/edit/manageable-units";
import {
  ARTICLE_COUNT_ACCESS_NOTE,
  ARTICLE_COUNT_REPORT,
  getReportScopes,
  HIGH_IMPACT_PUBS_REPORT,
  MENTORED_PUBS_REPORT,
} from "@/lib/edit/report-access";
import { loadReportAccessPopoverProps } from "@/lib/edit/report-access-popover-props";
import { loadReportMeta, reportLabel, type ReportKey, type ReportMeta } from "@/lib/edit/report-meta";
import { countPendingSlugRequests, isSlugRequestEnabled } from "@/lib/edit/slug-request";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reports — Scholars Console",
  robots: { index: false, follow: false },
};

/** One numbered report card on the index — styled off the `REPORTS` list item
 *  in `cancer-center-collab-report-card.tsx` (same classes/structure), just
 *  as a real route link instead of client-side `selectedKey` state. */
type ReportDef = ReportsIndexReport & { n: ReportNumber };

/** The per-request report catalog — `all` is every report this console can
 *  show (reports 1–6, the full catalog, not a per-kind one); `byKind[kind]`
 *  is what `ReportsIndex`/`SingleUnitReportsTable` render for a unit of that
 *  kind, resolved from `REPORT_NUMBERS_BY_KIND` (`lib/edit/cancer-center-
 *  reports.ts`) so the two lists can never drift. Department/division/core
 *  show only Publications + NIH-funded pubs — no dead card that 404s/empty-
 *  states when opened. Built per request from `report_meta` (`loadReportMeta`)
 *  now that names and blurbs are editable, where it used to be two module-level
 *  consts. */
type ReportCatalog = {
  all: readonly ReportDef[];
  byKind: Record<ReportableUnitKind, readonly ReportDef[]>;
};

/** One index card off the loaded meta: the numbered label + the one-line
 *  summary + the report's current slug (the row's link target,
 *  `/edit/reports/<slug>`) + the report's "Who can run this report" popover
 *  props. `meta` always has every key (`loadReportMeta` merges defaults).
 *  Generic in `n` so the same helper serves the unit catalog (`ReportNumber`,
 *  1–6) and the program pseudo-unit's report 7. */
function catalogEntry<N extends ReportsIndexReport["n"]>(
  meta: Map<ReportKey, ReportMeta>,
  n: N,
  access: ReportsIndexReport["access"],
): ReportsIndexReport & { n: N } {
  const m = meta.get(String(n) as ReportKey);
  if (!m) throw new Error(`report_meta: no entry for report ${n}`);
  return { n, slug: m.slug, label: reportLabel(m), description: m.summary, access };
}

function buildCatalog(meta: Map<ReportKey, ReportMeta>): ReportCatalog {
  // Reports 1–6 are unit-gated: the popover states the Owner/Curator rule.
  const all: readonly ReportDef[] = ([1, 2, 3, 4, 5, 6] as const).map((n) =>
    catalogEntry(meta, n, { mode: "unit" }),
  );
  return {
    all,
    byKind: {
      center: all.filter((r) => REPORT_NUMBERS_BY_KIND.center.includes(r.n)),
      department: all.filter((r) => REPORT_NUMBERS_BY_KIND.department.includes(r.n)),
      division: all.filter((r) => REPORT_NUMBERS_BY_KIND.division.includes(r.n)),
      core: all.filter((r) => REPORT_NUMBERS_BY_KIND.core.includes(r.n)),
    },
  };
}

const REPORTABLE_KINDS: readonly ReportableUnitKind[] = ["center", "department", "division", "core"];

function parseKind(raw: string | undefined): ReportableUnitKind {
  return raw === "department" || raw === "division" || raw === "core" ? raw : "center";
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
  // Program reports (report 7) ride a `report_access` row, not a unit grant —
  // one pseudo-unit row in whichever list the holder lands on below.
  const programScopes = await getReportScopes(session, MENTORED_PUBS_REPORT);
  // Names + blurbs come from `report_meta` (editable), read once per request.
  const meta = await loadReportMeta();
  const catalog = buildCatalog(meta);
  const programUnit =
    programScopes.size > 0
      ? buildProgramUnit(meta, await loadReportAccessPopoverProps(MENTORED_PUBS_REPORT, session))
      : null;
  // Reports 8 (Article counts: unit administrators + grants) and 9
  // (Top clinical and high-impact journal publications: grants) ride a second pseudo-unit.
  const [canArticleCount, highImpactScopes] = await Promise.all([
    canViewArticleCountReport(session),
    getReportScopes(session, HIGH_IMPACT_PUBS_REPORT),
  ]);
  const institutionReports = [
    ...(canArticleCount
      ? [
          catalogEntry(
            meta,
            8,
            await loadReportAccessPopoverProps(ARTICLE_COUNT_REPORT, session, ARTICLE_COUNT_ACCESS_NOTE),
          ),
        ]
      : []),
    ...(highImpactScopes.size > 0
      ? [catalogEntry(meta, 9, await loadReportAccessPopoverProps(HIGH_IMPACT_PUBS_REPORT, session))]
      : []),
  ];
  const institutionUnit = institutionReports.length > 0 ? buildInstitutionUnit(institutionReports) : null;
  const extraUnits = [programUnit, institutionUnit].filter((u): u is ReportsIndexUnit => u !== null);

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
        perReport={await loadSingleUnitPerReport(code, kind, catalog)}
        extraUnits={extraUnits}
        catalog={catalog}
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
  if (reportableUnits.length === 0 && !session.isSuperuser) {
    // A `report_access` holder or an administrator with no unit grant at
    // all still has somewhere to go: the pseudo-unit rows alone, not the 404.
    if (extraUnits.length === 0) notFound();
    return (
      <ConsoleShell active="reports" reportsTab {...shell}>
        <h1 className="mb-1 text-xl font-bold">Reports</h1>
        <p className="text-muted-foreground text-sm">
          Advisory only: every report reads precomputed data; nothing here writes to the roster.
        </p>
        <div className="apollo-card mt-5">
          <ReportsIndex units={extraUnits} mode="bands" />
        </div>
      </ConsoleShell>
    );
  }

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
        perReport={await loadSingleUnitPerReport(unit.code, unit.kind, catalog)}
        extraUnits={extraUnits}
        catalog={catalog}
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
    const reports = catalog.byKind[u.kind];
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
  units.push(...extraUnits);
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

/** The person-granted Mentored publications report as a one-report
 *  pseudo-unit, so it rides the same list (and filter rail) as every unit —
 *  never a card floating under the table. Not tied to an org unit; access is
 *  a `report_access` row. Rendered only when `getReportScopes` is non-empty.
 *  Its label/blurb come from `report_meta` like every other card; `access`
 *  is `loadReportAccessPopoverProps`'s result. */
function buildProgramUnit(
  meta: Map<ReportKey, ReportMeta>,
  access: ReportAccessPopoverPersonProps,
): ReportsIndexUnit {
  const report = catalogEntry(meta, 7, access);
  return {
    code: "mentoring-programs",
    kind: "program",
    name: "Mentoring programs",
    centerType: null,
    // The report's own canonical address (its current slug) — a program has
    // no profile to edit, and `ReportsIndex` never renders this for one.
    editHref: `/edit/reports/${report.slug}`,
    liveCount: 1,
    totalCount: 1,
    lastRefreshedAt: null,
    reports: [report],
    perReport: [{ n: 7, live: true, lastRefreshedAt: null }],
  };
}

/** Reports 8 / 9 — whichever this viewer may run — as one pseudo-unit. */
function buildInstitutionUnit(reports: ReportsIndexReport[]): ReportsIndexUnit {
  return {
    code: "institution",
    kind: "institution",
    name: "Institution-wide",
    centerType: null,
    editHref: `/edit/reports/${reports[0].slug}`,
    liveCount: reports.length,
    totalCount: reports.length,
    lastRefreshedAt: null,
    reports,
    perReport: reports.map((r) => ({ n: r.n, live: true, lastRefreshedAt: null })),
  };
}

type SerializedPerReport = ReadonlyArray<{
  n: ReportNumber;
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
async function loadSingleUnitPerReport(
  code: string,
  kind: ReportableUnitKind,
  catalog: ReportCatalog,
): Promise<SerializedPerReport> {
  const liveness = (await loadReportLiveness([{ code, kind }], db.read)).get(code);
  return serializePerReport(liveness, catalog.byKind[kind]);
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
  extraUnits,
  catalog,
  session,
  pendingSlugRequests,
  pendingHonors,
}: {
  ctx: ReportsContext;
  code: string;
  kind: ReportableUnitKind;
  perReport: SerializedPerReport;
  /** The pseudo-units this viewer may see (program, institution) — their
   *  reports join this unit's rows (an href never carries the unit). */
  extraUnits: ReportsIndexUnit[];
  /** This request's report catalog (`buildCatalog`). */
  catalog: ReportCatalog;
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
          perReport={[...perReport, ...extraUnits.flatMap((u) => u.perReport)]}
          reports={[...catalog.byKind[kind], ...extraUnits.flatMap((u) => u.reports)]}
        />
      </div>
    </ConsoleShell>
  );
}
