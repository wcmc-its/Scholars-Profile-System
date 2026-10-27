/**
 * #3071 — the shared evidence builder (`etl/reporter-grants/evidence.ts`),
 * which both the ETL and the read-only replay call. Fixture people and awards
 * are invented.
 */
import { describe, expect, it } from "vitest";

import { buildAwardEvidence, buildScholarFacts, firstHeldYear } from "@/etl/reporter-grants/evidence";
import { scoreAttribution } from "@/etl/reporter-grants/score";
import type { ReporterPI } from "@/etl/nih-profile/fetcher";

const pi = (profile_id: number, first: string, middle: string | null, last: string): ReporterPI =>
  ({
    profile_id,
    first_name: first,
    middle_name: middle,
    last_name: last,
    full_name: [first, middle, last].filter(Boolean).join(" "),
    is_contact_pi: true,
  }) as unknown as ReporterPI;

const facts = (over: Partial<Parameters<typeof buildScholarFacts>[0]> = {}) =>
  buildScholarFacts({
    names: { fullName: "Pat Q Example", preferredName: "Pat Example" },
    confirmed: [{ pmid: "1001", publication: { authorsString: "Example PQ, Other AB", meshTerms: [] } }],
    educations: [{ degree: "M.D.", institution: "Example University", year: 2000 }],
    profileIds: [11],
    rejected: new Set(["2002"]),
    ...over,
  });

const group = (over: Partial<Parameters<typeof buildAwardEvidence>[0]["group"]> = {}) => ({
  coreProjectNum: "T32XX000001",
  orgName: "EXAMPLE UNIVERSITY",
  orgHistory: [
    { orgName: "EXAMPLE UNIVERSITY", fiscalYear: 2012 },
    { orgName: "EXAMPLE UNIVERSITY", fiscalYear: 2010 },
  ],
  pis: [pi(11, "PAT", "Q", "EXAMPLE")],
  ...over,
});

const build = (over: Partial<Parameters<typeof buildAwardEvidence>[0]> = {}) =>
  buildAwardEvidence({
    policy: "publication-only",
    facts: facts(),
    group: group(),
    linkedViaGrantPub: false,
    linked: new Set(["2002", "3003"]),
    linkedRestricted: false,
    infoedOthers: [],
    meshUis: [],
    ...over,
  });

describe("firstHeldYear", () => {
  it("is the scholar's earliest fiscal year on the core, not the project start", () => {
    expect(firstHeldYear([{ fiscalYear: 2012 }, { fiscalYear: 2010 }, { fiscalYear: null }])).toBe(2010);
    expect(firstHeldYear([{ fiscalYear: null }])).toBeNull();
  });
});

describe("buildAwardEvidence", () => {
  it("takes cue 3's start from the scholar's own first year", () => {
    expect(build().evidence.startYear).toBe(2010);
  });

  it("counts cue 2 against the true link set, or as unknown when the core was restricted", () => {
    expect(build().evidence.rejected).toEqual({ overlap: 1, linkedTotal: 2, pmids: ["2002"] });
    expect(build({ linkedRestricted: true }).evidence.rejected).toEqual({
      overlap: 1,
      linkedTotal: null,
      pmids: ["2002"],
    });
    expect(build({ facts: facts({ rejected: null }) }).evidence.rejected).toBeNull();
  });

  it("links a confirmed paper through RePORTER or grant_publication", () => {
    expect(build().evidence.publicationLinked).toBe(false);
    expect(build({ linked: new Set(["1001"]) }).evidence.publicationLinked).toBe(true);
    expect(build({ linkedViaGrantPub: true }).evidence.publicationLinked).toBe(true);
  });

  it("is revocable only with our PI on the award and a scholar name on file", () => {
    expect(build().revocable).toBe(true);
    expect(build({ group: group({ pis: [] }) }).revocable).toBe(false);
    expect(build({ group: group({ pis: [pi(99, "OTHER", "Z", "PERSON")] }) }).revocable).toBe(false);
    expect(build({ facts: facts({ names: undefined }) }).revocable).toBe(false);
  });
});

describe("cue 6 detail (#3071 queue)", () => {
  it("names the co-PI who shares the most papers and keeps those PMIDs", () => {
    const f = facts({
      confirmed: [
        { pmid: "1", publication: { authorsString: "Example PQ, Sample L", meshTerms: [] } },
        { pmid: "2", publication: { authorsString: "Sample L, Example PQ, Other A", meshTerms: [] } },
        { pmid: "3", publication: { authorsString: "Other A, Example PQ", meshTerms: [] } },
      ],
    });
    const { evidence } = build({
      facts: f,
      group: group({ pis: [pi(11, "PAT", "Q", "EXAMPLE"), pi(22, "LEE", null, "SAMPLE"), pi(33, "ANN", null, "OTHER")] }),
    });
    expect(evidence.coPiSharedPapers).toBe(2);
    expect(evidence.coPi).toEqual({ name: "LEE SAMPLE", pmids: ["1", "2"] });
    const hit = scoreAttribution(evidence).reasons.find((r) => r.id === "copi_coauthor");
    expect(hit?.coPi).toEqual({ name: "LEE SAMPLE", pmids: ["1", "2"], total: 2 });
  });

  it("records nothing for a single-PI award or a co-PI with no shared papers", () => {
    expect(build().evidence.coPi).toBeNull();
    expect(build({ group: group({ pis: [pi(11, "PAT", "Q", "EXAMPLE"), pi(22, "NO", null, "MATCH")] }) }).evidence.coPi).toBeNull();
  });
});
