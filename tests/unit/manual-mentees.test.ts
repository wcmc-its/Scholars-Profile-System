/**
 * #2011 — manually-added mentees (mentees no source system recorded).
 *
 * Two suites:
 *   1. `validateManualMentees` — the pure write-path shape check.
 *   2. `getMenteesForMentor` — the read-path union, which is where the real
 *      risks live: the early return that used to bail before manual rows were
 *      considered, the per-CWID collapse that must MERGE a manual entry into a
 *      sourced one rather than duplicate it, and the co-pub query whose
 *      `IN (...)` clause is malformed SQL when every mentee is CWID-less.
 *
 * Prisma + ReciterDB are mocked (mirrors mentoring-copub-source.test.ts).
 * Synthetic names only — this repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

const {
  phdFindMany,
  postdocFindMany,
  studentPhdProgramFindMany,
  scholarFindMany,
  menteeCopubFindMany,
  menteeCopubFindFirst,
  aocMenteeFindMany,
  aocMenteeFindFirst,
  menteeCopubPubFindMany,
  suppressionFindMany,
  publicationAuthorFindMany,
  publicationFindMany,
  scholarFindUnique,
  phdFindFirst,
  postdocFindFirst,
  fieldOverrideFindUnique,
} = vi.hoisted(() => ({
  phdFindMany: vi.fn(async () => [] as unknown[]),
  postdocFindMany: vi.fn(async () => [] as unknown[]),
  studentPhdProgramFindMany: vi.fn(async () => [] as unknown[]),
  scholarFindMany: vi.fn(async () => [] as unknown[]),
  menteeCopubFindMany: vi.fn(async () => [] as unknown[]),
  menteeCopubFindFirst: vi.fn(async () => null as unknown),
  aocMenteeFindMany: vi.fn(async () => [] as unknown[]),
  aocMenteeFindFirst: vi.fn(async () => null as unknown),
  menteeCopubPubFindMany: vi.fn(async () => [] as unknown[]),
  suppressionFindMany: vi.fn(async () => [] as unknown[]),
  publicationAuthorFindMany: vi.fn(async () => [] as unknown[]),
  publicationFindMany: vi.fn(async () => [] as unknown[]),
  scholarFindUnique: vi.fn(async () => null as unknown),
  phdFindFirst: vi.fn(async () => null as unknown),
  postdocFindFirst: vi.fn(async () => null as unknown),
  fieldOverrideFindUnique: vi.fn(async () => null as unknown),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany, findFirst: phdFindFirst },
    postdocMentorRelationship: { findMany: postdocFindMany, findFirst: postdocFindFirst },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany, findUnique: scholarFindUnique },
    menteeCopublication: { findMany: menteeCopubFindMany, findFirst: menteeCopubFindFirst },
    aocMentee: { findMany: aocMenteeFindMany, findFirst: aocMenteeFindFirst },
    menteeCopublicationPub: { findMany: menteeCopubPubFindMany },
    suppression: { findMany: suppressionFindMany },
    publicationAuthor: { findMany: publicationAuthorFindMany },
    publication: { findMany: publicationFindMany },
    fieldOverride: { findUnique: fieldOverrideFindUnique },
  },
}));

import {
  getAllMentorCoPublications,
  getCoPublications,
  getMentorMenteePair,
  getMenteesForMentor,
} from "@/lib/api/mentoring";
import { MAX_MANUAL_MENTEES, validateManualMentees } from "@/lib/edit/manual-mentee";

const MENTOR = "abc1001";

/** Stub the stored `manualMentees` field-override with the given entries. */
function storeManual(entries: unknown[]): void {
  fieldOverrideFindUnique.mockResolvedValue({ value: JSON.stringify(entries) } as never);
}

