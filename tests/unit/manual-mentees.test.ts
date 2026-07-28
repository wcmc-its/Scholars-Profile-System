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
  fieldOverrideFindUnique: vi.fn(async () => null as unknown),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany },
    postdocMentorRelationship: { findMany: postdocFindMany },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany },
    menteeCopublication: { findMany: menteeCopubFindMany, findFirst: menteeCopubFindFirst },
    aocMentee: { findMany: aocMenteeFindMany, findFirst: aocMenteeFindFirst },
    menteeCopublicationPub: { findMany: menteeCopubPubFindMany },
    suppression: { findMany: suppressionFindMany },
    publicationAuthor: { findMany: publicationAuthorFindMany },
    fieldOverride: { findUnique: fieldOverrideFindUnique },
  },
}));

import { getMenteesForMentor } from "@/lib/api/mentoring";
import {
  MAX_MANUAL_MENTEES,
  manualMenteePairs,
  validateManualMentees,
} from "@/lib/edit/manual-mentee";

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

describe("manualMenteePairs — the co-pub bridge export's fourth pair source (#2011)", () => {
  it("emits a pair for an entry carrying a cwid", () => {
    expect(
      manualMenteePairs([
        { entityId: "thc2015", value: JSON.stringify([{ name: "Evan S", cwid: "evs2008" }]) },
      ]),
    ).toEqual([{ mentorCwid: "thc2015", menteeCwid: "evs2008" }]);
  });

  it("emits NOTHING for a CWID-less entry — there is no identifier to join on", () => {
    expect(
      manualMenteePairs([
        { entityId: "thc2015", value: JSON.stringify([{ name: "Rowan Ellis" }]) },
      ]),
    ).toEqual([]);
  });

  it("skips an unparseable row instead of throwing — one bad row must not abort the export", () => {
    expect(
      manualMenteePairs([
        { entityId: "aaa1001", value: "{not-json" },
        { entityId: "thc2015", value: JSON.stringify([{ name: "Evan S", cwid: "evs2008" }]) },
      ]),
    ).toEqual([{ mentorCwid: "thc2015", menteeCwid: "evs2008" }]);
  });

  it("drops a self-pair, matching the export's own add() guard", () => {
    expect(
      manualMenteePairs([
        { entityId: "thc2015", value: JSON.stringify([{ name: "Self", cwid: "thc2015" }]) },
      ]),
    ).toEqual([]);
  });

  it("flattens several mentors and several mentees per mentor", () => {
    const pairs = manualMenteePairs([
      {
        entityId: "thc2015",
        value: JSON.stringify([
          { name: "A", cwid: "aaa1" },
          { name: "B" },
          { name: "C", cwid: "ccc3" },
        ]),
      },
      { entityId: "xyz9", value: JSON.stringify([{ name: "D", cwid: "ddd4" }]) },
    ]);
    expect(pairs).toEqual([
      { mentorCwid: "thc2015", menteeCwid: "aaa1" },
      { mentorCwid: "thc2015", menteeCwid: "ccc3" },
      { mentorCwid: "xyz9", menteeCwid: "ddd4" },
    ]);
  });
});
