import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGenerateText, mockGround } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGround: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: () => () => ({}) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => undefined }));
vi.mock("@/lib/llm/models", () => ({
  DEFAULT_GENERATE_MODEL: "test-model",
  modelAcceptsTemperature: () => false,
}));
vi.mock("@/lib/edit/overview-generator", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/edit/overview-generator")>();
  return { ...real, groundOverviewDraft: mockGround };
});

import {



  generateBiosketch,
} from "@/lib/edit/biosketch-generator";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";
import type { OverviewFacts } from "@/lib/edit/overview-facts";

const pub = (
  pmid: string,
  title: string,
  year: number,
  leadAuthor: string | null,
  impact: number,
) => ({
  pmid,
  title,
  venue: "J",
  year,
  impact,
  synopsis: `finding for ${title}`,
  impactJustification: null,
  topicRationale: null,
  authorPosition: "last" as const,
  citationCount: 10,
  relativeCitationRatio: null,
  nihPercentile: null,
  citedByCount: null,
  leadAuthor,
});

const FACTS = {
  name: "Jane Q. Researcher",
  title: "Professor",
  department: "Medicine",
  topics: [],
  representativePublications: [
    pub("11", "Alpha vectors in the liver", 2019, "Doe", 90),
    pub("22", "Beta dosing study", 2021, null, 80),
  ],
  publicationCount: 2,
  yearsActive: { first: 2019, last: 2021 },
  activeGrants: [],
  education: [],
  titles: [],
  methods: [],
  facultyMetrics: null,
  existingBio: null,
} as unknown as OverviewFacts;

const PS = {
  mode: "personal_statement",
  projectTitle: "Liver gene therapy",
  aims: "Aim 1: alpha vectors in the liver.",
  applicationRole: "co_investigator",
  contributionLine: "lead the vector work for Aim 1",
};

// v7: no product references, so the statement body passes through the validator untouched.
const params = normalizeBiosketchParams({ ...PS, promptVersion: "v7" });
const draft = (n: number) => ({ text: `${"x".repeat(n - 1)}.` });

beforeEach(() => {
  vi.clearAllMocks();
  mockGround.mockImplementation(async (_facts: unknown, prose: string) => ({ prose, removed: [] }));
});

describe("generateBiosketch — #2665 over-cap tighten pass", () => {
  it("a draft 5% over the cap gets ONE tighten call and comes back under", async () => {
    mockGenerateText.mockResolvedValueOnce(draft(3675)).mockResolvedValueOnce(draft(3300));
    const r = await generateBiosketch(FACTS, params, { faithfulnessPass: false });
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockGenerateText.mock.calls[1][0].messages[0].content).toContain("the limit is 3,500");
    expect(r.entries[0].body).toHaveLength(3300);
    expect(r.overflow).toEqual([]);
    expect(r.tightened).toEqual([{ index: 0, before: 3675, after: 3300 }]);
  });

  it("a draft under the cap gets no extra call", async () => {
    mockGenerateText.mockResolvedValueOnce(draft(3400));
    const r = await generateBiosketch(FACTS, params, { faithfulnessPass: false });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(r.tightened).toEqual([]);
  });

  it("a failed or longer tighten keeps the original and it stays flagged", async () => {
    mockGenerateText.mockResolvedValueOnce(draft(3600)).mockRejectedValueOnce(new Error("boom"));
    const r = await generateBiosketch(FACTS, params, { faithfulnessPass: false });
    expect(r.entries[0].body).toHaveLength(3600);
    expect(r.overflow).toEqual([{ index: 0, chars: 3600 }]);
    expect(r.tightened).toEqual([{ index: 0, before: 3600, after: 3600 }]);
  });

  it("the faithfulness pass grounds the tightened text, not the original", async () => {
    mockGenerateText.mockResolvedValueOnce(draft(3675)).mockResolvedValueOnce(draft(3300));
    await generateBiosketch(FACTS, params, { faithfulnessPass: true });
    expect(mockGround.mock.calls[0][1]).toHaveLength(3300);
  });
});
