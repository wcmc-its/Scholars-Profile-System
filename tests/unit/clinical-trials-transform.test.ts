import { describe, it, expect } from "vitest";
import {
  buildTrialsAndLinks,
  cleanNct,
  fetchCtgovStudies,
  parseLooseDate,
  type CtgovStudy,
  type EnrichedRow,
  type InstitutionalRow,
} from "@/etl/clinical-trials/shared";

const NOW = new Date("2026-06-19T00:00:00.000Z");

function inst(p: Partial<InstitutionalRow>): InstitutionalRow {
  return {
    cwid: null,
    nctNumber: null,
    protocolNumber: null,
    piName: null,
    title: null,
    protocolType: null,
    firstOTADate: null,
    firstCTADate: null,
    statusDate: null,
    principalSponsor: null,
    overallCurrentStatus: null,
    ...p,
  };
}

describe("parseLooseDate", () => {
  it("parses M/D/YY and M/D/YYYY", () => {
    expect(parseLooseDate("3/15/24")?.toISOString().slice(0, 10)).toBe("2024-03-15");
    expect(parseLooseDate("12/1/2023")?.toISOString().slice(0, 10)).toBe("2023-12-01");
  });
  it("parses ISO and rejects junk/empty", () => {
    expect(parseLooseDate("2022-07-04")?.toISOString().slice(0, 10)).toBe("2022-07-04");
    expect(parseLooseDate("")).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
    expect(parseLooseDate("not a date")).toBeNull();
  });
});

describe("cleanNct", () => {
  it("canonicalizes real NCT ids to uppercase", () => {
    expect(cleanNct("nct04487730")).toBe("NCT04487730");
    expect(cleanNct(" NCT00001234 ")).toBe("NCT00001234");
  });
  it("maps placeholders and junk to null", () => {
    expect(cleanNct("NA")).toBeNull();
    expect(cleanNct("N/A")).toBeNull();
    expect(cleanNct("")).toBeNull();
    expect(cleanNct(null)).toBeNull();
    expect(cleanNct("pending")).toBeNull();
  });
});

describe("buildTrialsAndLinks", () => {
  // Keyed by LOWERCASED cwid; value carries the canonical scholar.cwid (see
  // loadScholars). scholar.cwid is lowercase; clinical_trials.cwid is uppercase.
  const scholars = new Map<string, { cwid: string; name: string }>([
    ["abc1234", { cwid: "abc1234", name: "Jane Smith" }],
    ["def5678", { cwid: "def5678", name: "Robert Jones" }],
  ]);

  it("dedupes one trial per protocol, links each investigator as PI, merges enrichment", () => {
    const institutional: InstitutionalRow[] = [
      inst({
        cwid: "abc1234",
        protocolNumber: "P-001",
        nctNumber: "NCT00001",
        piName: "Smith, Jane",
        title: "Institutional title",
        overallCurrentStatus: "Recruiting",
        statusDate: "3/15/24",
      }),
      // same protocol, second WCM investigator who is NOT the PI
      inst({
        cwid: "def5678",
        protocolNumber: "P-001",
        nctNumber: "NCT00001",
        piName: "Smith, Jane",
      }),
    ];
    const enriched: EnrichedRow[] = [
      {
        nctNumber: "NCT00001",
        officialTitle: "Official enriched title",
        briefTitle: "Brief",
        briefSummary: "A summary.",
        studyType: "Interventional",
        phases: "Phase 2",
        conditions: "Cancer",
        meshTerms: "Neoplasms",
        enrollment: "120",
      },
    ];

    const { trials, links, stats } = buildTrialsAndLinks(institutional, enriched, scholars, NOW);

    expect(stats.trials).toBe(1);
    expect(stats.links).toBe(2);
    expect(stats.enrichedHits).toBe(2); // both rows resolved the same NCT

    const trial = trials[0];
    expect(trial.protocolNumber).toBe("P-001");
    expect(trial.title).toBe("Official enriched title"); // enriched wins
    expect(trial.phase).toBe("Phase 2");
    expect(trial.enrollment).toBe(120);
    expect(trial.enrichmentSource).toBe("ClinicalTrials.gov");
    expect(trial.statusDate?.toISOString().slice(0, 10)).toBe("2024-03-15");

    // The feed lists the active PI only: no name heuristic, every link is PI.
    expect(links.map((l) => l.role)).toEqual(["Principal Investigator", "Principal Investigator"]);
  });

  it("skips rows without a protocol and with cwids not in the scholar set", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: null }), // no protocol
      inst({ cwid: "zzz9999", protocolNumber: "P-002" }), // unknown cwid
    ];
    const { trials, links, stats } = buildTrialsAndLinks(institutional, [], scholars, NOW);
    expect(trials).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(stats.skippedNoProtocol).toBe(1);
    expect(stats.skippedUnknownCwid).toBe(1);
  });

  it("falls back to institutional title and null enrichment when no NCT match", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: "P-003", title: "Only institutional" }),
    ];
    const { trials } = buildTrialsAndLinks(institutional, [], scholars, NOW);
    expect(trials[0].title).toBe("Only institutional");
    expect(trials[0].enrichmentSource).toBeNull();
    expect(trials[0].enrichedAt).toBeNull();
  });

  it("treats the 'NA' nctNumber placeholder as null (no bogus id, no enrichment)", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: "P-200", nctNumber: "NA", title: "Local only" }),
    ];
    const { trials } = buildTrialsAndLinks(institutional, [], scholars, NOW);
    expect(trials[0].nctNumber).toBeNull();
    expect(trials[0].enrichmentSource).toBeNull();
  });

  it("allows two protocols to share one real NCT (nctNumber is not unique)", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: "P-301", nctNumber: "NCT04487730" }),
      inst({ cwid: "def5678", protocolNumber: "P-302", nctNumber: "NCT04487730" }),
    ];
    const { trials } = buildTrialsAndLinks(institutional, [], scholars, NOW);
    expect(trials).toHaveLength(2);
    expect(trials.every((t) => t.nctNumber === "NCT04487730")).toBe(true);
  });

  it("matches UPPERCASE institutional cwids case-insensitively and stores the canonical (lowercase) cwid", () => {
    // clinical_trials.cwid is uppercase (e.g. "ABC1234"); scholar.cwid is "abc1234".
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "ABC1234", protocolNumber: "P-100", piName: "Smith, Jane" }),
    ];
    const { trials, links, stats } = buildTrialsAndLinks(institutional, [], scholars, NOW);
    expect(stats.skippedUnknownCwid).toBe(0);
    expect(trials).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0].cwid).toBe("abc1234"); // canonical scholar.cwid, not the uppercase source
    expect(links[0].role).toBe("Principal Investigator");
  });
});

