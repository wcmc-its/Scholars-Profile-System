/**
 * `etl/orcid-evidence` — the pure transforms behind the ORCID librarian queue:
 * the band rule (each band, first match wins), surname agreement for every
 * case the spec lists (diacritics, hyphens, spacing, compound surnames, an
 * empty family name), evidence assembly from a fixture `/record`, the three
 * competitor rules, and the email auto-confirm (flag off writes nothing, never
 * overwrites an iD on file, a dismissal is respected). Synthetic ids only
 * (ORCID's doc example iD).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPmidResolver, type FetchFn } from "@/etl/orcid-evidence/pubmed-resolve";

import {
  assembleEvidence,
  autoConfirmStep,
  bandOf,
  buildHistory,
  doisToResolve,
  matchByTitle,
  reciterAssertionOf,
  reciterStatusOf,
  titleMatchKey,
  withReciterAccepted,
  withResolvedPmids,
  type ReciterAssertion,
  historyBandShift,
  isHistoryBandEnabled,
  instMatchFacts,
  surnameRule,
  withSharedPaperDetail,
  findCompetitors,
  isEmailVerified,
  isInstMatch,
  nameAgrees,
  newWorksOf,
  planAutoConfirm,
  recordFacts,
  recordFamilyName,
  surnamesAgree,
  type BandInput,
  nameDisagrees,
} from "@/etl/orcid-evidence/index";
import { indexScholarWorks } from "@/etl/orcid-registry/index";
import type { ExternalId, RecordResponse } from "@/etl/orcid-registry/orcid-api";

const ORCID = "0000-0002-1825-0097";
const ORCID_2 = "0000-0002-1825-009X";

const doi = (v: string): ExternalId => ({
  "external-id-type": "doi",
  "external-id-value": v,
  "external-id-normalized": { value: v.toLowerCase() },
  "external-id-relationship": "self",
});
const pmid = (v: string): ExternalId => ({
  "external-id-type": "pmid",
  "external-id-value": v,
  "external-id-normalized": null,
  "external-id-relationship": "self",
});
const work = (title: string, year: string, ids: ExternalId[], source = "Crossref") => ({
  "external-ids": { "external-id": ids },
  "work-summary": [
    {
      "external-ids": { "external-id": ids },
      title: { title: { value: title } },
      "publication-date": { year: { value: year } },
      source: { "source-name": { value: source } },
    },
  ],
});

/** A fixture record: verified WCM email, an Example University employment with
 *  the WCM ROR, four works (three of them the scholar's papers). */
