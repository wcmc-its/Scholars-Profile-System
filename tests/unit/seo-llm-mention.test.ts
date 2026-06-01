import { describe, it, expect } from "vitest";

import {
  detectMention,
  aggregateMentionSamples,
  type MentionTargets,
  type MentionSample,
} from "@/lib/seo/llm-mention";
import { computeLlmShareOfVoice, toLlmShareMarkdown } from "@/lib/seo/llm-standings";
import type { LlmRankSnapshot } from "@/lib/seo/llm-rank";
import type { BasketTarget } from "@/lib/seo/rank-basket";
import { groupByInstitution } from "@/lib/seo/standings";

const targets: MentionTargets = {
  institutionNames: ["Weill Cornell Medicine", "Weill Cornell", "WCM"],
  scholarNames: ["Costantino Iadecola", "Lewis Cantley"],
  scholarsHost: "scholars.weill.cornell.edu",
  competitorNames: ["Harvard", "Stanford", "Mayo Clinic"],
};

describe("detectMention", () => {
  it("detects the institution by any alias, case/diacritic-insensitive", () => {
    expect(
      detectMention("Researchers at WEILL CORNELL lead the field.", targets).institutionNamed,
    ).toBe(true);
    expect(detectMention("Work from WCM is notable.", targets).institutionNamed).toBe(true);
    expect(detectMention("Stanford and Harvard dominate here.", targets).institutionNamed).toBe(
      false,
    );
  });

  it("does not fire WCM inside another token (word boundary)", () => {
    expect(detectMention("The AWCMX protocol is unrelated.", targets).institutionNamed).toBe(false);
  });

  it("detects rostered scholars and folds diacritics", () => {
    const r = detectMention("A leader is Costantino Iádecola, a neurologist.", targets);
    expect(r.scholarNamed).toBe(true);
    expect(r.namedScholars).toContain("Costantino Iadecola");
  });

  it("computes prominence ordinal as WCM's rank among competitors by position", () => {
    // Harvard appears before WCM, Stanford after → WCM is 2nd.
    const r = detectMention(
      "First, Harvard. Then Weill Cornell Medicine. Later, Stanford.",
      targets,
    );
    expect(r.institutionNamed).toBe(true);
    expect(r.prominenceOrdinal).toBe(2);
  });

  it("prominence is 1 when WCM leads", () => {
    expect(
      detectMention("Weill Cornell Medicine is the top center; also Harvard.", targets)
        .prominenceOrdinal,
    ).toBe(1);
  });

  it("null prominence + null index when WCM absent", () => {
    const r = detectMention("Only Mayo Clinic and Stanford here.", targets);
    expect(r.institutionNamed).toBe(false);
    expect(r.prominenceOrdinal).toBeNull();
    expect(r.firstMentionIndex).toBeNull();
  });

  it("detects a scholars host URL if present in prose", () => {
    expect(
      detectMention("See https://scholars.weill.cornell.edu/x", targets).scholarsHostCited,
    ).toBe(true);
    expect(detectMention("No url here", targets).scholarsHostCited).toBe(false);
  });
});

describe("aggregateMentionSamples", () => {
  const mk = (i: number, inst: boolean, prom: number | null, judge?: number): MentionSample => ({
    sampleIndex: i,
    prose: "",
    result: {
      institutionNamed: inst,
      scholarNamed: false,
      namedScholars: [],
      scholarsHostCited: false,
      prominenceOrdinal: prom,
      firstMentionIndex: prom !== null ? 0 : null,
      judgeScore: judge,
    },
  });

  it("rolls samples into Wilson rates + median prominence + mean judge", () => {
    const row = aggregateMentionSamples("flagship:x", "x", "X", "openai", [
      mk(0, true, 1, 2),
      mk(1, false, null, 0),
      mk(2, true, 3, 3),
    ]);
    expect(row.institutionNamed.count).toBe(2);
    expect(row.institutionNamed.rate).toBeCloseTo(0.6667, 3);
    expect(row.medianProminence).toBe(2); // median of [1,3]
    expect(row.meanJudgeScore).toBeCloseTo((2 + 0 + 3) / 3, 6);
    expect(row.scholarNamed.count).toBe(0);
  });
});

// ── §6 LLM-answer share of voice ────────────────────────────────────────────

function llmSnap(): LlmRankSnapshot {
  const tgts: BasketTarget[] = [
    {
      key: "wcm",
      label: "WCM",
      hosts: ["scholars.weill.cornell.edu"],
      institution: "WCM",
      surfaceType: "research-profiles",
    },
    {
      key: "harvard",
      label: "Harvard",
      hosts: ["connects.catalyst.harvard.edu"],
      institution: "Harvard",
      surfaceType: "research-profiles",
    },
  ];
  const mkSample = (wcmIdx: number | null, harvIdx: number | null) => ({
    sampleIndex: 0,
    citedUrls: [],
    placements: [
      { targetKey: "wcm", citationIndex: wcmIdx, url: null, title: null },
      { targetKey: "harvard", citationIndex: harvIdx, url: null, title: null },
    ],
  });
  return {
    capturedAt: "2026-06-01T00:00:00Z",
    basketSource: "x",
    targets: tgts,
    runs: [],
    rows: [
      {
        id: "q1",
        query: "q1",
        provider: "perplexity",
        perTarget: [],
        rawSamples: [mkSample(2, null), mkSample(null, null)],
      },
      { id: "q1", query: "q1", provider: "openai", perTarget: [], rawSamples: [mkSample(null, 1)] },
    ],
  };
}

describe("computeLlmShareOfVoice", () => {
  it("pools answer-level cite rate per institution with a per-provider split", () => {
    const snap = llmSnap();
    const groups = groupByInstitution(snap.targets, "research-profiles");
    const share = computeLlmShareOfVoice(snap, groups);
    const wcm = share.find((s) => s.label === "WCM")!;
    const harv = share.find((s) => s.label === "Harvard")!;
    // Share-of-voice denominator = ALL answers (3). WCM cited in 1 (perplexity
    // sample idx 2), Harvard in 1 (openai sample) → both 1/3.
    expect(wcm.answers).toBe(3);
    expect(wcm.citedAnswers).toBe(1);
    expect(harv.answers).toBe(3);
    expect(harv.citedAnswers).toBe(1);
    expect(wcm.rate.rate).toBeCloseTo(1 / 3, 6);
    expect(harv.rate.rate).toBeCloseTo(1 / 3, 6);
    // per-provider split reflects where each group's hits actually landed
    const wcmPerp = wcm.byProvider.find((p) => p.provider === "perplexity")!;
    expect(wcmPerp.citedAnswers).toBe(1);
    expect(wcmPerp.answers).toBe(2);
    const harvOpenai = harv.byProvider.find((p) => p.provider === "openai")!;
    expect(harvOpenai.citedAnswers).toBe(1);
    expect(harvOpenai.answers).toBe(1);
  });

  it("renders a markdown table with a per-provider column", () => {
    const snap = llmSnap();
    const md = toLlmShareMarkdown(
      computeLlmShareOfVoice(snap, groupByInstitution(snap.targets, "research-profiles")),
      "LLM SoV",
    );
    expect(md).toContain("LLM SoV");
    expect(md).toContain("WCM");
    expect(md).toContain("perplexity");
  });
});
