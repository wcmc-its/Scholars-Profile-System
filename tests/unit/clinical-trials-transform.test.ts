import { describe, it, expect } from "vitest";
import {
  buildTrialsAndLinks,
  isLikelyPi,
  parseLooseDate,
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

describe("isLikelyPi", () => {
  it("matches first+last regardless of order/format", () => {
    expect(isLikelyPi("Jane Smith", "Smith, Jane")).toBe(true);
    expect(isLikelyPi("Jane Smith", "Jane A. Smith")).toBe(true);
  });
  it("rejects a different person and missing/short names", () => {
    expect(isLikelyPi("Jane Smith", "John Doe")).toBe(false);
    expect(isLikelyPi("Jane Smith", null)).toBe(false);
    expect(isLikelyPi("Smith", "Smith, Jane")).toBe(false); // single token → not enough
  });
});

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

describe("buildTrialsAndLinks", () => {
  const scholarName = new Map<string, string>([
    ["abc1234", "Jane Smith"],
    ["def5678", "Robert Jones"],
  ]);

  it("dedupes one trial per protocol, links each investigator, derives role, merges enrichment", () => {
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

    const { trials, links, stats } = buildTrialsAndLinks(institutional, enriched, scholarName, NOW);

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

    const byCwid = Object.fromEntries(links.map((l) => [l.cwid, l.role]));
    expect(byCwid["abc1234"]).toBe("Principal Investigator"); // name matches piName
    expect(byCwid["def5678"]).toBe("Investigator"); // does not match piName
  });

  it("skips rows without a protocol and with cwids not in the scholar set", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: null }), // no protocol
      inst({ cwid: "zzz9999", protocolNumber: "P-002" }), // unknown cwid
    ];
    const { trials, links, stats } = buildTrialsAndLinks(institutional, [], scholarName, NOW);
    expect(trials).toHaveLength(0);
    expect(links).toHaveLength(0);
    expect(stats.skippedNoProtocol).toBe(1);
    expect(stats.skippedUnknownCwid).toBe(1);
  });

  it("falls back to institutional title and null enrichment when no NCT match", () => {
    const institutional: InstitutionalRow[] = [
      inst({ cwid: "abc1234", protocolNumber: "P-003", title: "Only institutional" }),
    ];
    const { trials } = buildTrialsAndLinks(institutional, [], scholarName, NOW);
    expect(trials[0].title).toBe("Only institutional");
    expect(trials[0].enrichmentSource).toBeNull();
    expect(trials[0].enrichedAt).toBeNull();
  });
});