function record(over: Partial<NonNullable<RecordResponse["person"]>> = {}): RecordResponse {
  return {
    history: { "last-modified-date": { value: Date.UTC(2026, 9, 1) } },
    person: {
      name: {
        "given-names": { value: "Jane" },
        "family-name": { value: "Doe" },
        "credit-name": null,
      },
      "other-names": { "other-name": [] },
      emails: { email: [{ email: "JD0001@Example.MED.CORNELL.EDU", verified: true }] },
      ...over,
    },
    "activities-summary": {
      "last-modified-date": null,
      employments: {
        "affiliation-group": [
          {
            summaries: [
              {
                "employment-summary": {
                  organization: {
                    name: "Example Medical College",
                    "disambiguated-organization": {
                      "disambiguated-organization-identifier": "https://ror.org/02r109517",
                      "disambiguation-source": "ROR",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
      educations: { "affiliation-group": [] },
      works: {
        "last-modified-date": null,
        group: [
          work("Paper one", "2020", [doi("10.1/A"), pmid("101")]),
          work("Paper two", "2021", [doi("10.1/B")]),
          work("Paper three", "2022", [pmid("103")]),
          work("Elsewhere", "2024", [doi("10.1/Z")], "Example Repository"),
        ],
      },
    },
  };
}

type Person = { cwid: string; fullName: string; preferredName: string; email: string | null };
const JANE: Person = {
  cwid: "jd0001",
  fullName: "Jane Doe",
  preferredName: "Jane Doe",
  email: "jd0001@example.med.cornell.edu",
};
const JANE_PAPERS = [
  { cwid: "jd0001", pmid: "101", doi: "10.1/a" },
  { cwid: "jd0001", pmid: "102", doi: "10.1/b" },
  { cwid: "jd0001", pmid: "103", doi: null },
];

const base: BandInput = {
  emailVerified: false,
  instMatch: false,
  shared: 0,
  competitor: false,
  nameAgrees: false,
};

describe("bandOf — first match wins", () => {
  it("email_verified: a verified email and no competitor, whatever else", () => {
    expect(bandOf({ ...base, emailVerified: true })).toBe("email_verified");
    // A competitor takes the email band away; the rest still decides.
    expect(bandOf({ ...base, emailVerified: true, competitor: true, instMatch: true })).toBe(
      "weak",
    );
  });

  it("strong: institution + ≥3 shared + name, no competitor", () => {
    expect(bandOf({ ...base, instMatch: true, shared: 3, nameAgrees: true })).toBe("strong");
  });

  it("shared_only: ≥3 shared + name, no institution", () => {
    expect(bandOf({ ...base, shared: 5, nameAgrees: true })).toBe("shared_only");
  });

  it("moderate: two of {institution, ≥3 shared, no competitor}", () => {
    // Name disagrees, so not strong — but institution + papers.
    expect(bandOf({ ...base, instMatch: true, shared: 3 })).toBe("moderate");
    // Institution, no competitor.
    expect(bandOf({ ...base, instMatch: true })).toBe("moderate");
    // Papers + no competitor, name disagrees.
    expect(bandOf({ ...base, shared: 4 })).toBe("moderate");
  });

  it("weak: everything else", () => {
    expect(bandOf(base)).toBe("weak");
    expect(bandOf({ ...base, competitor: true, shared: 9, nameAgrees: true })).toBe("weak");
    expect(bandOf({ ...base, shared: 2, nameAgrees: true })).toBe("weak");
  });
});

describe("surnamesAgree — every case the spec names", () => {
  const scholar = (fullName: string) => ({ cwid: "x", fullName, preferredName: fullName });
  it.each([
    ["Jaffré", "Marie Jaffre"],
    ["Jaffre", "Marie Jaffré"],
    ["Navarro-Millán", "Ana Navarro-Millan"],
    ["Al Hariri", "Omar Alhariri"],
    ["Alhariri", "Omar Al Hariri"],
    ["Al Hariri", "Omar K Alhariri"],
    ["Sanchez", "Maria Sanchez Garcia-Vao"],
    ["Sanchez Garcia-Vao", "Maria Sanchez"],
    ["Prieto", "Ana Prieto Fernandez"],
    ["Prieto Fernandez", "Ana Prieto"],
    // Equality has no length minimum: two-letter surnames agree with themselves.
    ["Li", "Wei Li"],
    ["Wu", "Jing Wu"],
    ["Ng", "Kenneth Ng"],
    ["Li", "Wei M Li"],
  ])("record %s agrees with scholar %s", (family, full) => {
    expect(surnamesAgree(family, scholar(full))).toBe(true);
  });

  it("different surnames, a short shared token, and no family name do not agree", () => {
    expect(surnamesAgree("Smith", scholar("Jane Doe"))).toBe(false);
    expect(surnamesAgree("Li", scholar("Wei Li Wang"))).toBe(false);
    expect(surnamesAgree("Li", scholar("Wei Wu"))).toBe(false);
    expect(surnamesAgree("L", scholar("Wei L"))).toBe(false); // an initial is not a surname
    expect(surnamesAgree(null, scholar("Jane Doe"))).toBe(false);
  });

  it("an empty family name with the whole name in given names is split and retried", () => {
    const facts = { names: ["Ana Prieto Fernandez"], given: "Ana Prieto Fernandez", family: null };
    expect(recordFamilyName(facts)).toBe("Prieto Fernandez");
    expect(nameAgrees(facts, scholar("Ana Prieto"))).toBe(true);
  });

  it("nameAgrees needs the full given name too, not just the surname", () => {
    const facts = { names: ["J Doe"], given: "J", family: "Doe" };
    expect(nameAgrees(facts, scholar("Jane Doe"))).toBe(false);
    expect(nameAgrees({ ...facts, names: ["Jane Doe"], given: "Jane" }, scholar("Jane Doe"))).toBe(
      true,
    );
  });
});

describe("recordFacts + the per-pair evidence", () => {
  const f = recordFacts(ORCID, record());

  it("reads names, emails, orgs, works and the modified date", () => {
    expect(f.names).toEqual(["Jane Doe"]);
    expect(f.emails).toEqual([{ email: "jd0001@example.med.cornell.edu", verified: true }]);
    expect(f.orgs).toEqual([
      {
        name: "Example Medical College",
        ror: "https://ror.org/02r109517",
        kind: "employment",
        start: null,
        end: null,
      },
    ]);
    expect(f.works).toHaveLength(4);
    expect(f.modifiedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("email verified is case-insensitive and needs verified: true", () => {
    expect(isEmailVerified(f, " JD0001@example.med.cornell.edu ")).toBe(true);
    const unverified = recordFacts(
      ORCID,
      record({ emails: { email: [{ email: JANE.email, verified: false }] } }),
    );
    expect(isEmailVerified(unverified, JANE.email)).toBe(false);
    expect(isEmailVerified(f, null)).toBe(false);
  });

  it("institution: the ROR id, a Cornell org name, or a cornell.edu email", () => {
    expect(isInstMatch(f)).toBe(true);
    expect(isInstMatch({ orgs: [{ name: "Weill Cornell Medicine", ror: null }], emails: [] })).toBe(
      true,
    );
    expect(isInstMatch({ orgs: [], emails: [{ email: "x@cornell.edu", verified: false }] })).toBe(
      true,
    );
    expect(
      isInstMatch({
        orgs: [{ name: "Example University", ror: "https://ror.org/000000000" }],
        emails: [],
      }),
    ).toBe(false);
  });

  it("new works: the record's works not in the scholar's papers, with title, year and source", () => {
    const nw = newWorksOf(f, indexScholarWorks(JANE_PAPERS).get("jd0001"));
    expect(nw).toEqual({
      total: 4,
      count: 1,
      sample: [
        {
          title: "Elsewhere",
          year: 2024,
          doi: "10.1/z",
          pmid: null,
          source: "Example Repository",
          url: null,
          status: "not_in_pubmed",
        },
      ],
      counts: { not_in_pubmed: 1 },
      unknown: 0,
    });
  });

  it("assembles one email_verified row: shared counts papers once, on-file and unfetched pairs get none", () => {
    const rows = assembleEvidence({
      pairs: [
        { cwid: "jd0001", orcid: ORCID },
        // No record fetched: no row. (A failed iD of jd0001's own would make
        // the pair above a competitor — the degraded-run test below.)
        { cwid: "ab0001", orcid: ORCID_2 },
      ],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([
        ["jd0001", JANE],
        ["ab0001", { cwid: "ab0001", fullName: "Al Bee", preferredName: "Al Bee", email: null }],
      ]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cwid: "jd0001",
      orcid: ORCID,
      band: "email_verified",
      emailVerified: true,
      instMatch: true,
      nameAgrees: true,
      shared: 3,
      competitor: false,
      worksTotal: 4,
      newWorks: 1,
    });
    const onFile = assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set([`jd0001|${ORCID}`]),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    });
    expect(onFile).toEqual([]);
  });

  it("a coauthor's iD (neither given name nor surname agrees) gets no row and is no rule-2 competitor", () => {
    const coauthor = { ...f, names: ["francesco soria"], given: "Francesco", family: "Soria" };
    const rows = assembleEvidence({
      pairs: [
        { cwid: "jd0001", orcid: ORCID },
        { cwid: "jd0001", orcid: ORCID_2 },
      ],
      onFile: new Set(),
      facts: new Map([
        [ORCID, f],
        [ORCID_2, coauthor],
      ]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    });
    expect(rows.map((r) => r.orcid)).toEqual([ORCID]);
    expect(rows[0].competitor).toBe(false);
    expect(nameDisagrees({ names: [], given: null, family: null }, JANE)).toBe(false);
  });
});

describe("findCompetitors", () => {
  const workIds = new Set(["pmid:1", "pmid:2", "pmid:3", "pmid:4", "pmid:5", "pmid:6"]);
  const mine = indexScholarWorks([
    { cwid: "a", pmid: "1", doi: null },
    { cwid: "a", pmid: "2", doi: null },
    { cwid: "a", pmid: "3", doi: null },
  ]).get("a");

  it("rule 1: a same-surname scholar with ≥3 of the record's papers this scholar lacks", () => {
    const other = indexScholarWorks([
      { cwid: "b", pmid: "4", doi: null },
      { cwid: "b", pmid: "5", doi: null },
      { cwid: "b", pmid: "6", doi: null },
    ]).get("b");
    const r = findCompetitors({
      cwid: "a",
      workIds,
      mine,
      sameSurname: [{ cwid: "b", works: other }],
      otherIds: [],
      otherHolders: [],
    });
    expect(r).toEqual({
      competitor: true,
      cwids: ["b"],
      orcids: [],
      detail: { cwids: [{ cwid: "b", shared: 3, reason: "same_surname" }], orcids: [] },
    });
  });

  it("rule 1 ignores joint papers: a co-author sharing only this scholar's papers is no competitor", () => {
    const coauthor = indexScholarWorks([
      { cwid: "b", pmid: "1", doi: null },
      { cwid: "b", pmid: "2", doi: null },
      { cwid: "b", pmid: "3", doi: null },
    ]).get("b");
    const r = findCompetitors({
      cwid: "a",
      workIds,
      mine,
      sameSurname: [{ cwid: "b", works: coauthor }],
      otherIds: [],
      otherHolders: [],
    });
    expect(r.competitor).toBe(false);
  });

  it("rule 2: another candidate iD of this scholar with ≥3 shared", () => {
    const r = findCompetitors({
      cwid: "a",
      workIds,
      mine,
      sameSurname: [],
      otherIds: [
        { orcid: ORCID_2, shared: 3 },
        { orcid: "0000-0000-0000-001X", shared: 2 },
      ],
      otherHolders: [],
    });
    expect(r).toEqual({
      competitor: true,
      cwids: [],
      orcids: [ORCID_2],
      detail: { cwids: [], orcids: [{ orcid: ORCID_2, shared: 3 }] },
    });
  });

  it("rule 3: the same iD is a candidate for another scholar with ≥3 shared", () => {
    const r = findCompetitors({
      cwid: "a",
      workIds,
      mine,
      sameSurname: [],
      otherIds: [],
      otherHolders: [
        { cwid: "c", shared: 4 },
        { cwid: "d", shared: 1 },
      ],
    });
    expect(r).toEqual({
      competitor: true,
      cwids: ["c"],
      orcids: [],
      detail: { cwids: [{ cwid: "c", shared: 4, reason: "same_id" }], orcids: [] },
    });
  });

  it("rule 2 reads an unscored iD (its /record fetch failed) as a competitor", () => {
    const r = findCompetitors({
      cwid: "a",
      workIds,
      mine,
      sameSurname: [],
      otherIds: [{ orcid: ORCID_2, shared: null }],
      otherHolders: [],
    });
    expect(r).toMatchObject({ competitor: true, orcids: [ORCID_2] });
  });

  it("assembleEvidence: a failed fetch of the scholar's other candidate iD keeps this pair out of the confirmable bands", () => {
    const f = recordFacts(ORCID, record());
    const args = {
      pairs: [
        { cwid: "jd0001", orcid: ORCID },
        { cwid: "jd0001", orcid: ORCID_2 },
      ],
      onFile: new Set<string>(),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    };
    // ORCID_2 fetched with no shared papers: no competitor, email band.
    const ok = assembleEvidence({
      ...args,
      facts: new Map([
        [ORCID, f],
        [ORCID_2, { ...f, emails: [], workIds: new Set<string>(), works: [] }],
      ]),
    });
    expect(ok.find((r) => r.orcid === ORCID)).toMatchObject({
      competitor: false,
      band: "email_verified",
    });
    // ORCID_2's fetch failed: unknown → competitor, and the pair drops to moderate.
    const degraded = assembleEvidence({ ...args, facts: new Map([[ORCID, f]]) });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      competitor: true,
      competitorOrcids: [ORCID_2],
      band: "moderate",
    });
  });

  it("assembleEvidence wires rule 3 across scholars: both holders of one iD with ≥3 shared compete", () => {
    const f = recordFacts(ORCID, record({ emails: { email: [] } }));
    const twin: Person = {
      cwid: "jd0002",
      fullName: "Jane Doe",
      preferredName: "Jane Doe",
      email: null,
    };
    const rows = assembleEvidence({
      pairs: [
        { cwid: "jd0001", orcid: ORCID },
        { cwid: "jd0002", orcid: ORCID },
      ],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([
        ["jd0001", JANE],
        ["jd0002", twin],
      ]),
      works: indexScholarWorks([
        ...JANE_PAPERS,
        ...JANE_PAPERS.map((p) => ({ ...p, cwid: "jd0002" })),
      ]),
      active: [JANE, twin],
    });
    expect(rows.map((r) => [r.cwid, r.competitor, r.competitorCwids, r.band])).toEqual([
      ["jd0001", true, ["jd0002"], "moderate"],
      ["jd0002", true, ["jd0001"], "moderate"],
    ]);
  });
});

describe("email auto-confirm", () => {
  const row = (cwid: string, orcid: string, band = "email_verified" as const) => ({
    cwid,
    orcid,
    band,
  });

  it("plans only email_verified rows with nothing on file, not dismissed, one per scholar and per iD", () => {
    const plan = planAutoConfirm(
      [
        row("a", ORCID),
        row("b", ORCID_2), // b already holds an iD
        row("c", "0000-0000-0000-001X"), // dismissed
        row("d", "0000-0000-0000-0028"),
        row("d", "0000-0000-0000-0036"), // two verified iDs: ambiguous
        { cwid: "e", orcid: "0000-0000-0000-0044", band: "strong" as const },
      ],
      new Map<string, string | null>([
        ["a", null],
        ["b", "0000-0000-0000-0052"],
        ["c", null],
        ["d", null],
        ["e", null],
      ]),
      new Set(["c|0000-0000-0000-001X"]),
    );
    expect(plan).toEqual([{ cwid: "a", orcid: ORCID }]);
  });

  it("never plans an iD another scholar already holds", () => {
    const plan = planAutoConfirm(
      [row("a", ORCID)],
      new Map<string, string | null>([
        ["a", null],
        ["z", ORCID],
      ]),
      new Set(),
    );
    expect(plan).toEqual([]);
  });

  const h = {
    dismissal: vi.fn(),
    updateMany: vi.fn(),
    executeRaw: vi.fn(),
    transaction: vi.fn(),
  };
  const tx = {
    orcidDismissal: { findUnique: h.dismissal },
    scholar: { updateMany: h.updateMany },
    $executeRaw: h.executeRaw,
  };
  const client = { $transaction: h.transaction } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    h.transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    h.dismissal.mockResolvedValue(null);
    h.updateMany.mockResolvedValue({ count: 1 });
    h.executeRaw.mockResolvedValue(1);
  });

  it("flag off (or a dry run) writes nothing and only logs the would-confirm cwids", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      await autoConfirmStep(client, [{ cwid: "a", orcid: ORCID }], {
        enabled: false,
        dryRun: false,
      }),
    ).toEqual([]);
    expect(
      await autoConfirmStep(client, [{ cwid: "a", orcid: ORCID }], { enabled: true, dryRun: true }),
    ).toEqual([]);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).toContain("would confirm 1: a");
  });

  it("flag on writes scholar.orcid WHERE orcid IS NULL with method email_verified, by ETL, plus an audit row", async () => {
    const now = new Date("2026-10-24T08:00:00Z");
    expect(
      await autoConfirmStep(client, [{ cwid: "a", orcid: ORCID }], {
        enabled: true,
        dryRun: false,
        now,
      }),
    ).toEqual(["a"]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { cwid: "a", orcid: null },
      data: {
        orcid: ORCID,
        orcidConfirmedAt: now,
        orcidConfirmMethod: "email_verified",
        orcidConfirmedBy: "ETL",
      },
    });
    const args = h.executeRaw.mock.calls[0] as unknown[];
    expect(args).toContain("ETL");
    expect(args).toContain("orcid_email_autoconfirm");
  });

  it("never overwrites: a scholar who got an iD since the read is skipped, with no audit row", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await autoConfirmStep(client, [{ cwid: "a", orcid: ORCID }], {
        enabled: true,
        dryRun: false,
      }),
    ).toEqual([]);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("a dismissal found inside the transaction skips the pair before any write", async () => {
    h.dismissal.mockResolvedValue({ cwid: "a", orcid: ORCID });
    expect(
      await autoConfirmStep(client, [{ cwid: "a", orcid: ORCID }], {
        enabled: true,
        dryRun: false,
      }),
    ).toEqual([]);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.executeRaw).not.toHaveBeenCalled();
  });
});

describe("v2: history_match, the band rule, and the evidence detail", () => {
  it("bandOf: a history match is the institutional condition for Strong (and Moderate)", () => {
    expect(bandOf({ ...base, historyMatch: true, shared: 3, nameAgrees: true })).toBe("strong");
    expect(bandOf({ ...base, historyMatch: true })).toBe("moderate");
    expect(
      bandOf({ ...base, historyMatch: true, shared: 3, nameAgrees: true, competitor: true }),
    ).toBe("moderate");
    expect(bandOf({ ...base, shared: 3, nameAgrees: true })).toBe("shared_only");
  });

  it("surnameRule names which rule agreed", () => {
    const scholar = (fullName: string) => ({ cwid: "x", fullName, preferredName: fullName });
    expect(surnameRule("Doe", scholar("Jane Doe"))).toBe("same");
    expect(surnameRule("Jaffré", scholar("Marie Jaffre"))).toBe("folded");
    expect(surnameRule("Navarro-Millán", scholar("Ana Navarro-Millan"))).toBe("folded");
    expect(surnameRule("Prieto", scholar("Ana Prieto Fernandez"))).toBe("compound_token");
    expect(surnameRule("Sanchez Garcia-Vao", scholar("Maria Sanchez"))).toBe("compound_token");
    expect(surnameRule("Al Hariri", scholar("Omar Alhariri"))).toBe("joined");
    expect(surnameRule("Smith", scholar("Jane Doe"))).toBeNull();
  });

  it("instMatchFacts pairs each matching org with what it matched, plus a Cornell email", () => {
    const f = instMatchFacts({
      orgs: [
        {
          name: "Example Medical College",
          ror: "https://ror.org/02r109517",
          kind: "employment",
          start: 2010,
          end: null,
        },
        { name: "Cornell University", ror: null, kind: "education", start: 1990, end: 1994 },
        { name: "Elsewhere University", ror: null, kind: "education", start: null, end: null },
      ],
      emails: [{ email: "x@cornell.edu", verified: false }],
    });
    expect(f.pairs.map((p) => [p.orcid.name, p.orcid.kind, p.ours.name])).toEqual([
      ["Example Medical College", "employment", "Weill Cornell Medicine (ROR)"],
      ["Cornell University", "education", "Cornell University"],
    ]);
    expect(f.email).toBe("x@cornell.edu");
  });

  it("buildHistory: education, external appointments and Identity, keyed by lowercase cwid", () => {
    const h = buildHistory({
      education: [{ cwid: "JD0001", institution: "Albany Medical College" }],
      appointments: [{ cwid: "jd0001", organization: " University of Rochester " }],
      identity: new Map([["jd0001", ["Albany Medical College of Union University"]]]),
    });
    expect(h.get("jd0001")).toEqual([
      { name: "Albany Medical College", source: "education" },
      { name: "University of Rochester", source: "appointment" },
      { name: "Albany Medical College of Union University", source: "identity" },
    ]);
  });

  /** A record with no WCM tie: an Albany employment, five works (three Jane's),
   *  a figure and an image that must not count, and a preprint of paper one. */
  function albanyRecord(): RecordResponse {
    const r = record({ emails: { email: [] } });
    r["activities-summary"]!.employments = {
      "affiliation-group": [
        {
          summaries: [
            {
              "employment-summary": {
                organization: {
                  name: "Albany Medical College",
                  "disambiguated-organization": null,
                },
                "start-date": { year: { value: "1996" } },
                "end-date": { year: { value: "2001" } },
              },
            },
          ],
        },
      ],
    };
    const typed = (w: ReturnType<typeof work>, type: string) => ({
      ...w,
      "work-summary": w["work-summary"].map((x) => ({ ...x, type })),
    });
    r["activities-summary"]!.works = {
      "last-modified-date": null,
      group: [
        typed(work("Paper one", "2020", [doi("10.1/A"), pmid("101")]), "journal-article"),
        typed(work("Paper two", "2021", [doi("10.1/B")]), "journal-article"),
        typed(work("Paper three", "2022", [pmid("103")]), "journal-article"),
        typed(work("Figure 2", "2022", [doi("10.6084/m9.figshare.1")]), "other"),
        typed(work("A microscopy image", "2022", [doi("10.9/IMG")]), "image"),
      ],
    };
    return r;
  }

  it("non-publications never count: works_total, new works and shared see publications only", () => {
    const f = recordFacts(ORCID, albanyRecord());
    expect(f.works.map((w) => w.title)).toEqual(["Paper one", "Paper two", "Paper three"]);
    expect(f.worksDropped).toBe(2);
    expect(f.workIds.has("doi:10.6084/m9.figshare.1")).toBe(false);
    expect(f.orgs[0]).toMatchObject({ kind: "employment", start: 1996, end: 2001 });
  });

  it("a history match lifts a pair to Strong, and the detail names the pair, sources and names", () => {
    const f = recordFacts(ORCID, albanyRecord());
    const rows = assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
      history: buildHistory({
        education: [],
        appointments: [],
        identity: new Map([["jd0001", ["Albany Medical College of Union University"]]]),
      }),
      sources: new Map([[`jd0001|${ORCID}`, ["rpm_inferred", "orcid_works"]]]),
      historyBand: true,
    });
    expect(rows[0]).toMatchObject({
      band: "strong",
      instMatch: false,
      historyMatch: true,
      shared: 3,
      worksTotal: 3,
      newWorks: 0,
    });
    const d = rows[0]!.evidenceDetail;
    expect(d.institutions).toEqual([
      {
        orcid: { name: "Albany Medical College", kind: "employment", start: 1996, end: 2001 },
        ours: { name: "Albany Medical College of Union University", source: "identity" },
      },
    ]);
    expect(d.names).toEqual({
      orcid: { credit: null, given: "Jane", family: "Doe", other: [] },
      givenAgrees: true,
      surnameRule: "same",
    });
    expect(d.sources).toEqual(["orcid_works", "rpm_inferred"]);
    expect(d.email).toBeNull();
    expect(d.worksDropped).toBe(2);
    expect(d.shared.map((p) => p.pmid)).toEqual(["103", "102", "101"]);

    // Without the history the same pair is Shared papers only.
    const without = assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    });
    expect(without[0]).toMatchObject({ band: "shared_only", historyMatch: false });
  });

  it("ORCID_HISTORY_BAND off: history_match is written but does not move the band", () => {
    const f = recordFacts(ORCID, albanyRecord());
    const rows = assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
      history: buildHistory({
        education: [],
        appointments: [],
        identity: new Map([["jd0001", ["Albany Medical College of Union University"]]]),
      }),
    });
    expect(rows[0]).toMatchObject({ band: "shared_only", historyMatch: true, instMatch: false });
    expect(rows[0]!.evidenceDetail.institutions).toHaveLength(1);
    expect(historyBandShift(rows)).toEqual({ "shared_only->strong": 1 });
  });

  it('isHistoryBandEnabled is exactly "on"', () => {
    const prev = process.env.ORCID_HISTORY_BAND;
    try {
      for (const [v, want] of [
        ["on", true],
        ["ON", false],
        ["1", false],
        ["off", false],
      ] as const) {
        process.env.ORCID_HISTORY_BAND = v;
        expect(isHistoryBandEnabled()).toBe(want);
      }
      delete process.env.ORCID_HISTORY_BAND;
      expect(isHistoryBandEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ORCID_HISTORY_BAND;
      else process.env.ORCID_HISTORY_BAND = prev;
    }
  });

  it("withSharedPaperDetail fills title, year, journal and DOI from our publications", () => {
    const f = recordFacts(ORCID, record());
    const rows = assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
    });
    expect(rows[0]!.evidenceDetail.email).toBe("jd0001@example.med.cornell.edu");
    const filled = withSharedPaperDetail(
      rows,
      new Map([["101", { doi: "10.1/a", title: "Paper one", year: 2020, journal: "J Example" }]]),
    );
    expect(filled[0]!.evidenceDetail.shared).toContainEqual({
      pmid: "101",
      doi: "10.1/a",
      title: "Paper one",
      year: 2020,
      journal: "J Example",
    });
    expect(filled[0]!.evidenceDetail.shared).toContainEqual({
      pmid: "103",
      doi: null,
      title: null,
      year: null,
      journal: null,
    });
  });
});

