/**
 * ONE grouping of a unit's active grant rows into funding PROJECTS — the single
 * implementation behind every department / division surface that counts or
 * renders grants (#2066).
 *
 * WHY THIS FILE EXISTS. Four surfaces carried near-verbatim copies of the same
 * grouping block: the department hero stat (`lib/api/departments.ts`), the
 * division hero stat and division Grants tab (`lib/api/divisions.ts`), and the
 * department Grants tab (`lib/api/dept-lists.ts`). All four keyed on
 * `Grant.externalId`, which is `INFOED-{accountNumber}-{cwid}` and therefore
 * EMBEDS the cwid: a multi-PI award rendered one card PER INVESTIGATOR, and
 * "N active grants" counted investigator-award ROWS rather than grants.
 * Measured live on staging: Medicine 1005 → 520, Radiology 254 → 105,
 * Population Health Sciences 348 → 235, Pediatrics 204 → 108, Psychiatry
 * 86 → 49, Neurology 67 → 51.
 *
 * 🔴 DO NOT EXPECT THESE TO EQUAL `/search?type=funding&department=X`, and do
 * not "restore parity" if they differ — the two count different things BY
 * CONSTRUCTION, and re-forking the grouping to close the gap would reintroduce
 * exactly what #2066 removed. A funding DOC belongs to ONE department: the lead
 * PI's `Scholar.primaryDepartment` (`projectFromRows`, lib/funding-projection.ts
 * — contact PI first, Co-PI as fallback). A unit PAGE counts a project for EVERY
 * department holding an active member row on it, keyed on `Scholar.deptCode` — a
 * different column. So one cross-department project is counted once by search
 * and once per participating department here, and 35% of active multi-PI awards
 * are cross-department. Radiology happening to land on 105 against search's 103
 * is one department's coincidence, not an identity.
 *
 * What IS shared with search is the KEY (below), which is what stops the two
 * from disagreeing about what constitutes one grant.
 *
 * The two hero stats and the two tab totals now come from the SAME call, so
 * they agree BY CONSTRUCTION. Before this, the department tab returned
 * `sortedGroups.length` and the division tab returned a ROW count from
 * `resolveActiveGrantSuppression`; those two already disagreed in principle and
 * were equal only because the externalId key made group count == row count.
 *
 * THE KEY is `coreProjectNum(awardNumber) ?? accountNumber`, reused verbatim
 * from `groupGrantsByProject` (lib/funding-projection.ts) — the key the funding
 * search index builds its `_id` from. Re-deriving it here is how these pages
 * would drift from `/search?type=funding` again.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { isPiRole } from "@/lib/funding-roles";
import {
  grantRoleRank,
  groupGrantsByProject,
  multiPiExternalIds,
  parseExternalId,
  sortPeople,
} from "@/lib/funding-projection";
import { loadEntitySuppressions } from "@/lib/api/manual-layer";
import { loadProjectSiblingRows } from "@/lib/api/project-siblings";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import type { DeptGrantCard } from "@/lib/api/dept-highlights";
import type { Prisma } from "@/lib/generated/prisma/client";

/** Grants-tab sort. Lives here because the grouping owns `sortKey`. */
export type GrantSort = "most_recent" | "end_date";

/**
 * The ONLY Prisma projection the unit grant grouping reads. Shared so the hero
 * stat and the tab list walk identical columns — a stat computed off a narrower
 * select is a second implementation waiting to disagree.
 */
export const UNIT_GRANT_SELECT = {
  cwid: true,
  title: true,
  role: true,
  funder: true,
  startDate: true,
  endDate: true,
  externalId: true,
  awardNumber: true,
  applId: true,
} satisfies Prisma.GrantSelect;

/** A row as returned under {@link UNIT_GRANT_SELECT}. `externalId` is NOT NULL
 *  in the schema; it is typed nullable here because the whole grouping path
 *  tolerates a null/unparsable id rather than dropping the row (see
 *  {@link groupUnitGrantsByProject}). */
export type UnitGrantRow = {
  cwid: string;
  title: string;
  role: string;
  funder: string;
  startDate: Date;
  endDate: Date;
  externalId: string | null;
  awardNumber: string | null;
  applId: number | null;
};

