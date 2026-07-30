/**
 * #2066 / #2075 — `isMultiPi` on a DEPARTMENT grant card (`lib/api/dept-lists.ts`).
 *
 * Two defects, in sequence:
 *
 *  - #2066: the flag was read off a grouping keyed on `externalId`
 *    (`INFOED-{account}-{cwid}`), which EMBEDS the cwid. Every group was a
 *    singleton and `piCwids.length >= 2` was structurally unsatisfiable.
 *  - #2075: #2073 fixed that by grouping the rows THIS PAGE fetched — but that
 *    pool is filtered to one department, so an award whose PD/PIs sit in
 *    different departments still could not fire. Measured at 35% of active
 *    multi-PI awards. The corpus-wide sibling query closes it.
 *
 * `lib/api/divisions.ts` is a near-verbatim copy of this loader — the same
 * duplication that let `search-index-docs.ts` and `data-quality.ts` disagree
 * about whether `Co-PI` is a PI role — so its twin block lives in
 * `api-div-roster-union.test.ts`. Covering only one of the pair is how the next
 * drift ships.
 *
 * The Prisma mock below INTERPRETS the sibling query's `OR` arms
 * (`externalId.startsWith` / `awardNumber.contains`) against a small
 * institution-wide corpus, rather than returning a fixed row set. A mock that
 * ignored the arms could not tell a correct candidate query from one that never
 * fetches the cross-department PD/PI at all — which is the entire point here.
 *
 * NOT re-tested here: `loadProjectSiblingRows`'s `GRANT_INDEX_WHERE` visibility
 * gate (a soft-deleted / `status='suppressed'` sibling must not flip the flag).
 * That loader is shared and its gate is covered in `profile-multi-pi.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGrantFindMany, mockScholarFindMany, mockSuppressionFindMany } =
  vi.hoisted(() => ({
    mockGrantFindMany: vi.fn(),
    mockScholarFindMany: vi.fn(),
    mockSuppressionFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    grant: { findMany: mockGrantFindMany },
    scholar: { findMany: mockScholarFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

import { getDeptGrantsList } from "@/lib/api/dept-lists";

type Row = {
  cwid: string;
  role: string;
  externalId: string;
  awardNumber: string;
  title: string;
  funder: string;
  startDate: Date;
  endDate: Date;
  applId: number | null;
  /** Which department the owning scholar sits in — decides whether the row is in
   *  the page's OWN pool or only reachable via the sibling query. */
  dept: string;
};

const D = {
  title: "Project",
  funder: "NCI",
  startDate: new Date("2024-01-01"),
  endDate: new Date("2029-12-31"),
  applId: null,
};

/** Institution-wide corpus. Only `dept: "NEURO"` rows reach the NEURO page's own
 *  `all` pull; the rest exist solely to be found by the sibling query. */
const CORPUS: Row[] = [
  // (1) CROSS-DEPARTMENT multi-PI — the #2075 case. InfoEd flags only the
  // contact PI, so the second PD/PI arrives as `Co-PI` (an NIH multiple-PI).
  { ...D, cwid: "xdep0001", role: "PI",    externalId: "INFOED-A100-xdep0001", awardNumber: "1R01CA245678-01", dept: "NEURO" },
  { ...D, cwid: "xdep0002", role: "Co-PI", externalId: "INFOED-A100-xdep0002", awardNumber: "1R01CA245678-01", dept: "MED" },

  // (2) SAME-department multi-PI — already fired under #2073; regression guard.
  { ...D, cwid: "same0001", role: "PI",    externalId: "INFOED-A400-same0001", awardNumber: "1R01CA777777-01", dept: "NEURO" },
  { ...D, cwid: "same0002", role: "Co-PI", externalId: "INFOED-A400-same0002", awardNumber: "1R01CA777777-01", dept: "NEURO" },

  // (3) Genuinely single-PI — negative control.
  { ...D, cwid: "solo0001", role: "PI",    externalId: "INFOED-A200-solo0001", awardNumber: "1R01CA999999-01", dept: "NEURO" },

  // (4) A cross-department CO-INVESTIGATOR, not a PD/PI — must NOT flip.
  { ...D, cwid: "coi00001", role: "PI",    externalId: "INFOED-A500-coi00001", awardNumber: "1R01CA555555-01", dept: "NEURO" },
  { ...D, cwid: "coi00002", role: "Co-I",  externalId: "INFOED-A500-coi00002", awardNumber: "1R01CA555555-01", dept: "MED" },

  // (5) RENEWAL — ONE scholar on two Account_Numbers under one core project.
  // `coreProjectNum` collapses them; counting distinct CWIDS is what keeps that
  // from reading as multi-PI.
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A600-renw0001", awardNumber: "1R01CA333333-01", dept: "NEURO" },
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A700-renw0001", awardNumber: "5R01CA333333-02", dept: "NEURO" },
];

