/**
 * #2066 — `lib/api/unit-grant-projects.ts`: the ONE grouping of a unit's active
 * grant rows into funding PROJECTS, plus the property that made this module
 * necessary — the department / division HERO STAT and the Grants-tab TOTAL are
 * the same number BY CONSTRUCTION, not because two implementations agree today.
 *
 * Before this, four near-verbatim copies of one grouping block keyed on
 * `Grant.externalId` = `INFOED-{account}-{cwid}`, which EMBEDS the cwid: a
 * multi-PI award drew one card PER INVESTIGATOR and "N active grants" counted
 * investigator-award ROWS. Worse, the two Grants tabs had ALREADY drifted — the
 * department returned a group count, the division a row count — and were equal
 * only because that key made group count == row count.
 *
 * The behaviour-level wiring of each surface is covered in
 * `dept-grants-multi-pi.test.ts` and `api-div-roster-union.test.ts`. This file
 * covers the shared fold itself and the cross-surface parity, which neither of
 * those can see.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGrantFindMany,
  mockScholarFindMany,
  mockScholarFindUnique,
  mockScholarCount,
  mockSuppressionFindMany,
  mockSuppressionFindFirst,
  mockDepartmentFindUnique,
  mockAppointmentFindFirst,
  mockPublicationTopicGroupBy,
  mockPublicationTopicCount,
  mockTopicFindMany,
  mockDivisionFindMany,
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockPublicationAuthorFindMany,
  mockQueryRawUnsafe,
  mockFieldOverrideFindMany,
} = vi.hoisted(() => ({
  mockGrantFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarFindUnique: vi.fn(),
  mockScholarCount: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockSuppressionFindFirst: vi.fn(),
  mockDepartmentFindUnique: vi.fn(),
  mockAppointmentFindFirst: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationTopicCount: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockDivisionFindMany: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockQueryRawUnsafe: vi.fn(),
  mockFieldOverrideFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    grant: { findMany: mockGrantFindMany },
    scholar: {
      findMany: mockScholarFindMany,
      findUnique: mockScholarFindUnique,
      count: mockScholarCount,
    },
    suppression: {
      findMany: mockSuppressionFindMany,
      findFirst: mockSuppressionFindFirst,
    },
    department: { findUnique: mockDepartmentFindUnique },
    appointment: { findFirst: mockAppointmentFindFirst },
    publicationTopic: {
      groupBy: mockPublicationTopicGroupBy,
      count: mockPublicationTopicCount,
    },
    topic: { findMany: mockTopicFindMany },
    division: { findMany: mockDivisionFindMany, findFirst: mockDivisionFindFirst },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    fieldOverride: { findMany: mockFieldOverrideFindMany },
    $queryRawUnsafe: mockQueryRawUnsafe,
  },
}));

import {
  groupUnitGrantsByProject,
  type UnitGrantProject,
  type UnitGrantRow,
} from "@/lib/api/unit-grant-projects";
import { getDepartment } from "@/lib/api/departments";
import { getDeptGrantsList } from "@/lib/api/dept-lists";
import { getDivision, getDivisionGrantsList } from "@/lib/api/divisions";

const BASE = {
  title: "Project",
  funder: "NCI",
  startDate: new Date("2024-01-01"),
  endDate: new Date("2029-12-31"),
  applId: null as number | null,
};

function row(over: Partial<UnitGrantRow> & { cwid: string }): UnitGrantRow {
  return { role: "PI", externalId: null, awardNumber: null, ...BASE, ...over };
}

const NONE: ReadonlySet<string> = new Set();

describe("groupUnitGrantsByProject (#2066)", () => {
  it("collapses a renewal/supplement pair sharing one coreProjectNum into ONE group", () => {
    // Different Account_Numbers, different award-number SPELLINGS, one core
    // project. Under the old `externalId` key these were two cards.
    const groups = groupUnitGrantsByProject(
      [
        row({ cwid: "aaa", externalId: "INFOED-A600-aaa", awardNumber: "1R01CA333333-01" }),
        row({ cwid: "aaa", externalId: "INFOED-A700-aaa", awardNumber: "5 R01 CA333333-02" }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].projectKey).toBe("R01CA333333");
    expect(groups[0].externalIds).toEqual(["INFOED-A600-aaa", "INFOED-A700-aaa"]);
  });

  it("keeps a row whose externalId is null or unparsable as its OWN group", () => {
    // `groupGrantsByProject` `continue`s past both — no derivable project key.
    // Without the singleton fallback the card silently disappears.
    const groups = groupUnitGrantsByProject(
      [
        row({ cwid: "aaa", externalId: null }),
        row({ cwid: "bbb", externalId: "LEGACY-77-bbb" }),
        row({ cwid: "ccc", externalId: "INFOED-A100-ccc", awardNumber: "1R01CA111111-01" }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.projectKey.startsWith("__solo__"))).toHaveLength(2);
    // Two unkeyable rows are two cards, not one bucket.
    expect(new Set(groups.map((g) => g.projectKey)).size).toBe(3);
  });

  it("does not collapse two unparsable ids for ONE cwid sharing a startDate", () => {
    // 🔴 The `__solo__${cwid}-${startDate}` key gave these ONE bucket: one card
    // where the pre-#2066 externalId key gave two, and a hero stat short by one
    // — exactly the silently-vanishing card the fallback exists to prevent. The
    // pair above passes on a cwid key because its two rows use DIFFERENT cwids.
    const groups = groupUnitGrantsByProject(
      [
        row({ cwid: "abc", externalId: "LEGACY-77-abc" }),
        row({ cwid: "abc", externalId: "LEGACY-88-abc" }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.externalId).sort()).toEqual([
      "LEGACY-77-abc",
      "LEGACY-88-abc",
    ]);
    // A genuinely null id has nothing else to key on, so it keeps the cwid+date
    // form — and still does not merge with the ids above.
    const withNull = groupUnitGrantsByProject(
      [
        row({ cwid: "abc", externalId: "LEGACY-77-abc" }),
        row({ cwid: "abc", externalId: null }),
      ],
      NONE,
      "most_recent",
    );
    expect(withNull).toHaveLength(2);
  });

  it("does not resurrect a suppressed unkeyable row as a singleton (#160)", () => {
    const groups = groupUnitGrantsByProject(
      [row({ cwid: "bbb", externalId: "LEGACY-77-bbb" })],
      new Set(["LEGACY-77-bbb"]),
      "most_recent",
    );
    expect(groups).toHaveLength(0);
  });

  it("resolves the HIGHEST-PRIORITY role per cwid, not the first seen", () => {
    // The representative (later startDate) carries the JUNIOR role, so first-wins
    // reports Co-I and the chip tooltip denies principal-investigator standing.
    const groups = groupUnitGrantsByProject(
      [
        row({ cwid: "aaa", role: "Co-I", externalId: "INFOED-B100-aaa", awardNumber: "1R01CA222222-01" }),
        row({
          cwid: "aaa",
          role: "PI",
          externalId: "INFOED-B200-aaa",
          awardNumber: "5R01CA222222-02",
          startDate: new Date("2023-01-01"),
        }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].roleByCwid.get("aaa")).toBe("PI");
    expect(groups[0].piCwids).toEqual(["aaa"]);
    expect(groups[0].cwids).toEqual(["aaa"]);
  });

  it("orders the chip list LEAD-PI-FIRST, not by row recency", () => {
    // 🔴 A regression project grouping INTRODUCED: before it, the key embedded
    // the cwid, so a card held exactly one chip and no order existed. Now one
    // card holds several, and `buildProject` walks `ordered` = startDate DESC —
    // InfoEd writes a per-investigator start date, so the MPI who joined in June
    // would print ahead of the contact PI who started in January, while
    // `/search?type=funding` renders the IDENTICAL project lead-PI-first via
    // `sortPeople`.
    //
    // The fixture makes role order and startDate order CONFLICT: the senior row
    // (`bob`, PI) is the OLDER one. A row-order implementation yields
    // ["alice", "bob"] — and so does a cwid-only sort, so this pins the RANK.
    const groups = groupUnitGrantsByProject(
      [
        row({
          cwid: "bob",
          role: "PI",
          externalId: "INFOED-A100-bob",
          startDate: new Date("2024-01-01"),
        }),
        row({
          cwid: "alice",
          role: "Co-PI",
          externalId: "INFOED-A100-alice",
          startDate: new Date("2024-06-01"),
        }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups).toHaveLength(1);
    // The representative really IS the recent row, so `ordered` is startDate DESC
    // and the fixture is a test of something.
    expect(groups[0].externalId).toBe("INFOED-A100-alice");
    expect(groups[0].piCwids).toEqual(["bob", "alice"]);
  });

  it("tiebreaks EQUAL-rank chips on cwid, exactly as sortPeople does", () => {
    // Same rank ⇒ the order must not fall back to row recency either, or two
    // co-PD/PIs swap places on the unit page relative to /search.
    const groups = groupUnitGrantsByProject(
      [
        row({ cwid: "zed", role: "PI", externalId: "INFOED-A100-zed", startDate: new Date("2024-06-01") }),
        row({ cwid: "amy", role: "PI", externalId: "INFOED-A100-amy", startDate: new Date("2024-01-01") }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups[0].piCwids).toEqual(["amy", "zed"]);
  });

  it("takes MIN(startDate) / MAX(endDate) across the group and first non-null applId", () => {
    const groups = groupUnitGrantsByProject(
      [
        row({
          cwid: "aaa",
          externalId: "INFOED-B100-aaa",
          awardNumber: "1R01CA222222-01",
          endDate: new Date("2027-06-30"),
        }),
        row({
          cwid: "bbb",
          externalId: "INFOED-B200-bbb",
          awardNumber: "5R01CA222222-02",
          startDate: new Date("2021-07-01"),
          endDate: new Date("2030-06-30"),
          applId: 4242,
        }),
      ],
      NONE,
      "most_recent",
    );
    expect(groups[0].startDate).toEqual(new Date("2021-07-01"));
    expect(groups[0].endDate).toEqual(new Date("2030-06-30"));
    expect(groups[0].applId).toBe(4242);
    // Representative = later startDate, ties by externalId ASC.
    expect(groups[0].externalId).toBe("INFOED-B100-aaa");
  });

  it("orders groups by sortKey DESC with a deterministic key tiebreak", () => {
    // These reads are cached, so a tie broken by Map insertion order — itself
    // decided by MySQL's unspecified order within one startDate — would render
    // the same page two different ways.
    const rows = [
      row({ cwid: "a", externalId: "INFOED-A1-a", awardNumber: "1R01CA000002-01" }),
      row({ cwid: "b", externalId: "INFOED-A2-b", awardNumber: "1R01CA000001-01" }),
      row({
        cwid: "c",
        externalId: "INFOED-A3-c",
        awardNumber: "1R01CA000003-01",
        startDate: new Date("2025-01-01"),
      }),
    ];
    const forward = groupUnitGrantsByProject(rows, NONE, "most_recent");
    const reversed = groupUnitGrantsByProject([...rows].reverse(), NONE, "most_recent");
    expect(forward.map((g) => g.projectKey)).toEqual([
      "R01CA000003",
      "R01CA000001",
      "R01CA000002",
    ]);
    expect(reversed.map((g) => g.projectKey)).toEqual(forward.map((g) => g.projectKey));
  });

  it("picks the SAME representative regardless of ROW order within a group", () => {
    // 🔴 The group-order test above pins the order of the CARDS; this pins which
    // row inside one card gets to BE the card. `buildProject` orders a group's
    // rows startDate DESC then externalId ASC and takes `ordered[0]` — that row
    // supplies the title, the externalId and the awardNumber, hence the card's
    // heading and its RePORTER link.
    //
    // Deleting the `.localeCompare` tiebreak leaves the whole suite green: V8's
    // sort is stable, so `ordered[0]` silently falls back to INPUT order, and
    // every other fixture happens to list its intended representative first.
    // Input order here is MySQL's unspecified order within one startDate, and
    // these reads are cached (lib/api/swr-cache), so the same department page
    // would render two different titles across cache refreshes.
    //
    // Both rows share BASE's startDate, so startDate DESC decides nothing and
    // only the externalId tiebreak can.
    const rows = [
      row({
        cwid: "aaa", externalId: "INFOED-A600-aaa", awardNumber: "1R01CA333333-01",
        title: "PARENT TITLE",
      }),
      row({
        cwid: "bbb", externalId: "INFOED-A700-bbb", awardNumber: "5R01CA333333-02",
        title: "SUPPLEMENT TITLE",
      }),
    ];
    const rep = (g: UnitGrantProject) => ({
      title: g.title,
      externalId: g.externalId,
      awardNumber: g.awardNumber,
    });

    const forward = groupUnitGrantsByProject(rows, NONE, "most_recent");
    const reversed = groupUnitGrantsByProject([...rows].reverse(), NONE, "most_recent");
    // One project either way — otherwise the two lists are not comparable.
    expect(forward).toHaveLength(1);
    expect(reversed).toHaveLength(1);
    expect(rep(reversed[0])).toEqual(rep(forward[0]));
    // And it is the externalId-ASC row, not merely a stable one.
    expect(rep(forward[0])).toEqual({
      title: "PARENT TITLE",
      externalId: "INFOED-A600-aaa",
      awardNumber: "1R01CA333333-01",
    });
  });

  it("keys sortKey on endDate under the end_date sort", () => {
    const rows = [
      row({ cwid: "a", externalId: "INFOED-A1-a", awardNumber: "1R01CA000001-01", endDate: new Date("2026-01-01") }),
      row({ cwid: "b", externalId: "INFOED-A2-b", awardNumber: "1R01CA000002-01", endDate: new Date("2031-01-01") }),
    ];
    expect(
      groupUnitGrantsByProject(rows, NONE, "end_date").map((g) => g.projectKey),
    ).toEqual(["R01CA000002", "R01CA000001"]);
  });

  it("sorts BOTH ways on the date the card DISPLAYS, not a second extremum", () => {
    // 🔴 The regression this exists to catch. Single-row groups make the group's
    // MIN and MAX start the same date, so the two candidate sort keys are
    // indistinguishable — only a genuinely multi-row group separates them.
    //
    // The renewal chain's rows start 2021 and 2026 and end 2030 and 2027, so its
    // card renders "2021–2030" (MIN start, MAX end). The solo project renders
    // "2024–2029". Keying `most_recent` on the group's MAX start (2026) would
    // put the 2021– card ABOVE the 2024– one — the list ordered by a date no
    // card shows. It would also re-split the /search reunification: the funding
    // doc's `startDate` is the EARLIEST start (`projectFromRows`) and
    // `searchFunding` sorts `{ startDate: "desc" }` on it.
    //
    // 🔴 THE LATER-STARTING ROW ENDS EARLIER, on purpose. With the parent ending
    // before the supplement, the representative (latest start) also carried
    // MAX(endDate), so `sortKey: … rep.endDate.getTime()` satisfied the
    // assertions by the WRONG expression and survived the whole suite. Here the
    // representative's own end is 2027 while the group's is 2030, and the solo's
    // 2029 sits BETWEEN them — so a representative-keyed (or MIN-end-keyed)
    // sortKey flips the order as well as failing the key identity.
    const rows = [
      row({
        cwid: "r", externalId: "INFOED-A600-r", awardNumber: "1R01CA333333-01",
        startDate: new Date("2021-01-01"), endDate: new Date("2030-06-30"),
      }),
      row({
        cwid: "r", externalId: "INFOED-A700-r", awardNumber: "5R01CA333333-02",
        startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"),
      }),
      row({
        cwid: "s", externalId: "INFOED-A200-s", awardNumber: "1R01CA999999-01",
        startDate: new Date("2024-01-01"), endDate: new Date("2029-06-30"),
      }),
    ];

    const recent = groupUnitGrantsByProject(rows, NONE, "most_recent");
    const renewal = recent.find((g) => g.projectKey === "R01CA333333")!;
    // The fixture is only a test of anything if MIN != MAX on both ends, and if
    // the representative row carries NEITHER extremum of the end date.
    expect(renewal.startDate).toEqual(new Date("2021-01-01"));
    expect(renewal.endDate).toEqual(new Date("2030-06-30"));
    expect(renewal.externalId).toBe("INFOED-A700-r");
    expect(recent.map((g) => g.projectKey)).toEqual(["R01CA999999", "R01CA333333"]);
    expect(recent.map((g) => g.sortKey)).toEqual(recent.map((g) => g.startDate.getTime()));

    // The other direction, and a DIFFERENT order — so keying `end_date` on the
    // group's MIN end (2027) or the representative's own end (also 2027) fails
    // here instead of coinciding with the answer.
    const byEnd = groupUnitGrantsByProject(rows, NONE, "end_date");
    expect(byEnd.map((g) => g.projectKey)).toEqual(["R01CA333333", "R01CA999999"]);
    expect(byEnd.map((g) => g.sortKey)).toEqual(byEnd.map((g) => g.endDate.getTime()));
  });
});

/**
 * The parity fixture, shared by the department and division blocks below.
 *
 * 5 investigator-award ROWS folding to 3 PROJECTS: a two-PD/PI award (one
 * Account_Number, two investigators), a renewal pair (one investigator, two
 * Account_Numbers, one coreProjectNum), and one single-PI award. A row count
 * reports 5 and a project count reports 3, so the two are never accidentally
 * equal — which is what makes `stat === total` an assertion rather than a
 * tautology.
 */