/** One funding project as a unit page renders (and counts) it. */
export type UnitGrantProject = {
  /** `coreProjectNum(awardNumber) ?? accountNumber`, or a `__solo__…` key for a
   *  row whose externalId does not parse. Deterministic tiebreak for the sort. */
  projectKey: string;
  title: string;
  funder: string;
  /** MIN across the group — a renewal chain's earliest start (union range, the
   *  same convention `projectFromRows` documents for a project group). */
  startDate: Date;
  /** MAX across the group. Every row is active (`endDate >= now`). */
  endDate: Date;
  /** The representative row's externalId. */
  externalId: string | null;
  /** EVERY externalId in the group. `isMultiPi` is keyed on the set, not the
   *  representative: `multiPiExternalIds` flags per-row ids, and a project that
   *  spans several Account_Numbers holds several of them. */
  externalIds: string[];
  awardNumber: string | null;
  applId: number | null;
  cwids: string[];
  /** LEAD-PI-FIRST, via the same `sortPeople` (lib/funding-projection.ts) that
   *  orders the chips on `/search?type=funding`. This is the chip list a card
   *  renders, and it needs an explicit order: before project grouping the key
   *  embedded the cwid, so a card held exactly ONE chip and row order could not
   *  show; now InfoEd's per-investigator start dates would otherwise print the
   *  most recently STARTED investigator first — an MPI above the contact PI, and
   *  the opposite of what search shows for the identical project. */
  piCwids: string[];
  /** #2074 — each investigator's own `Grant.role` on this project, so the chip
   *  tooltip can be truthful instead of assuming PI standing. HIGHEST-PRIORITY
   *  role per cwid: grouping by project can put one scholar on two rows (a
   *  renewal where they were Co-I on the parent and PI on the supplement), and
   *  first-wins would then demote them at random. */
  roleByCwid: Map<string, string>;
  sortKey: number;
};

/**
 * Group a unit's active grant rows into funding projects, newest first.
 *
 * 🔴 `groupGrantsByProject` SILENTLY DROPS any row whose externalId is null or
 * does not parse as `INFOED-{account}-{cwid}` — it `continue`s when
 * `parseExternalId` returns falsy. Those rows must still get a card, so they are
 * appended here as singleton groups under a `__solo__` key (the same key the
 * per-surface code used before this module existed). `__solo__` cannot collide
 * with a real project key, which is either a `coreProjectNum` or an InfoEd
 * Account_Number.
 *
 * In practice the residual set is empty on these surfaces: `Grant.externalId` is
 * `String @unique` (NOT NULL) in the schema, and the only non-`INFOED-` id the
 * ETL writes is `reporter:{cwid}:{core}` (etl/reporter-grants/transform.ts),
 * which every caller here already excludes via `source: { not: "RePORTER" }`.
 * The fallback is kept anyway: it costs one loop and its absence is a silently
 * vanishing card.
 */
export function groupUnitGrantsByProject(
  rows: readonly UnitGrantRow[],
  suppressedExternalIds: ReadonlySet<string>,
  sort: GrantSort,
): UnitGrantProject[] {
  const byKey = groupGrantsByProject(rows, suppressedExternalIds);

  for (const r of rows) {
    // Same suppression gate `groupGrantsByProject` applies, so a suppressed row
    // is not resurrected as a singleton.
    if (r.externalId !== null && suppressedExternalIds.has(r.externalId)) continue;
    if (parseExternalId(r.externalId) !== null) continue;
    // Key on the externalId when there IS one: two unparsable ids for the same
    // cwid that happen to share a startDate (`LEGACY-77-abc` / `LEGACY-88-abc`)
    // are two grants, and a cwid+date key collapses them into one card — the
    // silently-vanishing-card failure this fallback exists to prevent. The
    // cwid+date form survives only for a genuinely null id, where nothing else
    // distinguishes the row.
    const key = `__solo__${r.externalId ?? `${r.cwid}-${r.startDate.toISOString()}`}`;
    const arr = byKey.get(key) ?? [];
    arr.push(r);
    byKey.set(key, arr);
  }

  const projects: UnitGrantProject[] = [];
  for (const [key, groupRows] of byKey) projects.push(buildProject(key, groupRows, sort));

  // Deterministic: these reads are cached (lib/api/swr-cache), so a tie broken by
  // Map insertion order — itself decided by MySQL's unspecified order within one
  // `startDate` — would make the same page render two different ways.
  projects.sort(
    (a, b) => b.sortKey - a.sortKey || a.projectKey.localeCompare(b.projectKey),
  );
  return projects;
}