const DEPT = "NEURO";
const ownRows = (c: Row[] = CORPUS) => c.filter((r) => r.dept === DEPT);

/** Interpret the sibling query's OR arms against the corpus, exactly as MySQL
 *  would: `externalId LIKE 'INFOED-<acct>-%'` OR `awardNumber LIKE '%<serial>%'`. */
function serveSiblings(corpus: Row[], and: unknown[]) {
  const or =
    (
      and.find((c) => c && typeof c === "object" && "OR" in c) as
        | { OR: Array<Record<string, { startsWith?: string; contains?: string }>> }
        | undefined
    )?.OR ?? [];
  return corpus
    .filter((r) =>
      or.some((arm) => {
        if (arm.externalId?.startsWith) return r.externalId.startsWith(arm.externalId.startsWith);
        if (arm.awardNumber?.contains) return r.awardNumber.includes(arm.awardNumber.contains);
        return false;
      }),
    )
    .map((r) => ({
      cwid: r.cwid,
      role: r.role,
      externalId: r.externalId,
      awardNumber: r.awardNumber,
    }));
}

/** Routes the three distinct `grant.findMany` calls the loader makes. */
function serveGrants(corpus: Row[] = CORPUS) {
  return (args?: { select?: Record<string, true>; where?: { AND?: unknown[] } }) => {
    // 3. sibling candidate query — the only one using `where.AND`.
    if (args?.where?.AND) return Promise.resolve(serveSiblings(corpus, args.where.AND));
    // 1. the department's own full pull.
    if (args?.select?.title) return Promise.resolve(ownRows(corpus));
    // 2. the suppression/count projection.
    return Promise.resolve(
      ownRows(corpus).map((r) => ({ externalId: r.externalId, id: r.externalId })),
    );
  };
}

async function flags() {
  const { hits } = await getDeptGrantsList(DEPT, { page: 0 });
  return Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuppressionFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockImplementation(serveGrants());
  mockScholarFindMany.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
    Promise.resolve(
      (args?.where?.cwid?.in ?? []).map((cwid) => ({
        cwid,
        preferredName: cwid.toUpperCase(),
        slug: cwid,
        roleCategory: "faculty",
      })),
    ),
  );
});

describe("getDeptGrantsList — isMultiPi (#2066, #2075)", () => {
  it("flags an award whose second PD/PI is in ANOTHER department (#2075)", async () => {
    // The whole point: `xdep0002` sits in MED, so this department's own pool holds
    // exactly one PD/PI row for account A100. Under #2073 this read false.
    expect((await flags())["INFOED-A100-xdep0001"]).toBe(true);
  });

  it("still flags a same-department multi-PI award (#2073 regression guard)", async () => {
    const f = await flags();
    expect(f["INFOED-A400-same0001"]).toBe(true);
    expect(f["INFOED-A400-same0002"]).toBe(true);
  });

  it("does not flag a single-PI award", async () => {
    expect((await flags())["INFOED-A200-solo0001"]).toBe(false);
  });

  it("does not flag a cross-department PD/PI + Co-Investigator", async () => {
    expect((await flags())["INFOED-A500-coi00001"]).toBe(false);
  });

  it("does not flag a renewal — one scholar, two Account_Numbers, one core project", async () => {
    const f = await flags();
    expect(f["INFOED-A600-renw0001"]).toBe(false);
    expect(f["INFOED-A700-renw0001"]).toBe(false);
  });

  it("does not flag when the cross-department PD/PI's own row is suppressed (#160)", async () => {
    // The trap this guards: the upstream `suppressed` set is resolved over THIS
    // department's rows only, so it can never contain a row belonging to a
    // scholar in another department. Without the sibling-scoped suppression load,
    // a colleague who hid their own grant row would keep flipping this flag.
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "INFOED-A100-xdep0002" }]);
    expect((await flags())["INFOED-A100-xdep0001"]).toBe(false);
  });

  it("asks for the sibling rows by account prefix AND NIH serial", async () => {
    await flags();
    const sib = mockGrantFindMany.mock.calls
      .map((c) => c[0])
      .find((a) => a?.where?.AND);
    expect(sib, "no sibling candidate query was issued").toBeDefined();
    const arms = sib.where.AND.find(
      (c: unknown) => c && typeof c === "object" && "OR" in c,
    ).OR;
    expect(arms).toEqual(
      expect.arrayContaining([
        { externalId: { startsWith: "INFOED-A100-" } },
        { awardNumber: { contains: "245678" } },
      ]),
    );
    // Scoped to the RENDERED page, not the whole department pool. The serial arm
    // is an unanchored LIKE the index cannot serve, so arm count must track the
    // 20-card slice — never the ~2k active grants of a large department.
    expect(arms.length).toBeLessThanOrEqual(2 * ownRows().length);
  });
});