const PARITY_ROWS = [
  { ...BASE, cwid: "mpi001", role: "PI",    externalId: "INFOED-A100-mpi001", awardNumber: "1R01CA245678-01" },
  { ...BASE, cwid: "mpi002", role: "Co-PI", externalId: "INFOED-A100-mpi002", awardNumber: "1R01CA245678-01" },
  { ...BASE, cwid: "ren001", role: "PI",    externalId: "INFOED-A600-ren001", awardNumber: "1R01CA333333-01" },
  { ...BASE, cwid: "ren001", role: "PI",    externalId: "INFOED-A700-ren001", awardNumber: "5R01CA333333-02" },
  { ...BASE, cwid: "sol001", role: "PI",    externalId: "INFOED-A200-sol001", awardNumber: "1R01CA999999-01" },
];
const PARITY_CWIDS = ["mpi001", "mpi002", "ren001", "sol001"];

/** Serves the two distinct `grant.findMany` shapes: a unit's own
 *  `UNIT_GRANT_SELECT` pull, and the sibling candidate query (`where.AND`). */
function serveParityGrants(args?: { where?: { AND?: unknown[] } }) {
  return Promise.resolve(
    args?.where?.AND
      ? PARITY_ROWS.map((r) => ({
          cwid: r.cwid,
          role: r.role,
          externalId: r.externalId,
          awardNumber: r.awardNumber,
        }))
      : PARITY_ROWS,
  );
}

