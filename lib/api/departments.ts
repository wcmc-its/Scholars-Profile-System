/**
 * Department-page data assembly.
 *
 * Surfaces:
 *   - getDepartment(slug)              D-01/D-03 — dept row, chair, top research areas, divisions, stats
 *   - getDepartmentFaculty(code, opts) D-12      — paginated faculty list with optional division filter
 *
 * See also: lib/api/topics.ts — getDistinctScholarCountForTopic (D-10 affordance lives there
 * for semantic correctness, since it operates on Topic data).
 *
 * Ordering (Unit Page v2 roster toolbar): surname A–Z by default, or most
 * publications / most grants; chief-of-division first when filtering by
 * division under the surname sort.
 *
 * Eligibility: NO role carve on department faculty list per UI-SPEC §6.10 — all 11
 * role values shown. Only deletedAt IS NULL + status = active apply.
 *
 * See:
 *   - .planning/phases/03-topic-and-department-detail-pages/03-UI-SPEC.md §6.5–§6.10
 *   - .planning/phases/03-topic-and-department-detail-pages/03-CONTEXT.md (D-01, D-03, D-10, D-12)
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { cachedRead } from "@/lib/api/swr-cache";
import { attachTopMesh } from "@/lib/api/roster-mesh";
import type { RosterMeshChip } from "@/lib/roster-row-tags";
import { identityImageEndpoint } from "@/lib/headshot";
import { EXTERNAL_LEADERS } from "@/lib/external-leaders";
import { formatRoleCategory } from "@/lib/role-display";
import { publicRoleWhere } from "@/lib/eligibility";
import type { LeaderRole } from "@/components/scholar/leader-card";
import {
  departmentLeaderRoleKey,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
} from "@/lib/org-unit-roles";
import { resolveUnitLeader, resolveUnitLeaderCwids } from "@/lib/api/unit-leader";
import {
  isUnitSuppressed,
  loadAllPublicationSuppressions,
  loadUnitFieldOverrides,
  mergeUnitFields,
  resolveUnitDarkPmids,
} from "@/lib/api/manual-layer";
import { loadUnitGrantProjects } from "@/lib/api/unit-grant-projects";
import {
  aggregatePublicFamiliesForUnit,
  type MemberMethodFamily,
} from "@/lib/api/methods-roster";
import type { FacetOption } from "@/components/center/center-roster-facets";
import { loadUnitRosterIndex } from "@/lib/api/unit-roster-index";
import { hydrateRosterPage } from "@/lib/api/unit-members";
import { rankRoster, type RosterSort } from "@/lib/roster-sort";
import {
  isOrgUnitMethodsChipsEnabled,
  isOrgUnitMethodsFacetEnabled,
} from "@/lib/profile/methods-lens-flags";

export type DepartmentChair = {
  cwid: string;
  preferredName: string;
  /** Profile slug, or null for an external leader (lib/external-leaders.ts) who
   *  is not a WCM scholar — rendered as a non-linked name. */
  slug: string | null;
  /** From appointment.title, e.g. "Chairman and Stephen and Suzanne Weiss Professor"
   *  or "Director of Library" for administrative depts (issue #58). */
  chairTitle: string;
  /** Scholar's primary academic title, e.g. "Professor of Medicine" */
  primaryTitle: string | null;
  identityImageEndpoint: string;
  /** Display label for the leader card. Administrative depts (Library) use
   *  "Director"; everything else uses "Chair". Issue #58. */
  role: LeaderRole;
  /** Interim/acting qualifier — `field_override(leaderInterim)` for dept/div
   *  (#540 / ADR-005 Amendment 1 § A1.1). Renders "Interim Chair" / "Acting
   *  Director"; default false. */
  isInterim: boolean;
};

export type DepartmentTopicArea = {
  topicId: string;
  topicLabel: string;
  topicSlug: string;
  pubCount: number;
};

export type DepartmentDivisionSummary = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  chiefCwid: string | null;
  chiefName: string | null;
  chiefSlug: string | null;
  scholarCount: number;
};

export type DepartmentStats = {
  scholars: number;
  divisions: number;
  publications: number;
  activeGrants: number;
};