describe("v2.1: PMIDs from DOIs and titles, and ReCiter status", () => {
  /** Jane's record: one paper we hold, ReCiter-only papers in each state, a
   *  DOI-only work, a work with no id, and one whose only match is its title. */
  function statusRecord(): RecordResponse {
    const r = record();
    r["activities-summary"]!.works = {
      "last-modified-date": null,
      group: [
        work("Paper one", "2020", [doi("10.1/A"), pmid("101")]),
        work("Accepted in ReCiter only", "2023", [pmid("201")]),
        work("Pending in ReCiter", "2023", [pmid("202")]),
        work("Rejected in ReCiter", "2022", [pmid("203")]),
        work("Never retrieved by ReCiter", "2021", [pmid("204")]),
        work("A DOI-only paper", "2024", [doi("10.1/Q")]),
        work("A work with no identifiers", "2019", []),
        work("Gene Expression in Human Liver Cells", "2020", []),
      ],
    };
    return r;
  }
  const TITLES = new Map([
    [
      "jd0001",
      [{ pmid: "102", title: "Gene <i>expression</i> in human líver cells.", year: 2021 }],
    ],
  ]);
  const RECITER = new Map([
    [
      "jd0001",
      new Map<string, ReciterAssertion>([
        ["101", "ACCEPTED"],
        ["201", "ACCEPTED"],
        ["202", "PENDING"],
        ["203", "REJECTED"],
      ]),
    ],
  ]);
  const assemble = (over: Partial<Parameters<typeof assembleEvidence>[0]> = {}) =>
    assembleEvidence({
      pairs: [{ cwid: "jd0001", orcid: ORCID }],
      onFile: new Set(),
      facts: new Map([[ORCID, recordFacts(ORCID, statusRecord())]]),
      scholars: new Map([["jd0001", JANE]]),
      works: indexScholarWorks(JANE_PAPERS),
      active: [JANE],
      ...over,
    });

  it("reciterAssertionOf: ACCEPTED, REJECTED, anything else on a row is pending", () => {
    expect(reciterAssertionOf("ACCEPTED")).toBe("ACCEPTED");
    expect(reciterAssertionOf(" rejected ")).toBe("REJECTED");
    for (const v of [null, "NULL", "PENDING", ""]) expect(reciterAssertionOf(v)).toBe("PENDING");
  });

  it("reciterStatusOf: PMID states, DOI only, no ids, and unknown when ReCiter was not read", () => {
    const a = new Map<string, ReciterAssertion>([
      ["1", "ACCEPTED"],
      ["2", "PENDING"],
      ["3", "REJECTED"],
    ]);
    expect(reciterStatusOf({ pmid: "1", doi: null }, a)).toBe("accepted");
    expect(reciterStatusOf({ pmid: "2", doi: null }, a)).toBe("pending");
    expect(reciterStatusOf({ pmid: "3", doi: null }, a)).toBe("rejected");
    expect(reciterStatusOf({ pmid: "4", doi: "10.1/x" }, a)).toBe("not_retrieved");
    expect(reciterStatusOf({ pmid: null, doi: "10.1/x" }, a)).toBe("not_in_pubmed");
    expect(reciterStatusOf({ pmid: null, doi: null }, a)).toBe("no_ids");
    expect(reciterStatusOf({ pmid: "4", doi: null }, null)).toBeNull();
    expect(reciterStatusOf({ pmid: null, doi: "10.1/x" }, null)).toBe("not_in_pubmed");
    // The PubMed lookup never answered its DOI: unknown, not "not in PubMed".
    expect(reciterStatusOf({ pmid: null, doi: "10.1/x", pubmedUnknown: true }, a)).toBeNull();
  });

  it("doisToResolve: the DOIs of works with no PMID, normalized and distinct", () => {
    const f = recordFacts(ORCID, statusRecord());
    expect(doisToResolve([f, f])).toEqual(["10.1/q"]);
  });

  it("withResolvedPmids gives a DOI-only work its PMID, so it can count as shared", () => {
    const f = recordFacts(ORCID, record());
    // "Paper two" (10.1/B, no PMID on the record) resolves to Jane's 102.
    const g = withResolvedPmids(f, new Map([["10.1/b", "102"]]));
    const two = g.works.find((w) => w.title === "Paper two")!;
    expect(two).toMatchObject({ pmid: "102", resolvedBy: "doi" });
    expect(g.workIds.has("pmid:102")).toBe(true);
    // Every DOI answered "not in PubMed": nothing changes.
    expect(withResolvedPmids(f, new Map(doisToResolve([f]).map((d) => [d, null])))).toBe(f);
    // No DOI answered (an outage): the DOI-only works are marked unknown.
    expect(
      withResolvedPmids(f, new Map()).works.find((w) => w.title === "Paper two"),
    ).toMatchObject({ pmid: null, pubmedUnknown: true });
    // A work whose DOIs resolve to two PMIDs stays unresolved.
    const twin = {
      ...f,
      works: [{ ...two, pmid: null, ids: new Set(["doi:10.1/b", "doi:10.1/c"]) }],
    };
    expect(
      withResolvedPmids(
        twin,
        new Map([
          ["10.1/b", "1"],
          ["10.1/c", "2"],
        ]),
      ).works[0]!.pmid,
    ).toBeNull();
  });

  it("titleMatchKey strips tags, accents, case and punctuation; short titles never match", () => {
    expect(titleMatchKey("Gene <i>expression</i> in human líver cells.")).toBe(
      titleMatchKey("GENE EXPRESSION IN HUMAN LIVER CELLS"),
    );
    expect(titleMatchKey("Reply")).toBeNull();
  });

  it.each([
    "Letter to the Editor",
    "Letters to the editor",
    "Reply to the Letter to the Editor",
    "Response to letter to the editor",
    "In reply to the editor",
    "Authors' reply to the letter to the editor",
    "Response to the comment on the editorial",
  ])("titleMatchKey: generic correspondence title %s never matches", (title) => {
    expect(titleMatchKey(title)).toBeNull();
    const pubs = [{ pmid: "500", title, year: 2021 }];
    expect(matchByTitle({ title, year: 2021, ids: new Set<string>() }, pubs)).toBeNull();
  });

  it("titleMatchKey keeps a specific title that opens with a correspondence word", () => {
    expect(titleMatchKey("Response to immunotherapy in metastatic melanoma")).not.toBeNull();
    expect(titleMatchKey("Letter to the editor regarding statin use in sepsis")).not.toBeNull();
  });

  it("matchByTitle: exact normalized title, year ±1, no ids, one paper only", () => {
    const pubs = TITLES.get("jd0001")!;
    const w = (title: string, year: number | null, ids: string[] = []) => ({
      title,
      year,
      ids: new Set(ids),
    });
    expect(matchByTitle(w("Gene Expression in Human Liver Cells", 2020), pubs)).toBe("102");
    expect(matchByTitle(w("Gene Expression in Human Liver Cells", 2022), pubs)).toBe("102");
    expect(matchByTitle(w("Gene Expression in Human Liver Cells", 2019), pubs)).toBeNull();
    expect(matchByTitle(w("Gene Expression in Human Liver Cells", null), pubs)).toBeNull();
    expect(matchByTitle(w("Gene Expression in Human Liver Cells II", 2021), pubs)).toBeNull();
    expect(
      matchByTitle(w("Gene Expression in Human Liver Cells", 2021, ["doi:10.1/x"]), pubs),
    ).toBeNull();
    const dup = [
      ...pubs,
      { pmid: "999", title: "Gene expression in human liver cells", year: 2021 },
    ];
    expect(matchByTitle(w("Gene Expression in Human Liver Cells", 2021), dup)).toBeNull();
  });

  it("withReciterAccepted adds ACCEPTED PMIDs our publications lack, and only those", () => {
    const base = indexScholarWorks(JANE_PAPERS);
    const { works, added } = withReciterAccepted(base, RECITER);
    expect(works.get("jd0001")!.get("pmid:201")).toBe("201");
    expect(works.get("jd0001")!.has("pmid:202")).toBe(false);
    expect([...added.get("jd0001")!]).toEqual(["201"]);
    expect(base.get("jd0001")!.has("pmid:201")).toBe(false); // input untouched
  });

  it("assembles statuses: accepted counts as shared, the rest split by status in the sample and counts", () => {
    const [row] = assemble({ titles: TITLES, reciter: RECITER });
    // Shared: 101 (held), 102 (title match), 201 (ReCiter accepted only).
    expect(row!.shared).toBe(3);
    expect(row!.worksTotal).toBe(8);
    expect(row!.newWorks).toBe(5);
    expect(row!.newWorksSample.map((w) => [w.title, w.status])).toEqual([
      ["A DOI-only paper", "not_in_pubmed"],
      ["Pending in ReCiter", "pending"],
      ["Rejected in ReCiter", "rejected"],
      ["Never retrieved by ReCiter", "not_retrieved"],
      ["A work with no identifiers", "no_ids"],
    ]);
    expect(row!.evidenceDetail.workStatus).toEqual({
      counts: { pending: 1, rejected: 1, not_retrieved: 1, not_in_pubmed: 1, no_ids: 1 },
      unknown: 0,
      reciterRead: true,
      acceptedInReciter: 1,
      resolvedByDoi: 0,
      resolvedByTitle: 1,
      pubmedUnknown: 0,
    });
  });

  it("ReCiter unreadable: no accepted lift, PMID works unknown, the row still written", () => {
    const [row] = assemble({ titles: TITLES });
    expect(row!.shared).toBe(2); // 101 + the title match
    expect(row!.newWorks).toBe(6);
    expect(row!.newWorksSample.find((w) => w.title === "Pending in ReCiter")!.status).toBeNull();
    expect(row!.evidenceDetail.workStatus).toMatchObject({
      counts: { not_in_pubmed: 1, no_ids: 1 },
      unknown: 4,
      reciterRead: false,
      acceptedInReciter: 0,
    });
  });

  it("a DOI resolved to the scholar's PMID moves the work from new to shared", () => {
    const f = withResolvedPmids(recordFacts(ORCID, statusRecord()), new Map([["10.1/q", "103"]]));
    const [row] = assemble({ facts: new Map([[ORCID, f]]), reciter: RECITER, titles: TITLES });
    expect(row!.shared).toBe(4);
    expect(row!.newWorks).toBe(4);
    expect(row!.evidenceDetail.workStatus!.resolvedByDoi).toBe(1);
    expect(row!.evidenceDetail.workStatus!.counts.not_in_pubmed).toBeUndefined();
  });

  it("an NCBI outage (fetch rejects): the DOI-only work is unknown, not 'not in PubMed'", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as FetchFn;
    const resolver = createPmidResolver({ fetchFn, delayMs: 0, retryBaseMs: 0 });
    const facts = recordFacts(ORCID, statusRecord());
    const f = withResolvedPmids(facts, await resolver.resolve(doisToResolve([facts])));
    const [row] = assemble({ facts: new Map([[ORCID, f]]), reciter: RECITER, titles: TITLES });
    const doiOnly = row!.newWorksSample.find((w) => w.title === "A DOI-only paper")!;
    expect(doiOnly.status).toBeNull();
    expect(row!.evidenceDetail.workStatus).toMatchObject({
      counts: { pending: 1, rejected: 1, not_retrieved: 1, no_ids: 1 },
      unknown: 1,
      pubmedUnknown: 1,
    });
    expect(row!.evidenceDetail.workStatus!.counts.not_in_pubmed).toBeUndefined();
  });
});