const scholarChip = (cwid: string) => ({
  cwid,
  preferredName: cwid.toUpperCase(),
  slug: cwid,
  roleCategory: "faculty",
});

/**
 * The parity property. One fixture, two surfaces: the department hero stat
 * (`getDepartment().stats.activeGrants`) and the Grants tab total
 * (`getDeptGrantsList().total`). They call the SAME loader, so this can only
 * break if someone re-forks the grouping — which is exactly what happened
 * before.
 */
describe("hero stat and Grants-tab total agree by construction (#2066)", () => {
  const ROWS = PARITY_ROWS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGrantFindMany.mockImplementation(serveParityGrants);
    mockScholarFindMany.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
      Promise.resolve((args?.where?.cwid?.in ?? []).map(scholarChip)),
    );
    mockSuppressionFindMany.mockResolvedValue([]);
    mockSuppressionFindFirst.mockResolvedValue(null);
    mockFieldOverrideFindMany.mockResolvedValue([]);
    mockDepartmentFindUnique.mockResolvedValue({
      code: "NEURO",
      name: "Neurology",
      officialName: "Department of Neurology",
      compactName: "Neurology",
      slug: "neurology",
      description: null,
      url: null,
      chairCwid: null,
    });
    mockScholarFindUnique.mockResolvedValue(null);
    mockAppointmentFindFirst.mockResolvedValue(null);
    mockPublicationTopicGroupBy.mockResolvedValue([]);
    mockPublicationTopicCount.mockResolvedValue(0);
    mockTopicFindMany.mockResolvedValue([]);
    mockDivisionFindMany.mockResolvedValue([]);
    mockScholarCount.mockResolvedValue(10);
  });

  it("reports the PROJECT count on both surfaces, not the row count", async () => {
    const dept = await getDepartment("neurology");
    const tab = await getDeptGrantsList("NEURO", { page: 0 });

    expect(ROWS).toHaveLength(5);
    expect(dept!.stats.activeGrants).toBe(3);
    expect(tab.total).toBe(3);
    expect(tab.hits).toHaveLength(3);
    // The invariant #2066 turns on: the dept hero stat IS the Grants-tab total.
    expect(dept!.stats.activeGrants).toBe(tab.total);
  });

  it("stays equal when a grant is suppressed (#160) — both drop it", async () => {
    // The suppression gate lives inside the shared loader, so a hide cannot
    // reach one surface and miss the other. Hiding the CONTACT PI's row leaves
    // the project standing via its second row; hiding the lone single-PI row
    // removes a whole project from both numbers.
    mockSuppressionFindMany.mockImplementation(
      (args?: { where?: { entityId?: { in?: string[] } } }) => {
        const asked = new Set(args?.where?.entityId?.in ?? []);
        return Promise.resolve(
          ["INFOED-A200-sol001"]
            .filter((id) => asked.has(id))
            .map((entityId) => ({ entityId })),
        );
      },
    );
    const dept = await getDepartment("neurology");
    const tab = await getDeptGrantsList("NEURO", { page: 0 });
    expect(dept!.stats.activeGrants).toBe(2);
    expect(dept!.stats.activeGrants).toBe(tab.total);
  });
});