/** Fold one project's rows into a card. Every per-group field is resolved from a
 *  FIXED row order (startDate DESC, then externalId ASC) so the result does not
 *  depend on how the rows arrived. */
function buildProject(
  projectKey: string,
  rows: readonly UnitGrantRow[],
  sort: GrantSort,
): UnitGrantProject {
  const ordered = [...rows].sort(
    (a, b) =>
      b.startDate.getTime() - a.startDate.getTime() ||
      (a.externalId ?? "").localeCompare(b.externalId ?? ""),
  );
  const rep = ordered[0];

  let startDate = rep.startDate;
  let endDate = rep.endDate;
  let applId: number | null = null;
  const cwids: string[] = [];
  const piRows: string[] = [];
  const externalIds: string[] = [];
  const roleByCwid = new Map<string, string>();

  for (const r of ordered) {
    if (r.startDate < startDate) startDate = r.startDate;
    if (r.endDate > endDate) endDate = r.endDate;
    if (applId === null && r.applId !== null) applId = r.applId;
    if (!cwids.includes(r.cwid)) cwids.push(r.cwid);
    if (isPiRole(r.role) && !piRows.includes(r.cwid)) piRows.push(r.cwid);
    if (r.externalId !== null && !externalIds.includes(r.externalId)) {
      externalIds.push(r.externalId);
    }
    const held = roleByCwid.get(r.cwid);
    if (held === undefined || grantRoleRank(r.role) < grantRoleRank(held)) {
      roleByCwid.set(r.cwid, r.role);
    }
  }

  // Lead-PI-first, tiebroken on cwid — the SAME `sortPeople` that orders the
  // chips of this identical project on `/search?type=funding`
  // (`projectFromRows`, lib/funding-projection.ts). `ordered` is startDate DESC,
  // so without this the chips inherit ROW RECENCY: InfoEd writes a per-
  // investigator start date, so an MPI added in June prints ahead of the contact
  // PI who started in January. Sorting on `roleByCwid` (the per-cwid SENIOR role)
  // and not the representative row's is the same input `sortPeople` gets there —
  // it sorts `dedupedRows`, which kept each cwid's highest-priority role.
  const piCwids = sortPeople(
    piRows.map((cwid) => ({ cwid, role: roleByCwid.get(cwid) ?? "" })),
  ).map((p) => p.cwid);

  return {
    projectKey,
    title: rep.title,
    funder: rep.funder,
    startDate,
    endDate,
    externalId: rep.externalId,
    externalIds,
    awardNumber: rep.awardNumber,
    applId,
    cwids,
    piCwids,
    roleByCwid,
    // 🔴 SORT ON THE DATE THE CARD DISPLAYS. `startDate` is the group MIN and
    // `endDate` the group MAX, so keying `most_recent` on the group's MAX start
    // instead would order the list by a date no card shows: a 10-row renewal
    // chain that renders "2021–2027" would sort above a project that renders
    // "2026–2028" (measured on the local corpus: 15 such adjacent inversions in
    // Medicine alone, 30 across all departments — 42 of 1,654 active projects
    // have >1 distinct startDate). It would also re-split the /search
    // reunification this module exists for: the funding doc's `startDate` is the
    // EARLIEST start (`projectFromRows`, lib/funding-projection.ts) and
    // `searchFunding` sorts `{ startDate: "desc" }` on it, so the two surfaces
    // would order the identical project set differently.
    sortKey: sort === "end_date" ? endDate.getTime() : startDate.getTime(),
  };
}