describe("ClinicalTrials.gov live enrichment + CTA rule", () => {
  const scholars = new Map([["abc1234", { cwid: "abc1234", name: "Jane Smith" }]]);
  const study = (p: Partial<CtgovStudy>): CtgovStudy => ({
    nctNumber: "NCT00001",
    officialTitle: null,
    briefTitle: null,
    briefSummary: null,
    studyType: null,
    phases: null,
    conditions: null,
    meshTerms: null,
    enrollment: null,
    primaryCompletionActual: null,
    leadSponsorClass: null,
    ...p,
  });
  const row = (p: Partial<InstitutionalRow>) =>
    inst({ cwid: "abc1234", protocolNumber: "P-1", nctNumber: "NCT00001", firstCTADate: "2020-01-01", ...p });
  const cta = (r: InstitutionalRow, ctgov?: { studies: Map<string, CtgovStudy>; complete: boolean }) =>
    buildTrialsAndLinks([r], [], scholars, NOW, ctgov).trials[0].firstCtaDate?.toISOString().slice(0, 10) ?? null;

  it("prefers the live CT.gov study over the reciterdb enriched row", () => {
    const enriched: EnrichedRow[] = [{ ...study({ officialTitle: "Stale" }) }];
    const ctgov = { studies: new Map([["NCT00001", study({ officialTitle: "Live" })]]), complete: true };
    expect(buildTrialsAndLinks([row({})], enriched, scholars, NOW, ctgov).trials[0].title).toBe("Live");
  });

  it("keeps the OnCore CTA date for active and suspended trials", () => {
    const ctgov = { studies: new Map([["NCT00001", study({ primaryCompletionActual: "2023-05-01" })]]), complete: true };
    expect(cta(row({ overallCurrentStatus: "OPEN TO ACCRUAL" }), ctgov)).toBe("2020-01-01");
    expect(cta(row({ overallCurrentStatus: "SUSPENDED" }), ctgov)).toBe("2020-01-01");
  });

  it("inactive trials take the CT.gov ACTUAL primary completion date, else null", () => {
    const withDate = { studies: new Map([["NCT00001", study({ primaryCompletionActual: "2023-05-01" })]]), complete: true };
    const noDate = { studies: new Map([["NCT00001", study({})]]), complete: true };
    expect(cta(row({ overallCurrentStatus: "IRB STUDY CLOSURE" }), withDate)).toBe("2023-05-01");
    expect(cta(row({ overallCurrentStatus: "CLOSED TO ACCRUAL" }), noDate)).toBeNull();
    expect(cta(row({ overallCurrentStatus: "CLOSED TO ACCRUAL", nctNumber: "NA" }), withDate)).toBeNull();
  });

  it("keeps OnCore's CTA for an inactive trial CT.gov failed to return (can't tell missing from not fetched)", () => {
    const failed = { studies: new Map<string, CtgovStudy>(), complete: false };
    expect(cta(row({ overallCurrentStatus: "IRB STUDY CLOSURE" }), failed)).toBe("2020-01-01");
  });

  describe("sponsorClass", () => {
    const cls = (
      r: InstitutionalRow,
      ctgov?: { studies: Map<string, CtgovStudy>; complete: boolean },
    ) => buildTrialsAndLinks([r], [], scholars, NOW, ctgov).trials[0].sponsorClass;

    it("takes CT.gov LeadSponsorClass for a registered trial, over OnCore's name", () => {
      const ctgov = {
        studies: new Map([["NCT00001", study({ leadSponsorClass: "NETWORK" })]]),
        complete: true,
      };
      expect(cls(row({ principalSponsor: "Acme Pharmaceuticals Inc" }), ctgov)).toBe("network");
    });

    it("reads OnCore's principal sponsor for a trial with no NCT", () => {
      expect(cls(row({ nctNumber: "NA", principalSponsor: "Genentech, Inc." }))).toBe("industry");
      expect(cls(row({ nctNumber: null, principalSponsor: "Weill Cornell Medicine" }))).toBe(
        "academic",
      );
    });

    it("falls back to OnCore when CT.gov gives AMBIG/UNKNOWN or no study", () => {
      const ambig = {
        studies: new Map([["NCT00001", study({ leadSponsorClass: "UNKNOWN" })]]),
        complete: true,
      };
      expect(cls(row({ principalSponsor: "National Cancer Institute" }), ambig)).toBe("nih");
      expect(cls(row({ principalSponsor: "NRG Oncology" }))).toBe("network");
    });

    it("is null when neither source says", () => {
      expect(cls(row({ nctNumber: null, principalSponsor: null }))).toBeNull();
      expect(cls(row({ nctNumber: null, principalSponsor: "Dr. Smith" }))).toBeNull();
    });
  });
});

