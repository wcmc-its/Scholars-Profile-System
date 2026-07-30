/**
 * #2066 / #2075 — the DEPARTMENT Grants tab (`lib/api/dept-lists.ts`): one card
 * per funding PROJECT, and `isMultiPi` on it.
 *
 * Three defects, in sequence:
 *
 *  - #2066 (flag): the flag was read off a grouping keyed on `externalId`
 *    (`INFOED-{account}-{cwid}`), which EMBEDS the cwid. Every group was a
 *    singleton and `piCwids.length >= 2` was structurally unsatisfiable.
 *  - #2075: #2073 fixed that by grouping the rows THIS PAGE fetched — but that
 *    pool is filtered to one department, so an award whose PD/PIs sit in
 *    different departments still could not fire. Measured at 35% of active
 *    multi-PI awards. The corpus-wide sibling query closes it.
 *  - #2066 (cards): the SAME embedded-cwid key also meant a multi-PI award
 *    rendered one card PER INVESTIGATOR and "N active grants" counted
 *    investigator-award ROWS. Cards and both hero stats now group by
 *    `coreProjectNum(awardNumber) ?? accountNumber` — the funding index's key —
 *    via the one shared `lib/api/unit-grant-projects.ts`.
 *
 * `lib/api/divisions.ts` is a near-verbatim copy of this loader — the same
 * duplication that let `search-index-docs.ts` and `data-quality.ts` disagree
 * about whether `Co-PI` is a PI role — so its twin block lives in
 * `api-div-roster-union.test.ts`. Covering only one of the pair is how the next
 * drift ships. The stat-vs-total parity assertion lives in
 * `unit-grant-projects.test.ts`.
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
  /** Nullable on purpose: `Grant.external_id` is NOT NULL in the schema, but the
   *  grouping path must not DROP a row it cannot key (see the singleton case). */
  externalId: string | null;
  awardNumber: string | null;
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

  // (2) SAME-department multi-PI. Both rows share one project, so #2066 collapses
  // them into ONE card — under the externalId key this was two.
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
  // `coreProjectNum` collapses them into a single card; counting distinct CWIDS
  // is what keeps that from reading as multi-PI.
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A600-renw0001", awardNumber: "1R01CA333333-01", dept: "NEURO" },
  { ...D, cwid: "renw0001", role: "PI",    externalId: "INFOED-A700-renw0001", awardNumber: "5R01CA333333-02", dept: "NEURO" },

  // (6) SUPPLEMENT where ONE scholar holds TWO DIFFERENT roles under one core
  // project — impossible while the key embedded the cwid, unavoidable now. The
  // chip must report the SENIOR role. `dept-lists.ts:258` carried a `ponytail:`
  // note saying first-wins would break here; this is that case.
  // The parent (older) row also carries the only applId, so first-non-null in
  // (startDate DESC, externalId ASC) order must reach past the representative.
  { ...D, cwid: "dual0001", role: "Co-I",  externalId: "INFOED-B100-dual0001", awardNumber: "1R01CA222222-01", dept: "NEURO" },
  { ...D, cwid: "dual0001", role: "PI",    externalId: "INFOED-B200-dual0001", awardNumber: "5R01CA222222-02", dept: "NEURO",
    startDate: new Date("2023-01-01"), applId: 987654 },

  // (7) Rows the PROJECT KEY CANNOT BE DERIVED FROM. `groupGrantsByProject`
  // silently `continue`s past these (`parseExternalId` returns null), so without
  // the singleton fallback in `groupUnitGrantsByProject` the card VANISHES.
  { ...D, cwid: "nullext1", role: "PI", externalId: null, awardNumber: null, title: "Null-id award", dept: "NEURO" },
  { ...D, cwid: "badext01", role: "PI", externalId: "LEGACY-77-badext01", awardNumber: null, title: "Legacy-id award", dept: "NEURO" },

  // (8) PADDING that pushes the department past ONE PAGE. Older `startDate`, so
  // the `most_recent` sort puts these last and the tail falls off page 0. Without
  // rows beyond PAGE_SIZE, `pageSlice` and the full group list are the same list
  // and the page-scoping of the sibling query is untestable — a mutation keying
  // it on the whole pool stayed GREEN until these existed.
  ...Array.from({ length: 18 }, (_, i) => ({
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
 * 27 NEURO project groups: 9 recent (A100, A400 — now ONE card for two rows —,
 * A200, A500, A900, the A600/A700 renewal, the B100/B200 supplement, and the two
 * unkeyable singletons) + 18 padding. PAGE_SIZE 20 takes the 9 recent plus
 * PAD00–PAD10, leaving these seven off the page. The scoping test also asserts
 * `hits.length === 20`, so a miscount here fails loudly rather than silently
 * weakening the check.
 */
const OFF_PAGE_ACCOUNTS = ["PAD11", "PAD12", "PAD13", "PAD14", "PAD15", "PAD16", "PAD17"];

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
        if (arm.externalId?.startsWith) {
          return (r.externalId ?? "").startsWith(arm.externalId.startsWith);
        }
        if (arm.awardNumber?.contains) {
          return (r.awardNumber ?? "").includes(arm.awardNumber.contains);
        }
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

/** Routes the two distinct `grant.findMany` calls the loader makes. */
function serveGrants(corpus: Row[] = CORPUS) {
  return (args?: { select?: Record<string, true>; where?: { AND?: unknown[] } }) => {
    // 2. sibling candidate query — the only one using `where.AND`.
    if (args?.where?.AND) return Promise.resolve(serveSiblings(corpus, args.where.AND));
    // 1. the department's own full pull (UNIT_GRANT_SELECT). #2066 collapsed the
    // former second `{ externalId, id }` projection into this one query.
    return Promise.resolve(ownRows(corpus));
  };
}

async function hitsOf(sort?: "most_recent" | "end_date") {
  return (await getDeptGrantsList(DEPT, { page: 0, sort })).hits;
}

async function flags() {
  const hits = await hitsOf();
  return Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi]));
}