describe("validateManualMentees", () => {
  it("accepts a name-only entry — the CWID-less case this feature exists for", () => {
    const r = validateManualMentees([{ name: "Rowan Ellis" }]);
    expect(r).toEqual({ ok: true, value: [{ name: "Rowan Ellis" }] });
  });

  it("accepts and lowercases a well-formed cwid", () => {
    const r = validateManualMentees([{ name: "Rowan Ellis", cwid: "REL2002" }]);
    expect(r.ok && r.value[0].cwid).toBe("rel2002");
  });

  it("rejects a malformed cwid rather than storing an unresolvable id", () => {
    // Leading digit — `CWID_PATTERN` requires a letter first.
    expect(validateManualMentees([{ name: "R", cwid: "9zz" }])).toEqual({
      ok: false,
      error: "invalid_cwid",
    });
  });

  it("treats a blank cwid as absent, not as invalid", () => {
    // An empty optional input is a no-op, not a mistake — the form ships the
    // field whether or not the mentor filled it in.
    const r = validateManualMentees([{ name: "Rowan Ellis", cwid: "  " }]);
    expect(r).toEqual({ ok: true, value: [{ name: "Rowan Ellis" }] });
  });

  it("does NOT check that the cwid exists — alumni have one with no Scholar row", () => {
    // No DB client is passed at all; this is the structural guarantee.
    expect(validateManualMentees.length).toBe(1);
    expect(validateManualMentees([{ name: "A", cwid: "zzz9999" }]).ok).toBe(true);
  });

  it("rejects a blank or whitespace-only name", () => {
    expect(validateManualMentees([{ name: "   " }])).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });

  it("rejects duplicate cwids but allows duplicate names", () => {
    expect(
      validateManualMentees([
        { name: "A", cwid: "aaa1" },
        { name: "B", cwid: "aaa1" },
      ]),
    ).toEqual({ ok: false, error: "duplicate" });
    // Two trainees can genuinely share a name and nothing keys on it.
    expect(validateManualMentees([{ name: "Jane Doe" }, { name: "Jane Doe" }]).ok).toBe(true);
  });

  it("bounds the array and the year", () => {
    const many = Array.from({ length: MAX_MANUAL_MENTEES + 1 }, (_, i) => ({ name: `M${i}` }));
    expect(validateManualMentees(many)).toEqual({ ok: false, error: "too_many" });
    expect(validateManualMentees([{ name: "A", year: 1492 }])).toEqual({
      ok: false,
      error: "invalid_year",
    });
    expect(validateManualMentees([{ name: "A", year: 2020.5 }])).toEqual({
      ok: false,
      error: "invalid_year",
    });
    // Next calendar year is allowed — a mentee finishing this cycle.
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(validateManualMentees([{ name: "A", year: nextYear }]).ok).toBe(true);
    expect(validateManualMentees([{ name: "A", year: nextYear + 1 }]).ok).toBe(false);
  });

  it("accepts an empty array (the mentor removed them all) and a JSON string", () => {
    expect(validateManualMentees([])).toEqual({ ok: true, value: [] });
    expect(validateManualMentees('[{"name":"Rowan Ellis"}]').ok).toBe(true);
    expect(validateManualMentees("not json")).toEqual({ ok: false, error: "invalid_value" });
    expect(validateManualMentees([["nested"]])).toEqual({ ok: false, error: "invalid_value" });
  });

  it("omits absent optionals so the stored JSON stays minimal", () => {
    const r = validateManualMentees([{ name: "A", programLabel: "  " }]);
    expect(r.ok && JSON.stringify(r.value)).toBe('[{"name":"A"}]');
  });
});

