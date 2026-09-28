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
      prior?: Map<string, string | null>,
    ) => buildTrialsAndLinks([r], [], scholars, NOW, ctgov, prior).trials[0].sponsorClass;

    it("takes CT.gov LeadSponsorClass for a registered trial, over OnCore's name", () => {
      const ctgov = {
        studies: new Map([["NCT00001", study({ leadSponsorClass: "NETWORK" })]]),
        complete: true,
      };
      expect(cls(row({ principalSponsor: "Acme Pharmaceuticals Inc" }), ctgov)).toBe("network");
    });

    it("reads CT.gov's lead sponsor name to mark WCM-led OTHER trials", () => {
      const ctgov = {
        studies: new Map([
          [
            "NCT00001",
            study({
              leadSponsorClass: "OTHER",
              leadSponsorName: "Weill Medical College of Cornell University",
            }),
          ],
        ]),
        complete: true,
      };
      expect(cls(row({}), ctgov)).toBe("wcm");
    });

    it("reads OnCore's principal sponsor for a trial with no NCT", () => {
      expect(cls(row({ nctNumber: "NA", principalSponsor: "Genentech, Inc." }))).toBe("industry");
      expect(cls(row({ nctNumber: null, principalSponsor: "Weill Cornell Medicine" }))).toBe("wcm");
    });

    it("never reads OnCore's name for a registered trial (AMBIG/UNKNOWN, or not on CT.gov, is null)", () => {
      const ambig = {
        studies: new Map([["NCT00001", study({ leadSponsorClass: "UNKNOWN" })]]),
        complete: true,
      };
      expect(cls(row({ principalSponsor: "National Cancer Institute" }), ambig)).toBeNull();
      const absent = { studies: new Map<string, CtgovStudy>(), complete: true };
      expect(cls(row({ principalSponsor: "NRG Oncology" }), absent)).toBeNull();
    });

    it("keeps a registered trial's stored class when the CT.gov fetch failed or never ran", () => {
      const failed = { studies: new Map<string, CtgovStudy>(), complete: false };
      const prior = new Map<string, string | null>([["P-1", "industry"]]);
      const r = row({ protocolNumber: "P-1", principalSponsor: "Some Foundation" });
      expect(cls(r, failed, prior)).toBe("industry");
      // The bridge import: no CT.gov at all.
      expect(cls(r, undefined, prior)).toBe("industry");
      // No stored class (or a stale key): null, not a guess from OnCore.
      expect(cls(r, failed)).toBeNull();
      expect(cls(r, failed, new Map([["P-1", "bogus"]]))).toBeNull();
      // A complete fetch that lacks the study does not reuse the old class.
      expect(cls(r, { studies: new Map<string, CtgovStudy>(), complete: true }, prior)).toBeNull();
    });

    it("re-reads OnCore for a no-NCT trial even when a prior class is stored", () => {
      const prior = new Map<string, string | null>([["P-1", "industry"]]);
      const r = row({ protocolNumber: "P-1", nctNumber: null, principalSponsor: "NRG Oncology" });
      expect(cls(r, { studies: new Map<string, CtgovStudy>(), complete: false }, prior)).toBe(
        "network",
      );
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
          sponsorCollaboratorsModule: { leadSponsor: { class: "INDUSTRY", name: "Acme Inc" } },
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
      leadSponsorName: "Acme Inc",
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

  it("requests LeadSponsorClass and LeadSponsorName in fields=", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ studies: [] }));
    }) as unknown as typeof fetch;
    await fetchCtgovStudies(["NCT00000001"], fake);
    const fields = new URL(urls[0]).searchParams.get("fields")?.split(",");
    expect(fields).toContain("LeadSponsorClass");
    expect(fields).toContain("LeadSponsorName");
  });

  it("requests the enrichment fields in fields=", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ studies: [] }));
    }) as unknown as typeof fetch;
    await fetchCtgovStudies(["NCT00000001"], fake);
    const fields = new URL(urls[0]).searchParams.get("fields")?.split(",");
    for (const f of [
      "OverallStatus", "StartDate", "StartDateType", "PrimaryCompletionDate",
      "PrimaryCompletionDateType", "HasResults", "InterventionType", "InterventionName",
    ]) {
      expect(fields).toContain(f);
    }
  });

  // Shapes copied from a live v2 response (2026-09-28): hasResults is top-level
  // and explicitly false for a study without results; interventions repeat per arm.
  const enrichmentBody = {
    studies: [
      {
        protocolSection: {
          identificationModule: { nctId: "NCT04102020" },
          statusModule: {
            overallStatus: "COMPLETED",
            startDateStruct: { date: "2020-03-26", type: "ACTUAL" },
            primaryCompletionDateStruct: { date: "2022-09-29", type: "ACTUAL" },
          },
          armsInterventionsModule: {
            interventions: [
              { type: "DRUG", name: "Venetoclax" },
              { type: "DRUG", name: "Azacitidine" },
              { type: "DRUG", name: "Azacitidine" },
              { type: "DIETARY_SUPPLEMENT", name: "Vitamin D" },
            ],
          },
        },
        hasResults: true,
      },
      {
        protocolSection: {
          identificationModule: { nctId: "NCT07605416" },
          statusModule: {
            overallStatus: "NOT_YET_RECRUITING",
            startDateStruct: { date: "2027-04", type: "ESTIMATED" },
            primaryCompletionDateStruct: { date: "2030-01", type: "ESTIMATED" },
          },
        },
        hasResults: false,
      },
      {
        // hasResults absent, junk date → both null, never a guessed value.
        protocolSection: {
          identificationModule: { nctId: "NCT00000003" },
          statusModule: { startDateStruct: { date: "March 2020" } },
        },
      },
    ],
  };
  const scholars = new Map([["abc1234", { cwid: "abc1234", name: "Jane Smith" }]]);
  const now = new Date("2026-09-28T00:00:00Z");
  const instRow = (protocol: string, nct: string): InstitutionalRow => ({
    cwid: "abc1234", nctNumber: nct, protocolNumber: protocol, piName: null, title: null,
    protocolType: null, firstOTADate: null, firstCTADate: null, statusDate: null,
    principalSponsor: null, overallCurrentStatus: "Open to Accrual",
  });

  it("round-trips status, dates, hasResults and interventions into the stored row", async () => {
    const fake = (async () => new Response(JSON.stringify(enrichmentBody))) as typeof fetch;
    const ctgov = await fetchCtgovStudies(["NCT04102020", "NCT07605416", "NCT00000003"], fake);
    const { trials } = buildTrialsAndLinks(
      [instRow("P-1", "NCT04102020"), instRow("P-2", "NCT07605416"), instRow("P-3", "NCT00000003")],
      [],
      scholars,
      now,
      ctgov,
    );
    const byP = new Map(trials.map((t) => [t.protocolNumber, t]));
    expect(byP.get("P-1")).toMatchObject({
      ctgovStatus: "COMPLETED",
      startDate: "2020-03-26",
      startDateType: "ACTUAL",
      primaryCompletionDate: "2022-09-29",
      primaryCompletionDateType: "ACTUAL",
      hasResults: true,
      interventionTypes: "DRUG; DIETARY_SUPPLEMENT",
      interventions: "Drug: Venetoclax; Drug: Azacitidine; Dietary supplement: Vitamin D",
    });
    expect(byP.get("P-2")).toMatchObject({
      ctgovStatus: "NOT_YET_RECRUITING",
      startDate: "2027-04",
      startDateType: "ESTIMATED",
      primaryCompletionDate: "2030-01",
      primaryCompletionDateType: "ESTIMATED",
      hasResults: false,
      interventionTypes: null,
      interventions: null,
    });
    const p3 = byP.get("P-3")!;
    expect(p3.hasResults).toBeNull();
    expect(p3.startDate).toBeNull();
    expect(p3.startDateType).toBeNull();
    expect(p3.ctgovStatus).toBeNull();
  });

  it("leaves the CT.gov-only fields null on the reciterdb enriched fallback", () => {
    const enriched: EnrichedRow[] = [{
      nctNumber: "NCT04102020", officialTitle: "Fallback", briefTitle: null, briefSummary: null,
      studyType: "INTERVENTIONAL", phases: null, conditions: null, meshTerms: null, enrollment: null,
    }];
    const t = buildTrialsAndLinks([instRow("P-1", "NCT04102020")], enriched, scholars, now, {
      studies: new Map(),
      complete: false,
    }).trials[0];
    expect(t.title).toBe("Fallback");
    expect(t).toMatchObject({
      ctgovStatus: null, startDate: null, startDateType: null, primaryCompletionDate: null,
      primaryCompletionDateType: null, hasResults: null, interventionTypes: null, interventions: null,
    });
  });

  it("keeps the stored CT.gov-only fields when the fetch failed or never ran, not when it completed", () => {
    const stored = {
      ctgovStatus: "RECRUITING", startDate: "2020-03", startDateType: "ACTUAL", primaryCompletionDate: "2027-01",
      primaryCompletionDateType: "ESTIMATED", hasResults: false, interventionTypes: "DRUG", interventions: "Drug: X",
    };
    const priorCtgov = new Map([["P-1", stored]]);
    const build = (ctgov?: { studies: Map<string, CtgovStudy>; complete: boolean }) =>
      buildTrialsAndLinks([instRow("P-1", "NCT04102020")], [], scholars, now, ctgov, new Map(), priorCtgov).trials[0];
    expect(build({ studies: new Map(), complete: false })).toMatchObject(stored);
    expect(build(undefined)).toMatchObject(stored); // the bridge import
    expect(build({ studies: new Map(), complete: true })).toMatchObject({ ctgovStatus: null, hasResults: null });
  });
});