describe("fetchCtgovStudies", () => {
  const body = {
    studies: [
      {
        protocolSection: {
          identificationModule: { nctId: "NCT04472351", officialTitle: "Official", briefTitle: "Brief" },
          statusModule: { primaryCompletionDateStruct: { date: "2022-09-15", type: "ACTUAL" } },
          descriptionModule: { briefSummary: "Sum" },
          conditionsModule: { conditions: ["A", "B"] },
          designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE2"], enrollmentInfo: { count: 27 } },
          sponsorCollaboratorsModule: { leadSponsor: { class: "INDUSTRY" } },
        },
        derivedSection: { conditionBrowseModule: { meshes: [{ term: "Cognitive Dysfunction" }] } },
      },
      {
        protocolSection: {
          identificationModule: { nctId: "NCT00000002" },
          statusModule: { primaryCompletionDateStruct: { date: "2027-01", type: "ESTIMATED" } },
        },
      },
    ],
  };

  it("maps the v2 shape to the enriched-row format; ESTIMATED dates are not actual", async () => {
    const fake = (async () => new Response(JSON.stringify(body))) as typeof fetch;
    const { studies, complete } = await fetchCtgovStudies(["NCT04472351", "NCT00000002"], fake);
    expect(complete).toBe(true);
    expect(studies.get("NCT04472351")).toMatchObject({
      officialTitle: "Official",
      conditions: "A; B",
      meshTerms: "Cognitive Dysfunction",
      phases: "PHASE2",
      enrollment: 27,
      primaryCompletionActual: "2022-09-15",
      leadSponsorClass: "INDUSTRY",
    });
    expect(studies.get("NCT00000002")?.primaryCompletionActual).toBeNull();
    expect(studies.get("NCT00000002")?.leadSponsorClass).toBeNull();
  });

  it("batches 100 ids per request and reports incomplete on a failed batch", async () => {
    const urls: string[] = [];
    let n = 0;
    const fake = (async (url: string) => {
      urls.push(url);
      return ++n === 2 ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ studies: [] }));
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: 150 }, (_, i) => `NCT${String(i).padStart(8, "0")}`);
    const { complete } = await fetchCtgovStudies(ids, fake);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get("filter.ids")?.split(",")).toHaveLength(100);
    expect(complete).toBe(false);
  });

  it("requests LeadSponsorClass in fields=", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ studies: [] }));
    }) as unknown as typeof fetch;
    await fetchCtgovStudies(["NCT00000001"], fake);
    expect(new URL(urls[0]).searchParams.get("fields")?.split(",")).toContain("LeadSponsorClass");
  });
});