/**
 * 🔴 The DIVISION half of the same property, and it was the hole.
 *
 * Nothing asserted `getDivision(...).stats.activeGrants` against a NON-EMPTY
 * grant fixture: `api-div-unit-curation.test.ts` stubs `grant.findMany` to `[]`
 * and reads only `stats.scholars`, and `api-div-roster-union.test.ts` never
 * touches `stats` at all. Mutating `divisions.ts` to count investigator-award
 * ROWS instead of projects — precisely the behaviour #2066 exists to remove —
 * left the FULL suite green at 634 files / 8327 tests.
 *
 * Same fixture as the department block above, on purpose: `divisions.ts` was a
 * near-verbatim COPY of `dept-lists.ts` and the two had already drifted (the
 * department tab returned a group count, this one a ROW count), so a shared
 * assertion set is what keeps the copy honest.
 */
describe("division hero stat and Grants-tab total agree by construction (#2066)", () => {
  const DIVISION = {
    code: "CARDIO",
    deptCode: "MED",
    name: "Cardiology",
    slug: "cardiology",
    description: null,
    url: null,
    chiefCwid: null,
    source: "ED",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGrantFindMany.mockImplementation(serveParityGrants);
    // Two shapes: `where.divCode` is the division roster lookup
    // (`loadDivisionMemberCwids`); `where.cwid.in` is the card chip lookup.
    mockScholarFindMany.mockImplementation(
      (args?: { where?: { divCode?: string; cwid?: { in?: string[] } } }) =>
        Promise.resolve(
          args?.where?.divCode
            ? PARITY_CWIDS.map((cwid) => ({ cwid }))
            : (args?.where?.cwid?.in ?? []).map(scholarChip),
        ),
    );
    mockDepartmentFindUnique.mockResolvedValue({
      code: "MED",
      name: "Medicine",
      slug: "medicine",
    });
    mockDivisionFindFirst.mockResolvedValue(DIVISION);
    mockDivisionFindMany.mockResolvedValue([]);
    mockDivisionMembershipFindMany.mockResolvedValue([]);
    mockSuppressionFindMany.mockResolvedValue([]);
    mockSuppressionFindFirst.mockResolvedValue(null);
    mockFieldOverrideFindMany.mockResolvedValue([]);
    mockScholarFindUnique.mockResolvedValue(null);
    mockAppointmentFindFirst.mockResolvedValue(null);
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockQueryRawUnsafe.mockResolvedValue([]);
    mockTopicFindMany.mockResolvedValue([]);
  });

  it("reports the PROJECT count on both division surfaces, not the row count", async () => {
    const div = await getDivision("medicine", "cardiology");
    const tab = await getDivisionGrantsList("CARDIO", { page: 0 });

    // 5 investigator-award rows, 3 funding projects. A row count says 5, and the
    // mutation that survived the suite — `projects.reduce((n, p) => n +
    // Math.max(1, p.externalIds.length), 0)` — says 4. Only a project count
    // satisfies all three assertions.
    expect(PARITY_ROWS).toHaveLength(5);
    expect(div!.stats.activeGrants).toBe(3);
    expect(tab.total).toBe(3);
    expect(tab.hits).toHaveLength(3);
    // The invariant: the division hero stat IS the division Grants-tab total.
    expect(div!.stats.activeGrants).toBe(tab.total);
    // And the multi-investigator project really is one card carrying both PD/PIs
    // — otherwise "3" could be reached by a grouping that lost a row.
    const mpi = tab.hits.find((h) => h.externalId === "INFOED-A100-mpi001")!;
    expect(mpi.pis.map((p) => p.cwid).sort()).toEqual(["mpi001", "mpi002"]);
  });

  it("stays equal when a grant is suppressed (#160) — both division numbers drop it", async () => {
    mockSuppressionFindMany.mockImplementation(
      (args?: { where?: { entityId?: { in?: string[] } } }) => {
        const asked = new Set(args?.where?.entityId?.in ?? []);
        return Promise.resolve(
          ["INFOED-A200-sol001"]
            .filter((id) => asked.has(id))
            .map((entityId) => ({ entityId })),
        );
      },
    );
    const div = await getDivision("medicine", "cardiology");
    const tab = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(div!.stats.activeGrants).toBe(2);
    expect(div!.stats.activeGrants).toBe(tab.total);
  });

  it("gives a project with no PI row in the division exactly ONE chip", async () => {
    // The divergence #2066 made dangerous. The chip fallback read the bare
    // `cwids` here and `cwids.slice(0, 1)` on the department side — identical
    // while the key embedded the cwid (one cwid per group), but a project with
    // no PI/Co-PI row in the unit now aggregates every Co-I across the renewal
    // chain, so the division card would have grown from 1 chip to 3.
    const COI_ONLY = [
      { ...BASE, cwid: "coi001", role: "Co-I", externalId: "INFOED-C100-coi001", awardNumber: "1R01CA555555-01" },
      { ...BASE, cwid: "coi002", role: "Co-I", externalId: "INFOED-C200-coi002", awardNumber: "5R01CA555555-02" },
      { ...BASE, cwid: "coi003", role: "Co-I", externalId: "INFOED-C300-coi003", awardNumber: "5R01CA555555-03" },
    ];
    mockGrantFindMany.mockImplementation((args?: { where?: { AND?: unknown[] } }) =>
      Promise.resolve(
        args?.where?.AND
          ? COI_ONLY.map((r) => ({
              cwid: r.cwid,
              role: r.role,
              externalId: r.externalId,
              awardNumber: r.awardNumber,
            }))
          : COI_ONLY,
      ),
    );
    mockScholarFindMany.mockImplementation(
      (args?: { where?: { divCode?: string; cwid?: { in?: string[] } } }) =>
        Promise.resolve(
          args?.where?.divCode
            ? COI_ONLY.map((r) => ({ cwid: r.cwid }))
            : (args?.where?.cwid?.in ?? []).map(scholarChip),
        ),
    );

    const tab = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(tab.total).toBe(1);
    expect(tab.hits[0].pis).toHaveLength(1);
    expect(tab.hits[0].pis[0].cwid).toBe("coi001");
    // #2074 — and the tooltip must not call the fallback chip a PI.
    expect(tab.hits[0].pis[0].grantRole).toBe("Co-I");
  });

  it("renders the CARD's chips lead-PI-first, not by row recency", async () => {
    // The unit-level ordering above, asserted where it is actually SEEN: on
    // `DeptGrantCard.pis`, which `buildUnitGrantCards` maps straight off
    // `piCwids`. The contact PI's row starts EARLIER than the MPI's, so a
    // row-recency chip list puts "MPI002 (MPI)" ahead of "MPI001".
    const CONFLICT = [
      { ...BASE, cwid: "mpi001", role: "PI", externalId: "INFOED-A100-mpi001",
        awardNumber: "1R01CA245678-01", startDate: new Date("2024-01-01") },
      { ...BASE, cwid: "mpi002", role: "Co-PI", externalId: "INFOED-A100-mpi002",
        awardNumber: "1R01CA245678-01", startDate: new Date("2024-06-01") },
    ];
    mockGrantFindMany.mockImplementation((args?: { where?: { AND?: unknown[] } }) =>
      Promise.resolve(
        args?.where?.AND
          ? CONFLICT.map((r) => ({
              cwid: r.cwid,
              role: r.role,
              externalId: r.externalId,
              awardNumber: r.awardNumber,
            }))
          : CONFLICT,
      ),
    );

    const tab = await getDivisionGrantsList("CARDIO", { page: 0 });
    expect(tab.hits).toHaveLength(1);
    expect(tab.hits[0].pis.map((p) => p.cwid)).toEqual(["mpi001", "mpi002"]);
    expect(tab.hits[0].isMultiPi).toBe(true);
  });

  it("does not give a soft-deleted scholar a chip", async () => {
    // The division's scholar lookup omitted `deletedAt: null` where the
    // department's had it. Asserted through the QUERY, since the loader can only
    // honour the filter the DB is asked for.
    await getDivisionGrantsList("CARDIO", { page: 0 });
    const chipCall = mockScholarFindMany.mock.calls
      .map((c) => c[0])
      .find((a) => a?.where?.cwid?.in);
    expect(chipCall, "no chip lookup was issued").toBeDefined();
    expect(chipCall.where.deletedAt).toBeNull();
  });
});
