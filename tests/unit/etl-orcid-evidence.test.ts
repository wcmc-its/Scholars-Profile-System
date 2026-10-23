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

import {
  assembleEvidence,
  autoConfirmStep,
  bandOf,
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
  ])("record %s agrees with scholar %s", (family, full) => {
    expect(surnamesAgree(family, scholar(full))).toBe(true);
  });

  it("different surnames, a short shared token, and no family name do not agree", () => {
    expect(surnamesAgree("Smith", scholar("Jane Doe"))).toBe(false);
    expect(surnamesAgree("Li", scholar("Wei Li Wang"))).toBe(false);
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
    expect(f.orgs).toEqual([{ name: "Example Medical College", ror: "https://ror.org/02r109517" }]);
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
        { title: "Elsewhere", year: 2024, doi: "10.1/z", pmid: null, source: "Example Repository" },
      ],
    });
  });

  it("assembles one email_verified row: shared counts papers once, on-file and unfetched pairs get none", () => {
    const rows = assembleEvidence({
      pairs: [
        { cwid: "jd0001", orcid: ORCID },
        { cwid: "jd0001", orcid: ORCID_2 }, // no record fetched
      ],
      onFile: new Set(),
      facts: new Map([[ORCID, f]]),
      scholars: new Map([["jd0001", JANE]]),
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
    expect(r).toEqual({ competitor: true, cwids: ["b"], orcids: [] });
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
    expect(r).toEqual({ competitor: true, cwids: [], orcids: [ORCID_2] });
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
    expect(r).toEqual({ competitor: true, cwids: ["c"], orcids: [] });
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