/**
 * Load a unit's active grant rows and group them into projects — ONE query, one
 * suppression resolution, one grouping. Both hero stats take `.length` of this;
 * both Grants tabs paginate it. That shared call is what makes the stat and the
 * tab total the same number rather than two implementations that happen to agree.
 *
 * `where` is the caller's unit membership + activity filter (dept-code scoped,
 * or `cwid IN` for a division). Suppression (#160/#481(b)) is applied inside
 * `groupGrantsByProject`, so a hidden grant neither lists nor inflates a count.
 *
 * NO `orderBy`: row order cannot reach the output. `buildProject` re-sorts each
 * group's rows into a fixed order, and `groupUnitGrantsByProject` then applies a
 * TOTAL order over groups (`sortKey` DESC, `projectKey` ASC) with no possible
 * tie. Asking MySQL to sort as well only buys a filesort over the unit's whole
 * active-grant pool. Ordering is established in app code, on purpose — the
 * grouping key is derived (`coreProjectNum ?? accountNumber`), so it is not a
 * column the DB could have ordered by anyway.
 *
 * ponytail: the hero stats only need `.length` of this, but take the same
 * 9-column `UNIT_GRANT_SELECT` the tab list needs — ~1005 rows × 9 columns for
 * Medicine, where 2 key columns would do. That is deliberate: a stat computed
 * off a narrower query is a second implementation, and divergence is the exact
 * bug class #2066 exists to kill. Upgrade path if this ever shows up in page
 * timings: add a `countUnitGrantProjects(where)` here that pulls
 * `{ externalId, awardNumber, cwid, startDate }` and reuses
 * `groupUnitGrantsByProject` — same grouping, narrower row.
 */
export async function loadUnitGrantProjects(
  where: Prisma.GrantWhereInput,
  sort: GrantSort,
): Promise<UnitGrantProject[]> {
  const rows = (await prisma.grant.findMany({
    where,
    select: UNIT_GRANT_SELECT,
  })) as UnitGrantRow[];
  if (rows.length === 0) return [];
  const suppressed = await loadEntitySuppressions(
    "grant",
    rows.map((r) => r.externalId).filter((id): id is string => id !== null),
    prisma,
  );
  return groupUnitGrantsByProject(rows, suppressed, sort);
}

/**
 * Render one page of project groups as grant cards: the sibling-PD/PI lookup,
 * the scholar chip lookup, the `isMultiPi` fold, and the card map.
 *
 * WHY SHARED. `lib/api/dept-lists.ts` and `lib/api/divisions.ts` carried
 * line-for-line twins of this tail with three silent divergences, one of which
 * #2066 made dangerous. The chip fallback read `cwids.slice(0, 1)` on the dept
 * side and the bare `cwids` on the division side — IDENTICAL in effect while the
 * key was `externalId` (= `INFOED-{account}-{cwid}`, so every group held exactly
 * one cwid), but under project grouping a project with no PI/Co-PI row in the
 * unit now aggregates every Co-I across the renewal chain, and the division card
 * would have grown from 1 chip to N. `slice(0, 1)` for both preserves what both
 * surfaces render today. The division's scholar lookup also omitted
 * `deletedAt: null`, so a soft-deleted scholar could still draw a chip there; it
 * is filtered on both now.
 *
 * THE TWO SURFACES DO NOT DIFFER. An earlier round kept a `chipIsFirst` flag
 * (dept `true`, division `false`) for the "slate first-author chip variant" —
 * that difference does not exist. `DeptGrantCard.pis` has exactly ONE consumer,
 * `components/department/grant-card.tsx`, reached by both surfaces through the
 * same `DeptGrantsList`; it maps the chips, never reads `isFirst`, and hardcodes
 * `className="chip chip-first"`. The flag was unobservable BY CONSTRUCTION —
 * inverting it left all 67 tests across the four #2066 files green. `isFirst` is
 * therefore a constant `false`: `AuthorChip` requires the field (the publication
 * chip row reads it to draw the slate border and the "First author" tooltip),
 * but nothing on the GRANT card path ever reads it, and `false` is the honest
 * value — every chip here is an investigator, not a first author.
 *
 * 🔴 Pass the PAGE SLICE, never the whole group list. `loadProjectSiblingRows`
 * builds up to two OR arms per distinct account/serial and the serial arm is an
 * unanchored LIKE the index cannot serve; the full pool is every active grant in
 * the unit (~2k for a large department) ⇒ thousands of arms. `isMultiPi` is only
 * ever read for the cards a page RENDERS, so a slice of 20 caps it at ≤40.
 *
 * Passing each group's REPRESENTATIVE (externalId, awardNumber) still covers the
 * whole group even though a project can span several Account_Numbers: a group
 * spans >1 account only when its key is a `coreProjectNum`, which exists only
 * when the award number parses as NIH — so the representative always carries the
 * serial, and arm 2 (`awardNumber LIKE '%serial%'`) reaches every row of the core
 * project regardless of account. Single-account groups are covered by arm 1.
 * Measured on the dev corpus: 0 multi-account groups whose representative lacked
 * a serial, and a worst-case page of 39 arms.
 */
