/**
 * #2653 v8 — the generator's v8 wiring (`lib/edit/biosketch-generator.ts` + the verify-prompt /
 * grounding-reference additions in `overview-generator.ts`). The Bedrock draft call is mocked;
 * the faithfulness grounder is mocked to CAPTURE its options. Asserts:
 *   - the v8 user turn carries the role directive + fragment, the contribution line, and the
 *     keyed PRODUCTS block; the v7 user turn for the same inputs carries none of them
 *   - end-to-end under v8: keys are rendered, out-of-list references / URLs stripped, the
 *     `references` report is populated, the grounder receives `productRefs`, and a Personal
 *     Statement returns its (unmapped) products
 *   - end-to-end under v7 for the same inputs: no validator, `references: null`, `products: null`,
 *     the grounder gets NO productRefs (v7 output contract untouched)
 *   - the verify prompt / grounding reference gain the product-reference check ONLY when refs
 *     are passed (additive; the v5–v7 + overview callers stay byte-identical)
 */
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
  BIOSKETCH_ROLE_FRAGMENTS,
  biosketchProductRefs,
  buildBiosketchUserPrompt,
  generateBiosketch,
} from "@/lib/edit/biosketch-generator";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";
import { buildGroundingReference, overviewVerifySystemPrompt } from "@/lib/edit/overview-generator";
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

beforeEach(() => {
  vi.clearAllMocks();
  mockGround.mockImplementation(async (_facts: unknown, prose: string) => ({ prose, removed: [] }));
});

describe("buildBiosketchUserPrompt — v8 vs v7 for the same inputs", () => {
  it("v8 carries the role directive + fragment, the contribution line, and the keyed PRODUCTS block", () => {
    const turn = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ ...PS, promptVersion: "v8" }),
    );
    expect(turn).toContain("Your role on this application: Co-Investigator.");
    expect(turn).toContain(BIOSKETCH_ROLE_FRAGMENTS.co_investigator);
    expect(turn).toContain("What you will do on this project: lead the vector work for Aim 1");
    // the keyed list: related-by-aims first ("liver" overlaps Aim 1), then other significant
    expect(turn).toContain("[P1] renders as (Doe 2019): Alpha vectors in the liver (2019)");
    expect(turn).toContain("[P2] renders as (PMID 22): Beta dosing study (2021)");
    // the FACTS block still never surfaces the withheld fields
    expect(turn).not.toContain("facultyMetrics");
  });

  it("v7 carries none of it (byte-identical contract for v5–v7)", () => {
    const turn = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ ...PS, promptVersion: "v7" }),
    );
    expect(turn).not.toContain("Your role on this application");
    expect(turn).not.toContain("What you will do on this project");
    expect(turn).not.toContain("renders as");
    expect(turn).not.toContain("[P1]");
    expect(
      biosketchProductRefs(FACTS, normalizeBiosketchParams({ ...PS, promptVersion: "v7" })),
    ).toEqual([]);
  });

  it("v8 with a null role degrades to 'not specified' (never throws)", () => {
    const turn = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ ...PS, promptVersion: "v8", applicationRole: null }),
    );
    expect(turn).toContain("Your role on this application: not specified.");
  });

  it("v8 Contributions mode keys the products too (no role line)", () => {
    const turn = buildBiosketchUserPrompt(
      FACTS,
      normalizeBiosketchParams({ mode: "contributions", promptVersion: "v8" }),
    );
    expect(turn).toContain("[P1] renders as");
    expect(turn).not.toContain("Your role on this application");
  });
});

