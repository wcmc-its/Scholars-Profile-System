import { describe, expect, it } from "vitest";

import {
  buildSourceAttributionPrompt,
  parseSourceAttribution,
} from "@/lib/edit/biosketch-sources";
import type { OverviewFacts } from "@/lib/edit/overview-facts";

type Pub = OverviewFacts["representativePublications"][number];

const pub = (pmid: string, title = `T${pmid}`): Pub => ({
  pmid,
  title,
  venue: null,
  year: 2020,
  impact: null,
  synopsis: `synopsis ${pmid}`,
  impactJustification: null,
  topicRationale: null,
  authorPosition: "first",
  citationCount: null,
  relativeCitationRatio: null,
  nihPercentile: null,
  citedByCount: null,
});

describe("parseSourceAttribution (#917 v6 follow-up)", () => {
  const allowed = new Set(["1", "2", "3"]);

  it("keeps allowed pmids per contribution, clamps the index, sorts ascending", () => {
    const json = JSON.stringify({
      sources: [
        { contributionIndex: 2, pmids: ["2", "3"] },
        { contributionIndex: 1, pmids: ["1"] },
      ],
    });
    expect(parseSourceAttribution(json, allowed, 3)).toEqual([
      { contributionIndex: 1, pmids: ["1"] },
      { contributionIndex: 2, pmids: ["2", "3"] },
    ]);
  });

  it("drops pmids not in the allowed set and out-of-range contributions", () => {
    const json = JSON.stringify({
      sources: [
        { contributionIndex: 1, pmids: ["1", "GHOST"] },
        { contributionIndex: 99, pmids: ["2"] },
      ],
    });
    expect(parseSourceAttribution(json, allowed, 3)).toEqual([{ contributionIndex: 1, pmids: ["1"] }]);
  });

  it("merges + de-dupes duplicate contribution entries, drops empties", () => {
    const json = JSON.stringify({
      sources: [
        { contributionIndex: 1, pmids: ["1", "2"] },
        { contributionIndex: 1, pmids: ["2", "3"] },
        { contributionIndex: 2, pmids: ["GHOST"] },
      ],
    });
    expect(parseSourceAttribution(json, allowed, 3)).toEqual([
      { contributionIndex: 1, pmids: ["1", "2", "3"] },
    ]);
  });

  it("returns [] on malformed JSON (never throws)", () => {
    expect(parseSourceAttribution("not json", allowed, 3)).toEqual([]);
    expect(parseSourceAttribution("{}", allowed, 3)).toEqual([]);
    expect(parseSourceAttribution(JSON.stringify({ sources: "x" }), allowed, 3)).toEqual([]);
  });

  it("prompt lists the numbered contributions and the candidate pmids", () => {
    const prompt = buildSourceAttributionPrompt(["First.", "Second."], [pub("1"), pub("2")]);
    expect(prompt).toContain("1. First.");
    expect(prompt).toContain("2. Second.");
    expect(prompt).toContain("pmid 1:");
    expect(prompt).toContain("pmid 2:");
  });
});
