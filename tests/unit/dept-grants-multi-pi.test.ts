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

  // (4b) A NEURO award whose ONLY investigator is a CO-I. The card still renders
  // (chipCwids falls back to a non-PI cwid), which is the #2074 shape: the chip
  // must report Co-I so the tooltip cannot call them the principal investigator.
  { ...D, cwid: "conly001", role: "Co-I",  externalId: "INFOED-A900-conly001", awardNumber: "1R01CA444444-01", dept: "NEURO" },

  // (5) RENEWAL — ONE scholar on two Account_Numbers under one core project.
  // `coreProjectNum` collapses them; counting distinct CWIDS is what keeps that
  // from reading as multi-PI.
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A600-renw0001", awardNumber: "1R01CA333333-01", dept: "NEURO" },
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A700-renw0001", awardNumber: "5R01CA333333-02", dept: "NEURO" },

  // (6) PADDING that pushes the department past ONE PAGE. Older `startDate`, so
  // the `most_recent` sort puts these last and the tail falls off page 0. Without
  // rows beyond PAGE_SIZE, `pageSlice` and `all` are the same list and the
  // page-scoping of the sibling query is untestable — a mutation keying it on
  // `all` stayed GREEN until these existed.
  ...Array.from({ length: 15 }, (_, i) => ({
    ...D,
    startDate: new Date("2020-01-01"),
    cwid: `pad${String(i).padStart(5, "0")}`,
    role: "PI",
    externalId: `INFOED-PAD${String(i).padStart(2, "0")}-pad${String(i).padStart(5, "0")}`,
    awardNumber: `1R01CA10${String(i).padStart(4, "0")}-01`,
    dept: "NEURO",
  })),
];

/**
 * Accounts whose cards do NOT fit on page 0.
 *
 * 23 NEURO groups: 8 non-padding (A400 yields TWO — one per investigator, since
 * cards are still keyed per row) + 15 padding. PAGE_SIZE 20 takes the 8 recent
 * ones plus PAD00–PAD11, leaving these three off the page. The scoping test also
 * asserts `hits.length === 20`, so a miscount here fails loudly rather than
 * silently weakening the check.
 */
const OFF_PAGE_ACCOUNTS = ["PAD12", "PAD13", "PAD14"];

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

/** Active whole-grant suppressions, set per test. */
let suppressedIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  suppressedIds = [];
  // INTERPRETS `entityId: { in: [...] }` rather than returning a fixed set. This
  // is load-bearing: `resolveActiveGrantSuppression` asks only about THIS
  // department's ids, so a mock that ignored the filter would hand the
  // department-scoped set a sibling's id it could never really contain — and the
  // sibling-scoped suppression load below would then be untestable. A mutation
  // swapping the two sets stayed GREEN until this mock was made query-aware.
  mockSuppressionFindMany.mockImplementation(
    (args?: { where?: { entityId?: { in?: string[] } } }) => {
      const asked = new Set(args?.where?.entityId?.in ?? []);
      return Promise.resolve(
        suppressedIds.filter((id) => asked.has(id)).map((entityId) => ({ entityId })),
      );
    },
  );
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
    suppressedIds = ["INFOED-A100-xdep0002"];
    expect((await flags())["INFOED-A100-xdep0001"]).toBe(false);
  });

  it("carries each investigator's own grantRole onto the chip (#2074)", async () => {
    // Without this the component fix is dark: grant-card.tsx routes the chip
    // tooltip through `grantRoleTitle(p.grantRole, ...)`, so a null role
    // degrades every chip to a bare "Investigator".
    const { hits } = await getDeptGrantsList(DEPT, { page: 0 });
    const byId = new Map(hits.map((h) => [h.externalId, h]));
    expect(byId.get("INFOED-A100-xdep0001")?.pis[0]?.grantRole).toBe("PI");
    expect(byId.get("INFOED-A400-same0002")?.pis[0]?.grantRole).toBe("Co-PI");
    // The fallback chip on an award with NO PI row in this department — the
    // #2074 case. It must report Co-I, so the tooltip cannot claim PI standing.
    expect(byId.get("INFOED-A900-conly001")?.pis[0]?.grantRole).toBe("Co-I");
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
  });

  it("scopes the sibling query to the RENDERED page, not the whole department pool", async () => {
    // Load-bearing, not a micro-optimization: `loadProjectSiblingRows` builds up
    // to two OR arms per distinct account/serial and the serial arm is an
    // unanchored LIKE the index cannot serve. Keyed on `all` — ~2k active grants
    // for a large department — this becomes thousands of arms. The natural
    // refactor is to hoist it back up beside the other derivations, so the bound
    // is asserted here.
    await flags();
    const sib = mockGrantFindMany.mock.calls.map((c) => c[0]).find((a) => a?.where?.AND);
    const arms: Array<Record<string, { startsWith?: string }>> = sib.where.AND.find(
      (c: unknown) => c && typeof c === "object" && "OR" in c,
    ).OR;

    // 24 NEURO groups, PAGE_SIZE 20 ⇒ the oldest 4 are off page 0 and must not be
    // asked about. This is what a whole-pool key would violate.
    const prefixes = arms.map((a) => a.externalId?.startsWith).filter(Boolean).join(" ");
    for (const acct of OFF_PAGE_ACCOUNTS) {
      expect(prefixes, `off-page account ${acct} leaked into the sibling query`).not.toContain(acct);
    }
    expect(arms.length).toBeLessThanOrEqual(2 * 20);
    // The fixture must actually exceed one page, or pageSlice === all and this
    // test proves nothing.
    const { hits } = await getDeptGrantsList(DEPT, { page: 0 });
    expect(hits.length).toBe(20);
    expect(ownRows().length).toBeGreaterThan(20);
  });
});
