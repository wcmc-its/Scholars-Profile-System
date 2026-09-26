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
 * Reports IA redesign (2026-08-14): `?center=` addresses one of POTENTIALLY
 * SEVERAL reportable units; an accompanying `?kind=department|division|core`
 * addresses a department/division/core (by its core id) instead. Without
 * `?center=`: 0 reportable units → 404 for a scoped Owner/Curator/
 * comms_steward, but an empty index for a superuser (Gap 5, 2026-08-14 — a
 * superuser isn't scoped to any grants, so an empty roster isn't "this route
 * doesn't exist"); otherwise every reportable unit, scoped to the actor
 * (org-wide for a superuser/comms_steward, else their own `UnitAdmin` grants).
 *
 * Reports Index redesign (2026-09-25): whatever the unit set, it renders as
 * ONE list grouped by unit (`ReportsIndex`) — Institution-wide and Mentoring
 * programs first, then the units. A `?center=` view is that list with one
 * unit group. The search / scope / In progress filters ride the URL (`q`,
 * `scope`, `review=1`) so a shared link reproduces the view.
 *
 * Program reports (`/edit/reports/7`, Mentored publications) are NOT
 * unit-scoped — their gate is a `report_access` row (`getReportScopes`,
 * `lib/edit/report-access.ts`); reports 8/9 likewise. A holder gets the
 * pseudo-unit group in whichever list they land on (a plain holder with zero
 * reportable units gets it alone instead of the 404).
 *
 * Each row states who can open the report as plain text: this page builds
 * each report's access props — the static unit rule for reports 1–6, the
 * grant rows for 7/8/9 (`loadReportAccessPopoverProps`), exactly what the
 * report's own header gets — and hands the client only their one-line
 * `accessSummary(...).text` (`ReportsIndexReport.accessText`, the header
 * badge's own string source), so the two never disagree and the grantee list
 * behind "+ N others" stays on the server. Access is managed from the report
 * page's Edit details sheet, not here.
 */
import { notFound, redirect } from "next/navigation";

import { ConsoleShell } from "@/components/edit/console-shell";
import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";
import type {
  ReportAccessPopoverPersonProps,
  ReportAccessPopoverProps,
} from "@/components/edit/report-access-popover";
import {
  ReportsIndex,
  type ReportsIndexReport,
  type ReportsIndexUnit,
} from "@/components/edit/reports-index";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { canViewArticleCountReport } from "@/lib/edit/article-count-report";
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
import { accessSummary, ADMIN_AUDIENCE } from "@/lib/edit/report-access-summary";
import { parseReportsIndexScope } from "@/lib/edit/reports-index-scope";
import { loadReportMeta, type ReportKey, type ReportMeta } from "@/lib/edit/report-meta";
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
 *  is what `ReportsIndex` renders for a unit of that
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
 *  `/edit/reports/<slug>`) + who can open it, as text (never the props). `meta` always has every key (`loadReportMeta` merges defaults).
 *  Generic in `n` so the same helper serves the unit catalog (`ReportNumber`,
 *  1–6) and the program pseudo-unit's report 7. */
function catalogEntry<N extends ReportsIndexReport["n"]>(
  meta: Map<ReportKey, ReportMeta>,
  n: N,
  access: ReportAccessPopoverProps,
): ReportsIndexReport & { n: N } {
  const m = meta.get(String(n) as ReportKey);
  if (!m) throw new Error(`report_meta: no entry for report ${n}`);
  return { n, slug: m.slug, name: m.name, description: m.summary, accessText: accessSummary(access).text };
}

function buildCatalog(meta: Map<ReportKey, ReportMeta>): ReportCatalog {
  // Reports 1–6 are unit-gated: the Owner/Curator rule.
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
  searchParams?: Promise<{ center?: string; kind?: string; q?: string; scope?: string; review?: string }>;
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
  // Reports 8 (Article counts: unit administrators + grants) and 9 (Top
  // clinical and high-impact journal publications: grants) ride a second
  // pseudo-unit. (Report 10, Display titles, is the Titles queue now.)
  const [canArticleCount, highImpactScopes] = await Promise.all([
    canViewArticleCountReport(session),
    getReportScopes(session, HIGH_IMPACT_PUBS_REPORT),
  ]);
  const institutionReports = [
    ...(canArticleCount
      ? [
          // The report header's own props for report 8 (`[report]/page.tsx`),
          // audience included, so the row and the badge say the same thing.
          catalogEntry(meta, 8, {
            ...(await loadReportAccessPopoverProps(ARTICLE_COUNT_REPORT, session, ARTICLE_COUNT_ACCESS_NOTE)),
            audience: ADMIN_AUDIENCE,
          }),
        ]
      : []),
    ...(highImpactScopes.size > 0
      ? [catalogEntry(meta, 9, await loadReportAccessPopoverProps(HIGH_IMPACT_PUBS_REPORT, session))]
      : []),
  ];
  const institutionUnit = institutionReports.length > 0 ? buildInstitutionUnit(institutionReports) : null;
  // Group order on the index: Institution-wide, then Mentoring programs, then units.
  const extraUnits = [institutionUnit, programUnit].filter((u): u is ReportsIndexUnit => u !== null);

  const params = (await searchParams) ?? {};
  const { center, kind: kindParam } = params;
  let baseUnits: ReadonlyArray<{ code: string; kind: ReportableUnitKind; name: string }>;
  if (center) {
    // An explicit `?center=` addresses exactly one unit, validated against the
    // CenterProgram taxonomy gate for a center. A department/division/core has
    // no taxonomy to validate against — `loadReportsContext` is the real
    // existence/authz gate for every kind.
    const kind = parseKind(kindParam);
    const code = kind === "center" ? await resolveReportsCenterCode(db.read, center) : center;
    const ctx = await loadReportsContext(code, session, db.read, kind);
    if (ctx === null)
      return (
        <ConsoleShell active="reports" session={session} pendingSlugRequests={null} pendingHonors={null}>
          <ForbiddenEditPage variant="unit" targetEntity={code} />
        </ConsoleShell>
      );
    baseUnits = [{ code, kind, name: ctx.unit.name }];
  } else {
    baseUnits = await loadReportableUnitsForActor(session, db.read, REPORTABLE_KINDS);
    // Gap 5: zero reportable units is an empty roster for a superuser, a 404
    // for everyone else — unless a pseudo-unit (report 7/8/9) gives them
    // somewhere to go.
    if (baseUnits.length === 0 && !session.isSuperuser && extraUnits.length === 0) notFound();
  }

  const liveness = await loadReportLiveness(
    baseUnits.map((u) => ({ code: u.code, kind: u.kind })),
    db.read,
  );
  const units: ReportsIndexUnit[] = [
    ...extraUnits,
    ...baseUnits.map((u) => {
      const reports = catalog.byKind[u.kind];
      return {
        code: u.code,
        kind: u.kind,
        name: u.name,
        editHref: unitEditHref(u.kind, u.code),
        reports,
        perReport: serializePerReport(liveness.get(u.code), reports),
      };
    }),
  ];

  return (
    <ConsoleShell active="reports" reportsTab {...shell}>
      <h1 className="mb-1 text-xl font-bold">Reports</h1>
      <p className="text-muted-foreground max-w-[680px] text-sm">
        Reports you can open, grouped by the unit they cover. Every report reads precomputed data; nothing
        here changes a roster.
      </p>
      <ReportsIndex
        units={units}
        // A global viewer sees every department/division/core: off under
        // "All" (their own segments show them). Not for an explicit
        // `?center=` — that one unit is what they asked for.
        hideUnderAll={(session.isSuperuser || session.isCommsSteward) && !center}
        initialQuery={typeof params.q === "string" ? params.q : ""}
        initialScope={parseReportsIndexScope(params.scope)}
        initialReview={params.review === "1"}
      />
    </ConsoleShell>
  );
}

/** The person-granted Mentored publications report as a one-report
 *  pseudo-unit, so it rides the same list (and filter rail) as every unit —
 *  never a card floating under the list. Not tied to an org unit; access is
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
    // The report's own canonical address (its current slug) — a program has
    // no profile to edit, and `ReportsIndex` never renders this for one.
    editHref: `/edit/reports/${report.slug}`,
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
    editHref: `/edit/reports/${reports[0].slug}`,
    reports,
    perReport: reports.map((r) => ({ n: r.n, live: true, lastRefreshedAt: null })),
  };
}

/** ISO-string serialization for the client list — a unit/code with no
 *  liveness row at all (the Map lookup missed) degrades to "no data yet," not
 *  a missing entry. Report 2's cycle and review count pass through.
 *  `reports` is the unit's OWN catalog (varies by kind) — the fallback when
 *  liveness is missing pads exactly that list, never a fixed six. */
function serializePerReport(
  liveness: ReportLiveness | undefined,
  reports: readonly ReportDef[],
): ReportsIndexUnit["perReport"] {
  return (
    liveness?.perReport.map((r) => ({
      ...r,
      lastRefreshedAt: r.lastRefreshedAt?.toISOString() ?? null,
    })) ?? reports.map((r) => ({ n: r.n, live: false, lastRefreshedAt: null }))
  );
}