/** Active whole-grant suppressions, set per test. */
let suppressedIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  suppressedIds = [];
  // INTERPRETS `entityId: { in: [...] }` rather than returning a fixed set. This
  // is load-bearing: the unit-scoped suppression load asks only about THIS
  // department's ids, so a mock that ignored the filter would hand it a
  // sibling's id it could never really contain — and the sibling-scoped
  // suppression load below would then be untestable. A mutation swapping the two
  // sets stayed GREEN until this mock was made query-aware.
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
    const hits = await hitsOf();
    // #2066 — ONE card now, not one per investigator. Before, `INFOED-A400-same0001`
    // and `INFOED-A400-same0002` were two separate flagged cards.
    const a400 = hits.filter((h) => (h.externalId ?? "").startsWith("INFOED-A400-"));
    expect(a400).toHaveLength(1);
    expect(a400[0].externalId).toBe("INFOED-A400-same0001");
    expect(a400[0].isMultiPi).toBe(true);
    // Both PD/PIs are still on the single card.
    expect(a400[0].pis.map((p) => p.cwid).sort()).toEqual(["same0001", "same0002"]);
  });

  it("does not flag a single-PI award", async () => {
    expect((await flags())["INFOED-A200-solo0001"]).toBe(false);
  });

  it("does not flag a cross-department PD/PI + Co-Investigator", async () => {
    expect((await flags())["INFOED-A500-coi00001"]).toBe(false);
  });

  it("collapses a renewal to ONE card and does not flag it (#2066)", async () => {
    const hits = await hitsOf();
    const renewal = hits.filter((h) => h.pis.some((p) => p.cwid === "renw0001"));
    expect(renewal).toHaveLength(1);
    // The representative is the row with the later startDate, ties broken by
    // externalId ASC — both start 2024-01-01, so A600 wins.
    expect(renewal[0].externalId).toBe("INFOED-A600-renw0001");
    expect(renewal[0].isMultiPi).toBe(false);
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
    const hits = await hitsOf();
    const byId = new Map(hits.map((h) => [h.externalId, h]));
    expect(byId.get("INFOED-A100-xdep0001")?.pis[0]?.grantRole).toBe("PI");
    const a400 = byId.get("INFOED-A400-same0001")!;
    expect(a400.pis.find((p) => p.cwid === "same0002")?.grantRole).toBe("Co-PI");
    // The fallback chip on an award with NO PI row in this department — the
    // #2074 case. It must report Co-I, so the tooltip cannot claim PI standing.
    expect(byId.get("INFOED-A900-conly001")?.pis[0]?.grantRole).toBe("Co-I");
  });

  it("resolves a cwid holding TWO roles on one project to the SENIOR role (#2066)", async () => {
    // `dual0001` is Co-I on the representative (2024) row and PI on the parent
    // (2023) row. First-wins — what the per-row key made safe and what
    // dept-lists.ts flagged as a `ponytail:` debt — would report Co-I and the
    // tooltip would deny them principal-investigator standing.
    const hits = await hitsOf();
    const dual = hits.filter((h) => h.pis.some((p) => p.cwid === "dual0001"));
    expect(dual).toHaveLength(1);
    expect(dual[0].pis[0].grantRole).toBe("PI");
    // applId: first NON-NULL in (startDate DESC, externalId ASC) order — the
    // representative's is null, so the fold must look past it.
    expect(dual[0].applId).toBe(987654);
    // Date range is the UNION across the group's rows, not the representative's.
    expect(dual[0].startDate).toEqual(new Date("2023-01-01"));
    expect(dual[0].endDate).toEqual(new Date("2029-12-31"));
  });

  it("keeps a card for a row whose externalId is null or unparsable (#2066)", async () => {
    // `groupGrantsByProject` `continue`s past both — it can derive no project key.
    // They must reappear as singleton groups, or the department silently loses a
    // grant from both the list and the total.
    const hits = await hitsOf();
    const nullId = hits.filter((h) => h.title === "Null-id award");
    const badId = hits.filter((h) => h.title === "Legacy-id award");
    expect(nullId).toHaveLength(1);
    expect(nullId[0].externalId).toBeNull();
    expect(nullId[0].isMultiPi).toBe(false);
    expect(badId).toHaveLength(1);
    expect(badId[0].externalId).toBe("LEGACY-77-badext01");
    // Distinct cards, not merged into one bucket of unkeyable rows.
    expect(nullId[0].pis[0].cwid).toBe("nullext1");
    expect(badId[0].pis[0].cwid).toBe("badext01");
  });

  it("drops a suppressed row without resurrecting it as a singleton (#160)", async () => {
    // The singleton fallback runs over the SAME rows `groupGrantsByProject` saw,
    // so it must re-apply the suppression gate; otherwise hiding a grant whose
    // externalId does not parse would put the card straight back.
    suppressedIds = ["LEGACY-77-badext01"];
    const hits = await hitsOf();
    expect(hits.filter((h) => h.title === "Legacy-id award")).toHaveLength(0);
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
    // unanchored LIKE the index cannot serve. Keyed on the whole pool — ~2k active
    // grants for a large department — this becomes thousands of arms. The natural
    // refactor is to hoist it back up beside the other derivations, so the bound
    // is asserted here.
    //
    // #2066 raises the stake: a project group now spans SEVERAL accounts, so the
    // bound holds only because the group's REPRESENTATIVE is passed (one account
    // + one serial per card). A group spans >1 account only when its key is a
    // `coreProjectNum`, which exists only for a parsing NIH award number — so the
    // representative always carries the serial that reaches the other accounts.
    await flags();
    const sib = mockGrantFindMany.mock.calls.map((c) => c[0]).find((a) => a?.where?.AND);
    const arms: Array<Record<string, { startsWith?: string }>> = sib.where.AND.find(
      (c: unknown) => c && typeof c === "object" && "OR" in c,
    ).OR;

    const prefixes = arms.map((a) => a.externalId?.startsWith).filter(Boolean).join(" ");
    for (const acct of OFF_PAGE_ACCOUNTS) {
      expect(prefixes, `off-page account ${acct} leaked into the sibling query`).not.toContain(acct);
    }
    expect(arms.length).toBeLessThanOrEqual(2 * 20);
    // The fixture must actually exceed one page, or pageSlice === the full list
    // and this test proves nothing.
    const { hits, total } = await getDeptGrantsList(DEPT, { page: 0 });
    expect(hits.length).toBe(20);
    expect(total).toBeGreaterThan(20);
  });

  it("orders the tab by END DATE when the sort says so, not by start date", async () => {
    // 🔴 The `sort` argument's WIRING, which nothing else exercised: the sort KEY
    // is covered in `unit-grant-projects.test.ts` by calling
    // `groupUnitGrantsByProject` directly, and that cannot see whether the loader
    // ever hands its own `sort` down. `getDeptGrantsListUncached` dropping the
    // argument and always passing `"most_recent"` to `loadUnitGrantProjects`
    // makes the page's "End date" selector silently do nothing, with the full
    // suite green.
    //
    // The fixture makes the two orders EXACT REVERSES, so a most_recent result
    // cannot coincidentally satisfy the end_date assertion.
    const BY_END: Row[] = [
      { ...D, cwid: "srt00001", role: "PI", externalId: "INFOED-S100-srt00001", awardNumber: "1R01CA010001-01",
        dept: "NEURO", startDate: new Date("2026-01-01"), endDate: new Date("2027-01-01") },
      { ...D, cwid: "srt00002", role: "PI", externalId: "INFOED-S200-srt00002", awardNumber: "1R01CA010002-01",
        dept: "NEURO", startDate: new Date("2025-01-01"), endDate: new Date("2028-01-01") },
      { ...D, cwid: "srt00003", role: "PI", externalId: "INFOED-S300-srt00003", awardNumber: "1R01CA010003-01",
        dept: "NEURO", startDate: new Date("2024-01-01"), endDate: new Date("2030-01-01") },
    ];
    mockGrantFindMany.mockImplementation(serveGrants(BY_END));

    const recent = await hitsOf();
    expect(recent.map((h) => h.externalId)).toEqual([
      "INFOED-S100-srt00001",
      "INFOED-S200-srt00002",
      "INFOED-S300-srt00003",
    ]);

    const byEnd = await hitsOf("end_date");
    expect(byEnd.map((h) => h.externalId)).toEqual([
      "INFOED-S300-srt00003",
      "INFOED-S200-srt00002",
      "INFOED-S100-srt00001",
    ]);
  });

  it("the NIH-serial arm reaches a PD/PI on the project's OTHER Account_Number", async () => {
    // The renewal's PARENT account carries a second PD/PI who is on neither the
    // representative's account nor in this department. Arm 1 of the sibling query
    // (`INFOED-<representative account>-%`) cannot reach them; only the NIH-serial
    // arm can. This is what makes a project spanning several Account_Numbers safe
    // to represent by one (externalId, awardNumber) pair.
    //
    // Note what this does NOT show, and cannot: a case where the card's
    // group-level `externalIds.some(id => multiPi.has(id))` differs from
    // `multiPi.has(g.externalId)`. No such case is reachable — arm 1 is built
    // from the representative's own account, so the representative's row is in
    // the candidate set whenever any row of the group is, and
    // `multiPiExternalIds` flags every externalId of a flagged project. The
    // group-level form is kept as the honest statement of the rule, not because
    // a fixture can separate the two.
    const withMpiOnParent: Row[] = [
      ...CORPUS,
      { ...D, cwid: "xren0002", role: "Co-PI", externalId: "INFOED-A700-xren0002", awardNumber: "5R01CA333333-02", dept: "MED" },
    ];
    mockGrantFindMany.mockImplementation(serveGrants(withMpiOnParent));
    const hits = await hitsOf();
    const renewal = hits.find((h) => h.externalId === "INFOED-A600-renw0001");
    expect(renewal?.isMultiPi).toBe(true);
  });
});