describe("getMenteesForMentor — manual mentees (#2011)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MENTORING_COPUB_BRIDGE;
    phdFindMany.mockResolvedValue([]);
    postdocFindMany.mockResolvedValue([]);
    studentPhdProgramFindMany.mockResolvedValue([]);
    scholarFindMany.mockResolvedValue([]);
    aocMenteeFindMany.mockResolvedValue([]);
    suppressionFindMany.mockResolvedValue([]);
    fieldOverrideFindUnique.mockResolvedValue(null as never);
    withReciterConnection.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.MENTORING_COPUB_BRIDGE;
  });

  it("renders a mentor whose ONLY mentees are manual — the early return used to swallow them", async () => {
    storeManual([{ name: "Rowan Ellis", programLabel: "Visiting student", year: 2019 }]);

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(1);
    expect(mentees[0]).toMatchObject({
      fullName: "Rowan Ellis",
      programName: "Visiting student",
      graduationYear: 2019,
      copublicationCount: 0,
      scholar: null,
    });
  });

  it("never queries a co-pub source when every mentee is CWID-less", async () => {
    // The live path interpolates `IN (${cwids.map(() => "?").join(",")})`, which
    // is `IN ()` — a syntax error — on an empty list. Not reaching it is the fix.
    storeManual([{ name: "Rowan Ellis" }]);

    const { copubSourceAvailable } = await getMenteesForMentor(MENTOR);

    // Exactly ONE ReciterDB call: `loadAocRows`' AOC roster lookup in the
    // fan-out, which must run to know whether sourced mentees exist. The co-pub
    // query is the second call and must not happen.
    expect(withReciterConnection).toHaveBeenCalledTimes(1);
    // Zero co-pubs is a FACT here, not an outage — `false` would make callers
    // suppress the badges as though ReciterDB were down.
    expect(copubSourceAvailable).toBe(true);
  });

  it("gives a CWID-less mentee an empty headshot endpoint, not a URL that can only 404", async () => {
    storeManual([{ name: "Rowan Ellis" }]);
    const { mentees } = await getMenteesForMentor(MENTOR);
    expect(mentees[0].identityImageEndpoint).toBe("");
  });

  it("MERGES a manual entry into the sourced chip when it carries a real CWID", async () => {
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "rel2002",
        menteeFirstName: "Rowan",
        menteeLastName: "Ellis",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: "Immunology",
      },
    ]);
    // The mentor also typed them in by hand, with a different spelling.
    storeManual([{ name: "R. Ellis", cwid: "rel2002", programLabel: "Rotation" }]);

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(1);
    // The SOURCED record is authoritative for both name and program.
    expect(mentees[0].fullName).toBe("Rowan Ellis");
    expect(mentees[0].programName).toBe("Immunology");
    expect(mentees[0].graduationYear).toBe(2021);
  });

  it("passes only real CWIDs to the co-pub query in a mixed roster", async () => {
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "rel2002",
        menteeFirstName: "Rowan",
        menteeLastName: "Ellis",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: null,
      },
    ]);
    storeManual([{ name: "Sam Okafor" }]);
    let capturedParams: unknown[] = [];
    withReciterConnection.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const conn = {
        query: vi.fn(async (_sql: string, params: unknown[]) => {
          capturedParams = params;
          return [];
        }),
      };
      return fn(conn);
    });

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(2);
    // Mentor + the one real CWID. The synthetic `manual:0` id must not ride along.
    expect(capturedParams).toEqual([MENTOR, "rel2002"]);
    expect(capturedParams.some((p) => String(p).startsWith("manual:"))).toBe(false);
  });

  it("flags a hand-entered mentee as manualOnly — even when it carries a real CWID", async () => {
    // The /edit hide-only panel filters on this, and it is the ONLY signal that
    // separates a hand-entered mentee with a real cwid from a sourced one.
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "rel2002",
        menteeFirstName: "Rowan",
        menteeLastName: "Ellis",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: null,
      },
    ]);
    storeManual([{ name: "Evan Sholle", cwid: "evs2008" }, { name: "No Cwid Here" }]);

    const { mentees } = await getMenteesForMentor(MENTOR);
    const by = Object.fromEntries(mentees.map((m) => [m.fullName, m.manualOnly]));

    expect(by["Rowan Ellis"]).toBe(false); // Jenzabar contributed it
    expect(by["Evan Sholle"]).toBe(true); // real cwid, but no source has it
    expect(by["No Cwid Here"]).toBe(true);
  });

  it("clears manualOnly once a source ALSO carries the hand-entered cwid", async () => {
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "evs2008",
        menteeFirstName: "Evan",
        menteeLastName: "Sholle",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: null,
      },
    ]);
    storeManual([{ name: "E. Sholle", cwid: "evs2008" }]);

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(1);
    expect(mentees[0].manualOnly).toBe(false);
  });

  it("degrades to the sourced roster when the manual read throws", async () => {
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "rel2002",
        menteeFirstName: "Rowan",
        menteeLastName: "Ellis",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: null,
      },
    ]);
    fieldOverrideFindUnique.mockRejectedValue(new Error("aurora blip") as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(1);
    expect(mentees[0].fullName).toBe("Rowan Ellis");
    err.mockRestore();
  });

  it("treats a corrupt stored value as no manual mentees rather than 500-ing", async () => {
    fieldOverrideFindUnique.mockResolvedValue({ value: "{not-an-array" } as never);
    const { mentees } = await getMenteesForMentor(MENTOR);
    expect(mentees).toEqual([]);
  });
});