export type DepartmentDetail = {
  dept: {
    code: string;
    name: string;
    officialName: string | null;
    compactName: string | null;
    slug: string;
    description: string | null;
    /** #1021 — curated outbound website URL, or null. Rendered beside the name. */
    url: string | null;
  };
  chair: DepartmentChair | null;
  topResearchAreas: DepartmentTopicArea[];
  divisions: DepartmentDivisionSummary[];
  stats: DepartmentStats;
};


/** Distinct confirmed, non-dark publications of a department's active scholars. */
async function countDeptPublications(deptCode: string): Promise<number> {
  const membership = { scholar: { deptCode, deletedAt: null, status: "active" } };
  const suppressions = await loadAllPublicationSuppressions(prisma);
  const darkPmids = await resolveUnitDarkPmids(suppressions, membership, prisma);
  const notDark =
    darkPmids.length > 0
      ? Prisma.sql`AND pa.pmid NOT IN (${Prisma.join(darkPmids)})`
      : Prisma.empty;
  const rows = (await prisma.$queryRaw(
    Prisma.sql`SELECT COUNT(DISTINCT pa.pmid) AS n
                 FROM publication_author pa
                 JOIN scholar s ON s.cwid = pa.cwid
                WHERE pa.is_confirmed = 1
                  AND s.dept_code = ${deptCode}
                  AND s.deleted_at IS NULL
                  AND s.status = 'active'
                  ${notDark}`,
  )) as Array<{ n: number | bigint }> | undefined;
  return Number(rows?.[0]?.n ?? 0);
}