export async function buildUnitGrantCards(
  pageSlice: readonly UnitGrantProject[],
): Promise<DeptGrantCard[]> {
  // #2066/#2075 — a PD/PI in ANOTHER unit is absent from the page's own row pool
  // by construction (that pool is unit-scoped), measured at 35% of active
  // multi-PI awards. The corpus-wide sibling query closes it.
  const siblingRows = await loadProjectSiblingRows(pageSlice);

  const cwids = Array.from(new Set(pageSlice.flatMap((g) => g.cwids)));
  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const [scholars, siblingSuppressed] = await Promise.all([
    cwids.length > 0
      ? (prisma.scholar.findMany({
          where: { cwid: { in: cwids }, deletedAt: null },
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
        }) as Promise<Sl[]>)
      : Promise.resolve([] as Sl[]),
    // #160 on a SIBLING's row. The unit-scoped suppression load inside
    // `loadUnitGrantProjects` saw only this unit's rows, so it cannot speak for a
    // co-PD/PI outside it — without this, a colleague who hid their own grant row
    // would keep flipping the flag. Mirrors the same fold in lib/api/profile.ts.
    loadEntitySuppressions(
      "grant",
      siblingRows.map((r) => r.externalId).filter((id): id is string => id !== null),
      prisma,
    ),
  ]);
  const scholarMap = new Map(scholars.map((s) => [s.cwid, s]));
  const multiPi = multiPiExternalIds(siblingRows, siblingSuppressed);

  return pageSlice.map((g) => {
    const chipCwids = g.piCwids.length > 0 ? g.piCwids : g.cwids.slice(0, 1);
    const pis: AuthorChip[] = chipCwids
      .map((cwid) => {
        const s = scholarMap.get(cwid);
        if (!s) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          // Unread on this path — see the note on this function. The card
          // component hardcodes its own chip class.
          isFirst: false,
          isLast: false,
          roleCategory: s.roleCategory,
          // #2074 — `chipCwids` falls back to a NON-PI cwid when the project has
          // no PI row in this unit, so the chip cannot be assumed to be a PI.
          grantRole: g.roleByCwid.get(cwid) ?? null,
        } satisfies AuthorChip;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      externalId: g.externalId,
      awardNumber: g.awardNumber,
      funder: g.funder,
      title: g.title,
      startDate: g.startDate,
      endDate: g.endDate,
      isRecentlyCompleted: false,
      pis,
      // #2066 — MPI is a statement about the PROJECT, and a project group holds
      // several externalIds while `multiPiExternalIds` flags per-ROW ids.
      //
      // This equals `multiPi.has(g.externalId)` today, and NOT by coincidence:
      // arm 1 of `loadProjectSiblingRows` is built from the representative's own
      // account (project-siblings.ts), so the representative's row is in the
      // candidate set whenever any row of the group is — a divergent case is
      // unreachable. The group-level form is kept anyway because it is the honest
      // statement of the rule, so it survives a change to the sibling query
      // (e.g. dropping arm 1, or keying arms on something other than the
      // representative) instead of silently under-flagging.
      isMultiPi: g.externalIds.some((id) => multiPi.has(id)),
      // Only the ETL fills `Grant.applId` (usually null for InfoEd rows); both
      // tabs render through `DeptGrantsList`, which client-backfills it from
      // `awardNumber`, so carrying it on both surfaces resolves the same RePORTER
      // link one round trip earlier and changes nothing else.
      applId: g.applId,
    };
  });
}