/**
 * #2011 follow-up — co-pubs for a manual-only mentee, computed from local
 * Aurora at read time.
 *
 * The bridge cannot carry these pairs: `etl/mentoring/export-copubs.ts` reads
 * mentor→mentee pairs from Aurora but needs ReciterDB in the same process, and
 * no reachable host has both. So the risk this suite guards is NOT "does one
 * query work" — it is that the badge, the per-mentee page, and the mentor
 * rollup are three separate functions that must return the SAME set. A count
 * that outruns the page is a badge promising a page that is empty.
 */
describe("manual-only mentee co-pubs from local Aurora (#2011)", () => {
  const MANUAL = "man2001";
  /** Newest first — the order both ReciterDB paths return, so the preview and
   *  the page must agree row for row. */
  const SHARED = ["3001", "3002", "3003", "3004"];

  /** Confirmed authorship rows: both parties on every SHARED pmid, plus one
   *  solo pmid each that must NOT appear in the intersection. */
  function authorships(): Array<{ cwid: string; pmid: string }> {
    return [
      ...SHARED.flatMap((pmid) => [
        { cwid: MENTOR, pmid },
        { cwid: MANUAL, pmid },
      ]),
      { cwid: MENTOR, pmid: "3999" },
      { cwid: MANUAL, pmid: "3888" },
    ];
  }

  function pub(pmid: string, year: number): unknown {
    return {
      pmid,
      title: `Paper ${pmid}`,
      journal: "J Synth",
      year,
      doi: null,
      pmcid: null,
      volume: null,
      issue: null,
      pages: null,
      citationCount: 7,
      abstract: null,
      fullAuthorsString: "Ellis R, Okafor S",
    };
  }

  /** The SHARED four PLUS the two solo pmids. Hydrating the solo ones too is
   *  deliberate: if the publication fixture covered only the intersection, a
   *  broken intersection would still yield 4 rows here and the test would pass
   *  on the fixture's shape rather than on the logic. */
  function publications(): unknown[] {
    return [
      pub("3001", 2023),
      pub("3002", 2021),
      pub("3003", 2019),
      pub("3004", 2018),
      pub("3999", 2022),
      pub("3888", 2020),
    ];
  }

  /** `suppression.findMany` serves two callers with one accessor — the
   *  mentee-hide set (`entityType: "mentee"`) and publication suppression
   *  (`entityType: "publication"`). Route by the where-clause, or the rollup's
   *  hide lookup swallows the publication rows. */
  function suppress(publicationRows: Array<{ entityId: string; contributorCwid: string | null }>) {
    suppressionFindMany.mockImplementation((async (args: {
      where?: { entityType?: string };
    }) => (args?.where?.entityType === "publication" ? publicationRows : [])) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MENTORING_COPUB_BRIDGE;
    phdFindMany.mockResolvedValue([]);
    postdocFindMany.mockResolvedValue([]);
    phdFindFirst.mockResolvedValue(null as never);
    postdocFindFirst.mockResolvedValue(null as never);
    studentPhdProgramFindMany.mockResolvedValue([]);
    scholarFindMany.mockResolvedValue([]);
    scholarFindUnique.mockResolvedValue(null as never);
    aocMenteeFindMany.mockResolvedValue([]);
    aocMenteeFindFirst.mockResolvedValue(null as never);
    withReciterConnection.mockResolvedValue([]);
    suppress([]);
    publicationAuthorFindMany.mockResolvedValue(authorships() as never);
    publicationFindMany.mockResolvedValue(publications() as never);
    storeManual([{ name: "Sam Okafor", cwid: MANUAL }]);
  });

  afterEach(() => {
    delete process.env.MENTORING_COPUB_BRIDGE;
  });

  it("gives a manual-only mentee a co-pub count and preview with no bridge row and no ReciterDB", async () => {
    // The bridge is ON, as it is in staging and prod — and has nothing for this
    // pair, by design. Local Aurora is the whole source.
    process.env.MENTORING_COPUB_BRIDGE = "on";
    menteeCopubFindMany.mockResolvedValue([]);

    const { mentees, copubSourceAvailable } = await getMenteesForMentor(MENTOR);

    expect(mentees).toHaveLength(1);
    expect(mentees[0].copublicationCount).toBe(4);
    // Top 3, newest first.
    expect(mentees[0].copublicationPreview.map((p) => p.pmid)).toEqual([3001, 3002, 3003]);
    // A local computation is authoritative — `false` would suppress the badge
    // it just filled, as though ReciterDB were down.
    expect(copubSourceAvailable).toBe(true);
  });

  it("counts the INTERSECTION — a pmid only one of them authored is not a co-pub", async () => {
    const { mentees } = await getMenteesForMentor(MENTOR);
    const pmids = await getCoPublications(MENTOR, MANUAL, { manualOnly: true });
    expect(mentees[0].copublicationCount).toBe(SHARED.length);
    expect(pmids.map((p) => String(p.pmid)).sort()).toEqual([...SHARED].sort());
  });

  it("badge count, per-mentee page, and rollup are the SAME list — the divergence this feature risks", async () => {
    const { mentees } = await getMenteesForMentor(MENTOR);
    const page = await getCoPublications(MENTOR, MANUAL, { manualOnly: true });
    const rollup = await getAllMentorCoPublications(MENTOR);

    expect(mentees[0].copublicationCount).toBe(page.length);
    expect(rollup.publicationCount).toBe(page.length);
    expect(rollup.menteeCount).toBe(1);
    // The preview is literally the head of the page's list, not a second query.
    expect(mentees[0].copublicationPreview.map((p) => p.pmid)).toEqual(
      page.slice(0, 3).map((p) => p.pmid),
    );
  });

  it("suppresses a taken-down pmid from BOTH the count and the preview", async () => {
    // Computed BEFORE the dark-pmid pass, so it inherits suppression for free.
    // Computing after would publish a suppressed pmid into the popover.
    suppress([{ entityId: "3001", contributorCwid: null }]);

    const { mentees } = await getMenteesForMentor(MENTOR);
    const page = await getCoPublications(MENTOR, MANUAL, { manualOnly: true });

    expect(mentees[0].copublicationCount).toBe(3);
    expect(mentees[0].copublicationPreview.map((p) => p.pmid)).toEqual([3002, 3003]);
    expect(page.map((p) => p.pmid)).not.toContain(3001);
  });

  it("leaves a SOURCED mentee on the bridge path — local authorship rows are never consulted", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    phdFindMany.mockResolvedValue([
      {
        menteeCwid: "rel2002",
        menteeFirstName: "Rowan",
        menteeLastName: "Ellis",
        conferralYear: 2021,
        programType: "PhD",
        majorDesc: null,
      },
    ]);
    storeManual([]);
    menteeCopubFindMany.mockResolvedValue([
      { menteeCwid: "rel2002", count: 9, preview: [] },
    ]);

    const { mentees } = await getMenteesForMentor(MENTOR);

    expect(mentees[0].copublicationCount).toBe(9);
    expect(publicationAuthorFindMany).not.toHaveBeenCalled();
  });

  it("drops a source-prefixed pmid rather than emit NaN", async () => {
    // `publication.pmid` is a VarChar and non-PubMed records are re-keyed to
    // e.g. "SCOPUS:105037533819"; `CoPublicationFull.pmid` is a number.
    publicationAuthorFindMany.mockResolvedValue([
      { cwid: MENTOR, pmid: "3001" },
      { cwid: MANUAL, pmid: "3001" },
      { cwid: MENTOR, pmid: "SCOPUS:105037533819" },
      { cwid: MANUAL, pmid: "SCOPUS:105037533819" },
    ] as never);
    // The publication row must exist too, or the guard is never reached and this
    // test passes on a missing fixture instead of on the guard.
    publicationFindMany.mockResolvedValue([
      pub("3001", 2023),
      pub("SCOPUS:105037533819", 2022),
    ] as never);

    const page = await getCoPublications(MENTOR, MANUAL, { manualOnly: true });

    expect(page.map((p) => p.pmid)).toEqual([3001]);
    expect(page.every((p) => Number.isInteger(p.pmid))).toBe(true);
  });

  it("carries the full byline from full_authors_string, not just the WCM subset", async () => {
    // `publication_author` holds WCM CWIDs only, so it cannot back a citation.
    // Each token is already the rendered Vancouver author.
    const page = await getCoPublications(MENTOR, MANUAL, { manualOnly: true });
    expect(page[0].authors).toEqual([
      { rank: 1, lastName: "Ellis R", firstName: null, personIdentifier: null },
      { rank: 2, lastName: "Okafor S", firstName: null, personIdentifier: null },
    ]);
  });

  it("resolves the per-mentee co-pubs page instead of 404-ing it", async () => {
    const pair = await getMentorMenteePair(MENTOR, MANUAL);
    expect(pair).toEqual({
      mentorName: MENTOR,
      menteeName: "Sam Okafor",
      manualOnly: true,
    });
  });

  it("still 404s a cwid the mentor never entered — the gate is not weakened", async () => {
    expect(await getMentorMenteePair(MENTOR, "nope999")).toBeNull();
  });

  it("serves the same rows for a MIXED-CASE url segment the 404 gate already admits", async () => {
    // Stored cwids are lowercase and nothing normalizes the URL segment, so the
    // pair gate accepts /co-pubs/MAN2001. The co-pub lookup has to accept it
    // too, or the page renders its heading over an empty list. MySQL's ci
    // collation matches the row but returns the STORED spelling, so the JS-side
    // grouping is where the two can drift.
    const upper = MANUAL.toUpperCase();
    const pair = await getMentorMenteePair(MENTOR, upper);
    expect(pair?.manualOnly).toBe(true);

    const page = await getCoPublications(MENTOR, upper, { manualOnly: true });
    expect(page.map((p) => p.pmid)).toEqual([3001, 3002, 3003, 3004]);
  });

  it("reports manualOnly FALSE once a source also carries the cwid, keeping it on the bridge", async () => {
    phdFindFirst.mockResolvedValue({
      menteeFirstName: "Sam",
      menteeLastName: "Okafor",
    } as never);

    const pair = await getMentorMenteePair(MENTOR, MANUAL);

    expect(pair?.manualOnly).toBe(false);
    // The sourced record wins the display name.
    expect(pair?.menteeName).toBe("Sam Okafor");
  });
});