async function getDepartmentUncached(slug: string): Promise<DepartmentDetail | null> {
  const dept = await prisma.department.findUnique({ where: { slug } });
  if (!dept) return null;

  // #540 — a retired (whole-unit-suppressed) department is a 404.
  if (await isUnitSuppressed("department", dept.code, prisma)) return null;

  // #540 — field-override merge. `description`, `url` override the ETL
  // columns at read time (ADR-005 Amendment 1 § A1.1). `slug` is consumed by
  // `etl/ed`, not merged here. `leaderCwid`/`leaderInterim` are NOT merged
  // into this object any more — `resolveUnitLeader` below reads `overrides`
  // directly so it can apply override-over-assignment precedence
  // (`lib/api/unit-leader.ts`) rather than the override-or-column precedence
  // `mergeUnitFields` gives every other field. `mergeUnitFields`'s
  // `leaderCwid` input is a `null` placeholder passed through only to satisfy
  // `UnitRowFieldsForMerge`'s shape (`lib/api/manual-layer.ts`, out of scope
  // here) — Department has no `chairCwid` column any more (#2542 contract A)
  // and the merged `leaderCwid`/`leaderInterim` output is never read.
  const overrides = await loadUnitFieldOverrides("department", dept.code, prisma);
  const merged = mergeUnitFields(
    { description: dept.description, url: dept.url, leaderCwid: null },
    overrides,
  );

  // --- Leader (Chair for non-admin depts, Director for admin depts) ---
  // Issue #58 — administrative departments (Library) are led by a Director,
  // not a Chair. `departmentLeaderRoleKey` is the single place that derives
  // the role KEY from `category`; the display LABEL comes from the vocabulary
  // (`OrgUnitRole.label`) via `resolveUnitLeader`, so a steward rename shows
  // up here without a code change (#2542 Phase D).
  const roleKey = departmentLeaderRoleKey(dept.category);
  const resolvedLeader = await resolveUnitLeader({
    entityType: "department",
    entityId: dept.code,
    roleKey,
    overrides,
    fallbackLabel: roleKey === DEPARTMENT_DIRECTOR_ROLE_KEY ? "Director" : "Chair",
    client: prisma,
  });
  let chair: DepartmentChair | null = null;
  if (resolvedLeader) {
    const leaderRole: LeaderRole = resolvedLeader.roleLabel;
    const chairScholar = await prisma.scholar.findUnique({
      where: { cwid: resolvedLeader.cwid },
      select: { cwid: true, preferredName: true, slug: true, primaryTitle: true },
    });
    if (chairScholar) {
      // Find the leader's most-recent active appointment with a title starting
      // "Chair" / "Chairman" / "Professor and Chair", or "Director" when the
      // ROLE KEY (not the — possibly renamed — display label) is the
      // administrative-department director.
      const titleStartsWith =
        roleKey === DEPARTMENT_DIRECTOR_ROLE_KEY
          ? [{ title: { startsWith: "Director" } }]
          : [
              { title: { startsWith: "Chair" } },
              { title: { startsWith: "Professor and Chair" } },
            ];
      const chairAppt = await prisma.appointment.findFirst({
        where: {
          cwid: resolvedLeader.cwid,
          endDate: null,
          OR: titleStartsWith,
        },
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
        select: { title: true },
      });
      chair = {
        cwid: chairScholar.cwid,
        preferredName: chairScholar.preferredName,
        slug: chairScholar.slug,
        chairTitle: chairAppt?.title ?? leaderRole,
        primaryTitle: chairScholar.primaryTitle ?? null,
        identityImageEndpoint: identityImageEndpoint(chairScholar.cwid),
        role: leaderRole,
        isInterim: resolvedLeader.interim,
      };
    } else {
      // External-leader hack (lib/external-leaders.ts): a leader CWID that is
      // NOT a WCM scholar (e.g. a Columbia primary appointment, like Joel Stein
      // for Rehabilitation Medicine) renders as a non-linked name + Directory
      // photo. The CWID still drives the photo via identityImageEndpoint.
      const external = EXTERNAL_LEADERS[dept.code];
      if (external && external.cwid === resolvedLeader.cwid) {
        chair = {
          cwid: external.cwid,
          preferredName: external.name,
          slug: null,
          chairTitle: leaderRole,
          primaryTitle: external.primaryTitle,
          identityImageEndpoint: identityImageEndpoint(external.cwid),
          role: leaderRole,
          isInterim: resolvedLeader.interim,
        };
      }
    }
  }

  // --- Top research areas: top 10 parent topics by DISTINCT pub count for dept scholars ---
  // COUNT(DISTINCT pmid), not a `groupBy` `_count.pmid`: publication_topic is
  // keyed (pmid, cwid, parent_topic_id), so a row count counted a paper once
  // per department author. Same shape as the browse page (lib/api/browse.ts)
  // and the center / division loaders.
  const topicCounts = (
    ((await prisma.$queryRaw(
      Prisma.sql`SELECT pt.parent_topic_id AS parentTopicId, COUNT(DISTINCT pt.pmid) AS pubCount
                   FROM publication_topic pt
                   JOIN scholar s ON s.cwid = pt.cwid
                  WHERE s.dept_code = ${dept.code}
                    AND s.deleted_at IS NULL
                    AND s.status = 'active'
                  GROUP BY pt.parent_topic_id
                  ORDER BY pubCount DESC, pt.parent_topic_id ASC
                  LIMIT 10`,
    )) as Array<{ parentTopicId: string; pubCount: number | bigint }> | undefined) ?? []
  ).map((r) => ({ parentTopicId: r.parentTopicId, pubCount: Number(r.pubCount) }));
  const topicIds = topicCounts.map((t: { parentTopicId: string }) => t.parentTopicId);
  const topicMeta =
    topicIds.length > 0
      ? await prisma.topic.findMany({
          where: { id: { in: topicIds } },
          select: { id: true, label: true },
        })
      : ([] as Array<{ id: string; label: string }>);
  const labelMap = new Map<string, string>(
    topicMeta.map((t: { id: string; label: string }) => [t.id, t.label]),
  );
  const topResearchAreas: DepartmentTopicArea[] = topicCounts.map((t) => ({
    topicId: t.parentTopicId,
    topicLabel: labelMap.get(t.parentTopicId) ?? t.parentTopicId,
    topicSlug: t.parentTopicId, // Topic.id IS the slug per 02-SCHEMA-DECISION.md
    pubCount: t.pubCount,
  }));

  // --- Divisions for this dept, sorted by scholarCount DESC ---
  const rawDivisions = await prisma.division.findMany({
    where: { deptCode: dept.code },
    orderBy: { scholarCount: "desc" },
  });
  type DivisionRow = Awaited<typeof rawDivisions>[number];
  // Chief per division: override > assignment (#2542 contract A) —
  // `Division.chiefCwid` no longer exists as a read source. Same precedence as
  // `resolveUnitLeader` (the division's own page), batched: two queries for
  // every division instead of three per division.
  const chiefCwidByDivision = await resolveUnitLeaderCwids({
    entityType: "division",
    entityIds: rawDivisions.map((d: DivisionRow) => d.code),
    roleKey: DIVISION_CHIEF_ROLE_KEY,
    client: prisma,
  });
  const chiefCwids: string[] = [...chiefCwidByDivision.values()].filter(
    (c): c is string => !!c,
  );
  const chiefScholars =
    chiefCwids.length > 0
      ? await prisma.scholar.findMany({
          where: { cwid: { in: chiefCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })
      : ([] as Array<{ cwid: string; preferredName: string; slug: string }>);
  type ChiefRow = { cwid: string; preferredName: string; slug: string };
  const chiefMap = new Map<string, ChiefRow>(
    chiefScholars.map((s: ChiefRow) => [s.cwid, s]),
  );
  const divisions: DepartmentDivisionSummary[] = rawDivisions.map((d: DivisionRow) => {
    const divChiefCwid = chiefCwidByDivision.get(d.code) ?? null;
    const chief = divChiefCwid ? (chiefMap.get(divChiefCwid) ?? null) : null;
    return {
      code: d.code,
      name: d.name,
      slug: d.slug,
      description: d.description,
      chiefCwid: divChiefCwid,
      chiefName: chief?.preferredName ?? null,
      chiefSlug: chief?.slug ?? null,
      scholarCount: d.scholarCount,
    };
  });

  // --- Stats ---
  const now = new Date();
  const [scholarsCount, pubCount, grantCount] = await Promise.all([
    // #2202 — the hero "N scholars" and the Scholars tab label are BOTH this
    // number, and they sit on the same page as the roster, whose `total` now
    // carries the #536 carve (`getDepartmentFacultyUncached`). Carving here too
    // is what keeps "590 scholars" from sitting above an empty roster.
    prisma.scholar.count({
      where: {
        deptCode: dept.code,
        deletedAt: null,
        status: "active",
        ...publicRoleWhere(),
      },
    }),
    // NOT carved (deliberate): #718 retains a hidden scholar's publications and
    // grants. The unit's publication / grant / research-area aggregates below
    // keep counting them — only the counts of PEOPLE carve.
    // Distinct visible papers — the same set the Publications tab totals
    // (`getDeptPublicationsList`: confirmed dept author, minus unit-dark pmids).
    // Was a publication_topic ROW count: one per (paper, author, topic).
    countDeptPublications(dept.code),
    // #2066/#481(b) — count active funding PROJECTS (`coreProjectNum ??
    // accountNumber`), not investigator-award rows, through the SAME call
    // `getDeptGrantsList` paginates. The hero stat and the Grants-tab total are
    // one number from one implementation, not two that agree today.
    // #160-suppressed rows are dropped inside, before grouping.
    loadUnitGrantProjects(
      {
        scholar: { deptCode: dept.code, deletedAt: null, status: "active" },
        endDate: { gte: now },
        source: { not: "RePORTER" }, // exclude individual RePORTER history
      },
      "most_recent",
    ).then((projects) => projects.length),
  ]);

  const stats: DepartmentStats = {
    scholars: scholarsCount,
    divisions: divisions.length,
    publications: pubCount,
    activeGrants: grantCount,
  };

  return {
    dept: {
      code: dept.code,
      name: dept.name,
      officialName: dept.officialName,
      compactName: dept.compactName,
      slug: dept.slug,
      description: merged.description,
      // #1021 — empty-string override (curator cleared the link) reads as null.
      url: merged.url && merged.url !== "" ? merged.url : null,
    },
    chair,
    topResearchAreas,
    divisions,
    stats,
  };
}

export type DepartmentFacultyHit = {
  cwid: string;
  preferredName: string;
  slug: string;
  primaryTitle: string | null;
  /** Division name for the "Division · Department of Name" line */
  divisionName: string | null;
  departmentName: string;
  identityImageEndpoint: string;
  /** Role tag — Full-time faculty / Postdoc / etc. A display LABEL, not the enum:
   *  it is what `RoleChipRow` / `filterByRoleCategory` and `roleCategoryCounts`
   *  match on. Never pass it to an eligibility predicate — use `roleCategoryRaw`. */
  roleCategory: string | null;
  /** Raw `scholar.role_category`. The value `isPubliclyDisplayed` must see (#2202):
   *  the label above is not in its allow-list, so feeding it the label used to fail
   *  OPEN and published 684 doctoral students by name on public unit rosters.
   *  Optional so existing hit fixtures still typecheck — a producer that forgets it
   *  now falls back to the label, which fails CLOSED (de-links) rather than leaking. */
  roleCategoryRaw?: string | null;
  /** First ~120 chars of the scholar's research overview for the person-row snippet */
  overview: string | null;
  pubCount: number;
  grantCount: number;
  /** Bare ED primary-organization code (`HSS`, `WCMC`, …). `PersonRow` badges
   *  it through `visibleInstitutionName` — non-WCMC only. Optional so hit
   *  fixtures keep typing; an external (Cornell) hit never carries one. */
  primaryOrgCode?: string | null;
  /** #974 — top ≤3 PUBLIC method families for the per-row chips. Present only
   *  when ORG_UNIT_METHODS_CHIPS (+ METHODS_LENS_ENABLED) is on AND the member
   *  has ≥1 public family; undefined otherwise (off-path payload carries nothing). */
  topMethods?: MemberMethodFamily[];
  /** Unit Page v2 — top ≤3 MeSH terms (people index `topMeshTerms`) for the
   *  roster TOPICS chips. Attached OUTSIDE the cached roster read
   *  (lib/api/roster-mesh.ts); absent when the member has none. */
  topMesh?: RosterMeshChip[];
  /** #2519 — true only for a Cornell (Ithaca) external member (no `Scholar`
   *  row). Undefined on every WCM hit. `PersonRow` must branch on this BEFORE
   *  the `isPubliclyDisplayed`/`slug` profile-link logic, which does not apply
   *  to an external member (no role category, no WCM profile). */
  isExternal?: true;
  /** #2519 — the Cornell directory SSO landing page for this member, present
   *  only when `isExternal` is true. Precomputed server-side so no client
   *  component needs to import `lib/api/external-members.ts` (which pulls in
   *  `@/lib/db` at module scope). */
  externalProfileUrl?: string;
  /** Institution badge for an external member ("Cornell University", or a CTSC
   *  feed institution). Absent ⇒ no badge. */
  externalInstitution?: string;
};

export type DepartmentFacultyResult = {
  hits: DepartmentFacultyHit[];
  total: number;
  /**
   * Distinct count of scholars per normalized role-category label, computed
   * over the full dept (+ optional div) scope. Used by the role-chip-row so
   * the chip counts reflect the entire result set, not just the current
   * page. (#17)
   *
   * Keys are the normalized labels produced by formatRoleCategory
   * ("Full-time faculty", "Postdoc", "Doctoral student", etc.) — the same
   * shape that the chip-row's group.matches() inspects.
   */
  roleCategoryCounts: Record<string, number>;
  page: number;
  pageSize: number;
  /** #974 Phase 2 — unit-wide PUBLIC method-family facet buckets (count-desc).
   *  Present (possibly empty) only when ORG_UNIT_METHODS_FACET (+
   *  METHODS_LENS_ENABLED) is on; undefined otherwise so the off-path payload is
   *  byte-identical. Viewer-independent → the page stays CloudFront-cacheable. */
  methodFacet?: FacetOption[];
};

const FACULTY_PAGE_SIZE = 20;

const normalizeRoleCategory = formatRoleCategory;

/**
 * Returns paginated faculty for a department, optionally filtered by division,
 * in the roster toolbar's `sort` order (Unit Page v2): "last" = surname A–Z
 * (`extractLastNameSort`, the People-search / center-roster key — the default,
 * and a change from the old first-name `preferredName` ASC), "pubs" / "grants"
 * = the row's displayed count, descending, surname tiebreak.
 *
 * The page is ranked from the cached whole-roster index
 * (`loadUnitRosterIndex`), sliced, and hydrated through the same `buildHits`
 * the filtered route uses, so SSR and route rows cannot drift. With a divCode
 * and the surname sort, the division chief is pinned first.
 *
 * Eligibility: UI-SPEC §6.10 shows all ELIGIBILITY roles, but the #536 public-display
 * carve is an identity-class rule that overrides it (#2202) — doctoral students and
 * `affiliate_alumni` are not enumerable on a directed, crawlable surface. The carve
 * lives in the index's member query, so a hidden scholar is never LOADED, and
 * `buildHits` repeats it on the page rows; the render-time guard in
 * `person-row.tsx` is a second line of defense, not the only one.
 */
async function getDepartmentFacultyUncached(
  deptCode: string,
  opts: { divCode?: string; page?: number; sort?: RosterSort },
): Promise<DepartmentFacultyResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: RosterSort = opts.sort ?? "last";
  // ONE carved member list drives `total`, `roleCategoryCounts`, the chief pin,
  // the page rows and the methodFacet cwid set — so the #536 carve shrinks all
  // five together and nothing can desync. The "Doctoral students" chip then
  // counts 0 and `role-chip-row.tsx` omits it.
  const index = await loadUnitRosterIndex("department", deptCode, {
    withCounts: sort !== "last",
  });
  const scope = opts.divCode ? index.filter((e) => e.divCode === opts.divCode) : index;
  const total = scope.length;
  if (total === 0) {
    return { hits: [], total: 0, roleCategoryCounts: {}, page, pageSize: FACULTY_PAGE_SIZE };
  }

  // Whole-scope role-category counts so the chip-row reflects the entire
  // dataset, not just the visible page. (#17)
  const roleCategoryCounts: Record<string, number> = {};
  for (const e of scope) {
    const label = normalizeRoleCategory(e.roleCategory);
    if (label === null) continue;
    roleCategoryCounts[label] = (roleCategoryCounts[label] ?? 0) + 1;
  }

  let ranked = rankRoster(scope, { sort });

  // Chief-first ordering when divCode is provided (surname sort only — a count
  // sort is an explicit ranking). Override > assignment (#2542 contract A),
  // same precedence as the division page itself.
  if (opts.divCode && sort === "last") {
    const divOverrides = await loadUnitFieldOverrides("division", opts.divCode, prisma);
    const resolvedChief = await resolveUnitLeader({
      entityType: "division",
      entityId: opts.divCode,
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      overrides: divOverrides,
      fallbackLabel: "Chief",
      client: prisma,
    });
    const chiefIdx = resolvedChief?.cwid
      ? ranked.findIndex((e) => e.cwid === resolvedChief.cwid)
      : -1;
    if (chiefIdx > 0) {
      ranked = [ranked[chiefIdx], ...ranked.slice(0, chiefIdx), ...ranked.slice(chiefIdx + 1)];
    }
  }

  // #974 — the hydration attaches top-≤3 PUBLIC method families for the per-row
  // chips, keyed on the visible page's ≤20 CWIDs. The loader self-gates on the
  // flag, so off → no chips, and the page stays CloudFront-cacheable (a plain
  // DB read, no per-viewer call).
  const hits = await hydrateRosterPage(
    "department",
    ranked.slice(page * FACULTY_PAGE_SIZE, (page + 1) * FACULTY_PAGE_SIZE),
    { chipsEnabled: isOrgUnitMethodsChipsEnabled() },
  );

  // #974 Phase 2 — unit-wide "Methods & tools" facet buckets over the FULL
  // carved member set (the page above is only ≤20 rows), aggregated into PUBLIC
  // family buckets. Flag-gated: when off, no extra query runs and `methodFacet`
  // is undefined → omitted from JSON → off-path payload is byte-identical.
  // Viewer-independent → the page stays CloudFront-cacheable.
  const methodFacet = isOrgUnitMethodsFacetEnabled()
    ? await aggregatePublicFamiliesForUnit(
        scope.map((e) => e.cwid),
        { enabled: true },
      )
    : undefined;

  return {
    hits,
    total,
    roleCategoryCounts,
    page,
    pageSize: FACULTY_PAGE_SIZE,
    methodFacet,
  };
}

// --- Cached public wrappers (viewer-independent reads via lib/api/swr-cache;
//     mirrors the center-page caching in lib/api/centers.ts). ---
export const getDepartment = (slug: string) =>
  cachedRead(`department:detail:${slug}`, () => getDepartmentUncached(slug));

export const getDepartmentFaculty = async (
  deptCode: string,
  opts: { divCode?: string; page?: number; sort?: RosterSort },
): Promise<DepartmentFacultyResult> => {
  const result = await cachedRead(
    `department:faculty:${deptCode}:${opts.divCode ?? ""}:${Math.max(0, opts.page ?? 0)}:${opts.sort ?? "last"}`,
    () => getDepartmentFacultyUncached(deptCode, opts),
  );
  // TOPICS chips attach after the cached read so a degraded (OpenSearch-down)
  // empty is never baked into this roster's swr entry.
  return { ...result, hits: await attachTopMesh(result.hits) };
};