describe("generateBiosketch — v8 end to end (mocked gateway)", () => {
  it("renders keys, strips out-of-list references + URLs, reports, grounds with productRefs, returns products", async () => {
    mockGenerateText.mockResolvedValue({
      text: "I direct vector work [P1]. A dosing result [P2, P9]. See (Roe 2020) and https://x.org/y. Done.",
    });
    const result = await generateBiosketch(
      FACTS,
      normalizeBiosketchParams({ ...PS, promptVersion: "v8" }),
      { faithfulnessPass: true },
    );
    expect(result.entries).toEqual([
      {
        title: "",
        body: "I direct vector work (Doe 2019). A dosing result (PMID 22). See and. Done.",
      },
    ]);
    expect(result.references).toEqual({
      kept: 2,
      issues: [
        { span: "[P2, P9]", kind: "out_of_list", action: "stripped" },
        { span: "(Roe 2020)", kind: "out_of_list", action: "stripped" },
        { span: "https://x.org/y", kind: "url", action: "stripped" },
      ],
    });
    // The grounder saw the RENDERED text and the reference list.
    expect(mockGround).toHaveBeenCalledTimes(1);
    const [, prose, opts] = mockGround.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(prose).toContain("(Doe 2019)");
    expect(opts.productRefs).toEqual([
      expect.objectContaining({ key: "P1", pmid: "11", label: "Doe 2019" }),
      expect.objectContaining({ key: "P2", pmid: "22", label: "PMID 22" }),
    ]);
    // A Personal Statement returns the (unmapped) products its references point at; only the
    // draft call hit the gateway (no mapping / attribution calls for a statement).
    expect(result.products?.related.map((p) => p.pmid)).toEqual(["11"]);
    expect(result.products?.otherSignificant.map((p) => p.pmid)).toEqual(["22"]);
    expect(result.products?.relatedFromAims).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("v7 for the same inputs: no validator, references null, products null, grounder without refs", async () => {
    mockGenerateText.mockResolvedValue({ text: "I direct vector work [P1]. See (Roe 2020)." });
    const result = await generateBiosketch(
      FACTS,
      normalizeBiosketchParams({ ...PS, promptVersion: "v7" }),
      { faithfulnessPass: true },
    );
    expect(result.entries[0]!.body).toBe("I direct vector work [P1]. See (Roe 2020).");
    expect(result.references).toBeNull();
    expect(result.products).toBeNull();
    const [, , opts] = mockGround.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(opts).not.toHaveProperty("productRefs");
  });

  it("v8 Contributions: a stray key in a TITLE line is dropped, not rendered", async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        text: "1. TITLE: Alpha vectors [P1]\n\nBody alpha [P1].\n\n2. TITLE: Beta\n\nBody beta.",
      })
      // product-mapping + source-attribution calls (Contributions mode) — tolerant parsers
      .mockResolvedValue({ text: "{}" });
    const result = await generateBiosketch(
      FACTS,
      normalizeBiosketchParams({ mode: "contributions", promptVersion: "v8" }),
      { faithfulnessPass: false },
    );
    expect(result.entries).toEqual([
      { title: "Alpha vectors", body: "Body alpha (Doe 2019)." },
      { title: "Beta", body: "Body beta." },
    ]);
    expect(result.references?.kept).toBe(1);
  });
});

describe("verify prompt + grounding reference — the product-reference check is additive", () => {
  const refs = [
    { key: "P1", pmid: "11", label: "Doe 2019", title: "Alpha <i>vectors</i>", year: 2019 },
  ];

  it("appends the check only when refs are passed", () => {
    const base = overviewVerifySystemPrompt({
      permitSignificance: true,
      permitBibliometrics: true,
    });
    const withRefs = overviewVerifySystemPrompt({
      permitSignificance: true,
      permitBibliometrics: true,
      productRefs: refs,
    });
    expect(base).not.toContain("reference-mismatch");
    expect(withRefs.startsWith(base)).toBe(true);
    expect(withRefs).toContain("reference-mismatch");
    expect(overviewVerifySystemPrompt({ productRefs: [] })).toBe(overviewVerifySystemPrompt());
  });

  it("lists the rendered references, mapped to their titles, only when refs are passed", () => {
    const without = buildGroundingReference(FACTS, { permitSignificance: true });
    const withRefs = buildGroundingReference(FACTS, {
      permitSignificance: true,
      productRefs: refs,
    });
    expect(without).not.toContain("PRODUCT REFERENCES");
    expect(withRefs).toContain("PRODUCT REFERENCES");
    expect(withRefs).toContain("- (Doe 2019) = TITLE: Alpha vectors (2019)");
  });
});
