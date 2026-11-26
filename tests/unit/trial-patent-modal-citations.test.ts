/** The publication modal's "Trials and patents" payload: the two flag gates,
 *  the pure shaping (lib/citations/trials-patents.ts) and the read beside
 *  `readPolicyCitations`. PMIDs, NCT numbers, patent numbers, people, sponsors
 *  and assignees are invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ publication: vi.fn(), links: vi.fn() }));
vi.mock("@/lib/db", () => {
  const none = () => vi.fn(async () => []);
  return {
    prisma: {
      publication: { findUnique: h.publication },
      publicationCitingDocument: { findMany: h.links },
      subtopic: { findMany: none() },
      suppression: { findMany: none() },
      publicationAuthor: { findMany: none() },
      scholarFamily: { findMany: none() },
      publicationCiting: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
      familySuppressionOverlay: { findMany: none() },
      familySensitivityOverlay: { findMany: none() },
      publicationCore: { findMany: none() },
      coreClaim: { findMany: none() },
      core: { findMany: none() },
    },
    db: { read: { coreClaim: { findMany: none() } } },
  };
});
vi.mock("@/lib/sources/reciterdb", () => ({
  withReciterConnection: vi.fn(async (fn: (conn: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => []) }),
  ),
}));

import { getPublicationDetail, readTrialPatentCitations } from "@/lib/api/publication-detail";
import {
  representativePatent,
  shapeTrialPatentCitations,
  TRIAL_PATENT_CAP,
  trialDisplay,
  type TrialPatentLink,
} from "@/lib/citations/trials-patents";

const BOTH = { trials: true, patents: true };
let nextId = 1;

function trial(over: {
  nct?: string;
  year?: number | null;
  details?: Record<string, unknown>;
  own?: boolean;
  url?: string;
}): TrialPatentLink {
  const nct = over.nct ?? `NCT9${String(nextId).padStart(7, "0")}`;
  return {
    evidence: over.own ? { ownTrial: true } : null,
    citingDocument: {
      id: nextId++,
      level: "trial",
      externalId: nct,
      title: `Trial ${nct}`,
      year: over.year === undefined ? 2031 : over.year,
      url: over.url ?? `https://clinicaltrials.gov/study/${nct}`,
      dedupKey: nct,
      details: {
        phase: "PHASE2/PHASE3",
        sponsor: "Example University",
        sponsorClass: "OTHER",
        status: "RECRUITING",
        studyType: "INTERVENTIONAL",
        startDate: "2031-04",
        ...over.details,
      },
    },
  };
}

function patent(over: {
  id: string;
  family: string;
  grantDate?: string | null;
  publicationDate?: string | null;
  assignees?: string[];
  inventors?: Array<{ first: string; last: string }>;
  url?: string;
  title?: string;
}): TrialPatentLink {
  const display = over.id.replace(/-/g, "").toUpperCase();
  return {
    evidence: { score: 10, where: "front", release: "zenodo:0" },
    citingDocument: {
      id: nextId++,
      level: "patent",
      externalId: over.id,
      title: over.title ?? `Patent ${over.id}`,
      year: Number((over.grantDate ?? over.publicationDate ?? "").slice(0, 4)) || null,
      url: over.url ?? `https://patents.google.com/patent/${display}/en`,
      dedupKey: over.family,
      details: {
        kind: over.grantDate ? "grant" : "application",
        grantDate: over.grantDate ?? null,
        publicationDate: over.publicationDate ?? null,
        filingDate: null,
        familyKey: over.family,
        familySize: 9,
        assignees: over.assignees ?? ["Example Therapeutics, Inc."],
        inventors: over.inventors ?? [
          { first: "Ada", last: "Example" },
          { first: "Ben", last: "Sample" },
        ],
        metadataRelease: "2031-01-01",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  delete process.env.TRIAL_CITATIONS_MODAL;
  delete process.env.PATENT_CITATIONS_MODAL;
  delete process.env.POLICY_CITATION_BADGES;
});

describe("trialDisplay", () => {
  it.each([
    ["PHASE2/PHASE3", "Phase 2/3"],
    ["PHASE1/PHASE2", "Phase 1/2"],
    ["PHASE4", "Phase 4"],
    ["EARLY_PHASE1", "Early phase 1"],
    ["NA", null],
    ["", null],
    [null, null],
  ])("phase %s reads %s", (raw, shown) => {
    expect(trialDisplay({ phase: raw }).phase).toBe(shown);
  });

  it.each([
    ["RECRUITING", "Recruiting"],
    ["NOT_YET_RECRUITING", "Not yet recruiting"],
    ["ACTIVE_NOT_RECRUITING", "Active not recruiting"],
    ["ENROLLING_BY_INVITATION", "Enrolling by invitation"],
    ["COMPLETED", "Completed"],
    ["UNKNOWN", "Unknown status"],
    [undefined, null],
  ])("status %s reads %s", (raw, shown) => {
    expect(trialDisplay({ status: raw }).status).toBe(shown);
  });
});

describe("representativePatent", () => {
  const doc = (externalId: string, grantDate: string | null, publicationDate: string | null) => ({
    externalId,
    grantDate,
    publicationDate,
  });

  it("is the earliest granted patent, whatever the applications' dates", () => {
    const docs = [
      doc("us-20290000001-a1", null, "2029-01-01"),
      doc("us-90000003-b2", "2033-05-01", null),
      doc("us-90000002-b2", "2031-05-01", null),
    ];
    expect(representativePatent(docs)?.externalId).toBe("us-90000002-b2");
  });

  it("is the earliest application when nothing in the group is granted", () => {
    const docs = [
      doc("us-20320000002-a1", null, "2032-02-01"),
      doc("us-20300000001-a1", null, "2030-02-01"),
      doc("us-20310000009-a1", null, null),
    ];
    expect(representativePatent(docs)?.externalId).toBe("us-20300000001-a1");
  });

  it("does not depend on row order when two dates tie", () => {
    const a = doc("us-90000005-b2", "2031-05-01", null);
    const b = doc("us-90000004-b2", "2031-05-01", null);
    expect(representativePatent([a, b])?.externalId).toBe("us-90000004-b2");
    expect(representativePatent([b, a])?.externalId).toBe("us-90000004-b2");
  });

  it("is undefined for an empty group", () => {
    expect(representativePatent([])).toBeUndefined();
  });
});

describe("shapeTrialPatentCitations — trials", () => {
  it("lists a trial with display values, newest first", () => {
    const out = shapeTrialPatentCitations(
      [trial({ nct: "NCT90000001", year: 2029 }), trial({ nct: "NCT90000002", year: 2032 })],
      BOTH,
    )!;
    expect(out.inventions).toBeUndefined();
    expect(out.trials!.items.map((t) => t.nctId)).toEqual(["NCT90000002", "NCT90000001"]);
    expect(out.trials!.items[0]).toEqual({
      id: 2,
      title: "Trial NCT90000002",
      url: "https://clinicaltrials.gov/study/NCT90000002",
      sponsor: "Example University",
      phase: "Phase 2/3",
      status: "Recruiting",
      startYear: 2032,
      nctId: "NCT90000002",
      ownTrial: false,
    });
  });

  it("lists the authors' own trial, marked, and leaves it out of the count", () => {
    const out = shapeTrialPatentCitations([trial({}), trial({ own: true }), trial({})], BOTH)!;
    expect(out.trials!.items.map((t) => t.ownTrial)).toEqual([false, true, false]);
    expect(out.trials!.count).toBe(2);
    expect(out.trials!.total).toBe(3);
  });

  it("reads evidence and details stored as JSON text", () => {
    const row = trial({ own: true });
    row.evidence = JSON.stringify(row.evidence);
    row.citingDocument.details = JSON.stringify(row.citingDocument.details);
    const [t] = shapeTrialPatentCitations([row], BOTH)!.trials!.items;
    expect([t.ownTrial, t.phase, t.sponsor]).toEqual([true, "Phase 2/3", "Example University"]);
  });

  it("a trial with no phase, start year or details still lists", () => {
    const bare = trial({ year: null });
    bare.citingDocument.details = null;
    const out = shapeTrialPatentCitations([trial({ details: { phase: null } }), bare], BOTH)!;
    expect(out.trials!.items[0].phase).toBeNull();
    expect(out.trials!.items[1]).toMatchObject({ phase: null, status: null, sponsor: null, startYear: null });
  });

  it("sends the first 50 with the true totals", () => {
    const rows = Array.from({ length: 88 }, (_, i) => trial({ year: 2000 + (i % 30), own: i === 0 }));
    const out = shapeTrialPatentCitations(rows, BOTH)!;
    expect(out.trials!.items).toHaveLength(TRIAL_PATENT_CAP);
    expect(out.trials!.count).toBe(87);
    expect(out.trials!.total).toBe(88);
    expect(out.trials!.items[0].startYear).toBe(2029);
  });
});

describe("shapeTrialPatentCitations — inventions", () => {
  it("lists one entry per invention key, shown as its representative patent", () => {
    const out = shapeTrialPatentCitations(
      [
        patent({ id: "us-20290000001-a1", family: "F1", publicationDate: "2029-03-01" }),
        patent({ id: "us-90000002-b2", family: "F1", grantDate: "2031-06-01", title: "Widget assay" }),
        patent({ id: "us-90000003-b2", family: "F1", grantDate: "2033-06-01" }),
        patent({ id: "us-90000004-b1", family: "F2", grantDate: "2034-01-01" }),
      ],
      BOTH,
    )!;
    expect(out.trials).toBeUndefined();
    expect(out.inventions!.total).toBe(2);
    // Newest first, by the representative's year.
    expect(out.inventions!.items.map((i) => i.number)).toEqual(["US 90000004 B1", "US 90000002 B2"]);
    expect(out.inventions!.items[1]).toEqual({
      id: 2,
      title: "Widget assay",
      url: "https://patents.google.com/patent/US90000002B2/en",
      holder: "Example Therapeutics, Inc.",
      year: 2031,
      granted: true,
      number: "US 90000002 B2",
      related: 2,
    });
    expect(out.inventions!.items[0].related).toBe(0);
  });

  it("an application with no assignee shows its first inventor, et al.", () => {
    const rows = [
      // The dataset's ten-digit pre-grant id; USPTO's number has eleven.
      patent({ id: "us-2030000001-a1", family: "F1", publicationDate: "2030-02-01", assignees: [] }),
      patent({
        id: "us-20310000002-a1",
        family: "F2",
        publicationDate: "2031-02-01",
        assignees: [],
        inventors: [{ first: "Cy", last: "Solo" }],
      }),
      patent({ id: "us-20320000003-a1", family: "F3", publicationDate: "2032-02-01", assignees: [], inventors: [] }),
    ];
    const items = shapeTrialPatentCitations(rows, BOTH)!.inventions!.items;
    expect(items.map((i) => [i.holder, i.granted, i.year, i.number])).toEqual([
      [null, false, 2032, "US 20320000003 A1"],
      ["Cy Solo", false, 2031, "US 20310000002 A1"],
      ["Ada Example et al.", false, 2030, "US 20300000001 A1"],
    ]);
  });

  it("names every assignee the patent lists", () => {
    const [i] = shapeTrialPatentCitations(
      [patent({ id: "us-90000001-b2", family: "F1", grantDate: "2031-01-01", assignees: ["Example A", "Example B"] })],
      BOTH,
    )!.inventions!.items;
    expect(i.holder).toBe("Example A; Example B");
  });

  it("sends the first 50 inventions with the true total", () => {
    const rows = Array.from({ length: 130 }, (_, i) =>
      patent({ id: `us-9${String(i).padStart(7, "0")}-b2`, family: `F${i % 65}`, grantDate: `${1990 + (i % 65)}-01-01` }),
    );
    const out = shapeTrialPatentCitations(rows, BOTH)!;
    expect(out.inventions!.items).toHaveLength(TRIAL_PATENT_CAP);
    expect(out.inventions!.total).toBe(65);
    expect(out.inventions!.items[0]).toMatchObject({ year: 2054, related: 1 });
  });
});

describe("shapeTrialPatentCitations — links and gates", () => {
  it("only links out to ClinicalTrials.gov and the importer's patent host", () => {
    const out = shapeTrialPatentCitations(
      [
        trial({ nct: "NCT90000001", url: "https://clinicaltrials.gov.example.org/study/NCT90000001" }),
        trial({ nct: "NCT90000002", url: "http://clinicaltrials.gov/study/NCT90000002" }),
        trial({ nct: "NCT90000003", url: "javascript:alert(1)" }),
        trial({ nct: "NCT90000004" }),
        patent({ id: "us-90000001-b2", family: "F1", grantDate: "2031-01-01", url: "https://example.org/US90000001B2" }),
        patent({ id: "us-90000002-b2", family: "F2", grantDate: "2030-01-01" }),
      ],
      BOTH,
    )!;
    expect(out.trials!.items.map((t) => t.url)).toEqual([
      null,
      null,
      null,
      "https://clinicaltrials.gov/study/NCT90000004",
    ]);
    expect(out.inventions!.items.map((i) => i.url)).toEqual([
      null,
      "https://patents.google.com/patent/US90000002B2/en",
    ]);
  });

  it("leaves out a group whose flag is off, whatever the rows hold", () => {
    const rows = [trial({}), patent({ id: "us-90000001-b2", family: "F1", grantDate: "2031-01-01" })];
    expect(Object.keys(shapeTrialPatentCitations(rows, { trials: true, patents: false })!)).toEqual(["trials"]);
    expect(Object.keys(shapeTrialPatentCitations(rows, { trials: false, patents: true })!)).toEqual(["inventions"]);
    expect(shapeTrialPatentCitations(rows, { trials: false, patents: false })).toBeUndefined();
  });

  it("is undefined when nothing cites the paper", () => {
    expect(shapeTrialPatentCitations([], BOTH)).toBeUndefined();
  });
});

describe("readTrialPatentCitations", () => {
  it("does not touch the database with both flags off", async () => {
    expect(await readTrialPatentCitations("111", { trials: false, patents: false })).toBeUndefined();
    expect(h.links).not.toHaveBeenCalled();
  });

  it.each([
    [{ trials: true, patents: false }, ["trial"]],
    [{ trials: false, patents: true }, ["patent"]],
    [BOTH, ["trial", "patent"]],
  ])("asks only for the levels whose flag is on: %j", async (on, levels) => {
    h.links.mockResolvedValueOnce([]);
    expect(await readTrialPatentCitations("111", on)).toBeUndefined();
    expect(h.links.mock.calls[0][0].where).toEqual({ pmid: "111", citingDocument: { level: { in: levels } } });
  });

  it("is null on a read failure, so the modal omits the section", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.links.mockRejectedValueOnce(new Error("down"));
    expect(await readTrialPatentCitations("111", BOTH)).toBeNull();
    error.mockRestore();
  });
});

describe("getPublicationDetail — trial and patent flags", () => {
  const pub = {
    pmid: "111",
    title: "Test paper",
    journal: "J. Test",
    year: 2024,
    volume: "1",
    issue: "2",
    pages: "10-20",
    fullAuthorsString: "Example A, Sample B",
    abstract: "An abstract.",
    impactScore: 75,
    impactJustification: "Novel.",
    citationCount: 42,
    pmcid: null,
    doi: null,
    pubmedUrl: null,
    meshTerms: [],
    synopsis: null,
    publicationTopics: [],
  };
  const rows = () => [trial({}), patent({ id: "us-90000001-b2", family: "F1", grantDate: "2031-01-01" })];

  beforeEach(() => {
    h.publication.mockResolvedValue(pub);
    h.links.mockImplementation(async () => rows());
  });

  it("with both off the payload is what it is with no rows at all, and nothing is read", async () => {
    const off = JSON.stringify(await getPublicationDetail("111"));
    expect(h.links).not.toHaveBeenCalled();
    expect(off).not.toContain("trialPatentCitations");

    process.env.TRIAL_CITATIONS_MODAL = "off";
    process.env.PATENT_CITATIONS_MODAL = "true";
    expect(JSON.stringify(await getPublicationDetail("111"))).toBe(off);
    expect(h.links).not.toHaveBeenCalled();

    // On, with nothing citing the paper: still the same bytes.
    process.env.TRIAL_CITATIONS_MODAL = "on";
    process.env.PATENT_CITATIONS_MODAL = "on";
    h.links.mockImplementation(async () => []);
    expect(JSON.stringify(await getPublicationDetail("111"))).toBe(off);
  });

  it("the trial flag alone adds the trials and no inventions", async () => {
    process.env.TRIAL_CITATIONS_MODAL = "on";
    const payload = (await getPublicationDetail("111"))!;
    expect(h.links.mock.calls[0][0].where.citingDocument).toEqual({ level: { in: ["trial"] } });
    expect(payload.trialPatentCitations?.trials?.count).toBe(1);
    expect(payload.trialPatentCitations?.inventions).toBeUndefined();
    expect(payload.policyCitations).toBeUndefined();
  });

  it("the patent flag alone adds the inventions and no trials", async () => {
    process.env.PATENT_CITATIONS_MODAL = "on";
    const payload = (await getPublicationDetail("111"))!;
    expect(h.links.mock.calls[0][0].where.citingDocument).toEqual({ level: { in: ["patent"] } });
    expect(payload.trialPatentCitations?.inventions?.total).toBe(1);
    expect(payload.trialPatentCitations?.trials).toBeUndefined();
  });

  it("neither kind of row enters policyCitations when every flag is on", async () => {
    process.env.TRIAL_CITATIONS_MODAL = "on";
    process.env.PATENT_CITATIONS_MODAL = "on";
    process.env.POLICY_CITATION_BADGES = "on";
    // The policy read names the ranked levels; the store would return nothing for them here.
    h.links.mockImplementation(async (args: { where: { citingDocument: { level: { in: string[] } } } }) =>
      args.where.citingDocument.level.in.includes("trial") ? rows() : [],
    );
    const payload = (await getPublicationDetail("111"))!;
    expect(payload.policyCitations).toBeUndefined();
    expect(Object.keys(payload.trialPatentCitations!)).toEqual(["trials", "inventions"]);
  });
});
